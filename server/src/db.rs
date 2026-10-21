//! The server's own database: SQLite by default, PostgreSQL for larger installations. Both run
//! the same portable migrations through sqlx's `Any` driver.
//!
//! SQLite runs on one host with the database on a local disk; shared storage or several Kalzit
//! servers on one database need PostgreSQL.

use std::cell::Cell;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::any::AnyPoolOptions;
use sqlx::{Any, AnyPool, Transaction};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// How long a SQLite statement waits for a lock another connection holds before the request
/// answers `503 busy`. Locks are normally held for milliseconds; this covers a slow disk or a
/// burst of writers (the CI runners on Windows are both).
pub const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(15);

/// The size the WAL file is cut back to after a checkpoint, so a burst of writes does not leave a
/// large file behind (64 MiB).
const SQLITE_JOURNAL_SIZE_LIMIT: u64 = 64 * 1024 * 1024;

/// How long the server's own background writes (session touches, the hourly jobs) wait for the
/// write lock on SQLite before they give up. Short, because SQLite keeps waiting even when the
/// write is dropped, and closing the database at a stop waits for that.
pub const BACKGROUND_BUSY_TIMEOUT: Duration = Duration::from_secs(1);

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
    MIGRATOR.run(&pool).await.context("running database migrations")?;
    Ok(pool)
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

/// The writes the server makes on its own, outside requests: session touches and the hourly
/// jobs. They run as tasks the server aborts when it stops, and on SQLite through a `side_pool`
/// that waits at most `BACKGROUND_BUSY_TIMEOUT` for the write lock, so a stop never waits the
/// full busy timeout for one. Each of them is repeated later, so a dropped one costs nothing.
pub struct Background {
    db: AnyPool,
    own_pool: bool,
    /// `None` once stopped: nothing new starts.
    tasks: Mutex<Option<tokio::task::JoinSet<()>>>,
}

impl Background {
    /// For the server's pool `main` on `url`, with up to `max_connections` of its own on SQLite.
    pub fn new(main: &AnyPool, url: &str, max_connections: u32) -> Self {
        let own = side_pool(main, url, max_connections, BACKGROUND_BUSY_TIMEOUT);
        Self {
            own_pool: own.is_some(),
            db: own.unwrap_or_else(|| main.clone()),
            tasks: Mutex::new(Some(tokio::task::JoinSet::new())),
        }
    }

    /// The pool background writes go through.
    pub fn db(&self) -> &AnyPool {
        &self.db
    }

    /// Connections of the own pool in use right now: background writes running or waiting for
    /// the lock (tests). 0 without an own pool.
    pub fn connections_in_use(&self) -> u32 {
        if !self.own_pool {
            return 0;
        }
        self.db.size().saturating_sub(self.db.num_idle() as u32)
    }

    /// Runs `task` until it ends or the server stops; after the stop it does not start.
    pub fn spawn(&self, task: impl Future<Output = ()> + Send + 'static) {
        if let Some(tasks) = self.lock_tasks().as_mut() {
            // Finished tasks leave their result in the set; drop them so it does not grow.
            while tasks.try_join_next().is_some() {}
            tasks.spawn(task);
        }
    }

    /// Aborts every task for good and closes the own pool, which waits at most
    /// `BACKGROUND_BUSY_TIMEOUT` for a write that is waiting for the lock.
    pub async fn stop(&self) {
        let tasks = self.lock_tasks().take();
        if let Some(mut tasks) = tasks {
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
        }
        if self.own_pool {
            self.db.close().await;
        }
    }

    fn lock_tasks(&self) -> MutexGuard<'_, Option<tokio::task::JoinSet<()>>> {
        // The set holds no invariant a panic could break.
        self.tasks.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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
/// databases and for an in-memory one.
fn sqlite_file(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("sqlite:")?;
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    let path = rest.split('?').next().unwrap_or(rest);
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

/// The URL without a password, for log lines.
pub fn redact(url: &str) -> String {
    let (base, query) = match url.split_once('?') {
        Some((b, q)) => (b, Some(q)),
        None => (url, None),
    };
    let base = match (base.find("://"), base.rfind('@')) {
        (Some(scheme_end), Some(at)) if at > scheme_end => {
            let user = base[scheme_end + 3..at].split(':').next().unwrap_or("");
            format!("{}://{}:***@{}", &base[..scheme_end], user, &base[at + 1..])
        }
        _ => base.to_string(),
    };
    let Some(query) = query else { return base };
    // PostgreSQL also takes credentials as parameters: ?user=u&password=secret.
    let query: Vec<String> = query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((key, _)) if SECRET_PARAMS.contains(&key.to_ascii_lowercase().as_str()) => format!("{key}=***"),
            _ => pair.to_string(),
        })
        .collect();
    format!("{base}?{}", query.join("&"))
}

const SECRET_PARAMS: &[&str] = &["password", "pass", "pwd", "sslpassword", "sslkey"];

/// When a recurring job runs: at the start and then every `interval`. A run that finds the
/// database busy is tried again after each of `retries` in turn, as long as that comes before the
/// next run.
#[derive(Clone, Debug)]
pub struct Schedule {
    pub interval: Duration,
    pub retries: Vec<Duration>,
}

impl Schedule {
    /// Every hour; after `busy` again in 1, 2 and 4 minutes.
    pub fn hourly() -> Self {
        let minutes = |m: u64| Duration::from_secs(m * 60);
        Self { interval: minutes(60), retries: vec![minutes(1), minutes(2), minutes(4)] }
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
    background.spawn(async move {
        let mut tick = tokio::time::interval(schedule.interval);
        loop {
            let next = tick.tick().await + schedule.interval;
            let mut retries = schedule.retries.iter();
            loop {
                match job().await {
                    Ok(()) => break,
                    Err(JobError::Busy(e)) => match retries.next() {
                        Some(&wait) if tokio::time::Instant::now() + wait < next => {
                            tracing::debug!("{what}: the database is busy, trying again in {wait:?}: {e}");
                            tokio::time::sleep(wait).await;
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
    let background = state.background.clone();
    spawn_job(&background, "removing ended sessions", Schedule::hourly(), move || {
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
    });
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
            redact("postgres://db/kalzit?user=u&Password=secret&sslmode=require"),
            "postgres://db/kalzit?user=u&Password=***&sslmode=require"
        );
    }
}
