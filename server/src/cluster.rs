//! Several Kalzit servers on one PostgreSQL database, behind a load balancer (docs/ARCHITECTURE.md,
//! "Several servers on one database"; docs/operations/high-availability.md).
//!
//! - **Identity and heartbeat.** Every server process gets a new id at start and keeps its row in
//!   `cluster_instances` fresh (`Options::heartbeat`); a clean stop marks it stopped.
//! - **Leader.** One server leads and runs the jobs that must run once (retention cleanups, the
//!   plugin catalog refresh, certificate orders, the daily update check). The leader holds a lease
//!   row (`cluster_leader`) that it renews with every heartbeat; once the lease has passed in the
//!   database's clock, any other server takes it over with a new term. A lease and not an
//!   advisory lock: an advisory lock belongs to one connection, so it breaks behind a
//!   transaction-mode connection pooler (PgBouncer), and a half-open connection keeps it held
//!   while its server can no longer tell that it leads. With the lease the leader knows how long
//!   it leads: it stops counting itself the leader one heartbeat before its lease could pass,
//!   measured from before the renewal was sent, so two servers never both believe they lead.
//! - **Run once.** On top of the leader, each such job claims its run in `cluster_jobs` with the
//!   interval it keeps (`spawn_job`): a run is claimed only when the last finished one is an
//!   interval old, so a leader change in the middle of an interval does not run it twice.
//! - **Changes.** What servers keep in memory and another server can change (settings, the query
//!   cache's generations, data source connections, plugins, certificates) is announced as a row
//!   in `cluster_events` plus a PostgreSQL `NOTIFY`; every server reads new rows when notified and
//!   at least every `Options::poll`, so a lost notification (a reconnect) only delays a change.
//!   A server that could not read the events for longer than they are kept drops everything it
//!   keeps (`flush`).
//!
//! SQLite serves one server (`db::InstanceLock`): there the server registers itself, leads alone
//! and announces nothing.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde::Serialize;
use sqlx::AnyPool;
use tokio::sync::{Notify, mpsc};

use crate::app::AppState;
use crate::db::{JobError, Schedule};

/// The NOTIFY channel; the payload is empty, the rows in `cluster_events` are what counts.
pub const CHANNEL: &str = "kalzit_cluster";
/// How long announced changes are kept.
const EVENT_KEEP_MS: i64 = 60 * 60 * 1000;
/// How far back each read of the events looks behind the newest one it saw: an event written
/// just before another may become visible just after it.
const LOOKBACK_MS: i64 = 10_000;
/// How long rows of stopped or silent servers stay in `cluster_instances`.
const INSTANCE_KEEP_MS: i64 = 24 * 60 * 60 * 1000;
/// How often the leader removes old events, rows of servers long gone and unused packages.
const MAINTENANCE_EVERY: Duration = Duration::from_secs(60);
/// The heartbeat on SQLite, where nothing depends on it but the instance view.
const SQLITE_HEARTBEAT: Duration = Duration::from_secs(30);
/// The events are read this often while the NOTIFY connection is down.
const POLL_WITHOUT_NOTIFY: Duration = Duration::from_secs(1);

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
    /// How often the events are read without a notification.
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
    /// Other servers started on the database within `INSTANCE_KEEP_MS`.
    has_peers: AtomicBool,
    /// The NOTIFY connection is up.
    listening: AtomicBool,
    /// Changes waiting to be written.
    outbox: OnceLock<mpsc::UnboundedSender<Change>>,
    /// Wakes the reader of the events (a notification arrived).
    wake: Notify,
    /// Set by `stop`: nothing is written any more.
    stopped: AtomicBool,
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
    /// `single` (SQLite, or PostgreSQL with no other server seen) or `cluster`.
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

fn millis(d: Duration) -> i64 {
    i64::try_from(d.as_millis()).unwrap_or(i64::MAX)
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
            listening: AtomicBool::new(false),
            outbox: OnceLock::new(),
            wake: Notify::new(),
            stopped: AtomicBool::new(false),
        }
    }

    /// This server's id, new at every start.
    pub fn id(&self) -> &str {
        &self.id
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
    /// or the loops never started) always does.
    pub fn is_leader(&self) -> bool {
        if !self.coordinated() {
            return true;
        }
        self.leader_until.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|until| Instant::now() < until)
    }

    /// Other servers started on this database recently (a day): they count for the update mode
    /// and the instance view.
    pub fn has_peers(&self) -> bool {
        self.has_peers.load(Ordering::SeqCst)
    }

    /// Announces a change to the other servers; nothing on a server that runs alone.
    pub fn publish(&self, change: Change) {
        if let Some(outbox) = self.outbox.get() {
            let _ = outbox.send(change);
        }
    }

    fn publisher(&self) -> Option<Publisher> {
        let outbox = self.outbox.get()?.clone();
        Some(Arc::new(move |change| {
            let _ = outbox.send(change);
        }))
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
    let db = state.db.clone();
    let now = db_now(&db, postgres).await?;
    sqlx::query(
        "INSERT INTO cluster_instances (id, host, version, address, started_at, heartbeat_at, stopped_at) \
         VALUES ($1, $2, $3, $4, $5, $6, NULL)",
    )
    .bind(&cluster.id)
    .bind(&cluster.host)
    .bind(env!("CARGO_PKG_VERSION"))
    .bind(listen_address(state))
    .bind(now)
    .bind(now)
    .execute(&db)
    .await?;
    cluster.coordinated.store(true, Ordering::SeqCst);
    let (outbox, inbox) = mpsc::unbounded_channel();
    let _ = cluster.outbox.set(outbox);
    if let Some(publisher) = cluster.publisher() {
        crate::settings::cache(state).set_publisher(publisher.clone());
        state.datasources.set_publisher(publisher);
    }
    if let Err(e) = lead(state, &cluster).await {
        tracing::warn!("trying to lead: {e}");
    }
    check_peers(state, &cluster).await;
    spawn_heartbeat(state.clone(), true);
    spawn_writer(state.clone(), inbox);
    spawn_reader(state.clone(), now);
    spawn_listener(state.clone());
    // Plugins another server installed whose packages this one has not unpacked yet.
    let synced = state.clone();
    state.background.spawn(async move {
        if let Err(e) = synced.plugins.sync(&synced).await {
            tracing::warn!("taking over the plugins of the other servers: {}", e.message);
        }
    });
    tracing::info!(instance = %cluster.id, host = %cluster.host, "registered with the other servers on this database");
    Ok(())
}

/// Hands over the lease and marks this server stopped (`AppState::close`). Quick: the next
/// server takes over at its next heartbeat instead of waiting for the lease to pass.
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
    match tokio::time::timeout(Duration::from_secs(2), stop).await {
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

async fn check_peers(state: &AppState, cluster: &Cluster) {
    let postgres = cluster.coordinated();
    let peers = async {
        let now = db_now(&state.db, postgres).await?;
        let (n,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM cluster_instances WHERE id <> $1 AND COALESCE(stopped_at, heartbeat_at) > $2",
        )
        .bind(&cluster.id)
        .bind(now - INSTANCE_KEEP_MS)
        .fetch_one(&state.db)
        .await?;
        Ok::<_, sqlx::Error>(n > 0)
    };
    // SQLite never has peers: the instance lock keeps a second server away.
    match if postgres { peers.await } else { Ok(false) } {
        Ok(peers) => {
            let before = cluster.has_peers.swap(peers, Ordering::SeqCst);
            state.updates.set_clustered(peers);
            if peers && !before {
                tracing::info!("other Kalzit servers use this database; updates are installed per server");
            }
        }
        Err(e) => tracing::debug!("counting the other servers: {e}"),
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
            if cluster.is_leader() && last_maintenance.is_none_or(|at| at.elapsed() >= MAINTENANCE_EVERY) {
                last_maintenance = Some(Instant::now());
                if let Err(e) = maintain(&state).await {
                    tracing::debug!("removing old cluster rows: {e}");
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
        sqlx::query(
            "INSERT INTO cluster_instances (id, host, version, address, started_at, heartbeat_at, stopped_at) \
             VALUES ($1, $2, $3, $4, $5, $6, NULL)",
        )
        .bind(&cluster.id)
        .bind(&cluster.host)
        .bind(env!("CARGO_PKG_VERSION"))
        .bind(listen_address(state))
        .bind(now)
        .bind(now)
        .execute(state.background.db())
        .await?;
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

/// Writes announced changes as rows and wakes the other servers with a NOTIFY. A change that
/// cannot be written now is tried again; the queue holds it meanwhile.
fn spawn_writer(state: AppState, mut inbox: mpsc::UnboundedReceiver<Change>) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        let cluster = state.cluster.clone();
        let mut pending: Vec<Change> = Vec::new();
        loop {
            if pending.is_empty() {
                tokio::select! {
                    () = stopping.cancelled() => return,
                    change = inbox.recv() => match change {
                        Some(change) => pending.push(change),
                        None => return,
                    },
                }
            }
            while let Ok(change) = inbox.try_recv() {
                pending.push(change);
            }
            pending.dedup();
            match write_events(&state, &cluster, &pending).await {
                Ok(()) => pending.clear(),
                Err(e) => {
                    tracing::warn!("announcing {} change(s) to the other servers, trying again: {e}", pending.len());
                    tokio::select! {
                        () = stopping.cancelled() => return,
                        () = tokio::time::sleep(Duration::from_secs(1)) => {}
                    }
                }
            }
        }
    });
}

async fn write_events(state: &AppState, cluster: &Cluster, changes: &[Change]) -> Result<(), sqlx::Error> {
    let insert =
        format!("INSERT INTO cluster_events (id, origin, kind, scope, created_at) VALUES ($1, $2, $3, $4, {PG_NOW})");
    for change in changes {
        let (kind, scope) = change.encode();
        sqlx::query(sqlx::AssertSqlSafe(insert.clone()))
            .bind(uuid::Uuid::now_v7().to_string())
            .bind(&cluster.id)
            .bind(kind)
            .bind(scope)
            .execute(&state.db)
            .await?;
    }
    sqlx::query("SELECT pg_notify($1, '')").bind(CHANNEL).execute(&state.db).await?;
    Ok(())
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
fn spawn_reader(state: AppState, started_ms: i64) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        let cluster = state.cluster.clone();
        let mut reader = Reader { since: started_ms - LOOKBACK_MS, seen: HashMap::new(), last_read: Instant::now() };
        loop {
            let poll =
                if cluster.listening.load(Ordering::SeqCst) { cluster.options().poll } else { POLL_WITHOUT_NOTIFY };
            tokio::select! {
                () = stopping.cancelled() => return,
                () = cluster.wake.notified() => {}
                () = tokio::time::sleep(poll) => {}
            }
            if let Err(e) = reader.read(&state, &cluster).await {
                tracing::debug!("reading the changes of the other servers: {e}");
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

/// Applies another server's change to what this one keeps.
async fn apply(state: &AppState, change: Change) {
    tracing::debug!(?change, "a change of another server");
    match change {
        Change::Settings(org) => crate::settings::cache(state).invalidate_here(org.as_deref()),
        Change::Rights(org) => state.datasources.query_cache().rights_changed_here(org.as_deref()),
        Change::CacheCleared => state.datasources.query_cache().clear(),
        Change::Datasource(id) => state.datasources.forget_here(&id),
        Change::Plugins => {
            let synced = state.clone();
            state.background.spawn(async move {
                if let Err(e) = synced.plugins.sync(&synced).await {
                    tracing::warn!("taking over the plugin changes of another server: {}", e.message);
                }
            });
        }
        Change::Acme => state.acme.refresh_shared(state).await,
        Change::AcmeChallenges => state.acme.sync_challenges(state).await,
        Change::AcmeRenew => {
            if state.cluster.is_leader()
                && let Err(refused) = state.acme.request_renewal(state.clock.now_ms())
            {
                tracing::info!("a certificate order asked for on another server was refused: {}", refused.message);
            }
        }
    }
}

/// Drops everything kept that another server could have changed unnoticed.
async fn flush(state: &AppState) {
    crate::settings::cache(state).invalidate_all_here();
    state.datasources.query_cache().rights_changed_here(None);
    state.acme.refresh_shared(state).await;
    if let Err(e) = state.plugins.sync(state).await {
        tracing::warn!("taking over the plugin changes of the other servers: {}", e.message);
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
            if !claim(&db, &cluster, name, interval).await.map_err(busy)? {
                return Ok(());
            }
            run.await?;
            done(&db, &cluster, name).await.map_err(busy)
        }
    });
}

/// Claims the next run of `name` when the last finished one is `interval` old and nobody else
/// holds a claim that is still valid. A claim this server already holds (a run that failed) is
/// claimed again.
async fn claim(db: &AnyPool, cluster: &Cluster, name: &str, interval: Duration) -> Result<bool, sqlx::Error> {
    let now = db_now(db, true).await?;
    let due: Option<(i64, Option<String>, i64)> =
        sqlx::query_as("SELECT last_done_at, holder, lease_until FROM cluster_jobs WHERE name = $1")
            .bind(name)
            .fetch_optional(db)
            .await?;
    let interval_ms = millis(interval);
    match &due {
        None => {
            sqlx::query(
                "INSERT INTO cluster_jobs (name, holder, lease_until, last_done_at) VALUES ($1, NULL, 0, 0) \
                 ON CONFLICT (name) DO NOTHING",
            )
            .bind(name)
            .execute(db)
            .await?;
        }
        Some((last, holder, until)) => {
            let others = holder.as_deref().is_some_and(|h| h != cluster.id) && *until >= now;
            if now - last < interval_ms || others {
                return Ok(false);
            }
        }
    }
    // A run may take long; the claim lasts its interval, at least a minute.
    let lease = interval_ms.max(60_000);
    let claimed = sqlx::query(
        "UPDATE cluster_jobs SET holder = $1, lease_until = $2 \
         WHERE name = $3 AND last_done_at <= $4 AND (lease_until < $5 OR holder = $6)",
    )
    .bind(&cluster.id)
    .bind(now + lease)
    .bind(name)
    .bind(now - interval_ms)
    .bind(now)
    .bind(&cluster.id)
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

#[derive(sqlx::FromRow)]
struct InstanceRow {
    id: String,
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
        "SELECT id, host, version, address, started_at, heartbeat_at, stopped_at FROM cluster_instances \
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
    let fresh = millis(options.lease).max(millis(if postgres { options.heartbeat } else { SQLITE_HEARTBEAT }) * 3);
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
    let mode = if postgres && instances.iter().any(|i| !i.current) { "cluster" } else { "single" };
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
        cluster.coordinated.store(true, Ordering::SeqCst);
        assert!(!cluster.is_leader(), "coordinated, it leads only with a lease");
        cluster.set_leader(Some(Instant::now() + Duration::from_secs(5)), 3);
        assert!(cluster.is_leader());
        cluster.set_leader(Some(Instant::now() - Duration::from_millis(1)), 3);
        assert!(!cluster.is_leader(), "a belief that ran out is no lead");
        // Publishing without the loops is a no-op.
        cluster.publish(Change::Plugins);
    }

    #[tokio::test]
    async fn the_database_clock_is_in_milliseconds() {
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        let now = db_now(&db, false).await.unwrap();
        let local = crate::clock::Clock::now_ms(&crate::clock::SystemClock);
        assert!((now - local).abs() < 5_000, "{now} vs {local}");
    }
}
