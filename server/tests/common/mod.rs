//! Helpers shared by the integration tests.

// Each test binary compiles this module and uses only part of it.
#![allow(dead_code)]

use std::sync::Arc;

use kalzit::app::AppState;

/// How long a test waits for something that happens by itself (a background job, a reload)
/// before it calls it a hang. It only guards against hangs on slow CI runners; the test asserts
/// the behaviour itself.
pub const HANG_GUARD: std::time::Duration = std::time::Duration::from_secs(60);

/// A temporary directory that passes the data directory check: closed to group and others on
/// Unix (`tempfile` creates it with the umask's mode, often 0755). On Windows it keeps the ACL of
/// the user's temporary folder, which the ACL check accepts.
pub fn private_tempdir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    dir
}

/// Ends a test app: stops its background work and closes its databases, then deletes its data
/// directory. Windows cannot delete a file that is still open, and a `TempDir` that is simply
/// dropped ignores that error, so every test app's `kalzit.db` stayed behind in the temporary
/// folder. Deleting here fails the test instead.
pub struct Finish {
    state: AppState,
    dir: Arc<tempfile::TempDir>,
    schema: Option<PgSchema>,
}

impl Finish {
    /// For the app on `state` whose data directory is `dir`. The app keeps its own handle on
    /// `dir`; it must be gone before `finish` runs.
    pub fn new(state: AppState, dir: Arc<tempfile::TempDir>) -> Self {
        Self { state, dir, schema: None }
    }

    /// Also drops the app's PostgreSQL schema (`database`), once the app is closed.
    pub fn with_schema(mut self, schema: Option<PgSchema>) -> Self {
        self.schema = schema;
        self
    }

    pub async fn finish(self) {
        self.state.close().await;
        drop(self.state);
        remove_dir(Arc::try_unwrap(self.dir).expect("the test app still holds its data directory"));
        if let Some(schema) = self.schema {
            schema.drop_now().await;
        }
    }
}

/// Deletes a test's temporary directory and fails the test when that does not work, where a
/// dropped `TempDir` would give up silently (see `Finish`).
pub fn remove_dir(dir: tempfile::TempDir) {
    let path = dir.path().to_path_buf();
    if let Err(e) = dir.close() {
        panic!("the data directory {} was not deleted: {e}", path.display());
    }
}

/// Whether the environment variable `name` is `1`.
fn flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| v == "1")
}

/// The PostgreSQL test database (`KALZIT_TEST_POSTGRES_URL`), or `None` where none is set. Where
/// one is expected (`KALZIT_TEST_REQUIRE_POSTGRES=1`, as in the CI jobs on PostgreSQL, or
/// `KALZIT_TEST_REQUIRE_DATABASES=1`), a missing URL fails the test instead of skipping it.
pub fn postgres_base() -> Option<String> {
    match std::env::var("KALZIT_TEST_POSTGRES_URL") {
        Ok(url) if !url.is_empty() => Some(url),
        _ if flag("KALZIT_TEST_REQUIRE_POSTGRES") || flag("KALZIT_TEST_REQUIRE_DATABASES") => {
            panic!("KALZIT_TEST_POSTGRES_URL is not set, but PostgreSQL is required (KALZIT_TEST_REQUIRE_*=1)")
        }
        _ => None,
    }
}

/// `postgres_base` for a test that only runs on PostgreSQL: says what was not run without it.
pub fn postgres_url(what: &str) -> Option<String> {
    let url = postgres_base();
    if url.is_none() {
        eprintln!("KALZIT_TEST_POSTGRES_URL not set, {what} not run");
    }
    url
}

/// A throwaway schema on the PostgreSQL test database, dropped with everything in it when the
/// test is done: by `drop_now` where the test gets there, otherwise (a failed test) when the
/// guard is dropped.
pub struct PgSchema {
    base: String,
    name: String,
    /// The database URL that works in the schema.
    pub url: String,
    dropped: bool,
}

/// A throwaway schema on the PostgreSQL database at `base`.
pub async fn postgres_schema(base: &str) -> PgSchema {
    let name = format!("kalzit_test_{}", uuid::Uuid::now_v7().simple());
    sqlx::any::install_default_drivers();
    let admin = sqlx::AnyPool::connect(base).await.unwrap();
    // The schema name is a fixed prefix plus UUID hex digits, so it is safe to splice in.
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {name}"))).execute(&admin).await.unwrap();
    admin.close().await;
    let sep = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{sep}options=-csearch_path%3D{name}");
    PgSchema { base: base.to_string(), name, url, dropped: false }
}

impl PgSchema {
    /// Drops the schema now; fails the test when that does not work.
    pub async fn drop_now(mut self) {
        self.dropped = true;
        drop_schema(&self.base, &self.name).await.unwrap();
    }
}

impl Drop for PgSchema {
    fn drop(&mut self) {
        if self.dropped {
            return;
        }
        // Drop cannot wait on the test's runtime, so a thread of its own does the work. A lock
        // the ended test still holds gives up after the lock timeout rather than hanging.
        let (base, name) = (self.base.clone(), self.name.clone());
        let done = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
            runtime.block_on(drop_schema(&base, &name)).map_err(std::io::Error::other)
        })
        .join();
        if !matches!(done, Ok(Ok(()))) {
            eprintln!("the test schema {} was not dropped", self.name);
        }
    }
}

async fn drop_schema(base: &str, name: &str) -> Result<(), sqlx::Error> {
    sqlx::any::install_default_drivers();
    let admin = sqlx::AnyPool::connect(base).await?;
    let mut conn = admin.acquire().await?;
    sqlx::query("SET lock_timeout = '10s'").execute(&mut *conn).await?;
    // A fixed prefix plus hex digits (`postgres_schema`): safe to splice in.
    sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA IF EXISTS {name} CASCADE"))).execute(&mut *conn).await?;
    drop(conn);
    admin.close().await;
    Ok(())
}

/// The database for a test app that runs on either database: a throwaway schema on PostgreSQL
/// where `KALZIT_TEST_POSTGRES_URL` is set (its `url` goes into `database.url`, and the app keeps
/// the guard), otherwise `None` (SQLite in the data directory).
pub async fn database() -> Option<PgSchema> {
    match postgres_base() {
        Some(base) => Some(postgres_schema(&base).await),
        None => None,
    }
}
