//! Several Kalzit servers on one PostgreSQL database, behind a load balancer (docs/ARCHITECTURE.md,
//! "Several servers on one database"; docs/operations/high-availability.md).
//!
//! - **Identity and heartbeat.** Every server process gets a new id at start and keeps its row in
//!   `cluster_instances` fresh (`Options::heartbeat`); a clean stop marks it stopped. One server
//!   per host and data directory (`db::InstanceLock`), so an earlier row of the same host and
//!   directory is this server's own earlier run.
//! - **Leader.** One server leads and runs the jobs that must run once (retention cleanups, the
//!   plugin catalog refresh, certificate orders, the daily update check). The leader holds a lease
//!   row (`cluster_leader`) that it renews with every heartbeat; once the lease has passed in the
//!   database's clock, any other server takes it over with a new term. A lease and not an
//!   advisory lock: an advisory lock belongs to one connection, so it breaks behind a
//!   transaction-mode connection pooler (PgBouncer), and a half-open connection keeps it held
//!   while its server can no longer tell that it leads. With the lease the leader knows how long
//!   it leads: it stops counting itself the leader one heartbeat before its lease could pass,
//!   measured from before the renewal was sent, so two servers never both believe they lead.
//! - **Run once.** On top of the leader, each such job claims its run in `cluster_jobs`
//!   (`leader_claim`, `spawn_job`): only while the claiming server holds a valid lease in the
//!   database (checked in the same statement, so a server that paused does not act on an old
//!   belief), and only when the last finished run is an interval old.
//! - **Changes.** What servers keep in memory and another server can change is announced as a row
//!   in `cluster_events` plus a PostgreSQL `NOTIFY`. Where the change has a transaction, the row is
//!   written in it (`record`): it exists exactly when the change does. Changes made after a commit
//!   are written before the request answers (`announce`) or, from synchronous code, through a
//!   queue the stop flushes (`publish`). Every server reads new rows when notified and at least
//!   every `Options::poll`, and compares cheap fingerprints of the shared tables at the same time
//!   (`Reconciler`), so a change whose announcement was lost is still taken within one poll.
//!
//! SQLite serves one server (`db::InstanceLock`): there the server registers itself, leads alone
//! and announces nothing.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde::Serialize;
use sqlx::AnyPool;
use tokio::sync::Notify;

use crate::app::AppState;
use crate::db::{JobError, Schedule};

/// The NOTIFY channel; the payload is empty, the rows in `cluster_events` are what counts.
pub const CHANNEL: &str = "kalzit_cluster";
/// How long announced changes are kept.
const EVENT_KEEP_MS: i64 = 60 * 60 * 1000;
/// How far back each read of the events looks behind the newest one it saw: an event written in
/// a transaction that commits later than others may become visible after them.
const LOOKBACK_MS: i64 = 30_000;
/// How long rows of stopped or silent servers stay in `cluster_instances`.
const INSTANCE_KEEP_MS: i64 = 24 * 60 * 60 * 1000;
/// How often the leader removes old events, rows of servers long gone and unused packages.
const MAINTENANCE_EVERY: Duration = Duration::from_secs(60);
/// The heartbeat on SQLite, where nothing depends on it but the instance view.
const SQLITE_HEARTBEAT: Duration = Duration::from_secs(30);
/// The events are read this often while the NOTIFY connection is down.
const POLL_WITHOUT_NOTIFY: Duration = Duration::from_secs(1);
/// A failed plugin sync is tried again after this, doubling up to `SYNC_RETRY_MAX`.
const SYNC_RETRY_FIRST: Duration = Duration::from_secs(5);
const SYNC_RETRY_MAX: Duration = Duration::from_secs(300);

/// The database's clock in milliseconds since 1970.
const PG_NOW: &str = "CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)";
const SQLITE_NOW: &str = "CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER)";

/// A change other servers apply to what they keep in memory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    /// Server settings (`None`) or one organization's settings were written.
    Settings(Option<String>),
    /// Rights changed in one organization (`None`: on the whole server): a new query cache
    /// generation.
    Rights(Option<String>),
    /// The query cache was emptied.
    CacheCleared,
    /// A data source changed, went to the trash or was purged.
    Datasource(String),
    /// Plugins were installed, approved, switched, removed or blocked, or keys changed.
    Plugins,
    /// The ACME settings or the certificate changed.
    Acme,
    /// The challenge answers of a running certificate order changed.
    AcmeChallenges,
    /// An administrator asked for a certificate now; the leader orders it.
    AcmeRenew,
    /// The first-run setup is done: the setup gates close.
    SetupDone,
}

impl Change {
    fn encode(&self) -> (&'static str, String) {
        let scope = |s: &Option<String>| s.clone().unwrap_or_default();
        match self {
            Self::Settings(org) => ("settings", scope(org)),
            Self::Rights(org) => ("cache:rights", scope(org)),
            Self::CacheCleared => ("cache:clear", String::new()),
            Self::Datasource(id) => ("datasource", id.clone()),
            Self::Plugins => ("plugins", String::new()),
            Self::Acme => ("acme", String::new()),
            Self::AcmeChallenges => ("acme:challenges", String::new()),
            Self::AcmeRenew => ("acme:renew", String::new()),
            Self::SetupDone => ("setup", String::new()),
        }
    }

    fn decode(kind: &str, scope: String) -> Option<Self> {
        let org = (!scope.is_empty()).then(|| scope.clone());
        Some(match kind {
            "settings" => Self::Settings(org),
            "cache:rights" => Self::Rights(org),
            "cache:clear" => Self::CacheCleared,
            "datasource" if !scope.is_empty() => Self::Datasource(scope),
            "plugins" => Self::Plugins,
            "acme" => Self::Acme,
            "acme:challenges" => Self::AcmeChallenges,
            "acme:renew" => Self::AcmeRenew,
            "setup" => Self::SetupDone,
            _ => return None,
        })
    }
}

/// Hands a change to the cluster, which writes it for the other servers.
pub type Publisher = Arc<dyn Fn(Change) + Send + Sync>;

/// The timings; tests make them short.
#[derive(Clone, Debug)]
pub struct Options {
    /// How often a server writes its heartbeat and the leader renews its lease.
    pub heartbeat: Duration,
    /// How long a lease lasts without renewal: the longest a crashed leader's jobs wait.
    pub lease: Duration,
    /// How often the events and fingerprints are read without a notification.
    pub poll: Duration,
    /// How often a run-once job looks whether its run is due.
    pub job_check: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            heartbeat: Duration::from_secs(5),
            lease: Duration::from_secs(15),
            poll: Duration::from_secs(5),
            job_check: Duration::from_secs(30),
        }
    }
}

/// One plugin sync at a time, again when asked during one, and after a failure with a pause.
#[derive(Default)]
struct PluginSync {
    running: AtomicBool,
    again: AtomicBool,
    /// When a failed sync is tried again, and the pause after the next failure.
    retry: Mutex<Option<(Instant, Duration)>>,
}

/// This server's place among the servers on its database. One per `AppState`.
pub struct Cluster {
    id: String,
    host: String,
    options: RwLock<Options>,
    /// The loops run (`start`); before, and for tests that never start them, this server runs
    /// alone and leads.
    started: AtomicBool,
    /// PostgreSQL: other servers may share the database, so the lease and the events count.
    coordinated: AtomicBool,
    /// Until when this server counts itself the leader (coordinated only).
    leader_until: Mutex<Option<Instant>>,
    /// The term of the lease this server holds, 0 when it holds none.
    term: AtomicI64,
    /// Other servers run on the database now.
    has_peers: AtomicBool,
    /// `has_peers` was counted at least once.
    peers_known: AtomicBool,
    /// The NOTIFY connection is up.
    listening: AtomicBool,
    /// Changes waiting to be written (`publish`), flushed by `stop`.
    pending: Mutex<Vec<Change>>,
    pending_ready: Notify,
    /// Wakes the reader of the events (a notification arrived).
    wake: Notify,
    /// Set by `stop`: nothing is written any more.
    stopped: AtomicBool,
    plugin_sync: PluginSync,
    /// The node id (`node_id`), set by `boot`.
    node: Mutex<String>,
    /// The database's time when this run registered (`start`).
    started_ms: AtomicI64,
    /// The database's time and the shared state's counters when this server began to load what
    /// it keeps (`boot`): the reader replays the events from then, and the reconciler compares
    /// against these counters first, so nothing changed during the start is missed.
    boot: Mutex<Option<Snapshot>>,
}

/// The shared state's counters at one moment (`cluster_versions`, and the data sources).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Snapshot {
    at_ms: i64,
    versions: std::collections::BTreeMap<String, i64>,
    /// Count, newest `updated_at`, count in the trash, newest `deleted_at`: the data sources
    /// change without an announcement in their own transaction, so they are compared this way.
    sources: (i64, i64, i64, i64),
    /// Each data source's `updated_at` and `deleted_at`, to forget exactly the changed ones.
    source_rows: HashMap<String, (i64, Option<i64>)>,
}

impl Snapshot {
    async fn read(db: &AnyPool) -> Result<Self, sqlx::Error> {
        let at_ms = db_now(db, true).await?;
        let versions: Vec<(String, i64)> =
            sqlx::query_as("SELECT area, version FROM cluster_versions").fetch_all(db).await?;
        let sources: (i64, i64, i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), COALESCE(MAX(updated_at), 0), COUNT(deleted_at), COALESCE(MAX(deleted_at), 0) \
             FROM datasources",
        )
        .fetch_one(db)
        .await?;
        Ok(Self { at_ms, versions: versions.into_iter().collect(), sources, source_rows: HashMap::new() })
    }

    async fn read_source_rows(&mut self, db: &AnyPool) -> Result<(), sqlx::Error> {
        let rows: Vec<(String, i64, Option<i64>)> =
            sqlx::query_as("SELECT id, updated_at, deleted_at FROM datasources").fetch_all(db).await?;
        self.source_rows = rows.into_iter().map(|(id, u, d)| (id, (u, d))).collect();
        Ok(())
    }
}

/// Takes the moment before a server on PostgreSQL loads what it keeps in memory (plugins, the
/// certificate, settings): `AppState::new` calls it first, and `start` replays and compares from
/// it. Nothing for SQLite.
pub async fn boot(cluster: &Cluster, db: &AnyPool, url: &str, data_dir: &std::path::Path) -> Result<()> {
    // SQLite serves one server: no node id, nothing to replay.
    if !is_postgres(url) {
        return Ok(());
    }
    *cluster.node.lock().unwrap_or_else(|e| e.into_inner()) = node_id(data_dir)?;
    let mut snapshot = Snapshot::read(db).await?;
    snapshot.read_source_rows(db).await?;
    *cluster.boot.lock().unwrap_or_else(|e| e.into_inner()) = Some(snapshot);
    Ok(())
}

/// One server in the instance view (`GET /api/admin/instances`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceView {
    pub id: String,
    pub host: String,
    pub version: String,
    pub address: String,
    pub started_at: i64,
    pub heartbeat_at: i64,
    pub stopped_at: Option<i64>,
    /// Its heartbeat is recent and it did not stop.
    pub alive: bool,
    pub leader: bool,
    /// The server that answered this request.
    pub current: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterView {
    /// `single` (SQLite, or PostgreSQL with no other server running) or `cluster`.
    pub mode: &'static str,
    /// `sqlite` or `postgres`.
    pub database: &'static str,
    /// Changes reach this server by NOTIFY (`notify`) or only by polling (`poll`); `none` on
    /// SQLite.
    pub transport: &'static str,
    pub leader_since: Option<i64>,
    pub leader_term: i64,
    /// Seconds between heartbeats and of a lease, for the page's text.
    pub heartbeat_secs: u64,
    pub lease_secs: u64,
    pub instances: Vec<InstanceView>,
}

fn now_sql(postgres: bool) -> &'static str {
    if postgres { PG_NOW } else { SQLITE_NOW }
}

fn is_postgres(url: &str) -> bool {
    !url.starts_with("sqlite:")
}

/// The database's time in milliseconds.
async fn db_now(db: &AnyPool, postgres: bool) -> Result<i64, sqlx::Error> {
    let (now,): (i64,) =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {}", now_sql(postgres)))).fetch_one(db).await?;
    Ok(now)
}

/// The machine's name, for the instance view.
fn host_name() -> String {
    let from_env = ["COMPUTERNAME", "HOSTNAME"].iter().find_map(|v| std::env::var(v).ok());
    let from_file = || {
        ["/proc/sys/kernel/hostname", "/etc/hostname"]
            .iter()
            .find_map(|f| std::fs::read_to_string(f).ok())
            .map(|s| s.trim().to_string())
    };
    from_env
        .or_else(from_file)
        .map(|s| s.chars().filter(|c| !c.is_control()).take(253).collect::<String>())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

/// The file in the data directory that holds this server's node id.
pub const NODE_ID_FILE: &str = "kalzit-node-id";

/// This server's node id: a random id made once and kept in the data directory, the same for
/// every run of the server and independent of its host name or path. Rows of the same node id are
/// this server's earlier runs (`check_peers`). A copied data directory carries the id along; such a
/// copy is still counted as a peer while it keeps writing heartbeats after this start.
pub fn node_id(data_dir: &std::path::Path) -> Result<String> {
    let file = data_dir.join(NODE_ID_FILE);
    match std::fs::read_to_string(&file) {
        Ok(text) => {
            let id = text.trim();
            if uuid::Uuid::parse_str(id).is_ok() {
                return Ok(id.to_string());
            }
            tracing::warn!("{} does not hold a node id; making a new one", file.display());
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(anyhow::Error::new(e).context(format!("reading {}", file.display()))),
    }
    let id = uuid::Uuid::new_v4().to_string();
    let temp = data_dir.join(format!("{NODE_ID_FILE}.tmp"));
    std::fs::write(&temp, format!("{id}\n"))
        .and_then(|()| std::fs::rename(&temp, &file))
        .map_err(|e| anyhow::Error::new(e).context(format!("writing {}", file.display())))?;
    Ok(id)
}

/// The counter in `cluster_versions` a change raises (`record`).
fn area(change: &Change) -> &'static str {
    match change {
        Change::Settings(_) => "settings",
        Change::Rights(_) => "rights",
        Change::CacheCleared => "cache",
        Change::Datasource(_) => "datasources",
        Change::Plugins => "plugins",
        Change::Acme | Change::AcmeRenew => "acme",
        Change::AcmeChallenges => "challenges",
        Change::SetupDone => "setup",
    }
}

fn millis(d: Duration) -> i64 {
    i64::try_from(d.as_millis()).unwrap_or(i64::MAX)
}

/// Writes `change` for the other servers inside the caller's transaction, so the announcement
/// exists exactly when the change does; the NOTIFY is sent by PostgreSQL at the commit. Nothing
/// on SQLite, which serves one server. `origin` is the writing server's id (`Cluster::id`), or
/// empty where it is not at hand: then that server applies its own change once more, which is
/// harmless.
pub async fn record(conn: &mut sqlx::AnyConnection, origin: &str, change: &Change) -> Result<(), sqlx::Error> {
    if conn.backend_name() != "PostgreSQL" {
        return Ok(());
    }
    let (kind, scope) = change.encode();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO cluster_events (id, origin, kind, scope, created_at) VALUES ($1, $2, $3, $4, {PG_NOW})"
    )))
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(origin)
    .bind(kind)
    .bind(scope)
    .execute(&mut *conn)
    .await?;
    // The counter the other servers compare at every poll (`Reconciler`), so a missed row is
    // still noticed.
    sqlx::query("UPDATE cluster_versions SET version = version + 1 WHERE area = $1")
        .bind(area(change))
        .execute(&mut *conn)
        .await?;
    sqlx::query("SELECT pg_notify($1, '')").bind(CHANNEL).execute(&mut *conn).await?;
    Ok(())
}

impl Default for Cluster {
    fn default() -> Self {
        Self::new()
    }
}

impl Cluster {
    pub fn new() -> Self {
        Self {
            id: uuid::Uuid::now_v7().to_string(),
            host: host_name(),
            options: RwLock::new(Options::default()),
            started: AtomicBool::new(false),
            coordinated: AtomicBool::new(false),
            leader_until: Mutex::new(None),
            term: AtomicI64::new(0),
            has_peers: AtomicBool::new(false),
            peers_known: AtomicBool::new(false),
            listening: AtomicBool::new(false),
            pending: Mutex::default(),
            pending_ready: Notify::new(),
            wake: Notify::new(),
            stopped: AtomicBool::new(false),
            plugin_sync: PluginSync::default(),
            node: Mutex::default(),
            started_ms: AtomicI64::new(0),
            boot: Mutex::default(),
        }
    }

    /// This server's id, new at every start.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The node id kept in the data directory (`node_id`); empty before `boot`.
    pub fn node(&self) -> String {
        self.node.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Changes the timings; before `start` (tests).
    pub fn set_options(&self, options: Options) {
        *self.options.write().unwrap_or_else(|e| e.into_inner()) = options;
    }

    fn options(&self) -> Options {
        self.options.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Other servers may share the database: run-once jobs claim their runs and changes are
    /// announced.
    pub fn coordinated(&self) -> bool {
        self.coordinated.load(Ordering::SeqCst)
    }

    /// Whether this server runs the jobs that must run once. A server that runs alone (SQLite,
    /// or the loops never started) always does. Each such job also claims its run in the
    /// database (`leader_claim`), which checks the lease there.
    pub fn is_leader(&self) -> bool {
        if !self.coordinated() {
            return true;
        }
        self.leader_until.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|until| Instant::now() < until)
    }

    /// Other servers run on this database now: they count for the update mode and the view.
    pub fn has_peers(&self) -> bool {
        self.has_peers.load(Ordering::SeqCst)
    }

    /// Queues a change for the other servers, for synchronous code after a commit; `stop`
    /// flushes the queue, and the fingerprints catch what a crash loses. Nothing on a server
    /// that runs alone.
    pub fn publish(&self, change: Change) {
        if !self.coordinated() || self.stopped.load(Ordering::SeqCst) {
            return;
        }
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).push(change);
        self.pending_ready.notify_one();
    }

    /// Writes a change for the other servers before the caller goes on (after a commit, before a
    /// request answers); queued when the database cannot take it now.
    pub async fn announce(&self, db: &AnyPool, change: Change) {
        if !self.coordinated() {
            return;
        }
        if let Err(e) = write_events(db, &self.id, std::slice::from_ref(&change)).await {
            tracing::debug!("announcing a change, queued instead: {e}");
            self.publish(change);
        }
    }

    fn publisher(self: &Arc<Self>) -> Publisher {
        let cluster = Arc::downgrade(self);
        Arc::new(move |change| {
            if let Some(cluster) = cluster.upgrade() {
                cluster.publish(change);
            }
        })
    }

    fn take_pending(&self) -> Vec<Change> {
        let mut pending = std::mem::take(&mut *self.pending.lock().unwrap_or_else(|e| e.into_inner()));
        pending.dedup();
        pending
    }

    fn requeue(&self, mut changes: Vec<Change>) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        changes.append(&mut pending);
        *pending = changes;
    }

    fn set_leader(&self, until: Option<Instant>, term: i64) {
        let was = self.is_leader();
        *self.leader_until.lock().unwrap_or_else(|e| e.into_inner()) = until;
        self.term.store(term, Ordering::SeqCst);
        let is = self.is_leader();
        if is && !was {
            tracing::info!(instance = %self.id, term, "this server leads now and runs the jobs that must run once");
        } else if was && !is {
            tracing::info!(instance = %self.id, "this server no longer leads");
        }
    }
}

/// The addresses this server listens on, for the instance view.
fn listen_address(state: &AppState) -> String {
    let server = &state.config.server;
    [server.https_addr.as_str(), server.http_addr.as_str()]
        .into_iter()
        .filter(|a| !a.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Marks this server's earlier runs (same node id) stopped once their heartbeat is no longer
/// fresh: they ended without signing off. A row of the same node id that still writes heartbeats
/// (a copied data directory running elsewhere) is left alone.
async fn mark_earlier_runs(state: &AppState, cluster: &Cluster) -> Result<(), sqlx::Error> {
    let now = db_now(&state.db, true).await?;
    sqlx::query(
        "UPDATE cluster_instances SET stopped_at = heartbeat_at \
         WHERE node_id = $1 AND id <> $2 AND stopped_at IS NULL AND heartbeat_at < $3",
    )
    .bind(cluster.node())
    .bind(&cluster.id)
    .bind(now - freshness(&cluster.options()))
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn insert_instance(state: &AppState, db: &AnyPool, now: i64) -> Result<(), sqlx::Error> {
    let cluster = &state.cluster;
    sqlx::query(
        "INSERT INTO cluster_instances (id, node_id, host, version, address, started_at, heartbeat_at, stopped_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)",
    )
    .bind(&cluster.id)
    .bind(cluster.node())
    .bind(&cluster.host)
    .bind(env!("CARGO_PKG_VERSION"))
    .bind(listen_address(state))
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

/// Registers this server and starts its heartbeat; on PostgreSQL also the leader election, the
/// announcing of changes and the reading of other servers' changes. Tries to lead once before it
/// returns, so the jobs started next know whether they run here.
pub async fn start(state: &AppState) -> Result<()> {
    let cluster = state.cluster.clone();
    let postgres = is_postgres(&state.config.database_url());
    cluster.started.store(true, Ordering::SeqCst);
    if !postgres {
        // SQLite: the registration is a background write like the heartbeat, so a start never
        // waits for the write lock (`db::Background`).
        spawn_heartbeat(state.clone(), false);
        return Ok(());
    }
    // Until the other servers are counted, the server installs no update on its own.
    state.updates.set_clustered(true);
    let db = state.db.clone();
    if cluster.node().is_empty() {
        // `AppState::new` takes the node id and the moment before loading (`boot`); a state
        // built otherwise takes them now.
        boot(&cluster, &db, &state.config.database_url(), &state.config.paths.data_dir).await?;
    }
    let now = db_now(&db, postgres).await?;
    cluster.started_ms.store(now, Ordering::SeqCst);
    insert_instance(state, &db, now).await?;
    mark_earlier_runs(state, &cluster).await?;
    cluster.coordinated.store(true, Ordering::SeqCst);
    let publisher = cluster.publisher();
    state.datasources.set_publisher(publisher);
    if let Err(e) = lead(state, &cluster).await {
        tracing::warn!("trying to lead: {e}");
    }
    check_peers(state, &cluster).await;
    spawn_heartbeat(state.clone(), true);
    spawn_writer(state.clone());
    // Replayed and compared from the moment before the start loaded anything.
    let since = cluster.boot.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map_or(now, |b| b.at_ms);
    spawn_reader(state.clone(), since);
    spawn_reconciler(state.clone());
    spawn_listener(state.clone());
    // Plugins another server installed whose packages this one has not unpacked yet.
    request_plugin_sync(state);
    tracing::info!(instance = %cluster.id, host = %cluster.host, "registered with the other servers on this database");
    Ok(())
}

/// Writes what is still queued, hands over the lease and marks this server stopped
/// (`AppState::close`). Quick: the next server takes over at its next heartbeat instead of
/// waiting for the lease to pass.
pub async fn stop(state: &AppState) {
    let cluster = &state.cluster;
    if !cluster.started.load(Ordering::SeqCst) || cluster.stopped.swap(true, Ordering::SeqCst) {
        return;
    }
    // SQLite: nothing to hand over, and the next server marks this one stopped when it starts;
    // a stop never waits for the write lock.
    if !cluster.coordinated() {
        return;
    }
    let stop = async {
        let pending = cluster.take_pending();
        if !pending.is_empty() {
            write_events(&state.db, &cluster.id, &pending).await?;
        }
        cluster.set_leader(None, 0);
        sqlx::query("UPDATE cluster_leader SET expires_at = 0 WHERE id = 'leader' AND holder = $1")
            .bind(&cluster.id)
            .execute(&state.db)
            .await?;
        let now = db_now(&state.db, true).await?;
        sqlx::query("UPDATE cluster_instances SET stopped_at = $1 WHERE id = $2")
            .bind(now)
            .bind(&cluster.id)
            .execute(&state.db)
            .await?;
        Ok::<_, sqlx::Error>(())
    };
    match tokio::time::timeout(Duration::from_secs(3), stop).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!("signing off from the other servers: {e}"),
        Err(_) => tracing::warn!("signing off from the other servers took too long; the lease runs out on its own"),
    }
}

/// Takes or renews the lease. The local belief ends one heartbeat before the lease could pass in
/// the database, counted from before the statement was sent.
async fn lead(state: &AppState, cluster: &Cluster) -> Result<(), sqlx::Error> {
    let options = cluster.options();
    let sent = Instant::now();
    let now = db_now(&state.db, true).await?;
    let expires = now + millis(options.lease);
    let taken = sqlx::query(
        "UPDATE cluster_leader SET \
             term = CASE WHEN holder = $1 THEN term ELSE term + 1 END, \
             since = CASE WHEN holder = $2 THEN since ELSE $3 END, \
             holder = $4, expires_at = $5 \
         WHERE id = 'leader' AND (holder = $6 OR holder IS NULL OR expires_at < $7)",
    )
    .bind(&cluster.id)
    .bind(&cluster.id)
    .bind(now)
    .bind(&cluster.id)
    .bind(expires)
    .bind(&cluster.id)
    .bind(now)
    .execute(&state.db)
    .await?
    .rows_affected()
        == 1;
    if !taken {
        cluster.set_leader(None, 0);
        return Ok(());
    }
    let (term,): (i64,) =
        sqlx::query_as("SELECT term FROM cluster_leader WHERE id = 'leader'").fetch_one(&state.db).await?;
    let believed = options.lease.saturating_sub(options.heartbeat);
    cluster.set_leader(Some(sent + believed), term);
    Ok(())
}

/// How young a heartbeat is for its server to count as running.
fn freshness(options: &Options) -> i64 {
    millis(options.lease).max(millis(options.heartbeat) * 3)
}

/// Whether a row is another server running now: not stopped, a fresh heartbeat, and not an
/// earlier run of this server (the same node id with no heartbeat since this run started).
fn is_peer(cluster: &Cluster, id: &str, node: &str, heartbeat_at: i64, stopped: bool, now: i64) -> bool {
    id != cluster.id
        && !stopped
        && now - heartbeat_at <= freshness(&cluster.options())
        && (node != cluster.node() || heartbeat_at > cluster.started_ms.load(Ordering::SeqCst))
}

/// Counts the other servers running now (`is_peer`) and marks this server's earlier runs
/// stopped once silent. Until a count succeeds the mode stays unknown, and no update is installed
/// on its own.
async fn check_peers(state: &AppState, cluster: &Cluster) {
    let peers = async {
        mark_earlier_runs(state, cluster).await?;
        let now = db_now(&state.db, true).await?;
        let rows: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT id, node_id, heartbeat_at FROM cluster_instances WHERE id <> $1 AND stopped_at IS NULL \
             AND heartbeat_at >= $2",
        )
        .bind(&cluster.id)
        .bind(now - freshness(&cluster.options()))
        .fetch_all(&state.db)
        .await?;
        Ok::<_, sqlx::Error>(rows.iter().any(|(id, node, at)| is_peer(cluster, id, node, *at, false, now)))
    };
    match peers.await {
        Ok(peers) => {
            let before = cluster.has_peers.swap(peers, Ordering::SeqCst);
            cluster.peers_known.store(true, Ordering::SeqCst);
            state.updates.set_clustered(peers);
            if peers && !before {
                tracing::info!("other Kalzit servers run on this database; updates are installed per server");
            }
        }
        Err(e) => {
            if !cluster.peers_known.load(Ordering::SeqCst) {
                state.updates.set_clustered(true);
            }
            tracing::debug!("counting the other servers: {e}");
        }
    }
}

fn spawn_heartbeat(state: AppState, postgres: bool) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        let cluster = state.cluster.clone();
        let mut last_maintenance: Option<Instant> = None;
        // SQLite registers in the first round, at once.
        let mut first = !postgres;
        let mut registered = postgres;
        loop {
            let interval = if postgres { cluster.options().heartbeat } else { SQLITE_HEARTBEAT };
            if !first {
                tokio::select! {
                    () = stopping.cancelled() => return,
                    () = tokio::time::sleep(interval) => {}
                }
            }
            first = false;
            if cluster.stopped.load(Ordering::SeqCst) || stopping.is_cancelled() {
                return;
            }
            if let Err(e) = heartbeat(&state, &cluster, postgres).await {
                tracing::debug!("writing the heartbeat: {e}");
            }
            if !postgres {
                // This server holds the SQLite database's instance lock, so every other row is a
                // server that is gone.
                if !registered {
                    let gone = sqlx::query(
                        "UPDATE cluster_instances SET stopped_at = heartbeat_at WHERE id <> $1 AND stopped_at IS NULL",
                    )
                    .bind(&cluster.id)
                    .execute(state.background.db())
                    .await;
                    registered = gone.is_ok();
                }
                continue;
            }
            if let Err(e) = lead(&state, &cluster).await {
                tracing::warn!("renewing the leader lease: {e}");
            }
            check_peers(&state, &cluster).await;
            if cluster.is_leader()
                && last_maintenance.is_none_or(|at| at.elapsed() >= MAINTENANCE_EVERY)
                && leader_claim(&state, "cluster:maintain", MAINTENANCE_EVERY, MAINTENANCE_EVERY).await
            {
                last_maintenance = Some(Instant::now());
                match maintain(&state).await {
                    Ok(()) => leader_done(&state, "cluster:maintain").await,
                    Err(e) => tracing::debug!("removing old cluster rows: {e}"),
                }
            }
        }
    });
}

async fn heartbeat(state: &AppState, cluster: &Cluster, postgres: bool) -> Result<(), sqlx::Error> {
    let now = db_now(state.background.db(), postgres).await?;
    let written = sqlx::query("UPDATE cluster_instances SET heartbeat_at = $1 WHERE id = $2")
        .bind(now)
        .bind(&cluster.id)
        .execute(state.background.db())
        .await?
        .rows_affected();
    if written == 0 {
        // Removed while this server could not write (a day without a heartbeat): back in.
        insert_instance(state, state.background.db(), now).await?;
    }
    Ok(())
}

/// The leader's cleanup: events past their hour, servers gone for a day, challenge answers of
/// orders that ended without removing them, and plugin packages no plugin refers to any more.
async fn maintain(state: &AppState) -> Result<(), sqlx::Error> {
    let db = &state.db;
    let now = db_now(db, true).await?;
    sqlx::query("DELETE FROM cluster_events WHERE created_at < $1").bind(now - EVENT_KEEP_MS).execute(db).await?;
    sqlx::query("DELETE FROM cluster_instances WHERE COALESCE(stopped_at, heartbeat_at) < $1")
        .bind(now - INSTANCE_KEEP_MS)
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM acme_challenges WHERE created_at < $1").bind(now - EVENT_KEEP_MS).execute(db).await?;
    sqlx::query(
        "DELETE FROM plugin_packages WHERE dir NOT IN (SELECT dir FROM plugins) \
         AND dir NOT IN (SELECT pending_dir FROM plugins WHERE pending_dir IS NOT NULL) AND created_at < $1",
    )
    .bind(now - EVENT_KEEP_MS)
    .execute(db)
    .await?;
    Ok(())
}

/// Writes queued changes as rows and wakes the other servers with a NOTIFY. A change that cannot
/// be written now is tried again; the queue holds it meanwhile, and `stop` flushes it.
fn spawn_writer(state: AppState) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        let cluster = state.cluster.clone();
        loop {
            tokio::select! {
                () = stopping.cancelled() => return,
                () = cluster.pending_ready.notified() => {}
            }
            loop {
                let pending = cluster.take_pending();
                if pending.is_empty() {
                    break;
                }
                if let Err(e) = write_events(&state.db, &cluster.id, &pending).await {
                    tracing::warn!("announcing {} change(s) to the other servers, trying again: {e}", pending.len());
                    cluster.requeue(pending);
                    tokio::select! {
                        () = stopping.cancelled() => return,
                        () = tokio::time::sleep(Duration::from_secs(1)) => {}
                    }
                }
            }
        }
    });
}

async fn write_events(db: &AnyPool, origin: &str, changes: &[Change]) -> Result<(), sqlx::Error> {
    let mut tx = crate::db::begin(db).await?;
    for change in changes {
        record(&mut tx, origin, change).await?;
    }
    crate::db::commit(tx).await
}

/// Listens for notifications and wakes the reader; reconnects after a lost connection. While it
/// is down the reader polls every second.
fn spawn_listener(state: AppState) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        let cluster = state.cluster.clone();
        let url = state.config.database_url();
        let mut wait = Duration::from_secs(1);
        loop {
            let connected = async {
                let mut listener = sqlx::postgres::PgListener::connect(&url).await?;
                listener.listen(CHANNEL).await?;
                Ok::<_, sqlx::Error>(listener)
            };
            let listener = tokio::select! {
                () = stopping.cancelled() => return,
                listener = connected => listener,
            };
            match listener {
                Ok(mut listener) => {
                    wait = Duration::from_secs(1);
                    cluster.listening.store(true, Ordering::SeqCst);
                    // What happened while nobody listened.
                    cluster.wake.notify_one();
                    loop {
                        tokio::select! {
                            () = stopping.cancelled() => return,
                            note = listener.recv() => match note {
                                Ok(_) => cluster.wake.notify_one(),
                                Err(e) => {
                                    tracing::warn!("the notification connection to the database ended: {e}");
                                    break;
                                }
                            },
                        }
                    }
                    cluster.listening.store(false, Ordering::SeqCst);
                }
                Err(e) => tracing::warn!("listening for changes of the other servers: {e}; polling meanwhile"),
            }
            tokio::select! {
                () = stopping.cancelled() => return,
                () = tokio::time::sleep(wait) => {}
            }
            wait = (wait * 2).min(Duration::from_secs(30));
        }
    });
}

#[derive(sqlx::FromRow)]
struct EventRow {
    id: String,
    origin: String,
    kind: String,
    scope: String,
    created_at: i64,
}

/// Reads the other servers' changes when notified and every `Options::poll`, and applies them.
fn spawn_reader(state: AppState, since_ms: i64) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        let cluster = state.cluster.clone();
        let mut reader = Reader { since: since_ms - LOOKBACK_MS, seen: HashMap::new(), last_read: Instant::now() };
        loop {
            if let Err(e) = reader.read(&state, &cluster).await {
                tracing::debug!("reading the changes of the other servers: {e}");
            }
            let poll =
                if cluster.listening.load(Ordering::SeqCst) { cluster.options().poll } else { POLL_WITHOUT_NOTIFY };
            tokio::select! {
                () = stopping.cancelled() => return,
                () = cluster.wake.notified() => {}
                () = tokio::time::sleep(poll) => {}
            }
        }
    });
}

struct Reader {
    /// Rows from here on are read: the newest seen, less `LOOKBACK_MS`.
    since: i64,
    /// Rows already applied (id to time), down to `since`.
    seen: HashMap<String, i64>,
    last_read: Instant,
}

impl Reader {
    async fn read(&mut self, state: &AppState, cluster: &Cluster) -> Result<(), sqlx::Error> {
        let rows: Vec<EventRow> = sqlx::query_as(
            "SELECT id, origin, kind, scope, created_at FROM cluster_events WHERE created_at >= $1 \
             ORDER BY created_at, id",
        )
        .bind(self.since)
        .fetch_all(&state.db)
        .await?;
        // Too long without a read: rows this server never saw may be gone already.
        if self.last_read.elapsed() >= Duration::from_millis((EVENT_KEEP_MS - 5 * 60 * 1000) as u64) {
            tracing::warn!(
                "the changes of the other servers could not be read for a long time; dropping everything kept"
            );
            flush(state).await;
        }
        self.last_read = Instant::now();
        let mut newest = self.since + LOOKBACK_MS;
        for row in rows {
            newest = newest.max(row.created_at);
            if self.seen.insert(row.id, row.created_at).is_some() || row.origin == cluster.id {
                continue;
            }
            match Change::decode(&row.kind, row.scope) {
                Some(change) => apply(state, change).await,
                None => tracing::debug!(kind = %row.kind, "a change of a newer version, ignored"),
            }
        }
        self.since = self.since.max(newest - LOOKBACK_MS);
        let since = self.since;
        self.seen.retain(|_, at| *at >= since);
        Ok(())
    }
}

/// Compares the shared state's counters every `Options::poll` on a timer of its own, whatever the
/// notifications do, and retries a failed plugin sync when its pause is over.
fn spawn_reconciler(state: AppState) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        let cluster = state.cluster.clone();
        let boot = cluster.boot.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let mut reconciler = Reconciler { last: boot, failures: 0 };
        loop {
            tokio::select! {
                () = stopping.cancelled() => return,
                () = tokio::time::sleep(cluster.options().poll) => {}
            }
            match reconciler.compare(&state).await {
                Ok(()) => reconciler.failures = 0,
                Err(e) => {
                    reconciler.failures += 1;
                    if reconciler.failures >= COMPARE_FAILURES_WARN {
                        tracing::warn!(
                            failures = reconciler.failures,
                            "comparing the shared state with the other servers keeps failing: {e}"
                        );
                    } else {
                        tracing::debug!("comparing the shared state with the other servers: {e}");
                    }
                }
            }
            retry_plugin_sync(&state);
        }
    });
}

/// Failed comparisons in a row from which each is logged as a warning.
const COMPARE_FAILURES_WARN: u32 = 3;

/// Compares the counters every announced change raises in its transaction (`record`) and the data
/// sources' cheap aggregates with what this server last took, starting from the moment before it
/// loaded anything (`boot`): a change whose event row this server missed is taken within one poll
/// anyway. Its own changes move the counters too; taking them again is harmless.
struct Reconciler {
    last: Option<Snapshot>,
    failures: u32,
}

impl Reconciler {
    async fn compare(&mut self, state: &AppState) -> Result<(), sqlx::Error> {
        let mut now = Snapshot::read(&state.db).await?;
        let Some(last) = self.last.take() else {
            now.read_source_rows(&state.db).await?;
            self.last = Some(now);
            return Ok(());
        };
        let changed: std::collections::HashSet<String> = now
            .versions
            .iter()
            .filter(|(area, version)| last.versions.get(*area) != Some(*version))
            .map(|(area, _)| area.clone())
            .collect();
        let moved = |area: &str| changed.contains(area);
        if moved("settings") {
            crate::settings::cache(state).invalidate_all_here();
        }
        if moved("rights") {
            // Which organization is not known here: every kept answer goes.
            state.datasources.query_cache().rights_changed_here(None);
        }
        if moved("cache") {
            state.datasources.query_cache().clear();
        }
        if moved("plugins") {
            request_plugin_sync(state);
        }
        // The ACME settings are a server setting.
        if moved("acme") || moved("settings") {
            state.acme.refresh_shared(state).await;
        }
        if moved("challenges") {
            state.acme.sync_challenges(state).await;
        }
        if moved("datasources") || now.sources != last.sources {
            now.read_source_rows(&state.db).await?;
            for (id, was) in &last.source_rows {
                if now.source_rows.get(id) != Some(was) {
                    state.datasources.forget_here(id);
                }
            }
        } else {
            now.source_rows = last.source_rows;
        }
        if (moved("setup") || state.setup.is_open().await) && state.setup.is_open().await {
            let (done,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM setup_lock").fetch_one(&state.db).await?;
            if done > 0 {
                state.setup.close().await;
            }
        }
        self.last = Some(now);
        Ok(())
    }
}

/// Applies another server's change to what this one keeps.
async fn apply(state: &AppState, change: Change) {
    tracing::debug!(?change, "a change of another server");
    match change {
        Change::Settings(org) => crate::settings::cache(state).invalidate(org.as_deref()),
        Change::Rights(org) => state.datasources.query_cache().rights_changed_here(org.as_deref()),
        Change::CacheCleared => state.datasources.query_cache().clear(),
        Change::Datasource(id) => state.datasources.forget_here(&id),
        Change::Plugins => request_plugin_sync(state),
        Change::Acme => state.acme.refresh_shared(state).await,
        Change::AcmeChallenges => state.acme.sync_challenges(state).await,
        Change::AcmeRenew => {
            if state.cluster.is_leader()
                && let Err(refused) = state.acme.request_renewal(state.clock.now_ms())
            {
                tracing::info!("a certificate order asked for on another server was refused: {}", refused.message);
            }
        }
        Change::SetupDone => state.setup.close().await,
    }
}

/// Starts a plugin sync (`PluginHost::sync`) in the background, or asks the running one to go
/// once more. A sync that fails or leaves a plugin out is tried again with a growing pause.
pub fn request_plugin_sync(state: &AppState) {
    let sync = &state.cluster.plugin_sync;
    sync.again.store(true, Ordering::SeqCst);
    if sync.running.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = state.clone();
    let background = state.background.clone();
    background.spawn(async move {
        let sync = &state.cluster.plugin_sync;
        while sync.again.swap(false, Ordering::SeqCst) {
            let complete = match state.plugins.sync(&state).await {
                Ok(complete) => complete,
                Err(e) => {
                    tracing::warn!("taking over the plugin changes of the other servers: {}", e.message);
                    false
                }
            };
            let mut retry = sync.retry.lock().unwrap_or_else(|e| e.into_inner());
            *retry = if complete {
                None
            } else {
                let pause = retry.map_or(SYNC_RETRY_FIRST, |(_, pause)| (pause * 2).min(SYNC_RETRY_MAX));
                Some((Instant::now() + pause, pause))
            };
        }
        sync.running.store(false, Ordering::SeqCst);
    });
}

/// Starts the retry of a failed plugin sync once its pause is over.
fn retry_plugin_sync(state: &AppState) {
    let due = state
        .cluster
        .plugin_sync
        .retry
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some_and(|(at, _)| Instant::now() >= at);
    if due {
        request_plugin_sync(state);
    }
}

/// Drops everything kept that another server could have changed unnoticed.
async fn flush(state: &AppState) {
    crate::settings::cache(state).invalidate_all_here();
    state.datasources.query_cache().rights_changed_here(None);
    state.acme.refresh_shared(state).await;
    request_plugin_sync(state);
}

/// Claims the next run of the leader-only action `name` for this server: true when it may run
/// now. Alone (SQLite) always true. Otherwise only on the leader, and only when the database
/// confirms the lease in the same statement (a server that paused past its lease does not act on
/// its old belief), the last finished run is `interval` old and nobody else holds a valid claim.
/// The claim lasts `lease`; a run that fails keeps it for this server's retries. Call
/// `leader_done` after the run.
pub async fn leader_claim(state: &AppState, name: &str, interval: Duration, lease: Duration) -> bool {
    let cluster = &state.cluster;
    if !cluster.coordinated() {
        return true;
    }
    if !cluster.is_leader() {
        return false;
    }
    match claim(&state.db, cluster, name, interval, lease).await {
        Ok(claimed) => claimed,
        Err(e) => {
            tracing::debug!("claiming {name}: {e}");
            false
        }
    }
}

/// Records the run of `name` as finished (`leader_claim`).
pub async fn leader_done(state: &AppState, name: &str) {
    if state.cluster.coordinated()
        && let Err(e) = done(&state.db, &state.cluster, name).await
    {
        tracing::debug!("recording the run of {name}: {e}");
    }
}

/// Runs `job` like `db::spawn_job`, but on one server only when several share the database: the
/// leader, and only when its run is due across all of them (`cluster_jobs`, `name`). The run is
/// due once the last one finished `schedule.interval` ago; every server looks every
/// `Options::job_check` (at most the interval), so a new leader picks the job up at once. Alone
/// (SQLite), the job runs on `schedule` as it is.
pub fn spawn_job<F, Fut>(state: &AppState, name: &'static str, what: &'static str, schedule: Schedule, mut job: F)
where
    F: FnMut() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<(), JobError>> + Send + 'static,
{
    if !state.cluster.coordinated() {
        crate::db::spawn_job(&state.background, what, schedule, job);
        return;
    }
    let interval = schedule.interval;
    let check = Schedule { interval: interval.min(state.cluster.options().job_check), retries: schedule.retries };
    let db = state.db.clone();
    let cluster = state.cluster.clone();
    crate::db::spawn_job(&state.background, what, check, move || {
        let run = job();
        let db = db.clone();
        let cluster = cluster.clone();
        async move {
            if !cluster.is_leader() {
                return Ok(());
            }
            let busy = |e: sqlx::Error| {
                if crate::error::is_contention(&e) {
                    JobError::Busy(e.to_string())
                } else {
                    JobError::Failed(e.to_string())
                }
            };
            // A run may take long; the claim lasts its interval, at least a minute.
            let lease = interval.max(Duration::from_secs(60));
            if !claim(&db, &cluster, name, interval, lease).await.map_err(busy)? {
                return Ok(());
            }
            run.await?;
            done(&db, &cluster, name).await.map_err(busy)
        }
    });
}

/// Claims the next run of `name` (see `leader_claim`).
async fn claim(
    db: &AnyPool,
    cluster: &Cluster,
    name: &str,
    interval: Duration,
    lease: Duration,
) -> Result<bool, sqlx::Error> {
    let now = db_now(db, true).await?;
    sqlx::query(
        "INSERT INTO cluster_jobs (name, holder, lease_until, last_done_at) VALUES ($1, NULL, 0, 0) \
         ON CONFLICT (name) DO NOTHING",
    )
    .bind(name)
    .execute(db)
    .await?;
    let claimed = sqlx::query(
        "UPDATE cluster_jobs SET holder = $1, lease_until = $2 \
         WHERE name = $3 AND last_done_at <= $4 AND (lease_until < $5 OR holder = $6) \
         AND EXISTS (SELECT 1 FROM cluster_leader WHERE id = 'leader' AND holder = $7 AND expires_at >= $8)",
    )
    .bind(&cluster.id)
    .bind(now + millis(lease))
    .bind(name)
    .bind(now - millis(interval))
    .bind(now)
    .bind(&cluster.id)
    .bind(&cluster.id)
    .bind(now)
    .execute(db)
    .await?
    .rows_affected();
    Ok(claimed == 1)
}

async fn done(db: &AnyPool, cluster: &Cluster, name: &str) -> Result<(), sqlx::Error> {
    let now = db_now(db, true).await?;
    sqlx::query("UPDATE cluster_jobs SET last_done_at = $1, lease_until = 0 WHERE name = $2 AND holder = $3")
        .bind(now)
        .bind(name)
        .bind(&cluster.id)
        .execute(db)
        .await?;
    Ok(())
}

/// Records which challenge answers this server serves now (`acme::Acme::sync_challenges`), for
/// the leader's `await_challenges`.
pub async fn ack_challenges(state: &AppState, fingerprint: &str) {
    if !state.cluster.coordinated() {
        return;
    }
    let written = sqlx::query("UPDATE cluster_instances SET acme_seen = $1 WHERE id = $2")
        .bind(fingerprint)
        .bind(&state.cluster.id)
        .execute(&state.db)
        .await;
    if let Err(e) = written {
        tracing::debug!("recording the challenge answers served: {e}");
    }
}

/// Waits until every other running server serves the challenge answers with `fingerprint`, at
/// most `within`; false when one did not in time (the order goes on, and the CA may reach that
/// server).
pub async fn await_challenges(state: &AppState, fingerprint: &str, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    loop {
        let behind = async {
            let now = db_now(&state.db, true).await?;
            let (n,): (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM cluster_instances WHERE id <> $1 AND stopped_at IS NULL AND heartbeat_at >= $2 \
                 AND (acme_seen IS NULL OR acme_seen <> $3)",
            )
            .bind(&state.cluster.id)
            .bind(now - freshness(&state.cluster.options()))
            .bind(fingerprint)
            .fetch_one(&state.db)
            .await?;
            Ok::<_, sqlx::Error>(n)
        };
        match behind.await {
            Ok(0) => return true,
            Ok(_) | Err(_) if Instant::now() >= deadline => return false,
            _ => tokio::time::sleep(Duration::from_millis(200)).await,
        }
    }
}

#[derive(sqlx::FromRow)]
struct InstanceRow {
    id: String,
    node_id: String,
    host: String,
    version: String,
    address: String,
    started_at: i64,
    heartbeat_at: i64,
    stopped_at: Option<i64>,
}

/// The servers on this database, newest first, with the leader (`GET /api/admin/instances`).
pub async fn view(state: &AppState) -> Result<ClusterView, sqlx::Error> {
    let cluster = &state.cluster;
    let postgres = is_postgres(&state.config.database_url());
    let options = cluster.options();
    let now = db_now(&state.read_db, postgres).await?;
    let rows: Vec<InstanceRow> = sqlx::query_as(
        "SELECT id, node_id, host, version, address, started_at, heartbeat_at, stopped_at FROM cluster_instances \
         ORDER BY started_at DESC, id",
    )
    .fetch_all(&state.read_db)
    .await?;
    let (holder, term, expires_at, since): (Option<String>, i64, i64, Option<i64>) = if postgres {
        sqlx::query_as("SELECT holder, term, expires_at, since FROM cluster_leader WHERE id = 'leader'")
            .fetch_one(&state.read_db)
            .await?
    } else {
        (Some(cluster.id.clone()), 0, i64::MAX, None)
    };
    let leader = holder.filter(|_| expires_at >= now);
    let fresh = if postgres { freshness(&options) } else { millis(SQLITE_HEARTBEAT) * 3 };
    // Another server runs (`is_peer`): not this one, nor this one's earlier run.
    let peers = postgres
        && rows.iter().any(|r| is_peer(cluster, &r.id, &r.node_id, r.heartbeat_at, r.stopped_at.is_some(), now));
    let instances: Vec<InstanceView> = rows
        .into_iter()
        .map(|r| {
            let current = r.id == cluster.id;
            let alive = r.stopped_at.is_none() && (current || now - r.heartbeat_at <= fresh);
            InstanceView {
                leader: alive && leader.as_deref() == Some(r.id.as_str()),
                current,
                alive,
                id: r.id,
                host: r.host,
                version: r.version,
                address: r.address,
                started_at: r.started_at,
                heartbeat_at: r.heartbeat_at,
                stopped_at: r.stopped_at,
            }
        })
        .collect();
    let mode = if peers { "cluster" } else { "single" };
    let transport = match (postgres, cluster.listening.load(Ordering::SeqCst)) {
        (false, _) => "none",
        (true, true) => "notify",
        (true, false) => "poll",
    };
    let leader_since = if postgres {
        since.filter(|_| leader.is_some())
    } else {
        instances.iter().find(|i| i.current).map(|i| i.started_at)
    };
    Ok(ClusterView {
        mode,
        database: if postgres { "postgres" } else { "sqlite" },
        transport,
        leader_since,
        leader_term: term,
        heartbeat_secs: options.heartbeat.as_secs(),
        lease_secs: options.lease.as_secs(),
        instances,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_survive_their_row() {
        let changes = [
            Change::Settings(None),
            Change::Settings(Some("o".into())),
            Change::Rights(None),
            Change::Rights(Some("o".into())),
            Change::CacheCleared,
            Change::Datasource("d".into()),
            Change::Plugins,
            Change::Acme,
            Change::AcmeChallenges,
            Change::AcmeRenew,
            Change::SetupDone,
        ];
        for change in changes {
            let (kind, scope) = change.encode();
            assert_eq!(Change::decode(kind, scope), Some(change));
        }
        assert_eq!(Change::decode("datasource", String::new()), None);
        assert_eq!(Change::decode("from:a_newer_version", String::new()), None);
    }

    #[test]
    fn a_server_alone_leads() {
        let cluster = Cluster::new();
        assert!(cluster.is_leader() && !cluster.coordinated() && !cluster.has_peers());
        // Publishing without the loops is a no-op.
        cluster.publish(Change::Plugins);
        assert!(cluster.take_pending().is_empty());
        cluster.coordinated.store(true, Ordering::SeqCst);
        assert!(!cluster.is_leader(), "coordinated, it leads only with a lease");
        cluster.set_leader(Some(Instant::now() + Duration::from_secs(5)), 3);
        assert!(cluster.is_leader());
        cluster.set_leader(Some(Instant::now() - Duration::from_millis(1)), 3);
        assert!(!cluster.is_leader(), "a belief that ran out is no lead");
    }

    #[test]
    fn the_node_id_is_made_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let first = node_id(dir.path()).unwrap();
        assert!(uuid::Uuid::parse_str(&first).is_ok());
        assert_eq!(node_id(dir.path()).unwrap(), first, "the same data directory, the same node");
        std::fs::write(dir.path().join(NODE_ID_FILE), "not an id").unwrap();
        let replaced = node_id(dir.path()).unwrap();
        assert!(replaced != first && uuid::Uuid::parse_str(&replaced).is_ok(), "a damaged file gets a new id");
        assert_ne!(node_id(tempfile::tempdir().unwrap().path()).unwrap(), replaced);
    }

    #[test]
    fn peers_are_other_nodes_or_copies_that_still_run() {
        let cluster = Cluster::new();
        *cluster.node.lock().unwrap() = "node-a".into();
        cluster.started_ms.store(10_000, Ordering::SeqCst);
        let now = 11_000;
        assert!(is_peer(&cluster, "other", "node-b", now, false, now), "another node with a fresh heartbeat");
        assert!(!is_peer(&cluster, cluster.id(), "node-a", now, false, now), "not this run itself");
        assert!(!is_peer(&cluster, "other", "node-b", now, true, now), "not a stopped server");
        assert!(!is_peer(&cluster, "other", "node-b", now - 60_000, false, now), "not a silent one");
        assert!(!is_peer(&cluster, "earlier", "node-a", 9_500, false, now), "not this node's earlier run");
        assert!(is_peer(&cluster, "copy", "node-a", 10_500, false, now), "a copy still writing heartbeats");
    }

    #[test]
    fn the_queue_keeps_order_and_takes_back_what_failed() {
        let cluster = Cluster::new();
        cluster.coordinated.store(true, Ordering::SeqCst);
        cluster.publish(Change::Plugins);
        cluster.publish(Change::Plugins);
        cluster.publish(Change::Acme);
        let first = cluster.take_pending();
        assert_eq!(first, vec![Change::Plugins, Change::Acme], "repeats in a row are one");
        cluster.publish(Change::CacheCleared);
        cluster.requeue(first);
        assert_eq!(cluster.take_pending(), vec![Change::Plugins, Change::Acme, Change::CacheCleared]);
        cluster.stopped.store(true, Ordering::SeqCst);
        cluster.publish(Change::Plugins);
        assert!(cluster.take_pending().is_empty(), "nothing queues after the stop flushed");
    }

    #[test]
    fn every_change_raises_a_counter_the_migration_seeds() {
        let seeded = include_str!("../migrations/0026_cluster.sql");
        for change in [
            Change::Settings(None),
            Change::Rights(None),
            Change::CacheCleared,
            Change::Datasource("d".into()),
            Change::Plugins,
            Change::Acme,
            Change::AcmeRenew,
            Change::AcmeChallenges,
            Change::SetupDone,
        ] {
            assert!(seeded.contains(&format!("('{}', 0)", area(&change))), "{change:?}");
        }
    }

    #[tokio::test]
    async fn the_database_clock_is_in_milliseconds() {
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        let now = db_now(&db, false).await.unwrap();
        let local = crate::clock::Clock::now_ms(&crate::clock::SystemClock);
        assert!((now - local).abs() < 5_000, "{now} vs {local}");
        // Recording on SQLite writes nothing: one server, nobody to tell.
        let mut conn = db.acquire().await.unwrap();
        record(&mut conn, "x", &Change::Plugins).await.unwrap();
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM cluster_events").fetch_one(&mut *conn).await.unwrap();
        assert_eq!(n, 0);
    }
}
