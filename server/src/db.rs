//! The server's own database: SQLite by default, PostgreSQL for larger installations. Both run
//! the same portable migrations through sqlx's `Any` driver.
//!
//! SQLite runs on one host with the database on a local disk and serves one Kalzit server
//! (`InstanceLock`); shared storage or several Kalzit servers on one database need PostgreSQL.

use std::cell::Cell;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use crate::locks::MutexExt;

use anyhow::{Context, Result};
use sqlx::any::AnyPoolOptions;
use sqlx::{Any, AnyPool, Transaction};
use tokio_util::sync::CancellationToken;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// The newest migration this build carries (what `updates::install::schema_version` answers once
/// they all ran).
pub fn latest_migration() -> i64 {
    MIGRATOR.iter().map(|m| m.version).max().unwrap_or(0)
}

/// How long a SQLite statement waits for a lock another connection holds before the request
/// answers `503 busy`. Locks are normally held for milliseconds; this covers a slow disk or a
/// burst of writers (the CI runners on Windows are both).
pub const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(15);

/// The size the WAL file is cut back to after a checkpoint, so a burst of writes does not leave a
/// large file behind (64 MiB).
const SQLITE_JOURNAL_SIZE_LIMIT: u64 = 64 * 1024 * 1024;

/// How long the server's own background writes (session touches, the hourly jobs) wait for the
/// write lock on SQLite before they give up. Short, because SQLite keeps waiting even when the
/// write is dropped, and closing the database at a stop waits for that. Under load SQLite's busy
/// sleeps overshoot (about half again on Windows), so this stays well inside
/// `BACKGROUND_STOP_WAIT`.
pub const BACKGROUND_BUSY_TIMEOUT: Duration = Duration::from_millis(500);

pub async fn connect(url: &str, max_connections: u32) -> Result<AnyPool> {
    connect_with(url, max_connections, SQLITE_BUSY_TIMEOUT).await
}

/// `connect` with another SQLite busy timeout (tests use a short one).
///
/// SQLite runs in WAL mode: readers never wait for a writer and a writer never waits for
/// readers, so only writers queue for the one write lock, and they wait for it with the busy
/// timeout. The default rollback journal lets a committing writer block every reader and makes
/// SQLite answer `SQLITE_BUSY` at once, without waiting, when a reader's lock upgrade would
/// deadlock with a commit; on Windows it also creates and deletes a journal file per transaction,
/// which virus scanners slow down. Transactions start through `begin`, which takes the write lock
/// first, so they never hold a read snapshot that a commit makes stale.
pub async fn connect_with(url: &str, max_connections: u32, busy_timeout: Duration) -> Result<AnyPool> {
    sqlx::any::install_default_drivers();
    if let Some(file) = sqlite_file(url) {
        ensure_local_disk(&file)?;
    }
    let pool = pool_options(max_connections, busy_timeout)
        .connect(url)
        .await
        .with_context(|| format!("connecting to the database ({})", redact(url)))?;
    let mut conn = pool.acquire().await.context("connecting to the database")?;
    if conn.backend_name() == "SQLite" {
        // Stored in the database file, so one switch covers every later connection. Switching an
        // existing database needs it to itself for a moment. An in-memory database keeps its own
        // journal ("memory") and ignores this.
        let (mode,): (String,) =
            sqlx::query_as("PRAGMA journal_mode = WAL").fetch_one(&mut *conn).await.context("enabling WAL")?;
        if !matches!(mode.as_str(), "wal" | "memory") {
            anyhow::bail!(
                "the SQLite database stays in journal mode {mode}; WAL is required (is another program using it?)"
            );
        }
    }
    drop(conn);
    if let Err(e) = refuse_newer_schema(&pool).await {
        pool.close().await;
        return Err(e);
    }
    MIGRATOR.run(&pool).await.context("running database migrations")?;
    Ok(pool)
}

/// A database a newer Kalzit migrated cannot be used by this one (its tables changed in ways
/// this build does not know). Says so in words, instead of the migrator's "migration N was
/// previously applied but is missing", and names the way back. A new database has no migration
/// table yet and passes.
async fn refuse_newer_schema(pool: &AnyPool) -> Result<()> {
    let stored: Option<(i64,)> = sqlx::query_as("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success")
        .fetch_one(pool)
        .await
        .ok();
    let latest = latest_migration();
    match stored {
        Some((stored,)) if stored > latest => anyhow::bail!(
            "this database was written by a newer Kalzit (schema {stored}; this version knows up to {latest}). \
             Install that newer version again, or restore the database backup this version made before the \
             update (updates/backups in the data directory)"
        ),
        _ => Ok(()),
    }
}

/// One Kalzit server per SQLite database: an exclusive lock on `<database file>.lock` next to the
/// file, held while the server runs. The operating system lets go of it when the process ends,
/// a crash included, so a restart never waits for a stale lock. Two servers on one SQLite file
/// would each keep their own caches and leader and fight over its single write lock; several
/// servers need PostgreSQL (`cluster`).
///
/// With PostgreSQL the lock is `kalzit-server.lock` in the data directory instead: several servers share
/// the database, but each needs its own data directory (plugin packages, update files), and the
/// cluster counts an earlier row of the same host and data directory as this server's own.
///
/// Limits: the lock is advisory and taken per path. A hard link to the database under another
/// name, or a bind mount that does not pass locks between the host and a container (CIFS shares,
/// some Docker Desktop file sharing), is not seen; such storage is refused for SQLite anyway when
/// it is recognized as a network drive.
#[derive(Debug)]
pub struct InstanceLock {
    _file: std::fs::File,
}

impl InstanceLock {
    /// The lock for the database of `url` (SQLite) or for `data_dir` (PostgreSQL); `None` for an
    /// in-memory database. Fails when another server holds it, naming the file and the way out.
    pub fn acquire(url: &str, data_dir: &Path) -> Result<Option<Self>> {
        if url.starts_with("sqlite:") {
            let Some(file) = sqlite_file(url) else { return Ok(None) };
            let path = lock_path(&file);
            return Self::take(&path).map(Some).map_err(|busy| match busy {
                None => anyhow::anyhow!(
                    "another Kalzit server is already running on the SQLite database {} (it holds {}). SQLite \
                     serves one Kalzit server: stop the other one first, or move to PostgreSQL to run several \
                     servers on one database (docs/operations/high-availability.md)",
                    file.display(),
                    path.display()
                ),
                Some(e) => e,
            });
        }
        let path = data_dir.join("kalzit-server.lock");
        Self::take(&path).map(Some).map_err(|busy| match busy {
            None => anyhow::anyhow!(
                "another Kalzit server is already running with the data directory {}. Every server on one \
                 database needs its own data directory (docs/operations/high-availability.md)",
                data_dir.display()
            ),
            Some(e) => e,
        })
    }

    /// The exclusive lock on `path`; `Err(None)` when another process holds it.
    fn take(path: &Path) -> Result<Self, Option<anyhow::Error>> {
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("opening the lock file {}", path.display()))
            .map_err(Some)?;
        match lock.try_lock() {
            Ok(()) => Ok(Self { _file: lock }),
            Err(std::fs::TryLockError::WouldBlock) => Err(None),
            Err(std::fs::TryLockError::Error(e)) => {
                Err(Some(anyhow::Error::new(e).context(format!("locking {}", path.display()))))
            }
        }
    }
}

/// `kalzit.db.lock` for `kalzit.db`; links are resolved first, so two spellings of one database
/// share the lock (before the first start only the folder exists, and is resolved instead).
fn lock_path(file: &Path) -> PathBuf {
    let resolved = std::fs::canonicalize(file).ok().or_else(|| {
        let dir = file.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let name = file.file_name()?;
        std::fs::canonicalize(dir).ok().map(|d| d.join(name))
    });
    let mut name = resolved.unwrap_or_else(|| file.to_path_buf()).into_os_string();
    name.push(".lock");
    PathBuf::from(name)
}

/// A second, small pool on the same SQLite file whose connections wait only `busy_timeout` for a
/// lock, for best-effort writes that must not hold up a stop. Its connections are its own, so the
/// short timeout never reaches a request's connection. `None` for PostgreSQL, where a dropped
/// statement ends with its connection, and for an in-memory database, which a second pool would
/// not see. Connects on first use; the schema is the main pool's.
pub fn side_pool(pool: &AnyPool, url: &str, max_connections: u32, busy_timeout: Duration) -> Option<AnyPool> {
    sqlite_file(url)?;
    Some(pool_options(max_connections, busy_timeout).connect_lazy_with((*pool.connect_options()).clone()))
}

/// A pool of read-only connections on the same SQLite file, for the reads every request makes
/// (session and permission lookups). In WAL mode a reader never waits for the writer, but a
/// request's connection from the main pool may: writers queue there for the one write lock (up to
/// the busy timeout each), and once they hold every connection of the main pool, a sign-in or a
/// permission check would wait behind them. These connections cannot write (`query_only`), so
/// writes stay on the main pool and SQLite keeps its single writer. `None` for PostgreSQL, whose
/// readers never queue behind writers, and for an in-memory database, which a second pool would
/// not see. Connects on first use; the schema is the main pool's.
pub fn read_pool(pool: &AnyPool, url: &str, max_connections: u32) -> Option<AnyPool> {
    sqlite_file(url)?;
    let busy_ms = SQLITE_BUSY_TIMEOUT.as_millis();
    let options = AnyPoolOptions::new().max_connections(max_connections).after_connect(move |conn, _| {
        Box::pin(async move {
            for pragma in [format!("PRAGMA busy_timeout = {busy_ms}"), "PRAGMA query_only = ON".to_string()] {
                sqlx::query(sqlx::AssertSqlSafe(pragma)).execute(&mut *conn).await?;
            }
            Ok(())
        })
    });
    Some(options.connect_lazy_with((*pool.connect_options()).clone()))
}

/// The writes the server makes on its own, outside requests: session touches and the hourly
/// jobs. They run as tasks the server aborts when it stops, and on SQLite through a `side_pool`
/// that waits at most `BACKGROUND_BUSY_TIMEOUT` for the write lock, so a stop never waits the
/// full busy timeout for one. Each of them is repeated later, so a dropped one costs nothing.
pub struct Background {
    db: AnyPool,
    own_pool: bool,
    /// Cancelled when the server stops: tasks start no new statement and end their sleeps.
    stopping: CancellationToken,
    /// `None` once stopped: nothing new starts.
    tasks: Mutex<Option<tokio::task::JoinSet<()>>>,
}

/// How long a stop waits for background tasks to end on their own before it aborts them. A
/// running statement ends within `BACKGROUND_BUSY_TIMEOUT`, which a loaded machine stretches to
/// a second or more (measured: opening the connection 0.1 to 0.6 s, then 0.9 s for a 0.5 s busy
/// timeout); this leaves room for both.
const BACKGROUND_STOP_WAIT: Duration = Duration::from_secs(3);

impl Background {
    /// For the server's pool `main` on `url`, with up to `max_connections` of its own on SQLite.
    pub fn new(main: &AnyPool, url: &str, max_connections: u32) -> Self {
        let own = side_pool(main, url, max_connections, BACKGROUND_BUSY_TIMEOUT);
        Self {
            own_pool: own.is_some(),
            db: own.unwrap_or_else(|| main.clone()),
            stopping: CancellationToken::new(),
            tasks: Mutex::new(Some(tokio::task::JoinSet::new())),
        }
    }

    /// Cancelled when the server stops. A task checks it before each statement and races it
    /// against its sleeps; a statement already running is left to finish.
    pub fn stopping(&self) -> CancellationToken {
        self.stopping.clone()
    }

    /// The pool background writes go through.
    pub fn db(&self) -> &AnyPool {
        &self.db
    }

    /// Connections of the own pool in use right now: background writes running or waiting for
    /// the lock (tests). 0 without an own pool.
    #[doc(hidden)]
    pub fn connections_in_use(&self) -> u32 {
        if !self.own_pool {
            return 0;
        }
        self.db.size().saturating_sub(self.db.num_idle() as u32)
    }

    /// Runs `task` in the background; after the stop began it does not start. The task ends on
    /// its own when `stopping` is cancelled.
    pub fn spawn(&self, task: impl Future<Output = ()> + Send + 'static) {
        if self.stopping.is_cancelled() {
            return;
        }
        if let Some(tasks) = self.lock_tasks().as_mut() {
            // Finished tasks leave their result in the set; drop them so it does not grow.
            while tasks.try_join_next().is_some() {}
            tasks.spawn(task);
        }
    }

    /// Stops every task for good, then closes the own pool. The tasks are asked to end and get
    /// `BACKGROUND_STOP_WAIT` to finish the statement they are in, connection opening included,
    /// so all its connections are back when the pool closes. Only tasks still running after that
    /// are aborted; SQLite may then close a connection after this returns.
    pub async fn stop(&self) {
        self.stopping.cancel();
        let tasks = self.lock_tasks().take();
        if let Some(mut tasks) = tasks {
            let ended =
                tokio::time::timeout(BACKGROUND_STOP_WAIT, async { while tasks.join_next().await.is_some() {} }).await;
            if ended.is_err() {
                tracing::warn!("background writes still ran {BACKGROUND_STOP_WAIT:?} after the stop; aborting them");
                tasks.abort_all();
                while tasks.join_next().await.is_some() {}
            }
        }
        if self.own_pool {
            self.db.close().await;
        }
    }

    fn lock_tasks(&self) -> MutexGuard<'_, Option<tokio::task::JoinSet<()>>> {
        // The set holds no invariant a panic could break.
        self.tasks.lock_or_recover()
    }
}

fn pool_options(max_connections: u32, busy_timeout: Duration) -> AnyPoolOptions {
    let busy_ms = busy_timeout.as_millis();
    AnyPoolOptions::new().max_connections(max_connections).after_connect(move |conn, _| {
        Box::pin(async move {
            if conn.backend_name() == "SQLite" {
                // Per connection. `synchronous` stays at its default (FULL), so a committed
                // change survives a power loss too.
                let pragmas = [
                    format!("PRAGMA busy_timeout = {busy_ms}"),
                    format!("PRAGMA journal_size_limit = {SQLITE_JOURNAL_SIZE_LIMIT}"),
                ];
                for pragma in pragmas {
                    sqlx::query(sqlx::AssertSqlSafe(pragma)).execute(&mut *conn).await?;
                }
            }
            Ok(())
        })
    })
}

/// Starts a transaction that holds the write lock from its first statement: `BEGIN IMMEDIATE` on
/// SQLite, which waits for the lock with the busy timeout instead of failing later when a read
/// snapshot turns stale (`SQLITE_BUSY_SNAPSHOT`); a plain `BEGIN` on PostgreSQL, whose row locks
/// do the ordering. Every transaction of the server starts here: clippy refuses sqlx's own
/// `begin` everywhere else (`clippy.toml`).
#[expect(clippy::disallowed_methods, reason = "the one place transactions of Kalzit's database start")]
pub async fn begin(pool: &AnyPool) -> Result<Transaction<'static, Any>, sqlx::Error> {
    if pool.connect_options().database_url.scheme() == "sqlite" {
        pool.begin_with("BEGIN IMMEDIATE").await
    } else {
        pool.begin().await
    }
}

tokio::task_local! {
    /// Set once a transaction of the current request has committed (see `commit`).
    static COMMITTED: Cell<bool>;
}

/// Commits, and remembers for the rest of the request that something was saved: from then on a
/// database error answers `internal`, never `busy`, because "nothing changed, send it again" would
/// no longer be true. Every commit goes through here (clippy refuses sqlx's own elsewhere).
#[expect(clippy::disallowed_methods, reason = "the one place transactions of Kalzit's database commit")]
pub async fn commit(tx: Transaction<'static, Any>) -> Result<(), sqlx::Error> {
    tx.commit().await?;
    // Outside a request (startup, background tasks, tests) there is no scope and nothing to mark.
    let _ = COMMITTED.try_with(|c| c.set(true));
    Ok(())
}

/// Whether a transaction of the current request has committed.
pub fn committed() -> bool {
    COMMITTED.try_with(Cell::get).unwrap_or(false)
}

/// Runs `request` with its own commit flag; the router installs this around every request.
pub async fn request_scope<F: Future>(request: F) -> F::Output {
    COMMITTED.scope(Cell::new(false), request).await
}

/// The middleware that gives every request its own commit flag (`request_scope`).
pub async fn scope_requests(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    request_scope(next.run(req)).await
}

/// The database file of a SQLite URL (as `config::sqlite_url` writes them), `None` for other
/// databases and for an in-memory one (`sqlite::memory:`, `sqlite:file::memory:`, or any URL with
/// `mode=memory`).
pub fn sqlite_file(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("sqlite:")?;
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    if query.split('&').any(|pair| pair.eq_ignore_ascii_case("mode=memory")) {
        return None;
    }
    let path = path.strip_prefix("file:").unwrap_or(path);
    if path.is_empty() || path == ":memory:" {
        return None;
    }
    // The characters `config::sqlite_url` encodes; '%' last, so "%2523" stays "%23".
    Some(PathBuf::from(path.replace("%3F", "?").replace("%23", "#").replace("%25", "%")))
}

/// SQLite's locking needs a local disk: on network file systems WAL is unsupported and locks are
/// unreliable, which corrupts databases. Refused at start with the way out.
fn ensure_local_disk(file: &Path) -> Result<()> {
    // The file itself when it exists, so a symbolic link or junction to a share is followed;
    // before the first start only its directory exists. If neither resolves, the path as given is
    // checked: the start then fails later, opening the database, with that error.
    let resolved = std::fs::canonicalize(file).ok().or_else(|| {
        let dir = file.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
        std::fs::canonicalize(dir).ok()
    });
    let place = resolved.unwrap_or_else(|| file.to_path_buf());
    if let Some(kind) = network_storage(&place) {
        anyhow::bail!(
            "the SQLite database {} is on a network drive ({kind}); SQLite needs a local disk. For shared \
             storage or several Kalzit servers on one database, use PostgreSQL (database.url)",
            file.display()
        );
    }
    Ok(())
}

#[cfg(windows)]
fn network_storage(dir: &Path) -> Option<String> {
    let path = dir.to_string_lossy().replace('/', "\\");
    if is_unc(&path) {
        return Some("a UNC path".into());
    }
    // A path without a drive letter that is not UNC either (a volume GUID path) is let through:
    // there is no cheap way to tell, and such paths are local volumes in practice.
    let root = drive_root(&path)?;
    let wide: Vec<u16> = root.encode_utf16().chain([0]).collect();
    /// `GetDriveTypeW` answers this for a remote (network) drive.
    const DRIVE_REMOTE: u32 = 4;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDriveTypeW(root_path_name: *const u16) -> u32;
    }
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call, which only reads it.
    // An unknown or failed answer (0, 1) counts as local: refusing a start on a guess is worse.
    let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
    (kind == DRIVE_REMOTE).then(|| format!("network drive {root}"))
}

/// `\\server\share\...` and its long forms `\\?\UNC\...` and `\\.\UNC\...`; not `\\?\C:\...` or
/// a device path like `\\.\pipe\...`.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_unc(path: &str) -> bool {
    path.starts_with(r"\\?\UNC\")
        || path.starts_with(r"\\.\UNC\")
        || (path.starts_with(r"\\") && !path.starts_with(r"\\?\") && !path.starts_with(r"\\.\"))
}

/// `C:\` for `C:\data`, `\\?\C:\data` and `c:/data`.
#[cfg_attr(not(windows), allow(dead_code))]
fn drive_root(path: &str) -> Option<String> {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    let mut chars = path.chars();
    let letter = chars.next().filter(char::is_ascii_alphabetic)?;
    (chars.next() == Some(':')).then(|| format!("{}:\\", letter.to_ascii_uppercase()))
}

#[cfg(target_os = "linux")]
fn network_storage(dir: &Path) -> Option<String> {
    // Without a readable mount table (a restricted container) the check cannot tell and lets the
    // start go on.
    let mounts = std::fs::read_to_string("/proc/self/mounts").ok()?;
    remote_fs_type(&mounts, dir).map(|fs| format!("file system {fs}"))
}

/// Other systems (macOS, the BSDs) are not checked; Kalzit ships for Windows and Linux.
#[cfg(not(any(windows, target_os = "linux")))]
fn network_storage(_dir: &Path) -> Option<String> {
    None
}

/// File systems that reach the data over the network or across a VM boundary (WSL's 9p, the
/// virtiofs, grpcfuse and fakeowner shares of Docker Desktop and similar), where SQLite's locks
/// cannot be trusted.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const REMOTE_FILE_SYSTEMS: &[&str] = &[
    "nfs",
    "nfs4",
    "cifs",
    "smb3",
    "smbfs",
    "ncpfs",
    "afs",
    "ceph",
    "glusterfs",
    "lustre",
    "9p",
    "fuse.sshfs",
    "fuse.glusterfs",
    "fuse.cephfs",
    "virtiofs",
    "fuse.grpcfuse",
    "fakeowner",
];

/// The type of the file system that holds `dir`, from a mount table (`/proc/self/mounts`: device,
/// mount point, type, ...; spaces in mount points are written `\040`), if it is a remote one.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn remote_fs_type(mounts: &str, dir: &Path) -> Option<String> {
    let mut best: Option<(usize, &str)> = None;
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let (Some(_), Some(point), Some(fs)) = (fields.next(), fields.next(), fields.next()) else { continue };
        let point = point.replace("\\040", " ").replace("\\011", "\t").replace("\\134", "\\");
        if dir.starts_with(&point) && best.is_none_or(|(len, _)| point.len() >= len) {
            best = Some((point.len(), fs));
        }
    }
    best.map(|(_, fs)| fs).filter(|fs| REMOTE_FILE_SYSTEMS.contains(fs)).map(str::to_string)
}

/// The URL for log lines and error messages, rebuilt from its parsed parts only: scheme, user
/// name, `***` for a password, host, port and path, and the query with the values of harmless
/// keys. Every other value becomes `***`. An ambiguous URL (see [`ambiguity`]) is shown as
/// `scheme://***` alone: a password with raw special characters may have spilled into any part,
/// port and path included (`u:2024/Summer@db` parses as port 2024 and path `/Summer@db`).
/// `sqlite:` URLs hold a file path and no credentials; they are shown as they are.
pub fn redact(url: &str) -> String {
    if url.starts_with("sqlite:") {
        return url.to_string();
    }
    if ambiguity(url).is_some() {
        let scheme = url.split_once("://").map(|(scheme, _)| scheme).filter(|s| is_scheme(s));
        return scheme.map_or_else(|| "***".to_string(), |scheme| format!("{scheme}://***"));
    }
    let Ok(parsed) = url::Url::parse(url) else { return "<unparseable database url>".into() };
    // `postgres:u:secret@db/k` or `postgres:/u:secret@db`: no `//`, so no authority to take the
    // password from; the rest may be anything.
    if !parsed.has_authority() {
        return format!("{}:***", parsed.scheme());
    }
    let mut out = format!("{}:", parsed.scheme());
    if parsed.has_authority() {
        out.push_str("//");
        let user = parsed.username();
        match (user.is_empty(), parsed.password().is_some()) {
            (false, true) => out.push_str(&format!("{user}:***@")),
            (false, false) => out.push_str(&format!("{user}@")),
            (true, true) => out.push_str(":***@"),
            (true, false) => {}
        }
        out.push_str(parsed.host_str().unwrap_or_default());
    }
    if let Some(port) = parsed.port() {
        out.push_str(&format!(":{port}"));
    }
    out.push_str(parsed.path());
    if parsed.query().is_some() {
        let pairs: Vec<String> = parsed
            .query_pairs()
            .map(|(key, value)| {
                let shown = if HARMLESS_PARAMS.contains(&key.to_ascii_lowercase().as_str()) {
                    url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>()
                } else {
                    "***".to_string()
                };
                format!("{}={shown}", url::form_urlencoded::byte_serialize(key.as_bytes()).collect::<String>())
            })
            .collect();
        out.push('?');
        out.push_str(&pairs.join("&"));
    }
    out
}

/// A URL scheme: letters, digits, `+`, `-` and `.`, starting with a letter.
pub fn is_scheme(text: &str) -> bool {
    text.starts_with(|c: char| c.is_ascii_alphabetic())
        && text.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
}

/// Query keys whose values are shown in logs (compared after decoding, without case). Every
/// other value, credentials included, is masked.
const HARMLESS_PARAMS: &[&str] = &[
    "sslmode",
    "ssl-mode",
    "application_name",
    "connect_timeout",
    "target_session_attrs",
    "mode",
    "cache",
    "sslrootcert",
    "ssl-ca",
    "charset",
    "timezone",
    "host",
    "port",
    "dbname",
];

/// A warning when `url` holds an `@` after the end of its authority (the text from `://` to the
/// first `/`, `?` or `#`). Then a special character in the password was not percent-encoded,
/// the driver splits the URL at another place than its author meant, and no part of it can be
/// shown safely.
pub fn ambiguity(url: &str) -> Option<String> {
    let (_, after_scheme) = url.split_once("://")?;
    let authority_end = after_scheme.find(['/', '?', '#']).unwrap_or(after_scheme.len());
    after_scheme[authority_end..].contains('@').then(|| {
        "the database URL has an `@` after its host part, so a special character in the password is not \
         percent-encoded; the driver reads such a URL differently than intended, and the log shows it only \
         as `scheme://***`. Percent-encode the password (`@` as %40, `/` as %2F, `?` as %3F, `#` as %23)"
            .to_string()
    })
}

/// When a recurring job runs: at the start and then every `interval`. A run that finds the
/// database busy is tried again after each of `retries` in turn, as long as that comes before the
/// next run.
#[derive(Clone, Debug)]
pub struct Schedule {
    pub interval: Duration,
    pub retries: Vec<Duration>,
}

impl Schedule {
    /// Every hour; after `busy` again in 2 s, 10 s, 1 minute and 5 minutes. A short first retry
    /// matters: the jobs that start with the server contend for the lock for a moment, and
    /// waiting a minute for that would be a long time for a run that is due now.
    pub fn hourly() -> Self {
        let secs = Duration::from_secs;
        Self { interval: secs(60 * 60), retries: vec![secs(2), secs(10), secs(60), secs(5 * 60)] }
    }
}

/// Why a job run failed: `Busy` is tried again by the schedule's retries.
pub enum JobError {
    Busy(String),
    Failed(String),
}

/// Runs `job` as a background task on `schedule`; `what` names it in the log.
pub fn spawn_job<F, Fut>(background: &Background, what: &'static str, schedule: Schedule, mut job: F)
where
    F: FnMut() -> Fut + Send + 'static,
    Fut: Future<Output = Result<(), JobError>> + Send,
{
    let stopping = background.stopping();
    background.spawn(async move {
        let mut tick = tokio::time::interval(schedule.interval);
        loop {
            let due = tokio::select! {
                () = stopping.cancelled() => return,
                due = tick.tick() => due,
            };
            let next = due + schedule.interval;
            let mut retries = schedule.retries.iter();
            loop {
                if stopping.is_cancelled() {
                    return;
                }
                match job().await {
                    Ok(()) => break,
                    Err(JobError::Busy(e)) => match retries.next() {
                        Some(&wait) if tokio::time::Instant::now() + wait < next => {
                            tracing::debug!("{what}: the database is busy, trying again in {wait:?}: {e}");
                            tokio::select! {
                                () = stopping.cancelled() => return,
                                () = tokio::time::sleep(wait) => {}
                            }
                        }
                        _ => {
                            tracing::warn!(
                                "{what} failed, the database stayed busy; next run in {:?}: {e}",
                                schedule.interval
                            );
                            break;
                        }
                    },
                    Err(JobError::Failed(e)) => {
                        tracing::warn!("{what} failed, next run in {:?}: {e}", schedule.interval);
                        break;
                    }
                }
            }
        }
    });
}

/// Deletes sessions that have ended, every hour. Sessions are otherwise only deleted when their
/// cookie is presented again, and most expired cookies never come back.
pub fn spawn_session_cleanup(state: crate::app::AppState) {
    let cluster_state = state.clone();
    crate::cluster::spawn_job(
        &cluster_state,
        "sessions:cleanup",
        "removing ended sessions",
        Schedule::hourly(),
        move || {
            let state = state.clone();
            async move {
                let now = state.clock.now_ms();
                match crate::auth::session::delete_ended(state.background.db(), &state.config.sessions, now).await {
                    Ok(0) => Ok(()),
                    Ok(n) => {
                        tracing::debug!("removed {n} ended sessions");
                        Ok(())
                    }
                    Err(e) if crate::error::is_contention(&e) => Err(JobError::Busy(e.to_string())),
                    Err(e) => Err(JobError::Failed(e.to_string())),
                }
            }
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Contention after a commit of the same request is `internal`: the change is saved, so
    /// "busy, nothing changed, send it again" would be wrong. Without a commit in the request the
    /// same contention is `busy`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn contention_after_a_commit_is_internal() {
        use sqlx::Connection;
        let dir = tempfile::tempdir().unwrap();
        let url = crate::config::sqlite_url(&dir.path().join("k.db"));
        let pool = connect_with(&url, 2, Duration::from_millis(100)).await.unwrap();
        sqlx::query("CREATE TABLE t (x BIGINT)").execute(&pool).await.unwrap();
        let mut holder = sqlx::AnyConnection::connect(&url).await.unwrap();

        // A handler that commits and then reads (writes, here) again while another writer holds
        // the lock: the second statement hits the contention after the change was saved.
        let after_commit = async {
            let mut tx = begin(&pool).await.unwrap();
            sqlx::query("INSERT INTO t VALUES (1)").execute(&mut *tx).await.unwrap();
            commit(tx).await.unwrap();
            sqlx::query("BEGIN IMMEDIATE").execute(&mut holder).await.unwrap();
            let e = sqlx::query("INSERT INTO t VALUES (2)").execute(&pool).await.unwrap_err();
            sqlx::query("ROLLBACK").execute(&mut holder).await.unwrap();
            crate::error::ApiError::from(e).code
        };
        assert_eq!(request_scope(after_commit).await, "internal");

        sqlx::query("BEGIN IMMEDIATE").execute(&mut holder).await.unwrap();
        let nothing_saved = async {
            let e = sqlx::query("INSERT INTO t VALUES (3)").execute(&pool).await.unwrap_err();
            crate::error::ApiError::from(e).code
        };
        assert_eq!(request_scope(nothing_saved).await, "busy");
        assert!(!committed(), "outside a request scope nothing is marked");
        holder.close().await.unwrap();
        pool.close().await;
        dir.close().unwrap();
    }

    /// A first run that finds the database busy is tried again after the first retry delay, not
    /// at the next interval.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_busy_first_run_is_tried_again_after_the_short_delay() {
        use std::sync::atomic::{AtomicU32, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let url = crate::config::sqlite_url(&dir.path().join("k.db"));
        let pool = connect_with(&url, 2, Duration::from_millis(100)).await.unwrap();
        let background = Background::new(&pool, &url, 1);
        let runs = std::sync::Arc::new(AtomicU32::new(0));
        let counted = runs.clone();
        let schedule = Schedule { interval: Duration::from_secs(3600), retries: vec![Duration::from_millis(50)] };
        spawn_job(&background, "test job", schedule, move || {
            let counted = counted.clone();
            async move {
                if counted.fetch_add(1, Ordering::SeqCst) == 0 { Err(JobError::Busy("locked".into())) } else { Ok(()) }
            }
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        while runs.load(Ordering::SeqCst) < 2 {
            assert!(std::time::Instant::now() < deadline, "the busy run was not tried again");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(Schedule::hourly().retries[0], Duration::from_secs(2));
        pool.close().await;
        dir.close().unwrap();
    }

    #[tokio::test]
    async fn sqlite_transactions_take_the_write_lock_at_begin() {
        let dir = tempfile::tempdir().unwrap();
        let url = crate::config::sqlite_url(&dir.path().join("k.db"));
        let pool = connect_with(&url, 2, Duration::from_millis(200)).await.unwrap();
        let _first = begin(&pool).await.unwrap();
        // The second waits for the lock at BEGIN, gives up after the busy timeout and says so as
        // busy; a deferred BEGIN would have succeeded and failed only at a later write.
        let e = begin(&pool).await.unwrap_err();
        assert_eq!(crate::error::ApiError::from(e).code, "busy");
        drop(_first);
        pool.close().await;
        dir.close().unwrap();
    }

    #[tokio::test]
    async fn reads_proceed_while_writers_hold_every_main_connection() {
        let dir = tempfile::tempdir().unwrap();
        let url = crate::config::sqlite_url(&dir.path().join("k.db"));
        let pool = connect_with(&url, 2, Duration::from_secs(15)).await.unwrap();
        sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ('u', 'u@example.de', 'U', 0)")
            .execute(&pool)
            .await
            .unwrap();
        let read = read_pool(&pool, &url, 2).expect("a file database has a read pool");
        // One writer holds the write lock, a second waits for it: the main pool is used up.
        let first = begin(&pool).await.unwrap();
        let waiting = tokio::spawn({
            let pool = pool.clone();
            async move { begin(&pool).await.map(drop) }
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while pool.num_idle() > 0 || pool.size() < 2 {
            assert!(std::time::Instant::now() < deadline, "the second writer did not start");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(tokio::time::timeout(Duration::from_millis(300), pool.acquire()).await.is_err(), "main pool busy");
        // A sign-in or permission lookup still answers at once.
        let started = std::time::Instant::now();
        let (n,): (i64,) = tokio::time::timeout(
            Duration::from_secs(5),
            sqlx::query_as("SELECT COUNT(*) FROM users WHERE id = 'u'").fetch_one(&read),
        )
        .await
        .expect("the read does not wait for the writers")
        .unwrap();
        assert_eq!(n, 1);
        assert!(started.elapsed() < Duration::from_secs(5));
        // The read pool cannot write, so SQLite keeps its single writer on the main pool.
        let e = sqlx::query("DELETE FROM users").execute(&read).await.unwrap_err();
        assert!(e.to_string().contains("readonly") || e.to_string().contains("read-only"), "{e}");
        drop(first);
        waiting.await.unwrap().unwrap();
        read.close().await;
        pool.close().await;
        dir.close().unwrap();
        // In memory there is no second pool; PostgreSQL has none either.
        let memory = connect_with("sqlite::memory:", 1, Duration::from_millis(10)).await.unwrap();
        for url in ["sqlite::memory:", "sqlite:file::memory:?cache=shared", "sqlite:k.db?mode=memory"] {
            assert!(read_pool(&memory, url, 1).is_none(), "{url}");
            assert!(side_pool(&memory, url, 1, Duration::from_millis(10)).is_none(), "{url}");
        }
    }

    /// A database a newer Kalzit migrated is refused with words that say so and name the backup,
    /// not with the migrator's message about a missing migration.
    #[tokio::test]
    async fn a_database_from_a_newer_version_is_refused_in_words() {
        let dir = tempfile::tempdir().unwrap();
        let url = crate::config::sqlite_url(&dir.path().join("k.db"));
        let pool = connect(&url, 1).await.unwrap();
        let future = latest_migration() + 1;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
             VALUES ({future}, 'from a newer Kalzit', 1, X'00', 0)"
        )))
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        let err = format!("{:#}", connect(&url, 1).await.unwrap_err());
        assert!(err.contains("written by a newer Kalzit"), "{err}");
        assert!(err.contains(&format!("schema {future}")) && err.contains("updates/backups"), "{err}");
        assert!(!err.contains("previously applied"), "{err}");
        dir.close().unwrap();
    }

    #[tokio::test]
    async fn sqlite_runs_in_wal_mode_with_the_busy_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let url = crate::config::sqlite_url(&dir.path().join("k.db"));
        let pool = connect_with(&url, 2, Duration::from_millis(1234)).await.unwrap();
        let (mode,): (String,) = sqlx::query_as("PRAGMA journal_mode").fetch_one(&pool).await.unwrap();
        assert_eq!(mode, "wal");
        // Every connection of the pool is set up alike, not only the first.
        let mut a = pool.acquire().await.unwrap();
        let mut b = pool.acquire().await.unwrap();
        for conn in [&mut a, &mut b] {
            let (ms,): (i64,) = sqlx::query_as("PRAGMA busy_timeout").fetch_one(&mut **conn).await.unwrap();
            assert_eq!(ms, 1234);
            let (limit,): (i64,) = sqlx::query_as("PRAGMA journal_size_limit").fetch_one(&mut **conn).await.unwrap();
            assert_eq!(limit, SQLITE_JOURNAL_SIZE_LIMIT as i64);
            // FULL: a commit is on disk before it is confirmed.
            let (sync,): (i64,) = sqlx::query_as("PRAGMA synchronous").fetch_one(&mut **conn).await.unwrap();
            assert_eq!(sync, 2);
        }
        drop((a, b));
        pool.close().await;
        dir.close().unwrap();
        // In memory there is no WAL; that is no error.
        connect_with("sqlite::memory:", 1, Duration::from_millis(10)).await.unwrap();
    }

    #[test]
    fn sqlite_urls_give_their_file() {
        let path = Path::new("/srv/a?b#c%d.db");
        assert_eq!(sqlite_file(&crate::config::sqlite_url(path)).as_deref(), Some(path));
        assert_eq!(
            sqlite_file("sqlite:C:/ProgramData/Kalzit/kalzit.db?mode=rwc"),
            Some("C:/ProgramData/Kalzit/kalzit.db".into())
        );
        assert_eq!(sqlite_file("sqlite::memory:"), None);
        assert_eq!(sqlite_file("sqlite:file::memory:?cache=shared"), None);
        assert_eq!(sqlite_file("sqlite:file:k.db?mode=memory&cache=shared"), None);
        assert_eq!(sqlite_file("sqlite:k.db?Mode=Memory"), None);
        assert_eq!(sqlite_file("sqlite:k.db?mode=rwc"), Some("k.db".into()));
        assert_eq!(sqlite_file("postgres://db/kalzit"), None);
    }

    #[test]
    fn network_paths_are_recognized() {
        for unc in [r"\\nas\share\kalzit", r"\\?\UNC\nas\share\kalzit", r"\\.\UNC\nas\share\kalzit"] {
            assert!(is_unc(unc), "{unc}");
        }
        for local in [r"C:\ProgramData\Kalzit", r"\\?\C:\ProgramData\Kalzit", r"\\.\pipe\x"] {
            assert!(!is_unc(local), "{local}");
        }
        assert_eq!(drive_root(r"\\?\z:\data").as_deref(), Some(r"Z:\"));
        assert_eq!(drive_root(r"C:\data").as_deref(), Some(r"C:\"));
        assert_eq!(drive_root("/var/lib/kalzit"), None);

        let mounts = "/dev/sda1 / ext4 rw 0 0\n\
                      nas:/export /mnt/nas nfs4 rw 0 0\n\
                      //nas/share /mnt/smb\\040share cifs rw 0 0\n\
                      /dev/sdb1 /mnt/nas/local ext4 rw 0 0\n";
        assert_eq!(remote_fs_type(mounts, Path::new("/var/lib/kalzit")), None);
        assert_eq!(remote_fs_type(mounts, Path::new("/mnt/nas/kalzit")).as_deref(), Some("nfs4"));
        assert_eq!(remote_fs_type(mounts, Path::new("/mnt/smb share/k")).as_deref(), Some("cifs"));
        // The longest mount point wins: a local disk mounted inside the share is local.
        assert_eq!(remote_fs_type(mounts, Path::new("/mnt/nas/local/k")), None);
    }

    #[cfg(windows)]
    #[test]
    fn a_local_data_directory_is_accepted() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ensure_local_disk(&dir.path().join("kalzit.db")).is_ok());
        assert!(network_storage(Path::new(r"\\nas\share")).is_some());
    }

    #[test]
    fn redact_hides_password() {
        assert_eq!(redact("postgres://kalzit:s3cr3t@db:5432/kalzit"), "postgres://kalzit:***@db:5432/kalzit");
        assert_eq!(redact("sqlite:data/kalzit.db?mode=rwc"), "sqlite:data/kalzit.db?mode=rwc");
        assert_eq!(
            redact("sqlite:C:/ProgramData/Kalzit/data/kalzit.db?mode=rwc"),
            "sqlite:C:/ProgramData/Kalzit/data/kalzit.db?mode=rwc"
        );
        assert_eq!(
            redact("postgres://db/kalzit?user=u&Password=secret&sslmode=require&dbname=k"),
            "postgres://db/kalzit?user=***&Password=***&sslmode=require&dbname=k"
        );
        assert_eq!(redact("postgres://kalzit%40x:p%40ss@db/kalzit"), "postgres://kalzit%40x:***@db/kalzit");
        assert_eq!(redact("postgres://kalzit@db/kalzit"), "postgres://kalzit@db/kalzit");
        assert_eq!(redact("postgres://db/kalzit"), "postgres://db/kalzit");
        assert_eq!(redact("not a url"), "<unparseable database url>");
        // Ambiguous: nothing but the scheme.
        assert_eq!(redact("postgres://u:2024/Summer@db:5432/kalzit"), "postgres://***");
    }

    struct Case {
        url: &'static str,
        password: &'static str,
        /// Must appear in the output (only for URLs that are not ambiguous).
        host: Option<&'static str>,
    }

    /// No piece of the password of three or more characters may appear in the log line.
    #[test]
    fn no_password_form_leaks() {
        let case = |url, password, host| Case { url, password, host };
        let cases = [
            // Raw special characters in the password move it into port, path or query.
            case("postgres://u:9123?x=1@db/k", "9123?x=1", None),
            case("postgres://u:7?a=1@host:5432", "7?a=1", None),
            case("postgres://u:771?2=3@4@db", "771?2=3@4", None),
            case("postgres://:pzsecret?ss=1@db", "pzsecret?ss=1", None),
            case("postgres://u/x:pwsecret?a=b@db", "pwsecret?a=b", None),
            case("postgres://u:asecret@b?c=dsecret@db", "asecret@b?c=dsecret", None),
            case("postgres://u:asecret?b=csecret@d@db", "asecret?b=csecret@d", None),
            case("postgres://u:asecret?b@c=dsecret@db", "asecret?b@c=dsecret", None),
            case("postgres://kalzit:a?bsecret@db/kalzit", "a?bsecret", None),
            case("postgres://kalzit:a#bsecret@db/kalzit", "a#bsecret", None),
            case("postgres://kalzit:a/bsecret@db/kalzit", "a/bsecret", None),
            case("postgres://u:12/ss@db/k", "12/ss", None),
            case("postgres://u:2024/Summer@db:5432/kalzit", "2024/Summer", None),
            case("postgres://u:9/x?y@db", "9/x?y", None),
            case("postgres://u:pass@word?x=1@db/k", "pass@word?x=1", None),
            case("postgres://u:a@sec#ret@db/k", "a@sec#ret", None),
            // An `@` in the query makes the URL ambiguous as well.
            case("postgres://host:5432/db?application_name=a@b&password=secret5", "secret5", None),
            case("postgres://[::1]:5432/db?application_name=a@b&password=secret6", "secret6", None),
            // Encoded keys are compared after decoding; unknown keys are masked as well.
            case("postgres://db/k?pass%77ord=secret1", "secret1", Some("postgres://db/k")),
            case("postgres://db/k?password%3Dx=1&PASSWORD=secret2", "secret2", Some("postgres://db/k")),
            case("postgres://db/k?options=-c%20x&pwd=secret3", "secret3", Some("postgres://db/k")),
            case("postgres://u:secret7@[2001:db8::1]:5432/db", "secret7", Some("u:***@[2001:db8::1]:5432/db")),
            case("postgres://u:secret%2F8@db:5432/k", "secret%2F8", Some("u:***@db:5432/k")),
            // No `//` after the scheme: no authority, nothing but the scheme is shown.
            case("postgres:/u:secret9@db/k", "secret9", Some("postgres:***")),
            case("postgres:u:secret10@db/k", "secret10", Some("postgres:***")),
            case("mysql:/u:secret11@h:3306/db", "secret11", Some("mysql:***")),
            case("postgres:x://u:secret12@db", "secret12", Some("postgres:***")),
        ];
        for Case { url, password, host } in cases {
            let out = redact(url);
            let chars: Vec<char> = password.chars().collect();
            for start in 0..chars.len() {
                for end in start + 3..=chars.len() {
                    let piece: String = chars[start..end].iter().collect();
                    assert!(!out.contains(&piece), "{url} leaks {piece:?} of its password: {out}");
                }
            }
            if let Some(host) = host {
                assert!(out.contains(host), "{url} lost its host: {out}");
            }
        }
    }

    #[test]
    fn ambiguous_urls_are_reported() {
        for url in [
            "postgres://u:a@b?c@db",
            "postgres://u:a?b@db",
            "postgres://u:a#b@db",
            "postgres://u:2024/Summer@db",
            "postgres://db/k?x=a@b",
        ] {
            let warning = ambiguity(url).unwrap_or_else(|| panic!("{url}"));
            assert!(warning.contains("percent-encode") || warning.contains("Percent-encode"), "{warning}");
        }
        for url in [
            "postgres://u:p%40ss@db/k?sslmode=require",
            "postgres://u:a@b@db",
            "postgres://db/k",
            "sqlite:data/kalzit.db?mode=rwc",
        ] {
            assert_eq!(ambiguity(url), None, "{url}");
        }
    }
}
