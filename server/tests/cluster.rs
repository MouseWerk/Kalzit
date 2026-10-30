//! Several Kalzit servers on one database (`kalzit::cluster`): two servers on one PostgreSQL
//! database when `KALZIT_TEST_POSTGRES_URL` is set (CI job `postgres`), each in a throwaway
//! schema; and the refusal of a second server on one SQLite database, everywhere.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Request, StatusCode, header};
use kalzit::app::{AppState, router};
use kalzit::clock::{Clock, SystemClock};
use kalzit::cluster::{Change, Options};
use kalzit::config::Config;
use serde_json::json;
use tower::ServiceExt;

mod common;

/// Short timings, so a failover takes a second or two.
fn fast() -> Options {
    Options {
        heartbeat: Duration::from_millis(200),
        lease: Duration::from_millis(1200),
        poll: Duration::from_millis(300),
        job_check: Duration::from_millis(100),
    }
}

/// Polls `done` until it holds, for at most `within`.
async fn eventually<F, Fut>(what: &str, within: Duration, mut done: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = Instant::now() + within;
    while !done().await {
        assert!(Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A throwaway schema on the test database, dropped by `drop_schema`.
struct Schema {
    admin: sqlx::AnyPool,
    name: String,
    url: String,
}

async fn schema() -> Option<Schema> {
    let Ok(base) = std::env::var("KALZIT_TEST_POSTGRES_URL") else {
        eprintln!("KALZIT_TEST_POSTGRES_URL not set, PostgreSQL cluster test not run");
        return None;
    };
    sqlx::any::install_default_drivers();
    let admin = sqlx::AnyPool::connect(&base).await.unwrap();
    let name = format!("kalzit_test_{}", uuid::Uuid::now_v7().simple());
    // A fixed prefix plus hex digits: safe to splice in.
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {name}"))).execute(&admin).await.unwrap();
    let sep = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{sep}options=-csearch_path%3D{name}");
    Some(Schema { admin, name, url })
}

impl Schema {
    async fn drop_schema(self) {
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {} CASCADE", self.name)))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
}

/// One server: its state with the cluster loops started, and its data directory.
struct Server {
    state: AppState,
    dir: Arc<tempfile::TempDir>,
}

impl Server {
    async fn start(url: &str) -> Self {
        Self::start_in(url, Arc::new(common::private_tempdir())).await
    }

    /// A server on the data directory `dir` (a restart uses the one before).
    async fn start_in(url: &str, dir: Arc<tempfile::TempDir>) -> Self {
        let mut config = Config::default();
        config.paths.data_dir = dir.path().to_path_buf();
        config.database.url = Some(url.to_string());
        let pool = kalzit::db::connect(url, 4).await.unwrap();
        let state = AppState::new(config, pool, Arc::new(SystemClock), None).await.unwrap();
        state.cluster.set_options(fast());
        kalzit::cluster::start(&state).await.unwrap();
        Self { state, dir }
    }

    async fn status(&self, path: &str, cookie: &str) -> StatusCode {
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let req = Request::builder()
            .uri(path)
            .header(header::HOST, "kalzit.test")
            .header(header::COOKIE, cookie)
            .body(Body::empty())
            .unwrap();
        router(self.state.clone()).layer(MockConnectInfo(peer)).oneshot(req).await.unwrap().status()
    }

    async fn finish(self) {
        common::Finish::new(self.state, self.dir).finish().await;
    }
}

/// Exactly one of the two leads; when it stops, the other takes over within a lease, and a
/// server that stopped without handing over (its heartbeat ended, as in a crash) loses the lead
/// to the other once its lease has passed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_one_leader_and_failover() {
    let Some(schema) = schema().await else { return };
    let a = Server::start(&schema.url).await;
    let b = Server::start(&schema.url).await;
    eventually("one of two leads", common::HANG_GUARD, || async {
        a.state.cluster.is_leader() ^ b.state.cluster.is_leader()
    })
    .await;
    assert!(a.state.cluster.is_leader(), "the first server took the lease");
    assert!(a.state.cluster.has_peers() || b.state.cluster.has_peers());
    // The view names both and the leader.
    let view = kalzit::cluster::view(&b.state).await.unwrap();
    assert_eq!((view.mode, view.database), ("cluster", "postgres"));
    assert_eq!(view.instances.len(), 2);
    let leader: Vec<_> = view.instances.iter().filter(|i| i.leader).map(|i| i.id.clone()).collect();
    assert_eq!(leader, vec![a.state.cluster.id().to_string()]);
    assert!(view.instances.iter().all(|i| i.alive));
    // Several servers: no server replaces its own binary.
    eventually("updates per server", common::HANG_GUARD, || async {
        matches!(b.state.updates.mode(), kalzit::updates::platform::Mode::Manual(_))
    })
    .await;

    // A clean stop hands the lease over at once; the other leads at its next heartbeat.
    let stopped = Instant::now();
    a.finish().await;
    eventually("the other server leads after the stop", Duration::from_secs(10), || async {
        b.state.cluster.is_leader()
    })
    .await;
    assert!(stopped.elapsed() < Duration::from_secs(10));
    let view = kalzit::cluster::view(&b.state).await.unwrap();
    let gone = view.instances.iter().find(|i| !i.current).unwrap();
    assert!(!gone.alive && gone.stopped_at.is_some() && !gone.leader);

    // A server whose heartbeat stops without a hand-over (a crash) keeps the lease until it
    // passes; then the other takes it with a new term.
    let c = Server::start(&schema.url).await;
    let term = kalzit::cluster::view(&c.state).await.unwrap().leader_term;
    b.state.background.stop().await;
    let crashed = Instant::now();
    eventually("the lead moves after the lease passed", common::HANG_GUARD, || async { c.state.cluster.is_leader() })
        .await;
    assert!(crashed.elapsed() >= Duration::from_millis(500), "not before the lease could pass");
    assert!(!b.state.cluster.is_leader(), "the silent server no longer counts itself the leader");
    assert!(kalzit::cluster::view(&c.state).await.unwrap().leader_term > term);
    b.finish().await;
    c.finish().await;
    schema.drop_schema().await;
}

/// A settings change on one server is seen on the other well before the settings cache's TTL
/// (30 seconds), and a new rights generation reaches the other server's query cache.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_changes_reach_the_other_server() {
    let Some(schema) = schema().await else { return };
    let a = Server::start(&schema.url).await;
    let b = Server::start(&schema.url).await;
    let key = "audit.retention_days";
    assert_eq!(kalzit::settings::get(&b.state, key).await.unwrap(), json!(365));

    // As `PATCH /admin/settings/{key}` does: store, commit, drop the cache.
    let mut tx = kalzit::db::begin(&a.state.db).await.unwrap();
    let now = SystemClock.now_ms();
    let stored = kalzit::settings::store(&mut tx, None, key, &json!(30), 0, "u-1", now).await.unwrap();
    assert_eq!(stored, Some(1));
    kalzit::db::commit(tx).await.unwrap();
    let changed = Instant::now();
    kalzit::settings::cache(&a.state).invalidate(None);
    eventually("the other server sees the new value", Duration::from_secs(10), || async {
        kalzit::settings::get(&b.state, key).await.unwrap() == json!(30)
    })
    .await;
    assert!(changed.elapsed() < Duration::from_secs(10), "within seconds, not the cache's 30 seconds");

    let stamp = b.state.datasources.query_cache().stamp("org-1", "ds-1");
    a.state.datasources.query_cache().rights_changed(Some("org-1"));
    eventually("the rights generation moves on the other server", Duration::from_secs(10), || async {
        b.state.datasources.query_cache().stamp("org-1", "ds-1") != stamp
    })
    .await;
    let stamp = b.state.datasources.query_cache().stamp("org-1", "ds-1");
    a.state.datasources.forget("ds-1");
    eventually("the data source generation moves on the other server", Duration::from_secs(10), || async {
        b.state.datasources.query_cache().stamp("org-1", "ds-1") != stamp
    })
    .await;
    // A change is not applied twice on the server that made it.
    let own = a.state.datasources.query_cache().stamp("org-1", "ds-1");
    a.state.cluster.publish(Change::Rights(Some("org-2".into())));
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(a.state.datasources.query_cache().stamp("org-1", "ds-1"), own);

    a.finish().await;
    b.finish().await;
    schema.drop_schema().await;
}

/// A session ended on one server is refused on the other at once: sessions live in the database
/// and are looked up per request.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_a_session_ended_on_one_server_is_refused_on_the_other() {
    let Some(schema) = schema().await else { return };
    let a = Server::start(&schema.url).await;
    let b = Server::start(&schema.url).await;
    sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ('u-1', 'u@example.de', 'U', 0)")
        .execute(&a.state.db)
        .await
        .unwrap();
    let now = SystemClock.now_ms();
    let token = kalzit::auth::session::create(&a.state.db, &a.state.config.sessions, now, "u-1").await.unwrap();
    let cookie = format!("kalzit_session={token}");
    assert_eq!(a.status("/api/me", &cookie).await, StatusCode::OK);
    assert_eq!(b.status("/api/me", &cookie).await, StatusCode::OK);
    // As `POST /auth/logout` does on the first server.
    kalzit::auth::session::delete(&a.state.db, &token).await.unwrap();
    assert_eq!(b.status("/api/me", &cookie).await, StatusCode::UNAUTHORIZED);
    a.finish().await;
    b.finish().await;
    schema.drop_schema().await;
}

/// A job that must run once runs once across both servers per interval, even though each
/// looks every 100 milliseconds.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_a_run_once_job_runs_once() {
    let Some(schema) = schema().await else { return };
    let a = Server::start(&schema.url).await;
    let b = Server::start(&schema.url).await;
    let runs = Arc::new(AtomicUsize::new(0));
    for server in [&a, &b] {
        let counted = runs.clone();
        let schedule = kalzit::db::Schedule { interval: Duration::from_secs(3600), retries: vec![] };
        kalzit::cluster::spawn_job(&server.state, "test:once", "a test job", schedule, move || {
            let counted = counted.clone();
            async move {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        });
    }
    eventually("the job ran", common::HANG_GUARD, || async { runs.load(Ordering::SeqCst) > 0 }).await;
    // Both servers looked many times since.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    // A new leader does not run it again within the interval.
    a.finish().await;
    eventually("the other server leads", Duration::from_secs(10), || async { b.state.cluster.is_leader() }).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    b.finish().await;
    schema.drop_schema().await;
}

/// A server that restarts on its data directory after a crash (its old row never signed off,
/// its heartbeat still fresh) is known by its node id: it counts no peer and runs as a single
/// server. The old row is left alone while its heartbeat is fresh and marked stopped after.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_a_restarted_single_server_has_no_peers() {
    let Some(schema) = schema().await else { return };
    let first = Server::start(&schema.url).await;
    // A crash: the loops end, nothing is signed off.
    first.state.background.stop().await;
    let again = Server::start_in(&schema.url, first.dir.clone()).await;
    assert_eq!(again.state.cluster.node(), first.state.cluster.node(), "the node id stays with the data directory");
    assert!(!again.state.cluster.has_peers(), "the earlier run of the same server is no peer");
    assert!(
        !matches!(again.state.updates.mode(), kalzit::updates::platform::Mode::Manual("updates.mode_cluster")),
        "a single server keeps its own update mode"
    );
    let view = kalzit::cluster::view(&again.state).await.unwrap();
    assert_eq!(view.mode, "single");
    eventually("the earlier run is marked stopped once silent", common::HANG_GUARD, || async {
        let view = kalzit::cluster::view(&again.state).await.unwrap();
        view.instances.iter().find(|i| !i.current).is_some_and(|i| i.stopped_at.is_some() && !i.alive)
    })
    .await;
    first.state.close().await;
    drop(first);
    again.finish().await;
    schema.drop_schema().await;
}

/// A change whose event row the other server never reads (here: removed in the writing
/// transaction itself) still reaches it within a poll, through the counter the same transaction
/// raised.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_a_change_without_its_event_is_taken_by_the_counters() {
    let Some(schema) = schema().await else { return };
    let a = Server::start(&schema.url).await;
    let b = Server::start(&schema.url).await;
    let key = "audit.retention_days";
    assert_eq!(kalzit::settings::get(&b.state, key).await.unwrap(), json!(365));
    let mut tx = kalzit::db::begin(&a.state.db).await.unwrap();
    let now = SystemClock.now_ms();
    let stored = kalzit::settings::store(&mut tx, None, key, &json!(45), 0, "u-1", now).await.unwrap();
    assert_eq!(stored, Some(1));
    sqlx::query("DELETE FROM cluster_events").execute(&mut *tx).await.unwrap();
    kalzit::db::commit(tx).await.unwrap();
    let (events,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM cluster_events WHERE kind = 'settings'")
        .fetch_one(&a.state.db)
        .await
        .unwrap();
    assert_eq!(events, 0, "no event row to read");
    eventually("the other server takes the change through the counter", Duration::from_secs(10), || async {
        kalzit::settings::get(&b.state, key).await.unwrap() == json!(45)
    })
    .await;
    a.finish().await;
    b.finish().await;
    schema.drop_schema().await;
}

/// A second server on the same SQLite database stops at its start with a clear error; once the
/// first has stopped, it starts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_server_on_one_sqlite_database_is_refused() {
    let dir = common::private_tempdir();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.server.http_addr = "127.0.0.1:0".into();
    let first = kalzit::server::start(config.clone(), Some("cluster-test-setup-code-01".into())).await.unwrap();
    let err = match kalzit::server::start(config.clone(), Some("cluster-test-setup-code-01".into())).await {
        Ok(_) => panic!("a second server started on the same SQLite database"),
        Err(e) => format!("{e:#}"),
    };
    assert!(err.contains("another Kalzit server is already running on the SQLite database"), "{err}");
    assert!(err.contains("PostgreSQL"), "{err}");
    first.shutdown();
    first.wait().await.unwrap();
    let again = kalzit::server::start(config.clone(), Some("cluster-test-setup-code-01".into())).await.unwrap();
    // The view lists this one server, leading.
    again.shutdown();
    again.wait().await.unwrap();
    common::remove_dir(dir);
}
