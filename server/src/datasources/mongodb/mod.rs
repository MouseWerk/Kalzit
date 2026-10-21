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
pub mod documents;
pub mod pipeline;
pub mod relay;
#[cfg(test)]
mod test_server;

use std::sync::Arc;
use std::time::Duration;

use bson::{Bson, Document, RawDocumentBuf, doc};
use futures_util::TryStreamExt;
use mongodb::options::{ClientOptions, Credential, SelectionCriteria, ServerAddress, Socks5Proxy, Tls, TlsOptions};
use mongodb::{Client, ServerInfo, ServerType};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;

use super::frame::json_size;
use super::{
    Connection, DataSourcePlugin, DefaultValue, Detail, FieldError, Health, Kind, SettingField, SettingType,
    SourceError, SourceQuery, SourceSchema,
};
use crate::shapes::{DocumentSet, FieldSchema, Notice, NoticeSeverity, QueryResult, Shape, Truncated};
use documents::{Converter, SchemaSampler};
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
/// Documents of a result that the schema sample reads.
const RESULT_SAMPLE: usize = 1_000;
/// Paths named in `documents.binary_hidden` notices.
const MAX_BINARY_NOTICES: usize = 20;
/// The schema route: collections listed, sampled (with indexes), documents sampled per
/// collection and the time limit per sample.
const MAX_COLLECTIONS: usize = 1_000;
const MAX_SAMPLED_COLLECTIONS: usize = 100;
const SCHEMA_SAMPLE: i64 = 100;
const SCHEMA_SAMPLE_TIME: Duration = Duration::from_secs(2);

/// Privileges a login may hold: those of the built-in `read` and `readAnyDatabase` roles.
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
    "planCacheRead",
];

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
    Ok(())
}

pub struct MongoDb;

/// A built client with the relay its connections run through.
struct Shared {
    client: Client,
    relay: Relay,
    database: String,
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

/// Maps a driver error; connection failures caused by a refused target answer that refusal.
fn failed(e: &mongodb::error::Error, relay: Option<&Relay>, timeout: Duration) -> SourceError {
    use mongodb::error::ErrorKind;
    let connecting = matches!(
        *e.kind,
        ErrorKind::ServerSelection { .. }
            | ErrorKind::Io(_)
            | ErrorKind::ProxyConnect { .. }
            | ErrorKind::ConnectionPoolCleared { .. }
    );
    if connecting && let Some(refusal) = relay.and_then(Relay::refusal) {
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
    let mut options = if s.srv() {
        let (host, _) = &hosts[0];
        // The driver reads the SRV and TXT records; every host they name passes the relay. The
        // check here only answers a refused host early and clearly.
        let options = ClientOptions::parse(format!("mongodb+srv://{host}/"))
            .await
            .map_err(|e| failed(&e, Some(&relay), selection_timeout))?;
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
    options.selection_criteria = Some(selection(direct));
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
    let client = Client::with_options(options).map_err(|e| failed(&e, Some(&relay), selection_timeout))?;
    // The driver has read the certificate into its TLS configuration.
    drop(ca);
    let shared = Shared { client, relay, database: s.database.clone() };
    check_read_only(&shared, selection_timeout).await?;
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

/// Refuses a login that may do more than read, and a server without access control (where any
/// login may write).
async fn check_read_only(shared: &Shared, timeout: Duration) -> Result<(), SourceError> {
    let admin = shared.client.database("admin");
    let status = admin
        .run_command(doc! { "connectionStatus": 1, "showPrivileges": true })
        .await
        .map_err(|e| failed(&e, Some(&shared.relay), timeout))?;
    let privileges = status
        .get_document("authInfo")
        .ok()
        .and_then(|a| a.get_array("authenticatedUserPrivileges").ok())
        .cloned()
        .unwrap_or_default();
    for p in &privileges {
        let Bson::Document(p) = p else { continue };
        let actions = p.get_array("actions").map(|a| a.as_slice()).unwrap_or_default();
        for action in actions {
            let action = action.as_str().unwrap_or("?");
            if !READ_ACTIONS.contains(&action) {
                let resource = resource_text(p.get_document("resource").ok());
                return Err(SourceError::failed(
                    "mongodb.login_not_read_only",
                    format!("the login may {action} on {resource}; use a login with only the read role"),
                )
                .with("action", action)
                .with("resource", resource));
            }
        }
    }
    // hostInfo needs a privilege no reading role holds; a server that runs it anyway does not
    // check privileges at all.
    match admin.run_command(doc! { "hostInfo": 1 }).await {
        Ok(_) => Err(SourceError::failed(
            "mongodb.access_control_off",
            "the server does not check access rights, so any login may write; enable access control and use a login with only the read role",
        )),
        Err(e) if matches!(*e.kind, mongodb::error::ErrorKind::Command(_)) => Ok(()),
        Err(e) => Err(failed(&e, Some(&shared.relay), timeout)),
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
    Find { filter: Document, projection: Option<Document>, sort: Option<Document>, limit: Option<u64>, skip: u64 },
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
    let params = (!detail.params.is_empty()).then_some(detail.params);
    Notice { severity, code: detail.reason.to_string(), params, text: detail.message }
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
    db: &mongodb::Database,
    name: String,
    collection_type: &'static str,
    sample: bool,
) -> CollectionSchema {
    let mut schema = CollectionSchema { name, collection_type, indexes: Vec::new(), fields: Vec::new(), sampled: 0 };
    if !sample {
        return schema;
    }
    let coll = db.collection::<Document>(&schema.name);
    if collection_type != "view"
        && let Ok(mut cursor) = coll.list_indexes().await
    {
        while let Ok(Some(index)) = cursor.try_next().await {
            let mut converter = Converter::default();
            let keys = index
                .keys
                .iter()
                .map(|(field, kind)| IndexKey { field: field.clone(), kind: converter.value_at(kind, field) })
                .collect();
            let options = index.options.as_ref();
            schema.indexes.push(IndexSchema {
                name: options.and_then(|o| o.name.clone()).unwrap_or_default(),
                keys,
                unique: options.and_then(|o| o.unique).unwrap_or(false),
            });
        }
    }
    let sampled = async {
        let mut cursor =
            coll.aggregate([doc! { "$sample": { "size": SCHEMA_SAMPLE } }]).max_time(SCHEMA_SAMPLE_TIME).await?;
        let mut sampler = SchemaSampler::default();
        let mut n = 0u32;
        while let Some(d) = cursor.try_next().await? {
            sampler.add(&d);
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

    fn checks_on_save(&self) -> bool {
        true
    }

    async fn check_on_save(&self, conn: &Connection) -> Result<(), (&'static str, SourceError)> {
        match build(conn, SAVE_SELECTION_TIMEOUT).await {
            Ok(_) => Ok(()),
            Err(e @ SourceError::Blocked(_)) => Err(("hosts", e)),
            Err(e) if matches!(e.detail().reason, "mongodb.login_not_read_only" | "mongodb.access_control_off") => {
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
            let info = shared
                .client
                .database("admin")
                .run_command(doc! { "buildInfo": 1 })
                .await
                .map_err(|e| failed(&e, Some(&shared.relay), SERVER_SELECTION_TIMEOUT))?;
            let version = info.get_str("version").unwrap_or("").to_string();
            // The login must be able to read the database, not only to connect.
            shared
                .client
                .database(&shared.database)
                .list_collection_names()
                .await
                .map_err(|e| failed(&e, Some(&shared.relay), SERVER_SELECTION_TIMEOUT))?;
            Ok::<_, SourceError>(version)
        };
        match check.await {
            Ok(version) => Health::connected("MongoDB", &version, false),
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let shared = shared(conn).await?;
        let db = shared.client.database(&shared.database);
        let mut specs =
            db.list_collections().await.map_err(|e| failed(&e, Some(&shared.relay), SERVER_SELECTION_TIMEOUT))?;
        let mut list: Vec<(String, &'static str)> = Vec::new();
        while let Some(spec) =
            specs.try_next().await.map_err(|e| failed(&e, Some(&shared.relay), SERVER_SELECTION_TIMEOUT))?
        {
            if spec.name.starts_with("system.") {
                continue;
            }
            let t = match spec.collection_type {
                mongodb::results::CollectionType::View => "view",
                mongodb::results::CollectionType::Timeseries => "timeseries",
                _ => "collection",
            };
            list.push((spec.name, t));
            if list.len() >= MAX_COLLECTIONS {
                break;
            }
        }
        list.sort();
        // Four at a time, in name order.
        let mut collections = Vec::with_capacity(list.len());
        for (chunk_index, chunk) in list.chunks(4).enumerate() {
            let runs = chunk.iter().enumerate().map(|(i, (name, t))| {
                collection_schema(&db, name.clone(), t, chunk_index * 4 + i < MAX_SAMPLED_COLLECTIONS)
            });
            collections.extend(futures_util::future::join_all(runs).await);
        }
        Ok(SourceSchema::Collections { database: shared.database.clone(), collections })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let q: Query = req.parse()?;
        pipeline::check_collection(&q.collection)?;
        let binder = Binder { range: req.range, interval_ms: req.interval_ms, variables: &req.variables };
        let fp = fingerprint(&req);
        let offset = cursor_offset(req.cursor.as_deref(), &fp)?;
        let max = req.limits.max_rows.max(1) as u64;
        let plan = match &q.pipeline {
            Some(text) => {
                if q.filter.is_some()
                    || q.projection.is_some()
                    || q.sort.is_some()
                    || q.limit.is_some()
                    || q.skip.is_some()
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
                Plan::Find {
                    filter: binder.query_document(filter)?,
                    projection: projection.map(|p| binder.projection(p)).transpose()?,
                    sort: sort.map(|s| binder.query_document(s)).transpose()?,
                    limit: q.limit,
                    skip: q.skip.unwrap_or(0),
                }
            }
        };
        // Everything is checked before Kalzit connects.
        let s: Settings = conn.settings_as()?;
        let shared = shared(conn).await?;
        let timeout = req.limits.timeout;
        let coll = shared.client.database(&shared.database).collection::<RawDocumentBuf>(&q.collection);
        let fail = |e: mongodb::error::Error| failed(&e, Some(&shared.relay), timeout);
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
                let cursor = coll
                    .aggregate(stages)
                    .max_time(timeout)
                    .batch_size(batch)
                    .with_type::<RawDocumentBuf>()
                    .await
                    .map_err(fail)?;
                (executed, cursor)
            }
            Plan::Find { filter, projection, sort, limit, skip } => {
                if limit.is_some_and(|l| offset >= l) {
                    // Past the query's own limit: an empty page.
                    let set = DocumentSet { documents: Vec::new(), schema: Vec::new(), ..Default::default() };
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
                (executed, find.await.map_err(fail)?)
            }
        };
        let own_limit = s.max_response_bytes.map(|b| b as usize);
        let mut converter = Converter::default();
        let mut sampler = SchemaSampler::default();
        let mut docs = Vec::new();
        let mut notices = Vec::new();
        let mut bytes = 0usize;
        let mut cut = false;
        while let Some(raw) = cursor.try_next().await.map_err(fail)? {
            if docs.len() as u64 >= max {
                cut = true;
                let message = format!("only the first {max} documents are shown (document limit)");
                notices
                    .push(notice(NoticeSeverity::Warning, Detail::new("documents.limit", message).with("limit", max)));
                break;
            }
            let doc = Document::try_from(raw.as_ref())
                .map_err(|e| SourceError::from_source(format!("a document cannot be read: {e}")))?;
            let value = converter.document(&doc);
            let size = json_size(&value) + 1;
            if own_limit.is_some_and(|l| bytes + size > l) || !req.limits.budget.take(size) {
                cut = true;
                let detail = Detail::new("documents.size_limit", "the result was cut off at the response size limit");
                notices.push(notice(NoticeSeverity::Warning, detail));
                break;
            }
            bytes += size;
            if docs.len() < RESULT_SAMPLE {
                sampler.add(&doc);
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
        let count = docs.len() as u64;
        let set = DocumentSet {
            documents: docs,
            schema: sampler.finish(),
            next_cursor: cut.then(|| cursor_token(offset + count, &fp)),
            truncated: cut.then_some(Truncated { limit: count.min(u64::from(u32::MAX)) as u32 }),
            notices,
            executed_query: Some(executed),
        };
        Ok(QueryResult::Documents { documents: set })
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
    fn the_executed_query_keeps_the_key_order() {
        let d = doc! { "$sort": { "z": -1_i32, "a": 1_i32 }, "n": 5_i64 };
        assert_eq!(ext_json_doc(&d), r#"{"$sort": {"z": -1, "a": 1}, "n": 5}"#);
    }
}
