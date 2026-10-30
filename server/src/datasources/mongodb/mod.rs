//! MongoDB: aggregation pipelines and `find` on one collection, answering the `documents` shape
//! with BSON types kept (docs/api/datasources.md, "MongoDB").
//!
//! Read-only in three layers: the login must hold only reading privileges (checked through
//! `connectionStatus` when a client is built, on "Test connection" and when the source is saved),
//! the query check refuses writing stages and server-side JavaScript (`pipeline.rs`), and only
//! `aggregate` and `find` are ever sent for a query. Every connection the driver opens, also to
//! replica set members and SRV targets, goes through a relay that applies the target rules
//! (`relay.rs`).

#[cfg(test)]
mod api_tests;
pub mod distribution;
pub mod documents;
pub mod pipeline;
pub mod relay;
#[cfg(test)]
pub(crate) mod test_server;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bson::{Bson, Document, RawDocumentBuf, doc};
use futures_util::TryStreamExt;
use mongodb::change_stream::ChangeStream;
use mongodb::change_stream::event::ResumeToken;
use mongodb::event::EventHandler;
use mongodb::event::sdam::SdamEvent;
use mongodb::options::{ClientOptions, Credential, SelectionCriteria, ServerAddress, Socks5Proxy, Tls, TlsOptions};
use mongodb::{Client, ServerInfo, ServerType};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;

use super::document_schema::{SAMPLE_DOCUMENTS, SchemaSampler, charge_schema, schema_cut};
use super::{
    Connection, DataSourcePlugin, DefaultValue, Detail, FieldError, Health, Kind, SettingField, SettingType,
    SourceError, SourceQuery, SourceSchema,
};
use crate::shapes::{DocumentSet, FieldSchema, Notice, NoticeSeverity, QueryResult, Shape, Truncated};
use documents::Converter;
use pipeline::Binder;
use relay::{Refusal, Relay};

const SETTINGS: &[SettingField] = &[
    SettingField::new("hosts", "datasources.settings.hosts", SettingType::String).target().required(),
    SettingField::new("port", "datasources.settings.port", SettingType::Number)
        .target()
        .default(DefaultValue::Number(27017)),
    SettingField::new("srv", "datasources.settings.srv", SettingType::Bool).target().default(DefaultValue::Bool(false)),
    SettingField::new("replicaSet", "datasources.settings.replicaSet", SettingType::String).target(),
    SettingField::new("database", "datasources.settings.database", SettingType::String).target().required(),
    SettingField::new("user", "datasources.settings.user", SettingType::String).target(),
    SettingField::new("password", "datasources.settings.password", SettingType::String).secret(),
    SettingField::new("authSource", "datasources.settings.authSource", SettingType::String).target(),
    SettingField::new("tls", "datasources.settings.tls", SettingType::Bool).target().default(DefaultValue::Bool(false)),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
    SettingField::new("maxResponseBytes", "datasources.settings.maxResponseBytes", SettingType::Number),
];

const DEFAULT_PORT: u16 = 27017;
const MAX_HOSTS: usize = 50;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long an operation waits for a suitable server.
const SERVER_SELECTION_TIMEOUT: Duration = Duration::from_secs(10);
/// The privilege check when a source is saved waits less: an unreachable server does not stop
/// the save (the check runs again on every connect).
const SAVE_SELECTION_TIMEOUT: Duration = Duration::from_secs(4);
const POOL_SIZE: u32 = 4;
/// Paths named in `documents.binary_hidden` notices.
const MAX_BINARY_NOTICES: usize = 20;
/// The schema route: collections listed, sampled (with indexes), documents sampled per
/// collection and the time limit per sample.
const MAX_COLLECTIONS: usize = 1_000;
const MAX_SAMPLED_COLLECTIONS: usize = 100;
const SCHEMA_SAMPLE: i64 = 100;
const SCHEMA_SAMPLE_TIME: Duration = Duration::from_secs(2);

/// Privileges a login may hold: those of the built-in `read` and `readAnyDatabase` roles.
/// `OWN_DATABASE_ACTIONS` are also part of `read`, but only accepted on the source's own database
/// (any collection) and refused on other databases and cluster-wide: `planCacheRead` shows the
/// server's cached query plans, `performRawDataOperations` (MongoDB 8.2) lets reads see the raw
/// storage of time series collections (writing that way still needs a write privilege).
const READ_ACTIONS: &[&str] = &[
    "changeStream",
    "collStats",
    "dbHash",
    "dbStats",
    "find",
    "killCursors",
    "listCollections",
    "listDatabases",
    "listIndexes",
    "listSearchIndexes",
];
const OWN_DATABASE_ACTIONS: &[&str] = &["planCacheRead", "performRawDataOperations"];

pub fn kind() -> Kind {
    Kind { name: "MongoDB", hint_key: "datasources.kinds.mongodb.hint", settings: SETTINGS, plugin: Arc::new(MongoDb) }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    hosts: String,
    port: Option<u64>,
    srv: Option<bool>,
    replica_set: Option<String>,
    database: String,
    user: Option<String>,
    auth_source: Option<String>,
    tls: Option<bool>,
    ca_cert: Option<String>,
    max_response_bytes: Option<u64>,
}

impl Settings {
    fn srv(&self) -> bool {
        self.srv == Some(true)
    }

    /// TLS is on when asked for, and for SRV unless turned off (as in a `mongodb+srv` URI).
    fn tls(&self) -> bool {
        self.tls.unwrap_or(self.srv())
    }

    fn non_empty(v: &Option<String>) -> Option<&str> {
        v.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }
}

/// `host`, `host:port`, `[v6]` or `[v6]:port`, separated by commas.
fn split_hosts(hosts: &str) -> Vec<(String, Option<&str>)> {
    hosts
        .split(',')
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .map(|h| {
            if let Some(rest) = h.strip_prefix('[')
                && let Some((ip, after)) = rest.split_once(']')
            {
                return (ip.to_string(), after.strip_prefix(':'));
            }
            match h.rsplit_once(':') {
                Some((host, port)) if !host.contains(':') => (host.to_string(), Some(port)),
                _ => (h.to_string(), None),
            }
        })
        .collect()
}

/// The host names or addresses of a `hosts` setting, for the checks that need no network.
pub fn host_names(hosts: &str) -> Vec<String> {
    split_hosts(hosts).into_iter().map(|(h, _)| h).collect()
}

fn parse_hosts(s: &Settings) -> Result<Vec<(String, u16)>, FieldError> {
    let default_port = s.port.unwrap_or(u64::from(DEFAULT_PORT));
    let list = split_hosts(&s.hosts);
    if list.is_empty() {
        return Err(FieldError::new("hosts", "settings.required", "hosts is required"));
    }
    if list.len() > MAX_HOSTS {
        return Err(FieldError::new("hosts", "mongodb.too_many_hosts", format!("at most {MAX_HOSTS} hosts"))
            .with("max", MAX_HOSTS));
    }
    let mut out = Vec::new();
    for (host, port) in list {
        super::check_host("hosts", &host)?;
        let port = match port {
            Some(p) => p
                .parse::<u64>()
                .map_err(|_| FieldError::new("hosts", "settings.port_invalid", "the port must be 1 to 65535"))?,
            None => default_port,
        };
        super::check_port("hosts", Some(port))?;
        out.push((host, port as u16));
    }
    Ok(out)
}

/// Database names MongoDB accepts.
fn check_database(name: &str) -> Result<(), FieldError> {
    let bad = name.len() > 63 || name.chars().any(|c| matches!(c, '/' | '\\' | '.' | ' ' | '"' | '$' | '\0'));
    if bad {
        return Err(FieldError::new(
            "database",
            "mongodb.database_invalid",
            format!("{name:?} is not a database name"),
        ));
    }
    // Server-internal databases: users, the oplog, sharding metadata.
    if matches!(name, "admin" | "local" | "config") {
        return Err(FieldError::new(
            "database",
            "mongodb.database_reserved",
            format!("{name} is a database of the server itself"),
        ));
    }
    Ok(())
}

pub struct MongoDb;

/// A built client with the relay its connections run through.
struct Shared {
    client: Client,
    relay: Relay,
    database: String,
    /// Where every operation may go (`selection`); passed to commands explicitly, since the
    /// driver applies the client's default only to reads such as `find` and `aggregate`.
    selection: SelectionCriteria,
    /// A single server, without replica set discovery.
    direct: bool,
    /// Set when the topology names a server that is not a TCP host (a Unix socket path a replica
    /// set member announced); the source is then refused.
    socket_member: Arc<AtomicBool>,
    /// Whether the source has a login (then its privileges must be readable).
    has_user: bool,
    watcher: Watcher,
}

/// At most this many change streams are open per source; more subscriptions are polled.
const MAX_STREAMS: usize = 8;

/// The client of a source's change streams, through the same relay and with the same login as
/// the queries' client, but with its own pool of `MAX_STREAMS` connections.
struct Watcher {
    options: ClientOptions,
    /// The CA certificate, written to a file again while the client is built.
    ca_pem: Option<String>,
    ca_dir: std::path::PathBuf,
    client: tokio::sync::OnceCell<Client>,
    /// One permit per open stream of the source (`stream_permits`).
    streams: Arc<tokio::sync::Semaphore>,
}

/// The stream permits of a data source, shared by every client built for it: after a settings
/// change, streams of the old client still open (until their feeds reopen them) count against
/// the same `MAX_STREAMS` as the new client's.
fn stream_permits(datasource_id: &str) -> Arc<tokio::sync::Semaphore> {
    static PERMITS: std::sync::LazyLock<
        std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Semaphore>>>,
    > = std::sync::LazyLock::new(Default::default);
    let mut permits = PERMITS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // Forget sources without a client, so the map does not grow with every source ever seen.
    permits.retain(|_, s| Arc::strong_count(s) > 1 || s.available_permits() < MAX_STREAMS);
    permits
        .entry(datasource_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(MAX_STREAMS)))
        .clone()
}

impl Watcher {
    async fn client(&self) -> Result<&Client, SourceError> {
        self.client
            .get_or_try_init(|| async {
                let mut options = self.options.clone();
                let ca = match &self.ca_pem {
                    Some(pem) => {
                        let file = write_ca(&self.ca_dir, pem)?;
                        let mut tls = TlsOptions::default();
                        tls.ca_file_path = Some(file.0.clone());
                        options.tls = Some(Tls::Enabled(tls));
                        Some(file)
                    }
                    None => None,
                };
                let client = Client::with_options(options).map_err(|e| failed(&e, None, SERVER_SELECTION_TIMEOUT));
                drop(ca);
                client
            })
            .await
    }
}

impl Shared {
    /// Refuses the source once a member named a Unix socket.
    fn guard(&self) -> Result<(), SourceError> {
        if self.socket_member.load(Ordering::SeqCst) {
            return Err(SourceError::Blocked(Detail::new(
                "mongodb.socket_member",
                "a server names a Unix socket as a member of the deployment; only network hosts may be reached",
            )));
        }
        Ok(())
    }

    /// The driver error of an operation that began at `mark`, as a source error.
    fn fail(&self, e: &mongodb::error::Error, mark: u64, timeout: Duration) -> SourceError {
        if let Err(blocked) = self.guard() {
            return blocked;
        }
        failed(e, self.relay.refusal_since(mark), timeout)
    }

    /// Runs the start of an operation that began at `mark`. With a single server, a refused or
    /// unreachable connection to it ends the operation at once, with its cause, instead of after
    /// the driver's selection timeout; a replica set may still reach another member.
    async fn started<T>(
        &self,
        mark: u64,
        timeout: Duration,
        operation: impl std::future::IntoFuture<Output = mongodb::error::Result<T>>,
    ) -> Result<T, SourceError> {
        let refused = async {
            if !self.direct {
                return std::future::pending().await;
            }
            self.relay.next_refusal(mark).await
        };
        tokio::select! {
            done = operation.into_future() => done.map_err(|e| self.fail(&e, mark, timeout)),
            refusal = refused => Err(match refusal {
                Refusal::Blocked(d) => SourceError::Blocked(d),
                Refusal::Failed(d) => SourceError::Failed(d),
            }),
        }
    }

    /// A command on `db`, sent only to a server the selection allows.
    async fn command(&self, db: &str, command: Document, timeout: Duration) -> Result<Document, SourceError> {
        self.guard()?;
        let mark = self.relay.mark();
        let database = self.client.database(db);
        let run = database.run_command(command).selection_criteria(self.selection.clone());
        self.started(mark, timeout, run).await
    }

    /// A cursor command on the source's database (`listCollections`, `listIndexes`), at most
    /// `max` documents, sent only to a server the selection allows.
    async fn cursor_command(
        &self,
        command: Document,
        max: usize,
        timeout: Duration,
    ) -> Result<Vec<Document>, SourceError> {
        self.guard()?;
        let mark = self.relay.mark();
        let database = self.client.database(&self.database);
        let run = database.run_cursor_command(command).selection_criteria(self.selection.clone());
        let mut cursor = self.started(mark, timeout, run).await?;
        let mut out = Vec::new();
        while out.len() < max
            && let Some(d) = cursor.try_next().await.map_err(|e| self.fail(&e, mark, timeout))?
        {
            out.push(d);
        }
        Ok(out)
    }
}

/// The CA certificate as a file the driver reads once while the client is built; removed after.
struct CaFile(std::path::PathBuf);

impl Drop for CaFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn write_ca(dir: &std::path::Path, pem: &str) -> Result<CaFile, SourceError> {
    use std::io::Write;
    let path = dir.join(format!(".kalzit-mongodb-ca-{}.pem", hex::encode(rand::random::<[u8; 12]>())));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| {
        tracing::error!("writing the MongoDB CA certificate to {}: {e}", path.display());
        SourceError::failed("internal", "internal: the CA certificate cannot be prepared")
    })?;
    let guard = CaFile(path);
    file.write_all(pem.as_bytes()).map_err(|e| {
        tracing::error!("writing the MongoDB CA certificate: {e}");
        SourceError::failed("internal", "internal: the CA certificate cannot be prepared")
    })?;
    Ok(guard)
}

/// Maps a driver error; connection failures caused by a target the relay refused during the same
/// operation answer that refusal.
fn failed(e: &mongodb::error::Error, refusal: Option<Refusal>, timeout: Duration) -> SourceError {
    use mongodb::error::ErrorKind;
    let connecting = matches!(
        *e.kind,
        ErrorKind::ServerSelection { .. }
            | ErrorKind::Io(_)
            | ErrorKind::ProxyConnect { .. }
            | ErrorKind::ConnectionPoolCleared { .. }
    );
    if connecting && let Some(refusal) = refusal {
        return match refusal {
            Refusal::Blocked(d) => SourceError::Blocked(d),
            Refusal::Failed(d) => SourceError::Failed(d),
        };
    }
    match &*e.kind {
        ErrorKind::Command(c) if c.code == 50 => SourceError::Timeout(timeout.as_secs()),
        ErrorKind::Command(c) => SourceError::from_source(format!("{} ({})", c.message, c.code_name)),
        ErrorKind::Authentication { message, .. } => SourceError::from_source(message.clone()),
        ErrorKind::ServerSelection { message, .. } => {
            SourceError::failed("mongodb.no_server", format!("no suitable MongoDB server answered: {message}"))
                .with("detail", message)
        }
        ErrorKind::DnsResolve { message, .. } => {
            SourceError::failed("mongodb.srv_lookup", format!("the SRV or TXT lookup failed: {message}"))
                .with("detail", message)
        }
        ErrorKind::Io(io) if crate::datasources::connect::is_dead(io.kind()) => crate::datasources::connect::lost(io),
        ErrorKind::ConnectionPoolCleared { message, .. } => crate::datasources::connect::lost(message),
        _ => SourceError::from_source(e.to_string()),
    }
}

/// Reads go to the primary (or the one server of a direct connection), never to a Unix socket a
/// replica set member might name.
fn selection(direct: bool) -> SelectionCriteria {
    SelectionCriteria::Predicate(Arc::new(move |info: &ServerInfo| {
        matches!(info.address(), ServerAddress::Tcp { .. })
            && (direct
                || matches!(
                    info.server_type(),
                    ServerType::Standalone | ServerType::Mongos | ServerType::RsPrimary | ServerType::LoadBalancer
                ))
    }))
}

/// Builds a client for the source and checks that its login can only read.
async fn build(conn: &Connection, selection_timeout: Duration) -> Result<Shared, SourceError> {
    let s: Settings = conn.settings_as()?;
    let relay = Relay::start(conn.policy_arc(), CONNECT_TIMEOUT).await.map_err(|e| {
        tracing::error!("starting the MongoDB relay: {e}");
        SourceError::failed("internal", "internal: the connection relay cannot start")
    })?;
    let hosts = parse_hosts(&s).map_err(|e| SourceError::Failed(e.detail))?;
    let mark = relay.mark();
    let mut options = if s.srv() {
        let (host, _) = &hosts[0];
        // The driver reads the SRV and TXT records; every host they name passes the relay. The
        // check here only answers a refused host early and clearly.
        let options = ClientOptions::parse(format!("mongodb+srv://{host}/"))
            .await
            .map_err(|e| failed(&e, relay.refusal_since(mark), selection_timeout))?;
        for address in &options.hosts {
            match address {
                ServerAddress::Tcp { host, port } => {
                    conn.policy().resolve_all(host, port.unwrap_or(DEFAULT_PORT)).await?;
                }
                _ => {
                    return Err(SourceError::Blocked(Detail::new(
                        "mongodb.srv_target",
                        "an SRV record names a target that is not a host",
                    )));
                }
            }
        }
        options
    } else {
        let mut options = ClientOptions::default();
        options.hosts =
            hosts.iter().map(|(host, port)| ServerAddress::Tcp { host: host.clone(), port: Some(*port) }).collect();
        options
    };
    let direct = !s.srv() && hosts.len() == 1 && Settings::non_empty(&s.replica_set).is_none();
    options.direct_connection = Some(direct);
    if let Some(rs) = Settings::non_empty(&s.replica_set) {
        options.repl_set_name = Some(rs.to_string());
    }
    options.app_name = Some("Kalzit".into());
    options.default_database = Some(s.database.clone());
    options.connect_timeout = Some(CONNECT_TIMEOUT);
    options.server_selection_timeout = Some(selection_timeout);
    options.max_pool_size = Some(POOL_SIZE);
    options.min_pool_size = Some(0);
    options.max_idle_time = Some(Duration::from_secs(300));
    options.retry_writes = Some(false);
    // A read that fails on a connection the server closed (it restarted) runs once more on a
    // fresh one; the driver clears its pool for that server first.
    options.retry_reads = Some(true);
    let selection = selection(direct);
    options.selection_criteria = Some(selection.clone());
    // The selection keeps queries away from a Unix socket a member names, but the driver still
    // monitors every member it learns of; such a member refuses the whole source.
    let socket_member = Arc::new(AtomicBool::new(false));
    let flag = socket_member.clone();
    options.sdam_event_handler = Some(EventHandler::callback(move |event: SdamEvent| {
        if let SdamEvent::ServerOpening(e) = event
            && !matches!(e.address, ServerAddress::Tcp { .. })
        {
            tracing::warn!("a MongoDB deployment names a Unix socket as a member; the source is refused");
            flag.store(true, Ordering::SeqCst);
        }
    }));
    if let Some(user) = Settings::non_empty(&s.user) {
        let mut credential = Credential::default();
        credential.username = Some(user.to_string());
        credential.password = conn.secret("password").map(str::to_string);
        // As in a connection string: the database is the default, except for SRV (Atlas keeps
        // users in admin and says so in the TXT record).
        let default_source = if s.srv() {
            options.credential.as_ref().and_then(|c| c.source.clone()).unwrap_or_else(|| "admin".into())
        } else {
            s.database.clone()
        };
        credential.source = Some(Settings::non_empty(&s.auth_source).map_or(default_source, str::to_string));
        options.credential = Some(credential);
    }
    let mut ca = None;
    options.tls = Some(if s.tls() {
        let mut tls = TlsOptions::default();
        if let Some(pem) = Settings::non_empty(&s.ca_cert) {
            let file = write_ca(conn.policy().data_dir(), pem)?;
            tls.ca_file_path = Some(file.0.clone());
            ca = Some(file);
        }
        Tls::Enabled(tls)
    } else {
        Tls::Disabled
    });
    let (user, password) = relay.credentials();
    options.socks5_proxy = Some(
        Socks5Proxy::builder()
            .host("127.0.0.1".to_string())
            .port(relay.port())
            .authentication((user, password))
            .build(),
    );
    // Change streams get their own client, built when the first one opens: each open stream
    // holds a connection in a waiting getMore, which must not take the queries' pool.
    let mut watch_options = options.clone();
    watch_options.max_pool_size = Some(MAX_STREAMS as u32);
    let client = Client::with_options(options).map_err(|e| failed(&e, relay.refusal_since(mark), selection_timeout))?;
    // The driver has read the certificate into its TLS configuration.
    drop(ca);
    let has_user = Settings::non_empty(&s.user).is_some();
    let ca_pem = Settings::non_empty(&s.ca_cert).filter(|_| s.tls()).map(str::to_string);
    let watcher = Watcher {
        options: watch_options,
        ca_pem,
        ca_dir: conn.policy().data_dir().to_path_buf(),
        client: tokio::sync::OnceCell::new(),
        streams: stream_permits(conn.datasource_id()),
    };
    let shared =
        Shared { client, relay, database: s.database.clone(), selection, direct, socket_member, has_user, watcher };
    check_read_only(&shared, selection_timeout).await?;
    shared.guard()?;
    Ok(shared)
}

async fn shared(conn: &Connection) -> Result<Arc<Shared>, SourceError> {
    conn.shared(|| build(conn, SERVER_SELECTION_TIMEOUT)).await
}

/// `{db, collection}`, `cluster` or `anyResource` as text.
fn resource_text(resource: Option<&Document>) -> String {
    let Some(r) = resource else { return "?".into() };
    if r.get_bool("cluster").unwrap_or(false) {
        return "cluster".into();
    }
    if r.get_bool("anyResource").unwrap_or(false) {
        return "anyResource".into();
    }
    let db = r.get_str("db").unwrap_or("");
    let coll = r.get_str("collection").unwrap_or("");
    let db = if db.is_empty() { "*" } else { db };
    let coll = if coll.is_empty() { "*" } else { coll };
    format!("{db}.{coll}")
}

/// The `connectionStatus` answer judged: only reading privileges, and with a login, the login and
/// its privileges must be reported.
fn privileges_verdict(status: &Document, has_user: bool, database: &str) -> Result<(), SourceError> {
    let auth = status.get_document("authInfo").ok();
    let users = auth.and_then(|a| a.get_array("authenticatedUsers").ok()).map_or(0, |u| u.len());
    let privileges = auth.and_then(|a| a.get_array("authenticatedUserPrivileges").ok()).cloned().unwrap_or_default();
    // With a login, the server must name it and its privileges; an answer without them proves
    // nothing about what the login may do.
    if has_user && (users == 0 || privileges.is_empty()) {
        return Err(SourceError::failed(
            "mongodb.privileges_unknown",
            "the server does not report the login's privileges, so Kalzit cannot verify that it may only read",
        ));
    }
    for p in &privileges {
        let Bson::Document(p) = p else { continue };
        let actions = p.get_array("actions").map(|a| a.as_slice()).unwrap_or_default();
        for action in actions {
            let action = action.as_str().unwrap_or("?");
            let resource_doc = p.get_document("resource").ok();
            let own_database = resource_doc.and_then(|r| r.get_str("db").ok()) == Some(database);
            if !READ_ACTIONS.contains(&action) && !(OWN_DATABASE_ACTIONS.contains(&action) && own_database) {
                let resource = resource_text(resource_doc);
                return Err(SourceError::failed(
                    "mongodb.login_not_read_only",
                    format!("the login may {action} on {resource}; use a login with only the read role"),
                )
                .with("action", action)
                .with("resource", resource));
            }
        }
    }
    Ok(())
}

/// Refuses a login that may do more than read, a login whose privileges cannot be read, and a
/// server without access control (where any login may write).
async fn check_read_only(shared: &Shared, timeout: Duration) -> Result<(), SourceError> {
    let status = shared.command("admin", doc! { "connectionStatus": 1, "showPrivileges": true }, timeout).await?;
    privileges_verdict(&status, shared.has_user, &shared.database)?;
    // hostInfo needs a privilege no reading role holds; a server that runs it anyway does not
    // check privileges at all.
    shared.guard()?;
    let mark = shared.relay.mark();
    let admin = shared.client.database("admin");
    let run = admin.run_command(doc! { "hostInfo": 1 }).selection_criteria(shared.selection.clone());
    let host_info = tokio::select! {
        done = run.into_future() => done,
        refusal = shared.relay.next_refusal(mark), if shared.direct => return Err(match refusal {
            Refusal::Blocked(d) => SourceError::Blocked(d),
            Refusal::Failed(d) => SourceError::Failed(d),
        }),
    };
    match host_info {
        Ok(_) => Err(SourceError::failed(
            "mongodb.access_control_off",
            "the server does not check access rights, so any login may write; enable access control and use a login with only the read role",
        )),
        // Refused by the server (not authorized): access control is on.
        Err(e) if matches!(*e.kind, mongodb::error::ErrorKind::Command(_)) => Ok(()),
        Err(e) => Err(shared.fail(&e, mark, timeout)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Query {
    collection: String,
    /// Extended JSON text of the stages; the text keeps the key order (`$sort`).
    pipeline: Option<String>,
    filter: Option<String>,
    projection: Option<String>,
    sort: Option<String>,
    limit: Option<u64>,
    skip: Option<u64>,
}

enum Plan {
    Aggregate(Vec<Document>),
    Find(Box<FindPlan>),
}

struct FindPlan {
    filter: Document,
    projection: Option<Document>,
    sort: Option<Document>,
    limit: Option<u64>,
    skip: u64,
}

/// The query bound and checked: a pipeline, or a find. `max` is the document limit.
fn plan(req: &SourceQuery, q: &Query, max: u64) -> Result<Plan, SourceError> {
    let binder =
        Binder { range: req.range, interval_ms: req.interval_ms, variables: &req.variables, max_documents: max };
    Ok(match &q.pipeline {
        Some(text) => {
            if q.filter.is_some() || q.projection.is_some() || q.sort.is_some() || q.limit.is_some() || q.skip.is_some()
            {
                return Err(SourceError::rejected(
                    "mongodb.pipeline_and_find",
                    "a query is either a pipeline or a find with filter, projection, sort, limit and skip",
                ));
            }
            Plan::Aggregate(binder.pipeline(text)?)
        }
        None => {
            let filter = pipeline::parse_document("filter", q.filter.as_deref())?.unwrap_or_default();
            let projection = pipeline::parse_document("projection", q.projection.as_deref())?;
            let sort = pipeline::parse_document("sort", q.sort.as_deref())?;
            Plan::Find(Box::new(FindPlan {
                filter: binder.query_document(filter)?,
                projection: projection.map(|p| binder.projection(p)).transpose()?,
                sort: sort.map(|s| binder.query_document(s)).transpose()?,
                // As in MongoDB, a limit of 0 is no limit (the document limit still holds).
                limit: q.limit.filter(|l| *l > 0),
                skip: q.skip.unwrap_or(0),
            }))
        }
    })
}

impl Plan {
    /// The query as pipeline stages, for stages appended after it: a `find` becomes `$match`,
    /// `$sort`, `$skip`, `$limit` and `$project`, in the order the server applies them.
    fn into_stages(self) -> Vec<Document> {
        match self {
            Plan::Aggregate(stages) => stages,
            Plan::Find(find) => {
                let FindPlan { filter, projection, sort, limit, skip } = *find;
                let mut stages = vec![doc! { "$match": filter }];
                if let Some(s) = sort {
                    stages.push(doc! { "$sort": s });
                }
                if skip > 0 {
                    stages.push(doc! { "$skip": skip.min(i64::MAX as u64) as i64 });
                }
                if let Some(l) = limit {
                    stages.push(doc! { "$limit": l.min(i64::MAX as u64) as i64 });
                }
                if let Some(p) = projection {
                    stages.push(doc! { "$project": p });
                }
                stages
            }
        }
    }
}

/// How long the server holds a change stream's `getMore` open when nothing changed.
const CHANGE_AWAIT: Duration = Duration::from_secs(10);

/// Stages that read other collections: their changes are not in the watched collection's
/// stream, so such a pipeline is polled.
const OTHER_COLLECTION_STAGES: &[&str] = &["$lookup", "$graphLookup", "$unionWith"];

/// An open change stream of a live feed.
struct WatchState {
    stream: ChangeStream<Document>,
    shared: Arc<Shared>,
    _permit: tokio::sync::OwnedSemaphorePermit,
    /// The opening position was reported.
    opened: bool,
}

/// Server answers that a resume token cannot continue: its history is gone (286), the stream
/// cannot go on from there (280), or the token is not valid (260).
fn history_lost(e: &mongodb::error::Error) -> bool {
    matches!(&*e.kind, mongodb::error::ErrorKind::Command(c) if matches!(c.code, 286 | 280 | 260))
}

/// Server answers that mean "no change streams here":a standalone server (40573), a view (166),
/// a server without the stage (40324), or without the command (115, 59).
fn changes_unsupported(e: &mongodb::error::Error) -> bool {
    matches!(&*e.kind, mongodb::error::ErrorKind::Command(c) if matches!(c.code, 40573 | 166 | 40324 | 115 | 59))
}

/// The change stream stages for a query, or `None` when its changes cannot be watched (it reads
/// other collections). Inserts count only when the new document passes the query's filter (a
/// find's, or a pipeline's leading `$match`) where that filter can be applied to the event;
/// updates, replacements and deletes always count, since the document may leave the result.
/// Events carry only what the driver needs to resume, never the documents.
fn change_pipeline(plan: &Plan) -> Option<Vec<Document>> {
    let filter = match plan {
        Plan::Find(f) => Some(f.filter.clone()),
        Plan::Aggregate(stages) => {
            if stages.iter().any(|s| names_any_key(&Bson::Document(s.clone()), OTHER_COLLECTION_STAGES)) {
                return None;
            }
            stages.first().and_then(|s| s.get_document("$match").ok()).cloned()
        }
    };
    let mut stages = Vec::new();
    if let Some(inserted) = filter.as_ref().and_then(on_full_document).filter(|d| !d.is_empty()) {
        stages.push(doc! { "$match": { "$or": [
            { "operationType": { "$ne": "insert" } },
            { "$and": [{ "operationType": "insert" }, inserted] },
        ] } });
    }
    stages.push(doc! { "$project": { "operationType": 1, "ns": 1 } });
    Some(stages)
}

/// Whether `value` holds one of `keys` as a key at any depth.
fn names_any_key(value: &Bson, keys: &[&str]) -> bool {
    match value {
        Bson::Document(d) => d.iter().any(|(k, v)| keys.contains(&k.as_str()) || names_any_key(v, keys)),
        Bson::Array(items) => items.iter().any(|v| names_any_key(v, keys)),
        _ => false,
    }
}

/// A query filter applied to a change event's `fullDocument`: field paths get the prefix,
/// `$and`, `$or` and `$nor` are followed. `None` for anything else at the top (`$expr`, `$text`,
/// `$jsonSchema`, ...), which then does not narrow the events.
fn on_full_document(filter: &Document) -> Option<Document> {
    let mut out = Document::new();
    for (key, value) in filter {
        match key.as_str() {
            "$and" | "$or" | "$nor" => {
                let Bson::Array(items) = value else { return None };
                let mut mapped = Vec::with_capacity(items.len());
                for item in items {
                    let Bson::Document(d) = item else { return None };
                    mapped.push(Bson::Document(on_full_document(d)?));
                }
                out.insert(key, mapped);
            }
            k if k.starts_with('$') => return None,
            k => {
                out.insert(format!("fullDocument.{k}"), value.clone());
            }
        }
    }
    Some(out)
}

/// Ordered Extended JSON (relaxed) for the executed query.
fn ext_json(value: &Bson) -> String {
    match value {
        Bson::Document(d) => ext_json_doc(d),
        Bson::Array(items) => format!("[{}]", items.iter().map(ext_json).collect::<Vec<_>>().join(", ")),
        other => other.clone().into_relaxed_extjson().to_string(),
    }
}

fn ext_json_doc(d: &Document) -> String {
    let parts: Vec<String> = d.iter().map(|(k, v)| format!("{}: {}", Value::String(k.clone()), ext_json(v))).collect();
    format!("{{{}}}", parts.join(", "))
}

/// The cursor token: where the next page starts, bound to the query it came from.
fn fingerprint(req: &SourceQuery) -> String {
    let basis = serde_json::json!({ "q": req.query, "r": [req.range.from, req.range.to], "v": req.variables });
    hex::encode(&sha2::Sha256::digest(basis.to_string().as_bytes())[..8])
}

fn cursor_token(offset: u64, fp: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("{offset}:{fp}"))
}

fn cursor_offset(cursor: Option<&str>, fp: &str) -> Result<u64, SourceError> {
    use base64::Engine;
    let Some(cursor) = cursor else { return Ok(0) };
    let invalid = || SourceError::rejected("mongodb.cursor_invalid", "the cursor does not belong to this query");
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(cursor).map_err(|_| invalid())?;
    let text = String::from_utf8(raw).map_err(|_| invalid())?;
    let (offset, hash) = text.split_once(':').ok_or_else(invalid)?;
    if hash != fp {
        return Err(invalid());
    }
    offset.parse().map_err(|_| invalid())
}

fn notice(severity: NoticeSeverity, detail: Detail) -> Notice {
    detail.notice(severity)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSchema {
    pub name: String,
    /// `collection`, `view` or `timeseries`.
    #[serde(rename = "type")]
    pub collection_type: &'static str,
    pub indexes: Vec<IndexSchema>,
    /// Field paths from a random sample of `sampled` documents.
    pub fields: Vec<FieldSchema>,
    /// Documents sampled; 0 when the collection was not sampled (beyond the first 100, or the
    /// sample failed).
    pub sampled: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSchema {
    pub name: String,
    /// In index order.
    pub keys: Vec<IndexKey>,
    pub unique: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct IndexKey {
    pub field: String,
    /// `1`, `-1`, `"text"`, `"2dsphere"`, `"hashed"`, ...
    pub kind: Value,
}

async fn collection_schema(
    shared: &Shared,
    name: String,
    collection_type: &'static str,
    sample: bool,
) -> CollectionSchema {
    let mut schema = CollectionSchema { name, collection_type, indexes: Vec::new(), fields: Vec::new(), sampled: 0 };
    if !sample || shared.guard().is_err() {
        return schema;
    }
    if collection_type != "view"
        && let Ok(indexes) =
            shared.cursor_command(doc! { "listIndexes": &schema.name }, 1_000, SERVER_SELECTION_TIMEOUT).await
    {
        for index in indexes {
            let mut converter = Converter::default();
            let keys = index
                .get_document("key")
                .map(|k| {
                    k.iter()
                        .map(|(field, kind)| IndexKey {
                            field: field.clone(),
                            kind: converter.value_at(kind, field).to_value(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            schema.indexes.push(IndexSchema {
                name: index.get_str("name").unwrap_or_default().to_string(),
                keys,
                unique: index.get_bool("unique").unwrap_or(false),
            });
        }
    }
    let coll = shared.client.database(&shared.database).collection::<Document>(&schema.name);
    let sampled = async {
        let mut cursor =
            coll.aggregate([doc! { "$sample": { "size": SCHEMA_SAMPLE } }]).max_time(SCHEMA_SAMPLE_TIME).await?;
        let mut sampler = SchemaSampler::default();
        let mut n = 0u32;
        while let Some(d) = cursor.try_next().await? {
            documents::sample(&mut sampler, &d);
            n += 1;
        }
        Ok::<_, mongodb::error::Error>((sampler.finish(), n))
    };
    if let Ok(Ok((fields, n))) = tokio::time::timeout(SCHEMA_SAMPLE_TIME * 2, sampled).await {
        schema.fields = fields;
        schema.sampled = n;
    }
    schema
}

#[async_trait::async_trait]
impl DataSourcePlugin for MongoDb {
    fn kind(&self) -> &'static str {
        "mongodb"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Documents]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        let hosts = parse_hosts(&s)?;
        super::check_port("port", s.port)?;
        if s.srv() {
            let one_name = hosts.len() == 1
                && split_hosts(&s.hosts)[0].1.is_none()
                && super::targets::parse_ip_literal(&hosts[0].0).is_none();
            if !one_name {
                return Err(FieldError::new(
                    "hosts",
                    "mongodb.srv_host",
                    "with SRV, give exactly one host name without a port (the SRV records name the servers)",
                ));
            }
        }
        if s.database.trim().is_empty() {
            return Err(FieldError::new("database", "settings.required", "database is required"));
        }
        check_database(&s.database)?;
        super::check_pem("caCert", s.ca_cert.as_deref())?;
        if Settings::non_empty(&s.ca_cert).is_some() && !s.tls() {
            return Err(FieldError::new("caCert", "mongodb.ca_without_tls", "a CA certificate needs TLS turned on"));
        }
        if s.max_response_bytes == Some(0) {
            return Err(FieldError::new(
                "maxResponseBytes",
                "settings.out_of_range",
                "maxResponseBytes must be at least 1",
            )
            .with("min", 1));
        }
        Ok(())
    }

    fn capabilities(&self) -> &'static [super::Capability] {
        &[super::Capability::CheckOnSave, super::Capability::Watch, super::Capability::Distribution]
    }

    async fn check_on_save(&self, conn: &Connection) -> Result<(), (&'static str, SourceError)> {
        match build(conn, SAVE_SELECTION_TIMEOUT).await {
            Ok(_) => Ok(()),
            Err(e @ SourceError::Blocked(_)) => Err(("hosts", e)),
            Err(e)
                if matches!(
                    e.detail().reason,
                    "mongodb.login_not_read_only" | "mongodb.access_control_off" | "mongodb.privileges_unknown"
                ) =>
            {
                Err(("user", e))
            }
            Err(e) => {
                // Not reachable now, wrong password, ...: saving goes ahead; the check runs again
                // whenever Kalzit connects.
                tracing::debug!(datasource = conn.datasource_id(), "MongoDB check on save not completed: {e}");
                Ok(())
            }
        }
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let shared = shared(conn).await?;
            // The client may be older than a change of the login's rights: check them again.
            check_read_only(&shared, SERVER_SELECTION_TIMEOUT).await?;
            let info = shared.command("admin", doc! { "buildInfo": 1 }, SERVER_SELECTION_TIMEOUT).await?;
            let version = info.get_str("version").unwrap_or("").to_string();
            // The login must be able to read the database, not only to connect.
            shared.cursor_command(doc! { "listCollections": 1, "nameOnly": true }, 1, SERVER_SELECTION_TIMEOUT).await?;
            Ok::<_, SourceError>(version)
        };
        match check.await {
            Ok(version) => Health::connected("MongoDB", &version, false),
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let shared = shared(conn).await?;
        let specs = shared
            .cursor_command(doc! { "listCollections": 1 }, MAX_COLLECTIONS + 100, SERVER_SELECTION_TIMEOUT)
            .await?;
        let mut list: Vec<(String, &'static str)> = Vec::new();
        for spec in specs {
            let Ok(name) = spec.get_str("name") else { continue };
            if name.starts_with("system.") {
                continue;
            }
            let t = match spec.get_str("type").unwrap_or("collection") {
                "view" => "view",
                "timeseries" => "timeseries",
                _ => "collection",
            };
            list.push((name.to_string(), t));
            if list.len() >= MAX_COLLECTIONS {
                break;
            }
        }
        list.sort();
        // Four at a time, in name order.
        let mut collections = Vec::with_capacity(list.len());
        for (chunk_index, chunk) in list.chunks(4).enumerate() {
            let runs = chunk.iter().enumerate().map(|(i, (name, t))| {
                collection_schema(&shared, name.clone(), t, chunk_index * 4 + i < MAX_SAMPLED_COLLECTIONS)
            });
            collections.extend(futures_util::future::join_all(runs).await);
        }
        shared.guard()?;
        Ok(SourceSchema::Collections { database: shared.database.clone(), collections })
    }

    async fn watch(
        &self,
        conn: &Connection,
        req: SourceQuery,
        resume: Option<super::ResumeToken>,
    ) -> Result<Option<super::ChangeFeed>, SourceError> {
        let q: Query = req.parse()?;
        pipeline::check_collection(&q.collection)?;
        let plan = plan(&req, &q, req.limits.max_rows.max(1) as u64)?;
        let Some(stages) = change_pipeline(&plan) else { return Ok(None) };
        let shared = shared(conn).await?;
        shared.guard()?;
        let Ok(permit) = shared.watcher.streams.clone().try_acquire_owned() else {
            return Err(SourceError::failed(
                "mongodb.streams_limit",
                format!("{MAX_STREAMS} change streams of this source are open already; the query is polled"),
            )
            .with("max", MAX_STREAMS));
        };
        let client = shared.watcher.client().await?;
        let coll = client.database(&shared.database).collection::<Document>(&q.collection);
        let token = resume.and_then(|t| t.0.downcast_ref::<ResumeToken>().cloned());
        let timeout = req.limits.timeout;
        let open = |token: Option<ResumeToken>| {
            let mut watch = coll
                .watch()
                .pipeline(stages.clone())
                .selection_criteria(shared.selection.clone())
                .max_await_time(CHANGE_AWAIT);
            if let Some(token) = token {
                watch = watch.start_after(token);
            }
            watch
        };
        let mark = shared.relay.mark();
        let opened = match open(token.clone()).await {
            // The token's history is gone (the oplog moved on): start from now. The caller runs the
            // query after every open, so nothing in between is missed.
            Err(e) if token.is_some() && history_lost(&e) => open(None).await,
            other => other,
        };
        let stream = match opened {
            Ok(stream) => stream.with_type::<Document>(),
            Err(e) if changes_unsupported(&e) => return Ok(None),
            Err(e) => return Err(shared.fail(&e, mark, timeout)),
        };
        // The client, its relay and the stream's permit stay as long as the feed. The first report
        // is the position the stream opened at; waits without changes report newer positions.
        let state = WatchState { stream, shared, _permit: permit, opened: false };
        let feed = futures_util::stream::unfold(Some(state), move |state| async move {
            let mut state = state?;
            let token = |s: &WatchState| s.stream.resume_token().map(|t| super::ResumeToken(Arc::new(t)));
            if !state.opened {
                state.opened = true;
                let change = super::Change { changed: false, token: token(&state) };
                return Some((Ok(change), Some(state)));
            }
            if !state.stream.is_alive() {
                return None;
            }
            let mark = state.shared.relay.mark();
            match state.stream.next_if_any().await {
                Ok(Some(event)) if event.get_str("operationType").ok() == Some("invalidate") => None,
                Ok(event) => {
                    let change = super::Change { changed: event.is_some(), token: token(&state) };
                    Some((Ok(change), Some(state)))
                }
                Err(e) => Some((Err(state.shared.fail(&e, mark, timeout)), None)),
            }
        });
        Ok(Some(Box::pin(feed)))
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let q: Query = req.parse()?;
        pipeline::check_collection(&q.collection)?;
        let max = req.limits.max_rows.max(1) as u64;
        let fp = fingerprint(&req);
        let offset = cursor_offset(req.cursor.as_deref(), &fp)?;
        let plan = plan(&req, &q, max)?;
        // Everything is checked before Kalzit connects.
        let s: Settings = conn.settings_as()?;
        let shared = shared(conn).await?;
        let timeout = req.limits.timeout;
        let coll = shared.client.database(&shared.database).collection::<RawDocumentBuf>(&q.collection);
        shared.guard()?;
        let mark = shared.relay.mark();
        let fail = |e: mongodb::error::Error| shared.fail(&e, mark, timeout);
        let batch = (max + 1).min(1_000) as u32;
        let (executed, mut cursor) = match plan {
            Plan::Aggregate(mut stages) => {
                if offset > 0 {
                    stages.push(doc! { "$skip": offset as i64 });
                }
                stages.push(doc! { "$limit": (max + 1) as i64 });
                let executed = format!(
                    "{}.aggregate({})",
                    q.collection,
                    ext_json(&Bson::Array(stages.iter().cloned().map(Bson::Document).collect()))
                );
                let aggregate =
                    coll.aggregate(stages).max_time(timeout).batch_size(batch).with_type::<RawDocumentBuf>();
                let cursor = shared.started(mark, timeout, aggregate).await?;
                (executed, cursor)
            }
            Plan::Find(find_plan) => {
                let FindPlan { filter, projection, sort, limit, skip } = *find_plan;
                if limit.is_some_and(|l| offset >= l) {
                    // Past the query's own limit: an empty page.
                    let set = DocumentSet {
                        documents: Vec::new(),
                        schema: Vec::new(),
                        distributable: true,
                        ..Default::default()
                    };
                    return Ok(QueryResult::Documents { documents: set });
                }
                let fetch = limit.map_or(max + 1, |l| (l - offset).min(max + 1));
                let mut executed = format!("{}.find({}", q.collection, ext_json_doc(&filter));
                let mut find = coll.find(filter).max_time(timeout).batch_size(batch).limit(fetch as i64);
                if let Some(p) = projection {
                    executed.push_str(&format!(", {}", ext_json_doc(&p)));
                    find = find.projection(p);
                }
                executed.push(')');
                if let Some(s) = sort {
                    executed.push_str(&format!(".sort({})", ext_json_doc(&s)));
                    find = find.sort(s);
                }
                let skip = skip.saturating_add(offset);
                if skip > 0 {
                    executed.push_str(&format!(".skip({skip})"));
                    find = find.skip(skip);
                }
                executed.push_str(&format!(".limit({fetch})"));
                (executed, shared.started(mark, timeout, find).await?)
            }
        };
        let own_limit = s.max_response_bytes.map(|b| b as usize);
        let mut converter = Converter::default();
        let mut sampler = SchemaSampler::default();
        let mut docs = Vec::new();
        let mut notices = Vec::new();
        let mut bytes = 0usize;
        let mut cut: Option<&str> = None;
        while let Some(raw) = cursor.try_next().await.map_err(fail)? {
            if docs.len() as u64 >= max {
                cut = Some("documents.limit");
                let message = format!("only the first {max} documents are shown (document limit)");
                notices
                    .push(notice(NoticeSeverity::Warning, Detail::new("documents.limit", message).with("limit", max)));
                break;
            }
            let doc = Document::try_from(raw.as_ref())
                .map_err(|e| SourceError::from_source(format!("a document cannot be read: {e}")))?;
            let value = converter.document(&doc).to_json();
            let size = value.get().len() + 1;
            if own_limit.is_some_and(|l| bytes + size > l) || !req.limits.budget.take(size) {
                cut = Some("documents.size_limit");
                let detail = Detail::new("documents.size_limit", "the result was cut off at the response size limit");
                notices.push(notice(NoticeSeverity::Warning, detail));
                break;
            }
            bytes += size;
            if docs.len() < SAMPLE_DOCUMENTS {
                documents::sample(&mut sampler, &doc);
            }
            docs.push(value);
        }
        // Dropping the cursor ends it on the server (killCursors).
        drop(cursor);
        for path in converter.binary_paths.iter().take(MAX_BINARY_NOTICES) {
            let detail = Detail::new("documents.binary_hidden", format!("binary values in {path} are not shown"))
                .with("path", path);
            notices.push(notice(NoticeSeverity::Info, detail));
        }
        let mut schema = sampler.finish();
        if charge_schema(&mut schema, &req.limits.budget) {
            notices.push(notice(NoticeSeverity::Info, schema_cut()));
        }
        let count = docs.len() as u64;
        let set = DocumentSet {
            documents: docs,
            schema,
            next_cursor: cut.map(|_| cursor_token(offset + count, &fp)),
            truncated: cut.map(|r| Truncated { limit: count.min(u64::from(u32::MAX)) as u32, reason: Some(r.into()) }),
            notices,
            executed_query: Some(executed),
            distributable: true,
        };
        Ok(QueryResult::Documents { documents: set })
    }

    async fn distribution(
        &self,
        conn: &Connection,
        req: SourceQuery,
        spec: &crate::datasources::distribution::DistributionSpec,
    ) -> Result<crate::shapes::FieldDistribution, SourceError> {
        let q: Query = req.parse()?;
        pipeline::check_collection(&q.collection)?;
        let max = req.limits.max_rows.max(1) as u64;
        let base = plan(&req, &q, max)?.into_stages();
        let summary_stages = distribution::summary_stages(spec);
        pipeline::check_built(&summary_stages)?;
        // Everything is checked before Kalzit connects.
        let shared = shared(conn).await?;
        let timeout = req.limits.timeout;
        let started = std::time::Instant::now();
        let coll = shared.client.database(&shared.database).collection::<Document>(&q.collection);
        // Both aggregations share the query's time limit.
        let run = |appended: Vec<Document>| {
            let mut stages = base.clone();
            stages.extend(appended);
            let left = timeout.saturating_sub(started.elapsed()).max(Duration::from_millis(1));
            let coll = coll.clone();
            let shared = shared.clone();
            async move {
                shared.guard()?;
                let mark = shared.relay.mark();
                let fail = |e: mongodb::error::Error| shared.fail(&e, mark, timeout);
                // Grouping a path with many distinct values may need more than the 100 MB a stage
                // holds in memory; the server spills to disk then instead of failing.
                let cursor = coll.aggregate(stages).max_time(left).allow_disk_use(true).await.map_err(fail)?;
                let rows: Vec<Document> = cursor.try_collect().await.map_err(fail)?;
                Ok::<_, SourceError>(rows)
            }
        };
        let answer = run(summary_stages).await?;
        let (mut out, range) =
            distribution::read_summary(answer.first().unwrap_or(&Document::new()), &req.limits.budget);
        if let Some(range) = range {
            let rows = if range.lo < range.hi {
                let stages = distribution::histogram_stages(spec, range.scale, range.lo, range.hi);
                pipeline::check_built(&stages)?;
                run(stages).await?
            } else {
                Vec::new()
            };
            out.bins = distribution::bins(range, spec.bins, &rows);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hosts_are_parsed_and_checked() {
        let s = |hosts: &str| Settings {
            hosts: hosts.into(),
            port: Some(27018),
            srv: None,
            replica_set: None,
            database: "shop".into(),
            user: None,
            auth_source: None,
            tls: None,
            ca_cert: None,
            max_response_bytes: None,
        };
        assert_eq!(
            parse_hosts(&s("a.intern, b.intern:27020,[::1]:1,10.0.0.5")).unwrap(),
            [("a.intern".into(), 27018), ("b.intern".into(), 27020), ("::1".into(), 1), ("10.0.0.5".into(), 27018)]
        );
        assert_eq!(parse_hosts(&s("u:p@h")).unwrap_err().detail.reason, "settings.port_invalid");
        assert_eq!(parse_hosts(&s("u@h")).unwrap_err().detail.reason, "settings.host_credentials");
        assert_eq!(parse_hosts(&s("h:0")).unwrap_err().detail.reason, "settings.port_invalid");
        assert_eq!(parse_hosts(&s("h/x")).unwrap_err().detail.reason, "settings.host_invalid");
        assert_eq!(parse_hosts(&s(" , ")).unwrap_err().detail.reason, "settings.required");
        assert_eq!(host_names("a:1, [::1]:2"), ["a", "::1"]);
    }

    #[test]
    fn settings_are_checked() {
        let kind = kind();
        let base = json!({ "hosts": "db.intern", "database": "shop" });
        assert!(kind.validate_settings(&base).is_ok());
        let bad = |extra: Value| {
            let mut v = base.clone();
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            kind.validate_settings(&v).unwrap_err()
        };
        let e = bad(json!({ "srv": true, "hosts": "a.example.com,b.example.com" }));
        assert_eq!((e.field, e.detail.reason), ("hosts", "mongodb.srv_host"));
        assert_eq!(
            bad(json!({ "srv": true, "hosts": "cluster0.example.com:27017" })).detail.reason,
            "mongodb.srv_host"
        );
        assert_eq!(bad(json!({ "srv": true, "hosts": "10.0.0.1" })).detail.reason, "mongodb.srv_host");
        assert!(
            kind.validate_settings(&json!({ "hosts": "cluster0.example.com", "srv": true, "database": "shop" }))
                .is_ok()
        );
        assert_eq!(bad(json!({ "database": "a.b" })).detail.reason, "mongodb.database_invalid");
        assert_eq!(bad(json!({ "database": "" })).field, "database");
        let pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
        assert_eq!(bad(json!({ "caCert": pem })).detail.reason, "mongodb.ca_without_tls");
        assert!(kind.validate_settings(&json!({ "hosts": "h", "database": "d", "tls": true, "caCert": pem })).is_ok());
        assert_eq!(bad(json!({ "maxResponseBytes": 0 })).field, "maxResponseBytes");
        assert_eq!(bad(json!({ "password": "x" })).detail.reason, "settings.secret_in_settings");
        let targets: Vec<&str> = kind.all_settings().filter(|f| f.target).map(|f| f.name).collect();
        assert_eq!(targets, ["hosts", "port", "srv", "replicaSet", "database", "user", "authSource", "tls", "caCert"]);
    }

    #[test]
    fn privileges_must_be_reported_and_only_reading() {
        let read = doc! { "resource": { "db": "shop", "collection": "" }, "actions": ["find", "listCollections"] };
        let status = |users: Vec<Document>, privileges: Vec<Document>| {
            doc! { "authInfo": { "authenticatedUsers": users, "authenticatedUserRoles": [], "authenticatedUserPrivileges": privileges }, "ok": 1 }
        };
        let user = doc! { "user": "leser", "db": "shop" };
        assert!(privileges_verdict(&status(vec![user.clone()], vec![read.clone()]), true, "shop").is_ok());
        let reason = |r: Result<(), SourceError>| r.unwrap_err().detail().reason;
        // A login the server does not name, or names without privileges, proves nothing.
        assert_eq!(
            reason(privileges_verdict(&status(vec![], vec![read.clone()]), true, "shop")),
            "mongodb.privileges_unknown"
        );
        assert_eq!(
            reason(privileges_verdict(&status(vec![user.clone()], vec![]), true, "shop")),
            "mongodb.privileges_unknown"
        );
        assert_eq!(reason(privileges_verdict(&doc! { "ok": 1 }, true, "shop")), "mongodb.privileges_unknown");
        // Without a login, an empty answer is what a server with access control gives.
        assert!(privileges_verdict(&status(vec![], vec![]), false, "shop").is_ok());
        // What MongoDB 8.0's read role grants: planCacheRead on its database, any collection.
        for collection in ["", "system.js", "orders"] {
            let plan = doc! { "resource": { "db": "shop", "collection": collection }, "actions": ["planCacheRead", "performRawDataOperations"] };
            assert!(
                privileges_verdict(&status(vec![user.clone()], vec![read.clone(), plan]), true, "shop").is_ok(),
                "{collection:?}"
            );
        }
        // On another database or the cluster it is refused.
        for resource in
            [doc! { "db": "andere", "collection": "" }, doc! { "db": "", "collection": "" }, doc! { "cluster": true }]
        {
            for action in ["planCacheRead", "performRawDataOperations"] {
                let plan = doc! { "resource": resource.clone(), "actions": [action] };
                assert_eq!(
                    reason(privileges_verdict(&status(vec![user.clone()], vec![read.clone(), plan]), true, "shop")),
                    "mongodb.login_not_read_only",
                    "{action} on {resource}"
                );
            }
            let plan = doc! { "resource": resource.clone(), "actions": ["planCacheRead"] };
            assert_eq!(
                reason(privileges_verdict(&status(vec![user.clone()], vec![read.clone(), plan]), true, "shop")),
                "mongodb.login_not_read_only",
                "{resource}"
            );
        }
    }

    #[test]
    fn server_databases_are_refused() {
        let kind = kind();
        for db in ["admin", "local", "config"] {
            let e = kind.validate_settings(&json!({ "hosts": "h", "database": db })).unwrap_err();
            assert_eq!((e.field, e.detail.reason), ("database", "mongodb.database_reserved"), "{db}");
        }
    }

    #[test]
    fn cursors_belong_to_their_query() {
        let token = cursor_token(200, "abcd");
        assert_eq!(cursor_offset(Some(&token), "abcd").unwrap(), 200);
        assert_eq!(cursor_offset(None, "abcd").unwrap(), 0);
        for bad in [token.as_str(), "nein", "", "MjAwOg"] {
            assert_eq!(
                cursor_offset(Some(bad), "efgh").unwrap_err().detail().reason,
                "mongodb.cursor_invalid",
                "{bad}"
            );
        }
    }

    #[test]
    fn change_streams_narrow_inserts_where_the_filter_allows() {
        let find = |filter: Document| {
            Plan::Find(Box::new(FindPlan { filter, projection: None, sort: None, limit: None, skip: 0 }))
        };
        let stages =
            change_pipeline(&find(doc! { "land": "AT", "$or": [{ "n": { "$gt": 1 } }, { "x": null }] })).unwrap();
        assert_eq!(
            stages[0],
            doc! { "$match": { "$or": [
                { "operationType": { "$ne": "insert" } },
                { "$and": [{ "operationType": "insert" }, {
                    "fullDocument.land": "AT",
                    "$or": [{ "fullDocument.n": { "$gt": 1 } }, { "fullDocument.x": null }]
                }] },
            ] } }
        );
        assert_eq!(stages[1], doc! { "$project": { "operationType": 1, "ns": 1 } });
        // No filter, or one that cannot apply to the event: every change counts.
        assert_eq!(change_pipeline(&find(Document::new())).unwrap().len(), 1);
        assert_eq!(change_pipeline(&find(doc! { "$expr": { "$gt": ["$a", "$b"] } })).unwrap().len(), 1);
        // A pipeline: its leading $match; one reading other collections is not watched.
        let aggregate = Plan::Aggregate(vec![doc! { "$match": { "land": "AT" } }, doc! { "$sort": { "n": 1 } }]);
        assert!(format!("{:?}", change_pipeline(&aggregate).unwrap()[0]).contains("fullDocument.land"));
        let lookup = Plan::Aggregate(vec![doc! { "$facet": { "a": [{ "$lookup": { "from": "k", "as": "k" } }] } }]);
        assert!(change_pipeline(&lookup).is_none());
    }

    #[test]
    fn the_executed_query_keeps_the_key_order() {
        let d = doc! { "$sort": { "z": -1_i32, "a": 1_i32 }, "n": 5_i64 };
        assert_eq!(ext_json_doc(&d), r#"{"$sort": {"z": -1, "a": 1}, "n": 5}"#);
    }
}
