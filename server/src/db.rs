//! The server's own database: SQLite by default, PostgreSQL for larger installations. Both run
//! the same portable migrations through sqlx's `Any` driver.

use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::AnyPool;
use sqlx::any::AnyPoolOptions;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// How long a SQLite statement waits for a lock another connection holds before the request
/// answers `503 busy`. Locks are normally held for milliseconds; this covers a slow disk or a
/// burst of writers (the CI runners on Windows are both).
pub const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(15);

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
/// which virus scanners slow down. Transactions start with a write (`authz::lock_org` or the
/// change itself), so they never hold a read snapshot that a commit makes stale.
pub async fn connect_with(url: &str, max_connections: u32, busy_timeout: Duration) -> Result<AnyPool> {
    sqlx::any::install_default_drivers();
    let busy_ms = busy_timeout.as_millis();
    let pool = AnyPoolOptions::new()
        .max_connections(max_connections)
        .after_connect(move |conn, _| {
            Box::pin(async move {
                if conn.backend_name() == "SQLite" {
                    // Per connection. `synchronous` stays at its default (FULL), so a committed
                    // change survives a power loss too.
                    let pragma = format!("PRAGMA busy_timeout = {busy_ms}");
                    sqlx::query(sqlx::AssertSqlSafe(pragma)).execute(&mut *conn).await?;
                }
                Ok(())
            })
        })
        .connect(url)
        .await
        .with_context(|| format!("connecting to the database ({})", redact(url)))?;
    let mut conn = pool.acquire().await.context("connecting to the database")?;
    if conn.backend_name() == "SQLite" {
        // Stored in the database file, so one switch covers every later connection. An in-memory
        // database keeps its own journal ("memory") and ignores this.
        let (mode,): (String,) =
            sqlx::query_as("PRAGMA journal_mode = WAL").fetch_one(&mut *conn).await.context("enabling WAL")?;
        if !matches!(mode.as_str(), "wal" | "memory") {
            anyhow::bail!(
                "the SQLite database stays in journal mode {mode}; WAL is required (is it on a network share?)"
            );
        }
    }
    drop(conn);
    MIGRATOR.run(&pool).await.context("running database migrations")?;
    Ok(pool)
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

    /// Guard for the write-first rule (see `connect_with`): after every `begin()` in the server,
    /// the first database statement is a write or one of the lock helpers, which start with one.
    /// A transaction that reads first holds a SQLite read snapshot, and its first write then
    /// fails at once (`SQLITE_BUSY_SNAPSHOT`, no waiting) when another writer committed in
    /// between. A source check, since wrapping every transaction to watch its first statement
    /// would touch every call site and the sqlx types they use.
    #[test]
    fn transactions_write_first() {
        const WRITES: &[&str] = &[
            "UPDATE ",
            "INSERT ",
            "DELETE ",
            "lock_org(",
            "lock_place(",
            "locked_tree(",
            "lock_server_admins(",
            "lock_orgs_left_without_owner(",
            "settings::store(",
            "session::delete",
            "delete_for_user(",
        ];
        const READS: &[&str] =
            &["SELECT ", "fetch_", "::load(", "load(&mut", "_role(", "resource_exists(", "_checked("];
        let first = |text: &str, markers: &[&str]| markers.iter().filter_map(|m| text.find(m)).min();
        let mut files = vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
        let mut checked = 0;
        while let Some(path) = files.pop() {
            if path.is_dir() {
                files.extend(std::fs::read_dir(&path).unwrap().map(|e| e.unwrap().path()));
                continue;
            }
            if path.extension().is_none_or(|e| e != "rs") || path.ends_with("db.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            let lines: Vec<&str> = source.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if !line.contains(".begin().await") {
                    continue;
                }
                let after: String = lines[i + 1..(i + 16).min(lines.len())]
                    .iter()
                    .filter(|l| !l.trim_start().starts_with("//"))
                    .copied()
                    .collect::<Vec<_>>()
                    .join("\n");
                let write = first(&after, WRITES);
                let read = first(&after, READS);
                let ok = matches!((write, read), (Some(w), Some(r)) if w < r) || (write.is_some() && read.is_none());
                assert!(ok, "{}:{}: the transaction must write before it reads", path.display(), i + 1);
                checked += 1;
            }
        }
        assert!(checked > 20, "only {checked} transactions found; is the guard still looking at the code?");
    }

    #[tokio::test]
    async fn sqlite_runs_in_wal_mode_with_the_busy_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let url = crate::config::sqlite_url(&dir.path().join("k.db"));
        let pool = connect_with(&url, 2, Duration::from_millis(1234)).await.unwrap();
        let (mode,): (String,) = sqlx::query_as("PRAGMA journal_mode").fetch_one(&pool).await.unwrap();
        assert_eq!(mode, "wal");
        // Every connection of the pool waits as long, not only the first.
        let mut a = pool.acquire().await.unwrap();
        let mut b = pool.acquire().await.unwrap();
        for conn in [&mut a, &mut b] {
            let (ms,): (i64,) = sqlx::query_as("PRAGMA busy_timeout").fetch_one(&mut **conn).await.unwrap();
            assert_eq!(ms, 1234);
        }
        drop((a, b));
        pool.close().await;
        // In memory there is no WAL; that is no error.
        connect_with("sqlite::memory:", 1, Duration::from_millis(10)).await.unwrap();
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
