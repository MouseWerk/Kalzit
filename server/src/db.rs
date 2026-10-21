//! The server's own database: SQLite by default, PostgreSQL for larger installations. Both run
//! the same portable migrations through sqlx's `Any` driver.
//!
//! SQLite runs on one host with the database on a local disk; shared storage or several Kalzit
//! servers on one database need PostgreSQL.

use std::path::{Path, PathBuf};
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
    let busy_ms = busy_timeout.as_millis();
    let pool = AnyPoolOptions::new()
        .max_connections(max_connections)
        .after_connect(move |conn, _| {
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

/// Starts a transaction that holds the write lock from its first statement: `BEGIN IMMEDIATE` on
/// SQLite, which waits for the lock with the busy timeout instead of failing later when a read
/// snapshot turns stale (`SQLITE_BUSY_SNAPSHOT`); a plain `BEGIN` on PostgreSQL, whose row locks
/// do the ordering. Every transaction of the server starts here (a guard test checks it).
pub async fn begin(pool: &AnyPool) -> Result<Transaction<'static, Any>, sqlx::Error> {
    if pool.connect_options().database_url.scheme() == "sqlite" {
        pool.begin_with("BEGIN IMMEDIATE").await
    } else {
        pool.begin().await
    }
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
    let dir = file.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if let Some(kind) = network_storage(&dir) {
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
    let root = drive_root(&path)?;
    let wide: Vec<u16> = root.encode_utf16().chain([0]).collect();
    /// `GetDriveTypeW` answers this for a remote (network) drive.
    const DRIVE_REMOTE: u32 = 4;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDriveTypeW(root_path_name: *const u16) -> u32;
    }
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call, which only reads it.
    let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
    (kind == DRIVE_REMOTE).then(|| format!("network drive {root}"))
}

/// `\\server\share\...` and its long form `\\?\UNC\server\share\...`; not `\\?\C:\...`.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_unc(path: &str) -> bool {
    path.starts_with(r"\\?\UNC\")
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
    let mounts = std::fs::read_to_string("/proc/self/mounts").ok()?;
    remote_fs_type(&mounts, dir).map(|fs| format!("file system {fs}"))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn network_storage(_dir: &Path) -> Option<String> {
    None
}

/// File systems that reach the data over the network (or across a VM boundary, like WSL's 9p),
/// where SQLite's locks cannot be trusted.
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

/// Deletes sessions that have ended, every hour. Sessions are otherwise only deleted when their
/// cookie is presented again, and most expired cookies never come back.
pub fn spawn_session_cleanup(state: crate::app::AppState) {
    const INTERVAL: std::time::Duration = std::time::Duration::from_secs(3600);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(INTERVAL);
        loop {
            tick.tick().await;
            let now = state.clock.now_ms();
            match crate::auth::session::delete_ended(&state.db, &state.config.sessions, now).await {
                Ok(0) => {}
                Ok(n) => tracing::debug!("removed {n} ended sessions"),
                Err(e) => tracing::warn!("removing ended sessions failed, will retry in an hour: {e}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every transaction starts through `begin` (`BEGIN IMMEDIATE` on SQLite), so none can hold a
    /// read snapshot before its first write. No `.begin()` or `begin_with` anywhere else.
    #[test]
    fn transactions_start_through_db_begin() {
        let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let this = src.join("db.rs");
        let mut files = vec![src];
        let mut offenders = Vec::new();
        let mut scanned = 0;
        while let Some(path) = files.pop() {
            if path.is_dir() {
                files.extend(std::fs::read_dir(&path).unwrap().map(|e| e.unwrap().path()));
                continue;
            }
            if path.extension().is_none_or(|e| e != "rs") || path == this {
                continue;
            }
            scanned += 1;
            let source = std::fs::read_to_string(&path).unwrap();
            for (i, line) in source.lines().enumerate() {
                if line.contains(".begin()") || line.contains("begin_with") {
                    offenders.push(format!("{}:{}", path.display(), i + 1));
                }
            }
        }
        assert!(scanned > 20, "only {scanned} files scanned; is the guard still looking at the code?");
        assert!(offenders.is_empty(), "start transactions with db::begin: {offenders:?}");
    }

    /// After a commit, a handler must not touch the database again: a busy error there would tell
    /// the client "nothing changed" although the change is saved. Everything a reply needs is
    /// read inside the transaction. Checked from each `tx.commit()` to the end of its function or
    /// branch (a `return`, or the function's closing brace).
    #[test]
    fn nothing_reads_the_database_after_a_commit() {
        let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        // This file holds the guard's own patterns, and no handler.
        let this = src.join("db.rs");
        let mut files = vec![src];
        let mut offenders = Vec::new();
        let mut commits = 0;
        while let Some(path) = files.pop() {
            if path.is_dir() {
                files.extend(std::fs::read_dir(&path).unwrap().map(|e| e.unwrap().path()));
                continue;
            }
            if path.extension().is_none_or(|e| e != "rs") || path == this {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            let lines: Vec<&str> = source.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if !line.contains("tx.commit().await?") {
                    continue;
                }
                commits += 1;
                for (j, after) in lines.iter().enumerate().skip(i + 1) {
                    if *after == "}" || after.trim_start().starts_with("return ") {
                        break;
                    }
                    if after.contains("state.db") || after.contains(".acquire()") || after.contains("(&state,") {
                        offenders.push(format!("{}:{}", path.display(), j + 1));
                    }
                }
            }
        }
        assert!(commits > 20, "only {commits} commits found; is the guard still looking at the code?");
        assert!(offenders.is_empty(), "database use after a commit: {offenders:?}");
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
        for unc in [r"\\nas\share\kalzit", r"\\?\UNC\nas\share\kalzit"] {
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
