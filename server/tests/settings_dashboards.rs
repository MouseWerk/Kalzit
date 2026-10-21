//! Settings, the audit view, folders and dashboards through the real router and database.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::{Clock, ManualClock};
use kalzit::config::Config;
use serde_json::{Value, json};
use tower::ServiceExt;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const DAY_MS: i64 = 24 * 3_600_000;

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    _dir: tempfile::TempDir,
    owner: String,
    org: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
}

impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }

    fn field(&self) -> &str {
        self.body["error"]["field"].as_str().unwrap_or("")
    }
}

async fn test_app(db_url: Option<String>, tweak: impl FnOnce(&mut Config)) -> TestApp {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.database.url = db_url;
    tweak(&mut config);
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(1_800_000_000_000));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    let app = router(state.clone()).layer(MockConnectInfo(peer));
    let mut t = TestApp { app, clock, state, _dir: dir, owner: String::new(), org: String::new() };
    let setup = t
        .send(
            Method::POST,
            "/api/setup",
            Some(json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg Müller",
                         "email": "joerg@example.de", "password": "Grün und sicher 2026" })),
            None,
        )
        .await;
    assert_eq!(setup.status, StatusCode::OK, "{}", setup.body);
    t.org = setup.body["orgs"][0]["id"].as_str().unwrap().to_string();
    let owner_id = setup.body["id"].as_str().unwrap().to_string();
    t.owner = t.session_for(&owner_id).await;
    // The data source the sample models query; saving checks that it exists in the organization.
    sqlx::query(
        "INSERT INTO datasources (id, org_id, name, kind, settings, created_at, updated_at) \
         VALUES ('ds-1', $1, 'Bestellungen', 'sqlite', '{}', 0, 0)",
    )
    .bind(&t.org)
    .execute(&t.state.db)
    .await
    .unwrap();
    t
}

impl TestApp {
    async fn send(&self, method: Method, path: &str, body: Option<Value>, cookie: Option<&str>) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        Reply { status, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) }
    }

    async fn get(&self, path: &str, cookie: &str) -> Reply {
        self.send(Method::GET, &self.path(path), None, Some(cookie)).await
    }

    async fn post(&self, path: &str, body: Value, cookie: &str) -> Reply {
        self.send(Method::POST, &self.path(path), Some(body), Some(cookie)).await
    }

    async fn put(&self, path: &str, body: Value, cookie: &str) -> Reply {
        self.send(Method::PUT, &self.path(path), Some(body), Some(cookie)).await
    }

    async fn patch(&self, path: &str, body: Value, cookie: &str) -> Reply {
        self.send(Method::PATCH, &self.path(path), Some(body), Some(cookie)).await
    }

    async fn delete(&self, path: &str, cookie: &str) -> Reply {
        self.send(Method::DELETE, &self.path(path), None, Some(cookie)).await
    }

    /// `~` stands for `/api/orgs/<the org>`.
    fn path(&self, path: &str) -> String {
        match path.strip_prefix('~') {
            Some(rest) => format!("/api/orgs/{}{rest}", self.org),
            None => format!("/api{path}"),
        }
    }

    async fn session_for(&self, user_id: &str) -> String {
        let cfg = &self.state.config.sessions;
        let token = kalzit::auth::session::create(&self.state.db, cfg, self.clock.now_ms(), user_id).await.unwrap();
        format!("kalzit_session={token}")
    }

    /// A new user in the organization with `role`, signed in.
    async fn member(&self, name: &str, role: &str) -> String {
        let id = uuid::Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ($1, $2, $3, 0)")
            .bind(&id)
            .bind(format!("{}@example.de", name.to_lowercase()))
            .bind(name)
            .execute(&self.state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, $3, 0)")
            .bind(&self.org)
            .bind(&id)
            .bind(role)
            .execute(&self.state.db)
            .await
            .unwrap();
        self.session_for(&id).await
    }

    async fn user_id(&self, name: &str) -> String {
        let (id,): (String,) =
            sqlx::query_as("SELECT id FROM users WHERE name = $1").bind(name).fetch_one(&self.state.db).await.unwrap();
        id
    }

    /// Grants `level` on a resource to a user, as the owner.
    async fn grant(&self, user: &str, resource_type: &str, resource_id: &str, level: &str) -> Reply {
        let user_id = self.user_id(user).await;
        let body = json!({ "subjectType": "user", "subjectId": user_id, "resourceType": resource_type,
                           "resourceId": resource_id, "level": level });
        let r = self.post("~/grants", body, &self.owner).await;
        // 200 when the grant existed and only its level changed.
        assert!(matches!(r.status, StatusCode::CREATED | StatusCode::OK), "{}", r.body);
        r
    }

    async fn grants_on(&self, ids: &[&str]) -> i64 {
        let mut total = 0;
        for id in ids {
            let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM resource_grants WHERE resource_id = $1")
                .bind(*id)
                .fetch_one(&self.state.db)
                .await
                .unwrap();
            total += n;
        }
        total
    }

    async fn actions(&self) -> Vec<String> {
        let rows: Vec<(String,)> = sqlx::query_as("SELECT action FROM audit_events ORDER BY created_at, id")
            .fetch_all(&self.state.db)
            .await
            .unwrap();
        rows.into_iter().map(|r| r.0).collect()
    }

    /// A real folder and dashboard of another organization: (folder id, dashboard id).
    async fn foreign_ids(&self) -> (String, String) {
        let org = uuid::Uuid::now_v7().to_string();
        let folder = uuid::Uuid::now_v7().to_string();
        let dashboard = uuid::Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, 'Andere', 0)")
            .bind(&org)
            .execute(&self.state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO folders (id, org_id, name, restricted, version, created_at, updated_at) \
             VALUES ($1, $2, 'Fremd', 0, 1, 0, 0)",
        )
        .bind(&folder)
        .bind(&org)
        .execute(&self.state.db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO dashboards (id, org_id, folder_id, title, search_title, version, created_at, updated_at) \
             VALUES ($1, $2, $3, 'Fremd', 'fremd', 1, 0, 0)",
        )
        .bind(&dashboard)
        .bind(&org)
        .bind(&folder)
        .execute(&self.state.db)
        .await
        .unwrap();
        (folder, dashboard)
    }
}

/// Every flow runs on SQLite, and on PostgreSQL when `KALZIT_TEST_POSTGRES_URL` is set (in a
/// throwaway schema per flow, so the test database is left as it was).
macro_rules! on_both_databases {
    ($($flow:ident: $tweak:expr;)*) => {
        mod sqlite {
            use super::*;
            $(
                // Several worker threads, so the concurrency flows really run side by side.
                #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
                async fn $flow() {
                    super::$flow(test_app(None, $tweak).await).await
                }
            )*
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn postgres_flows() {
            let Ok(base) = std::env::var("KALZIT_TEST_POSTGRES_URL") else {
                eprintln!("KALZIT_TEST_POSTGRES_URL not set, PostgreSQL flows not run");
                return;
            };
            sqlx::any::install_default_drivers();
            let admin = sqlx::AnyPool::connect(&base).await.unwrap();
            $(
                let schema = format!("kalzit_test_{}", uuid::Uuid::now_v7().simple());
                // The schema name is a fixed prefix plus UUID hex digits, so it is safe to splice in.
                sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}"))).execute(&admin).await.unwrap();
                let sep = if base.contains('?') { '&' } else { '?' };
                let url = format!("{base}{sep}options=-csearch_path%3D{schema}");
                $flow(test_app(Some(url), $tweak).await).await;
                sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE"))).execute(&admin).await.unwrap();
            )*
        }
    };
}

on_both_databases! {
    // As if kalzit.toml set the lifetime.
    server_settings_report_sources_and_save_with_versions: |c| {
        c.sessions.lifetime_hours = 10;
        c.file_keys.insert("sessions.lifetime_hours".into());
    };
    writes_drop_the_settings_cache: |_| {};
    organization_settings_need_settings_permissions: |_| {};
    audit_views_filter_and_page_newest_first: |_| {};
    old_audit_events_are_deleted_after_the_retention: |_| {};
    folders_nest_move_without_cycles_and_go_through_the_trash: |_| {};
    restricted_folders_do_not_exist_for_members_without_access: |_| {};
    dashboards_save_versions_and_refuse_stale_writes: |_| {};
    dashboards_go_through_the_trash: |_| {};
    dashboard_lists_search_move_and_page: |_| {};
    old_versions_beyond_the_retention_are_dropped: |_| {};
    subtrees_with_hidden_content_stay_out_of_reach: |_| {};
    separate_trashes_restore_separately: |_| {};
    concurrent_moves_never_build_a_cycle: |_| {};
    dashboards_cannot_slip_into_a_folder_being_trashed: |_| {};
    grants_open_restricted_folders: |_| {};
    purging_deletes_grants: |_| {};
    purges_and_new_grants_leave_no_orphans: |_| {};
    subtree_actions_need_rights_on_every_part: |_| {};
    a_masked_parent_is_no_move_and_restriction_moves_need_permissions: |_| {};
    purge_never_takes_a_restored_dashboard: |_| {};
    grants_extend_rights_beyond_the_role: |_| {};
    a_dashboard_reached_by_its_own_grant_hides_its_folder: |_| {};
    audit_summaries_do_not_name_hidden_folders: |_| {};
    answers_say_what_the_caller_may_do: |_| {};
    new_dashboards_take_the_default_time_range: |_| {};
    dashboard_moves_across_restriction_need_permissions: |_| {};
    restricting_through_an_admin_grant_keeps_access: |_| {};
    moving_a_folder_to_the_top_level_needs_the_org_wide_right: |_| {};
    dashboards_moved_out_of_restriction_stay_hidden_once_purged: |_| {};
}

/// Lock contention on SQLite is never a 500. Another connection holds the database's write lock
/// for longer than the app waits: reads go on (WAL), writes answer `503 busy` with `Retry-After`,
/// and once the lock is free the same write succeeds. The app's wait is cut to 300 ms so the test
/// does not sit out the production timeout.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_locked_database_answers_busy_not_internal() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    let url = config.database_url();
    let pool = kalzit::db::connect_with(&url, 4, std::time::Duration::from_millis(300)).await.unwrap();
    let clock = Arc::new(ManualClock::new(1_800_000_000_000));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    let app = router(state.clone()).layer(MockConnectInfo(peer));
    let mut t = TestApp { app, clock, state, _dir: dir, owner: String::new(), org: String::new() };
    let setup = t
        .send(
            Method::POST,
            "/api/setup",
            Some(json!({ "token": SETUP_CODE, "orgName": "Org", "name": "Jörg Müller",
                         "email": "joerg@example.de", "password": "Grün und sicher 2026" })),
            None,
        )
        .await;
    assert_eq!(setup.status, StatusCode::OK, "{}", setup.body);
    t.org = setup.body["orgs"][0]["id"].as_str().unwrap().to_string();
    t.owner = t.session_for(setup.body["id"].as_str().unwrap()).await;

    // Another writer (a second server process, a backup tool) takes the write lock and keeps it.
    use sqlx::Connection;
    let mut holder = sqlx::AnyConnection::connect(&url).await.unwrap();
    sqlx::query("BEGIN EXCLUSIVE").execute(&mut holder).await.unwrap();

    let read = t.get("~/folders", &t.owner).await;
    assert_eq!(read.status, StatusCode::OK, "reads are not blocked by a writer: {}", read.body);
    let req = Request::builder()
        .method(Method::POST)
        .uri(t.path("~/folders"))
        .header(header::HOST, "kalzit.test")
        .header(header::COOKIE, &t.owner)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "name": "Wartet" }).to_string()))
        .unwrap();
    let res = t.app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(res.headers().get(header::RETRY_AFTER).map(|v| v.to_str().unwrap()), Some("1"));
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["error"]["code"], "busy", "{body}");

    // A failed sign-in stays a failed sign-in, even when its audit entry cannot be written.
    let wrong = t
        .send(
            Method::POST,
            "/api/auth/login",
            Some(json!({ "email": "joerg@example.de", "password": "falsch falsch falsch" })),
            None,
        )
        .await;
    assert_eq!((wrong.status, wrong.code()), (StatusCode::UNAUTHORIZED, "invalid_credentials"), "{}", wrong.body);

    sqlx::query("COMMIT").execute(&mut holder).await.unwrap();
    let again = t.post("~/folders", json!({ "name": "Wartet" }), &t.owner).await;
    assert_eq!(again.status, StatusCode::CREATED, "{}", again.body);
}

/// Reading never waits on a writer, also when the session is due for its last-seen update: that
/// update is best-effort and gives up at once, so the request answers well within the busy
/// timeout (15 s) instead of waiting for it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_due_session_touch_does_not_wait_for_a_writer() {
    let t = test_app(None, |_| {}).await;
    use sqlx::Connection;
    let url = t.state.config.database_url();
    let mut holder = sqlx::AnyConnection::connect(&url).await.unwrap();
    // Past the touch interval (5 minutes), so this request wants to update last_seen_at.
    t.clock.advance_ms(6 * 60 * 1000);
    sqlx::query("BEGIN IMMEDIATE").execute(&mut holder).await.unwrap();
    let started = std::time::Instant::now();
    let me = t.get("/me", &t.owner).await;
    let took = started.elapsed();
    sqlx::query("ROLLBACK").execute(&mut holder).await.unwrap();
    assert_eq!(me.status, StatusCode::OK, "{}", me.body);
    assert!(took < std::time::Duration::from_secs(3), "the read waited {took:?} for the writer");
    // The update waited for the lock in the background and lands once it is free.
    t.state.touches.settle().await;
    let last_seen: i64 =
        sqlx::query_scalar("SELECT MAX(last_seen_at) FROM sessions").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(last_seen, t.clock.now_ms());
}

/// A request dropped at any point while its session touch is due leaves every pooled
/// connection with the normal busy timeout.
#[tokio::test]
async fn a_cancelled_request_leaves_the_busy_timeout_alone() {
    use sqlx::Connection;
    use std::future::Future;
    use std::task::Poll;
    let t = test_app(None, |_| {}).await;
    let url = t.state.config.database_url();
    let mut holder = sqlx::AnyConnection::connect(&url).await.unwrap();
    t.clock.advance_ms(6 * 60 * 1000);
    sqlx::query("BEGIN IMMEDIATE").execute(&mut holder).await.unwrap();
    // Drop the request after 0, 1, 2, ... polls, until it would finish on its own.
    for polls in 0.. {
        let mut request = Box::pin(t.get("/me", &t.owner));
        let mut done = false;
        for _ in 0..polls {
            done = std::future::poll_fn(|cx| Poll::Ready(request.as_mut().poll(cx).is_ready())).await;
            if done {
                break;
            }
            tokio::task::yield_now().await;
        }
        drop(request);
        if done {
            break;
        }
    }
    sqlx::query("ROLLBACK").execute(&mut holder).await.unwrap();
    t.state.touches.settle().await;

    let max = t.state.db.options().get_max_connections();
    let mut conns = Vec::new();
    for _ in 0..max {
        conns.push(t.state.db.acquire().await.unwrap());
    }
    for conn in &mut conns {
        let timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout").fetch_one(&mut **conn).await.unwrap();
        assert_eq!(timeout, kalzit::db::SQLITE_BUSY_TIMEOUT.as_millis() as i64);
    }
}

/// A graceful stop closes the database, so SQLite checkpoints its WAL and removes it: what a
/// backup copies with the server stopped is complete in `kalzit.db` alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_the_server_checkpoints_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.server.http_addr = "127.0.0.1:0".into();
    let server = kalzit::server::start(config.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let wal = dir.path().join("kalzit.db-wal");
    assert!(wal.exists(), "the database runs in WAL mode");
    server.shutdown();
    server.wait().await.unwrap();
    assert!(!wal.exists(), "the WAL is folded into the database once the server stops");
}

/// A touch waiting for the write lock does not hold up the stop: the server drops it before it
/// closes the database, instead of waiting out the busy timeout.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_waiting_session_touch_does_not_delay_the_stop() {
    use sqlx::Connection;
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.server.http_addr = "127.0.0.1:0".into();
    let url = config.database_url();
    let db = kalzit::db::connect(&url, 1).await.unwrap();
    sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ('u-1', 'joerg@example.de', 'Jörg', 0)")
        .execute(&db)
        .await
        .unwrap();
    // Last seen ten minutes ago, so the next request touches the session.
    let now = kalzit::clock::SystemClock.now_ms();
    let token = kalzit::auth::session::create(&db, &config.sessions, now - 10 * 60 * 1000, "u-1").await.unwrap();
    // The jobs the server runs at its start write too. Something for each to delete shows when
    // they are done, so only the touch waits for the lock below.
    kalzit::auth::session::create(&db, &config.sessions, 0, "u-1").await.unwrap();
    sqlx::query("INSERT INTO audit_events (id, action, summary, created_at) VALUES ('old', 'auth.signed_in', '{}', 0)")
        .execute(&db)
        .await
        .unwrap();
    db.close().await;

    let server = kalzit::server::start(config.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let mut holder = sqlx::AnyConnection::connect(&url).await.unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let (left,): (i64,) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM audit_events WHERE id = 'old')",
        )
        .fetch_one(&mut holder)
        .await
        .unwrap();
        if left == 1 {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "the start jobs did not run within 20 s");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    sqlx::query("BEGIN IMMEDIATE").execute(&mut holder).await.unwrap();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let me = reqwest::Client::new()
        .get(format!("http://{}/api/me", server.http_addr.unwrap()))
        .header("cookie", format!("kalzit_session={token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(me.status(), StatusCode::OK);

    let started = std::time::Instant::now();
    server.shutdown();
    server.wait().await.unwrap();
    let took = started.elapsed();
    sqlx::query("ROLLBACK").execute(&mut holder).await.unwrap();
    // Within the shortest grace (closing the console on Windows: 3 s), far below the 15 s busy timeout.
    assert!(took < std::time::Duration::from_secs(3), "the stop waited {took:?} for the touch");
}

/// The jobs the server runs at its start write too. One that waits for a lock another program
/// holds does not hold up the stop: the server aborts it and bounds the close.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_start_job_waiting_for_the_lock_does_not_delay_the_stop() {
    use sqlx::Connection;
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.server.http_addr = "127.0.0.1:0".into();
    // A first start sets the database up, so the second one only reads before its jobs run.
    let server = kalzit::server::start(config.clone(), Some(SETUP_CODE.into())).await.unwrap();
    server.shutdown();
    server.wait().await.unwrap();

    let mut holder = sqlx::AnyConnection::connect(&config.database_url()).await.unwrap();
    sqlx::query("BEGIN IMMEDIATE").execute(&mut holder).await.unwrap();
    let server = kalzit::server::start(config.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let started = std::time::Instant::now();
    server.shutdown();
    server.wait().await.unwrap();
    let took = started.elapsed();
    sqlx::query("ROLLBACK").execute(&mut holder).await.unwrap();
    // Within the shortest grace (closing the console on Windows: 3 s), far below the 15 s busy timeout.
    assert!(took < std::time::Duration::from_secs(3), "the stop waited {took:?} for the start jobs");
}

/// The server schedules the audit retention when it starts: an event from 1970 is gone soon after.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_server_runs_the_audit_retention() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.server.http_addr = "127.0.0.1:0".into();
    let db = kalzit::db::connect(&config.database_url(), 1).await.unwrap();
    sqlx::query("INSERT INTO audit_events (id, action, summary, created_at) VALUES ('old', 'auth.signed_in', '{}', 0)")
        .execute(&db)
        .await
        .unwrap();
    db.close().await;

    let server = kalzit::server::start(config.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let db = kalzit::db::connect(&config.database_url(), 1).await.unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let (old,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE id = 'old'").fetch_one(&db).await.unwrap();
        if old == 0 {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "the retention did not delete the 1970 event within 20 s");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    db.close().await;
    server.shutdown();
    server.wait().await.unwrap();
}

fn model(title: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "title": title,
        "timeRange": { "from": "now-6h", "to": "now" },
        "panels": [
            { "id": "p1", "type": "timeseries", "title": "Bestellungen", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
              "targets": [ { "refId": "A", "datasourceId": "ds-1", "query": { "sql": "SELECT 1" } } ] }
        ]
    })
}

/// A model without queries, for members who may not query data sources (viewers with grants).
fn plain(title: &str) -> Value {
    json!({ "schemaVersion": 1, "title": title, "timeRange": { "from": "now-6h", "to": "now" } })
}

fn setting<'a>(list: &'a Reply, key: &str) -> &'a Value {
    list.body["items"].as_array().unwrap().iter().find(|s| s["key"] == key).unwrap_or_else(|| panic!("{key} missing"))
}

async fn server_settings_report_sources_and_save_with_versions(t: TestApp) {
    let list = t.get("/admin/settings", &t.owner).await;
    assert_eq!(list.status, StatusCode::OK, "{}", list.body);
    assert!(list.body["nextCursor"].is_null());
    let retention = setting(&list, "audit.retention_days");
    assert_eq!(
        (&retention["value"], &retention["source"], &retention["version"], &retention["editable"]),
        (&json!(365), &json!("default"), &json!(0), &json!(true))
    );
    let lifetime = setting(&list, "sessions.lifetime_hours");
    assert_eq!(
        (&lifetime["value"], &lifetime["source"], &lifetime["editable"]),
        (&json!(10), &json!("file"), &json!(false))
    );
    assert!(list.body["items"].as_array().unwrap().iter().all(|s| s["scope"] == "server"));

    let saved = t.patch("/admin/settings/audit.retention_days", json!({ "value": 30, "version": 0 }), &t.owner).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    assert_eq!(
        (&saved.body["value"], &saved.body["source"], &saved.body["version"]),
        (&json!(30), &json!("database"), &json!(1))
    );
    assert!(saved.body["updatedBy"].is_string() && saved.body["updatedAt"].is_number());
    assert_eq!(kalzit::settings::get(&t.state, "audit.retention_days").await.unwrap(), json!(30));

    // Someone who started from version 0 gets the stored setting back to merge with.
    let stale = t.patch("/admin/settings/audit.retention_days", json!({ "value": 60, "version": 0 }), &t.owner).await;
    assert_eq!((stale.status, stale.code()), (StatusCode::CONFLICT, "version_conflict"));
    assert_eq!((&stale.body["current"]["value"], &stale.body["current"]["version"]), (&json!(30), &json!(1)));

    for bad in [json!(0), json!("30"), Value::Null] {
        let r = t.patch("/admin/settings/audit.retention_days", json!({ "value": bad, "version": 1 }), &t.owner).await;
        assert_eq!((r.status, r.code(), r.field()), (StatusCode::UNPROCESSABLE_ENTITY, "validation", "value"), "{bad}");
    }
    let missing_version = t.patch("/admin/settings/audit.retention_days", json!({ "value": 30 }), &t.owner).await;
    assert_eq!(missing_version.code(), "validation");
    let unknown = t.patch("/admin/settings/no.such", json!({ "value": 1, "version": 0 }), &t.owner).await;
    assert_eq!(unknown.code(), "not_found");
    // Organization settings are not server settings.
    let org_key =
        t.patch("/admin/settings/dashboards.default_time_range", json!({ "value": 1, "version": 0 }), &t.owner).await;
    assert_eq!(org_key.code(), "not_found");
    let locked =
        t.patch("/admin/settings/sessions.lifetime_hours", json!({ "value": 5, "version": 0 }), &t.owner).await;
    assert_eq!((locked.status, locked.code()), (StatusCode::CONFLICT, "conflict"));

    assert_eq!(t.actions().await.iter().filter(|a| *a == "settings.updated").count(), 1);
    let summary: (String,) = sqlx::query_as("SELECT summary FROM audit_events WHERE action = 'settings.updated'")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert!(!summary.0.contains("30"), "the value stays out of the audit summary: {}", summary.0);
}

async fn writes_drop_the_settings_cache(t: TestApp) {
    let key = "dashboards.version_retention";
    assert_eq!(kalzit::settings::get(&t.state, key).await.unwrap(), json!(100));
    let r = t.patch(&format!("/admin/settings/{key}"), json!({ "value": 5, "version": 0 }), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(kalzit::settings::get(&t.state, key).await.unwrap(), json!(5));

    // A change made by another server process shows up once the cache expires.
    sqlx::query("UPDATE server_settings SET value = '7', version = 2 WHERE key = $1")
        .bind(key)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(kalzit::settings::get(&t.state, key).await.unwrap(), json!(5), "still cached");
    t.clock.advance_ms(30_000);
    assert_eq!(kalzit::settings::get(&t.state, key).await.unwrap(), json!(7));
}

async fn organization_settings_need_settings_permissions(t: TestApp) {
    let list = t.get("~/settings", &t.owner).await;
    assert_eq!(list.status, StatusCode::OK, "{}", list.body);
    let range = setting(&list, "dashboards.default_time_range");
    assert_eq!((&range["scope"], &range["source"], &range["version"]), (&json!("org"), &json!("default"), &json!(0)));

    let value = json!({ "from": "now-24h", "to": "now" });
    let saved =
        t.patch("~/settings/dashboards.default_time_range", json!({ "value": value, "version": 0 }), &t.owner).await;
    assert_eq!((saved.status, &saved.body["value"]), (StatusCode::OK, &value), "{}", saved.body);
    let org = t.org.clone();
    assert_eq!(kalzit::settings::get_org(&t.state, &org, "dashboards.default_time_range").await.unwrap(), value);
    let bad = t
        .patch(
            "~/settings/dashboards.default_time_range",
            json!({ "value": { "from": "gestern", "to": "now" }, "version": 1 }),
            &t.owner,
        )
        .await;
    assert_eq!((bad.code(), bad.field()), ("validation", "value"));
    let server_key = t.patch("~/settings/audit.retention_days", json!({ "value": 30, "version": 0 }), &t.owner).await;
    assert_eq!(server_key.code(), "not_found");

    let editor = t.member("Erika", "editor").await;
    assert_eq!(t.get("~/settings", &editor).await.code(), "forbidden");
    let r = t.patch("~/settings/dashboards.default_time_range", json!({ "value": value, "version": 1 }), &editor).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let audit: (Option<String>,) = sqlx::query_as("SELECT org_id FROM audit_events WHERE action = 'settings.updated'")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(audit.0.as_deref(), Some(org.as_str()));
}

async fn audit_views_filter_and_page_newest_first(t: TestApp) {
    for title in ["Eins", "Zwei", "Drei"] {
        t.clock.advance_ms(1000);
        assert_eq!(
            t.post("~/dashboards", json!({ "model": model(title) }), &t.owner).await.status,
            StatusCode::CREATED
        );
    }
    t.clock.advance_ms(1000);
    t.post("~/folders", json!({ "name": "Berichte" }), &t.owner).await;

    let all = t.get("~/audit", &t.owner).await;
    assert_eq!(all.status, StatusCode::OK, "{}", all.body);
    let actions: Vec<&str> =
        all.body["items"].as_array().unwrap().iter().map(|e| e["action"].as_str().unwrap()).collect();
    assert_eq!(
        actions,
        ["folder.created", "dashboard.created", "dashboard.created", "dashboard.created", "setup.completed"]
    );
    assert_eq!(all.body["items"][0]["actorName"], "Jörg Müller");
    assert!(all.body["items"][0]["summary"].is_object());

    let dashboards = t.get("~/audit?action=dashboard.&limit=2", &t.owner).await;
    assert_eq!(dashboards.body["items"].as_array().unwrap().len(), 2);
    let cursor = dashboards.body["nextCursor"].as_str().unwrap().to_string();
    let rest = t.get(&format!("~/audit?action=dashboard.&limit=2&cursor={cursor}"), &t.owner).await;
    assert_eq!(rest.body["items"].as_array().unwrap().len(), 1);
    assert!(rest.body["nextCursor"].is_null());
    let first_two: Vec<&Value> =
        dashboards.body["items"].as_array().unwrap().iter().chain(rest.body["items"].as_array().unwrap()).collect();
    let mut ids: Vec<&str> = first_two.iter().map(|e| e["id"].as_str().unwrap()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 3, "no event twice across pages");

    let created_at = all.body["items"][1]["createdAt"].as_i64().unwrap();
    let window = t.get(&format!("~/audit?from={created_at}&to={}", created_at + 1), &t.owner).await;
    assert_eq!(window.body["items"].as_array().unwrap().len(), 1);
    let owner_id = all.body["items"][0]["actorUserId"].as_str().unwrap();
    let by_actor = t.get(&format!("~/audit?actor={owner_id}&resourceType=folder"), &t.owner).await;
    assert_eq!(by_actor.body["items"].as_array().unwrap().len(), 1);
    let folder_id = by_actor.body["items"][0]["resourceId"].as_str().unwrap();
    let by_resource = t.get(&format!("~/audit?resourceId={folder_id}"), &t.owner).await;
    assert_eq!(by_resource.body["items"][0]["action"], "folder.created");

    for bad in ["limit=201", "limit=0", "cursor=zz", "from=5&to=4", "orgId=x", "colour=red", "from=gestern"] {
        let r = t.get(&format!("~/audit?{bad}"), &t.owner).await;
        assert_eq!((r.status, r.code()), (StatusCode::UNPROCESSABLE_ENTITY, "validation"), "{bad}: {}", r.body);
    }
    let editor = t.member("Erika", "editor").await;
    assert_eq!(t.get("~/audit", &editor).await.code(), "forbidden");

    // The server view has every organization's events and sign-ins, and filters by organization.
    sqlx::query("INSERT INTO audit_events (id, action, summary, created_at) VALUES ('x', 'auth.signed_in', '{}', 1)")
        .execute(&t.state.db)
        .await
        .unwrap();
    let server = t.get("/admin/audit?limit=200", &t.owner).await;
    assert_eq!(server.body["items"].as_array().unwrap().len(), 6);
    let one_org = t.get(&format!("/admin/audit?orgId={}", t.org), &t.owner).await;
    assert_eq!(one_org.body["items"].as_array().unwrap().len(), 5);
    let empty = t.get("/admin/audit?orgId=", &t.owner).await;
    assert_eq!((empty.code(), empty.field()), ("validation", "orgId"));
    assert_eq!(t.get("/admin/audit", &editor).await.code(), "forbidden");
}

async fn old_audit_events_are_deleted_after_the_retention(t: TestApp) {
    sqlx::query(
        "INSERT INTO audit_events (id, action, summary, created_at) VALUES ('old', 'auth.signed_in', '{}', $1)",
    )
    .bind(t.clock.now_ms() - 400 * DAY_MS)
    .execute(&t.state.db)
    .await
    .unwrap();
    assert_eq!(kalzit::routes::audit::purge_expired(&t.state).await.unwrap(), 1);
    assert_eq!(t.actions().await, ["setup.completed", "audit.expired"]);
    assert_eq!(kalzit::routes::audit::purge_expired(&t.state).await.unwrap(), 0);

    t.patch("/admin/settings/audit.retention_days", json!({ "value": 1, "version": 0 }), &t.owner).await;
    t.clock.advance_ms(DAY_MS - 1);
    assert_eq!(kalzit::routes::audit::purge_expired(&t.state).await.unwrap(), 0, "a day has not passed yet");
    t.clock.advance_ms(2);
    // Setup, the first purge record and the settings change are now older than a day.
    assert_eq!(kalzit::routes::audit::purge_expired(&t.state).await.unwrap(), 3);
    assert_eq!(t.actions().await, ["audit.expired"]);
}

async fn folders_nest_move_without_cycles_and_go_through_the_trash(t: TestApp) {
    let create = |name: &str, parent: Option<&str>| json!({ "name": name, "parentId": parent });
    let a = t.post("~/folders", create("Vertrieb", None), &t.owner).await;
    assert_eq!(a.status, StatusCode::CREATED, "{}", a.body);
    let a_id = a.body["id"].as_str().unwrap().to_string();
    assert_eq!((&a.body["version"], &a.body["restricted"]), (&json!(1), &json!(false)));
    let b = t.post("~/folders", create("Ärzte", Some(&a_id)), &t.owner).await;
    let b_id = b.body["id"].as_str().unwrap().to_string();
    let c = t.post("~/folders", create("Zahlen", Some(&b_id)), &t.owner).await;
    let c_id = c.body["id"].as_str().unwrap().to_string();

    let tree = t.get("~/folders", &t.owner).await;
    assert_eq!(tree.status, StatusCode::OK, "{}", tree.body);
    assert_eq!(tree.body["items"][0]["name"], "Vertrieb");
    assert_eq!(tree.body["items"][0]["children"][0]["children"][0]["name"], "Zahlen");

    for parent in [&a_id, &c_id] {
        let r = t.patch(&format!("~/folders/{a_id}"), json!({ "parentId": parent, "version": 1 }), &t.owner).await;
        assert_eq!((r.code(), r.field()), ("validation", "parentId"), "{}", r.body);
    }
    for bad in [json!({ "name": " ", "version": 1 }), json!({ "name": "x".repeat(101), "version": 1 })] {
        assert_eq!(t.patch(&format!("~/folders/{a_id}"), bad, &t.owner).await.field(), "name");
    }
    let (foreign_folder, _) = t.foreign_ids().await;
    let foreign_parent = t.post("~/folders", create("X", Some(&foreign_folder)), &t.owner).await;
    assert_eq!(foreign_parent.code(), "not_found");
    let foreign_move =
        t.patch(&format!("~/folders/{a_id}"), json!({ "parentId": foreign_folder, "version": 1 }), &t.owner).await;
    assert_eq!(foreign_move.code(), "not_found");
    for path in [format!("~/folders/{foreign_folder}"), format!("~/folders/{foreign_folder}/purge")] {
        assert_eq!(t.delete(&path, &t.owner).await.code(), "not_found", "{path}");
    }

    // Move c to the top level, then rename it with a stale version.
    let moved = t.patch(&format!("~/folders/{c_id}"), json!({ "parentId": null, "version": 1 }), &t.owner).await;
    assert_eq!((&moved.body["parentId"], &moved.body["version"]), (&Value::Null, &json!(2)), "{}", moved.body);
    let stale = t.patch(&format!("~/folders/{c_id}"), json!({ "name": "Neu", "version": 1 }), &t.owner).await;
    assert_eq!((stale.status, stale.code()), (StatusCode::CONFLICT, "version_conflict"));
    assert_eq!((&stale.body["current"]["version"], &stale.body["current"]["name"]), (&json!(2), &json!("Zahlen")));
    let renamed = t.patch(&format!("~/folders/{c_id}"), json!({ "name": "Neu", "version": 2 }), &t.owner).await;
    assert_eq!(renamed.body["name"], "Neu");

    // Trashing a takes b and b's dashboard along; restoring brings back exactly those.
    let d = t.post("~/dashboards", json!({ "folderId": b_id, "model": model("In Ärzte") }), &t.owner).await;
    let d_id = d.body["id"].as_str().unwrap().to_string();
    let purge_live = t.delete(&format!("~/folders/{a_id}/purge"), &t.owner).await;
    assert_eq!((purge_live.status, purge_live.code()), (StatusCode::CONFLICT, "conflict"));
    assert_eq!(t.delete(&format!("~/folders/{a_id}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    let tree = t.get("~/folders", &t.owner).await;
    assert_eq!(tree.body["items"].as_array().unwrap().len(), 1, "only Neu is left: {}", tree.body);
    let trash = t.get("~/folders?trashed=true", &t.owner).await;
    assert_eq!(trash.body["items"].as_array().unwrap().len(), 1, "one entry per trashed subtree: {}", trash.body);
    assert_eq!(trash.body["items"][0]["id"], a_id.as_str());
    assert!(t.get(&format!("~/dashboards/{d_id}"), &t.owner).await.body["deletedAt"].is_number());
    let in_trash = t.patch(&format!("~/folders/{b_id}"), json!({ "name": "y", "version": 1 }), &t.owner).await;
    assert_eq!(in_trash.code(), "conflict");
    let child_first = t.post(&format!("~/folders/{b_id}/restore"), json!({}), &t.owner).await;
    assert_eq!(child_first.code(), "conflict");
    let under_trashed = t.post("~/folders", create("Z", Some(&b_id)), &t.owner).await;
    assert_eq!(under_trashed.field(), "parentId");

    let restored = t.post(&format!("~/folders/{a_id}/restore"), json!({}), &t.owner).await;
    assert_eq!((restored.status, &restored.body["deletedAt"]), (StatusCode::OK, &Value::Null), "{}", restored.body);
    assert!(t.get(&format!("~/dashboards/{d_id}"), &t.owner).await.body["deletedAt"].is_null());
    assert_eq!(t.get("~/folders", &t.owner).await.body["items"].as_array().unwrap().len(), 2);

    // Purging removes the folder, its subfolders and their dashboards for good.
    t.delete(&format!("~/folders/{a_id}"), &t.owner).await;
    assert_eq!(t.delete(&format!("~/folders/{a_id}/purge"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&format!("~/dashboards/{d_id}"), &t.owner).await.code(), "not_found");
    let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM folders WHERE org_id = $1")
        .bind(&t.org)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(left, 1);
    let (versions,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM dashboard_versions").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(versions, 0);

    let actions = t.actions().await;
    for action in ["folder.created", "folder.updated", "folder.trashed", "folder.restored", "folder.purged"] {
        assert!(actions.iter().any(|a| a == action), "{action} missing from {actions:?}");
    }

    let viewer = t.member("Vera", "viewer").await;
    assert_eq!(t.get("~/folders", &viewer).await.status, StatusCode::OK);
    assert_eq!(t.post("~/folders", create("V", None), &viewer).await.code(), "forbidden");
    assert_eq!(t.delete(&format!("~/folders/{c_id}"), &viewer).await.code(), "forbidden");
}

async fn subtrees_with_hidden_content_stay_out_of_reach(t: TestApp) {
    let editor = t.member("Erika", "editor").await;
    let parent =
        t.post("~/folders", json!({ "name": "Team" }), &t.owner).await.body["id"].as_str().unwrap().to_string();
    let secret =
        t.post("~/folders", json!({ "name": "Geheim", "parentId": parent, "restricted": true }), &t.owner).await;
    let secret_id = secret.body["id"].as_str().unwrap().to_string();
    t.post("~/dashboards", json!({ "folderId": secret_id, "model": model("Gehälter") }), &t.owner).await;
    t.post("~/dashboards", json!({ "folderId": parent, "model": model("Plan") }), &t.owner).await;
    let elsewhere =
        t.post("~/folders", json!({ "name": "Anderswo" }), &t.owner).await.body["id"].as_str().unwrap().to_string();

    // The editor sees the parent but not what is inside the restricted child.
    let refused = [
        t.delete(&format!("~/folders/{parent}"), &editor).await,
        t.patch(&format!("~/folders/{parent}"), json!({ "parentId": elsewhere, "version": 1 }), &editor).await,
    ];
    for r in refused {
        assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden"), "{}", r.body);
    }
    // Renaming touches only the folder itself.
    let renamed = t.patch(&format!("~/folders/{parent}"), json!({ "name": "Team 2", "version": 1 }), &editor).await;
    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.body);

    assert_eq!(t.delete(&format!("~/folders/{parent}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    for r in [
        t.post(&format!("~/folders/{parent}/restore"), json!({}), &editor).await,
        t.delete(&format!("~/folders/{parent}/purge"), &editor).await,
    ] {
        assert_eq!(r.code(), "forbidden", "{}", r.body);
    }
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM dashboards").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(n, 2, "nothing was purged");
    assert_eq!(t.delete(&format!("~/folders/{parent}/purge"), &t.owner).await.status, StatusCode::NO_CONTENT);
    let (summary,): (String,) = sqlx::query_as("SELECT summary FROM audit_events WHERE action = 'folder.purged'")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&summary).unwrap(), json!({ "folders": 2, "dashboards": 2 }));
}

async fn separate_trashes_restore_separately(t: TestApp) {
    // The clock stands still: both trashes happen in the same millisecond.
    let folder = t.post("~/folders", json!({ "name": "F" }), &t.owner).await.body["id"].as_str().unwrap().to_string();
    let alone = t.post("~/dashboards", json!({ "folderId": folder, "model": model("Allein") }), &t.owner).await;
    let alone_id = alone.body["id"].as_str().unwrap().to_string();
    let along = t.post("~/dashboards", json!({ "folderId": folder, "model": model("Mit") }), &t.owner).await;
    let along_id = along.body["id"].as_str().unwrap().to_string();
    t.delete(&format!("~/dashboards/{alone_id}"), &t.owner).await;
    t.delete(&format!("~/folders/{folder}"), &t.owner).await;
    let restored = t.post(&format!("~/folders/{folder}/restore"), json!({}), &t.owner).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert!(t.get(&format!("~/dashboards/{along_id}"), &t.owner).await.body["deletedAt"].is_null());
    assert!(
        t.get(&format!("~/dashboards/{alone_id}"), &t.owner).await.body["deletedAt"].is_number(),
        "trashed on its own, so it stays in the trash"
    );
}

/// Opposite moves at the same time: one wins, the other sees the cycle.
async fn concurrent_moves_never_build_a_cycle(t: TestApp) {
    for round in 0..15 {
        let a = t.post("~/folders", json!({ "name": format!("A{round}") }), &t.owner).await.body["id"]
            .as_str()
            .unwrap()
            .to_string();
        let b = t.post("~/folders", json!({ "name": format!("B{round}") }), &t.owner).await.body["id"]
            .as_str()
            .unwrap()
            .to_string();
        let (path_a, path_b) = (format!("~/folders/{a}"), format!("~/folders/{b}"));
        let (ab, ba) = tokio::join!(
            t.patch(&path_a, json!({ "parentId": b, "version": 1 }), &t.owner),
            t.patch(&path_b, json!({ "parentId": a, "version": 1 }), &t.owner),
        );
        // One wins; the other learns of the cycle (placement is checked before "changed meanwhile").
        let mut statuses = [ab.status, ba.status];
        statuses.sort();
        assert_eq!(statuses, [StatusCode::OK, StatusCode::UNPROCESSABLE_ENTITY], "{} / {}", ab.body, ba.body);
        let loser = if ab.status == StatusCode::OK { &ba } else { &ab };
        assert_eq!(loser.field(), "parentId");
    }
    let tree = t.get("~/folders", &t.owner).await;
    assert_eq!(tree.body["items"].as_array().unwrap().len(), 15, "every pair hangs together: {}", tree.body);
    let created = t.post("~/dashboards", json!({ "model": model("Danach") }), &t.owner).await;
    assert_eq!(created.status, StatusCode::CREATED);
}

/// Trash and purge racing with dashboards entering the folder: never a live dashboard in a
/// trashed folder, never an internal error.
async fn dashboards_cannot_slip_into_a_folder_being_trashed(t: TestApp) {
    let moving = t.post("~/dashboards", json!({ "model": model("Wandert") }), &t.owner).await;
    let moving_id = moving.body["id"].as_str().unwrap().to_string();
    let mut version = 1;
    for round in 0..15 {
        let folder = t.post("~/folders", json!({ "name": format!("F{round}") }), &t.owner).await.body["id"]
            .as_str()
            .unwrap()
            .to_string();
        let (folder_path, moving_path) = (format!("~/folders/{folder}"), format!("~/dashboards/{moving_id}"));
        let (trashed, created, moved) = tokio::join!(
            t.delete(&folder_path, &t.owner),
            t.post("~/dashboards", json!({ "folderId": folder, "model": model("Neu") }), &t.owner),
            t.put(&moving_path, json!({ "model": model("Wandert"), "version": version, "folderId": folder }), &t.owner),
        );
        // A dashboard that entered between the trash's check and its lock makes it answer 409
        // ("changed in the meantime"); the retry takes the dashboard along.
        if trashed.code() == "conflict" {
            assert_eq!(t.delete(&folder_path, &t.owner).await.status, StatusCode::NO_CONTENT);
        } else {
            assert_eq!(trashed.status, StatusCode::NO_CONTENT, "{}", trashed.body);
        }
        for r in [&created, &moved] {
            assert!(
                matches!(r.status, StatusCode::OK | StatusCode::CREATED) || r.field() == "folderId",
                "{} {}",
                r.status,
                r.body
            );
        }
        if moved.status == StatusCode::OK {
            // It entered the folder before the trash, so it went to the trash with it.
            let gone = t.get(&format!("~/dashboards/{moving_id}"), &t.owner).await;
            assert!(gone.body["deletedAt"].is_number(), "{}", gone.body);
            t.post(&format!("~/folders/{folder}/restore"), json!({}), &t.owner).await;
            let body = json!({ "model": model("Wandert"), "version": version + 1, "folderId": null });
            let back = t.put(&format!("~/dashboards/{moving_id}"), body, &t.owner).await;
            assert_eq!(back.status, StatusCode::OK, "{}", back.body);
            version += 2;
        }
        let (live_in_trash,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM dashboards d JOIN folders f ON f.id = d.folder_id \
             WHERE d.deleted_at IS NULL AND f.deleted_at IS NOT NULL",
        )
        .fetch_one(&t.state.db)
        .await
        .unwrap();
        assert_eq!(live_in_trash, 0);

        // Purging the folder while one of its dashboards is restored: one of them wins cleanly.
        let inside = t.post("~/dashboards", json!({ "model": model("Drin") }), &t.owner).await.body["id"]
            .as_str()
            .unwrap()
            .to_string();
        let target = t.post("~/folders", json!({ "name": format!("G{round}") }), &t.owner).await.body["id"]
            .as_str()
            .unwrap()
            .to_string();
        t.put(
            &format!("~/dashboards/{inside}"),
            json!({ "model": model("Drin"), "version": 1, "folderId": target }),
            &t.owner,
        )
        .await;
        t.delete(&format!("~/folders/{target}"), &t.owner).await;
        let (purge_path, restore_path) =
            (format!("~/folders/{target}/purge"), format!("~/dashboards/{inside}/restore"));
        let (purged, restored) =
            tokio::join!(t.delete(&purge_path, &t.owner), t.post(&restore_path, json!({}), &t.owner),);
        assert_eq!(purged.status, StatusCode::NO_CONTENT, "{}", purged.body);
        assert!(matches!(restored.code(), "conflict" | "not_found"), "{} {}", restored.status, restored.body);
    }
}

async fn restricted_folders_do_not_exist_for_members_without_access(t: TestApp) {
    let editor = t.member("Erika", "editor").await;
    let viewer = t.member("Vera", "viewer").await;
    let refused = t.post("~/folders", json!({ "name": "Geheim", "restricted": true }), &editor).await;
    assert_eq!(refused.code(), "forbidden", "restricting is a permissions change");

    let secret = t.post("~/folders", json!({ "name": "Geheim", "restricted": true }), &t.owner).await;
    let secret_id = secret.body["id"].as_str().unwrap().to_string();
    let inner = t.post("~/folders", json!({ "name": "Innen", "parentId": secret_id }), &t.owner).await;
    let inner_id = inner.body["id"].as_str().unwrap().to_string();
    let open = t.post("~/folders", json!({ "name": "Offen" }), &t.owner).await;
    let open_id = open.body["id"].as_str().unwrap().to_string();
    let hidden = t.post("~/dashboards", json!({ "folderId": inner_id, "model": model("Gehälter") }), &t.owner).await;
    let hidden_id = hidden.body["id"].as_str().unwrap().to_string();
    t.post("~/dashboards", json!({ "folderId": open_id, "model": model("Umsatz") }), &t.owner).await;

    for who in [&viewer, &editor] {
        let tree = t.get("~/folders", who).await;
        let names: Vec<&str> =
            tree.body["items"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Offen"]);
        let list = t.get("~/dashboards", who).await;
        let titles: Vec<&str> =
            list.body["items"].as_array().unwrap().iter().map(|d| d["title"].as_str().unwrap()).collect();
        assert_eq!(titles, ["Umsatz"]);
        for path in [
            format!("~/dashboards/{hidden_id}"),
            format!("~/dashboards/{hidden_id}/versions"),
            format!("~/dashboards/{hidden_id}/versions/1"),
            format!("~/dashboards?folderId={inner_id}"),
        ] {
            assert_eq!(t.get(&path, who).await.code(), "not_found", "{path}");
        }
    }
    let save = t.put(&format!("~/dashboards/{hidden_id}"), json!({ "model": model("x"), "version": 1 }), &editor).await;
    assert_eq!(save.code(), "not_found");
    let into = t.post("~/dashboards", json!({ "folderId": secret_id, "model": model("x") }), &editor).await;
    assert_eq!(into.code(), "not_found");
    let rename = t.patch(&format!("~/folders/{secret_id}"), json!({ "name": "x", "version": 1 }), &editor).await;
    assert_eq!(rename.code(), "not_found");
    let move_in =
        t.patch(&format!("~/folders/{open_id}"), json!({ "parentId": inner_id, "version": 1 }), &editor).await;
    assert_eq!(move_in.code(), "not_found");

    // Search and the trash do not reveal hidden content either.
    for path in ["~/dashboards?q=geh", "~/dashboards?q=%C3%84lter"] {
        assert!(t.get(path, &editor).await.body["items"].as_array().unwrap().is_empty(), "{path}");
    }
    assert_eq!(t.get("~/dashboards?q=geh", &t.owner).await.body["items"].as_array().unwrap().len(), 1);
    t.delete(&format!("~/dashboards/{hidden_id}"), &t.owner).await;
    let other = t.post("~/folders", json!({ "name": "Weg", "parentId": secret_id }), &t.owner).await;
    t.delete(&format!("~/folders/{}", other.body["id"].as_str().unwrap()), &t.owner).await;
    for who in [&editor, &viewer] {
        assert!(t.get("~/dashboards?trashed=true", who).await.body["items"].as_array().unwrap().is_empty());
        assert!(t.get("~/folders?trashed=true", who).await.body["items"].as_array().unwrap().is_empty());
    }
    assert_eq!(t.get("~/dashboards?trashed=true", &t.owner).await.body["items"].as_array().unwrap().len(), 1);
    assert_eq!(t.get("~/folders?trashed=true", &t.owner).await.body["items"].as_array().unwrap().len(), 1);
    t.post(&format!("~/dashboards/{hidden_id}/restore"), json!({}), &t.owner).await;

    // Owners see everything; lifting the restriction shows the folder to everyone.
    assert_eq!(t.get(&format!("~/dashboards/{hidden_id}"), &t.owner).await.status, StatusCode::OK);
    let lifted =
        t.patch(&format!("~/folders/{secret_id}"), json!({ "restricted": false, "version": 1 }), &t.owner).await;
    assert_eq!(lifted.status, StatusCode::OK, "{}", lifted.body);
    assert_eq!(t.get(&format!("~/dashboards/{hidden_id}"), &viewer).await.status, StatusCode::OK);
}

async fn dashboards_save_versions_and_refuse_stale_writes(t: TestApp) {
    let created = t
        .post("~/dashboards", json!({ "model": model("Umsatz Übersicht"), "message": "erste Fassung" }), &t.owner)
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let id = created.body["id"].as_str().unwrap().to_string();
    assert_eq!((&created.body["version"], &created.body["title"]), (&json!(1), &json!("Umsatz Übersicht")));
    assert_eq!(created.body["model"]["panels"][0]["fieldConfig"], json!({}), "defaults are filled in");

    let got = t.get(&format!("~/dashboards/{id}"), &t.owner).await;
    assert_eq!((got.status, &got.body["model"]["schemaVersion"]), (StatusCode::OK, &json!(1)));

    let saved = t
        .put(
            &format!("~/dashboards/{id}"),
            json!({ "model": model("Umsatz 2026"), "version": 1, "message": "Titel" }),
            &t.owner,
        )
        .await;
    assert_eq!((saved.status, &saved.body["version"]), (StatusCode::OK, &json!(2)), "{}", saved.body);
    let stale = t.put(&format!("~/dashboards/{id}"), json!({ "model": model("Alt"), "version": 1 }), &t.owner).await;
    assert_eq!((stale.status, stale.code()), (StatusCode::CONFLICT, "version_conflict"));
    assert_eq!(
        (&stale.body["current"]["version"], &stale.body["current"]["model"]["title"]),
        (&json!(2), &json!("Umsatz 2026"))
    );

    let mut bad = model("x");
    bad["panels"][0]["grid"]["w"] = json!(25);
    let invalid = t.put(&format!("~/dashboards/{id}"), json!({ "model": bad, "version": 2 }), &t.owner).await;
    assert_eq!((invalid.code(), invalid.field()), ("validation", "model"));
    assert!(invalid.body["error"]["message"].as_str().unwrap().contains("panels[0].grid"));
    let mut future = model("x");
    future["schemaVersion"] = json!(2);
    let newer = t.post("~/dashboards", json!({ "model": future }), &t.owner).await;
    assert!(newer.body["error"]["message"].as_str().unwrap().contains("newer Kalzit"), "{}", newer.body);
    let long = t
        .put(
            &format!("~/dashboards/{id}"),
            json!({ "model": model("x"), "version": 2, "message": "x".repeat(501) }),
            &t.owner,
        )
        .await;
    assert_eq!(long.field(), "message");

    let versions = t.get(&format!("~/dashboards/{id}/versions"), &t.owner).await;
    let numbers: Vec<i64> =
        versions.body["items"].as_array().unwrap().iter().map(|v| v["version"].as_i64().unwrap()).collect();
    assert_eq!(numbers, [2, 1]);
    assert_eq!(versions.body["items"][1]["message"], "erste Fassung");
    assert_eq!(versions.body["items"][0]["authorName"], "Jörg Müller");
    let paged = t.get(&format!("~/dashboards/{id}/versions?limit=1"), &t.owner).await;
    let cursor = paged.body["nextCursor"].as_str().unwrap().to_string();
    let second = t.get(&format!("~/dashboards/{id}/versions?limit=1&cursor={cursor}"), &t.owner).await;
    assert_eq!((&second.body["items"][0]["version"], &second.body["nextCursor"]), (&json!(1), &Value::Null));

    let first = t.get(&format!("~/dashboards/{id}/versions/1"), &t.owner).await;
    assert_eq!(first.body["model"]["title"], "Umsatz Übersicht");
    for missing in ["9", "eins", "-1"] {
        assert_eq!(t.get(&format!("~/dashboards/{id}/versions/{missing}"), &t.owner).await.code(), "not_found");
    }
    let back = t.post(&format!("~/dashboards/{id}/versions/1/restore"), json!({}), &t.owner).await;
    assert_eq!(
        (back.status, &back.body["version"], &back.body["title"]),
        (StatusCode::OK, &json!(3), &json!("Umsatz Übersicht")),
        "{}",
        back.body
    );
    let latest = t.get(&format!("~/dashboards/{id}/versions?limit=1"), &t.owner).await;
    assert_eq!(latest.body["items"][0]["restoredFrom"], 1);

    let actions = t.actions().await;
    for action in ["dashboard.created", "dashboard.saved", "dashboard.version_restored"] {
        assert!(actions.iter().any(|a| a == action), "{action} missing from {actions:?}");
    }

    // Viewers read but do not write; ids of other organizations do not exist.
    let viewer = t.member("Vera", "viewer").await;
    assert_eq!(t.get(&format!("~/dashboards/{id}"), &viewer).await.status, StatusCode::OK);
    assert_eq!(
        t.put(&format!("~/dashboards/{id}"), json!({ "model": model("x"), "version": 3 }), &viewer).await.code(),
        "forbidden"
    );
    assert_eq!(t.post("~/dashboards", json!({ "model": model("x") }), &viewer).await.code(), "forbidden");
    assert_eq!(t.delete(&format!("~/dashboards/{id}"), &viewer).await.code(), "forbidden");
    let (foreign_folder, foreign) = t.foreign_ids().await;
    for r in [
        t.get(&format!("~/dashboards/{foreign}"), &t.owner).await,
        t.get(&format!("~/dashboards/{foreign}/versions"), &t.owner).await,
        t.delete(&format!("~/dashboards/{foreign}"), &t.owner).await,
        t.put(&format!("~/dashboards/{foreign}"), json!({ "model": model("x"), "version": 1 }), &t.owner).await,
        t.post("~/dashboards", json!({ "folderId": foreign_folder, "model": model("x") }), &t.owner).await,
        t.put(
            &format!("~/dashboards/{id}"),
            json!({ "model": model("x"), "version": 3, "folderId": foreign_folder }),
            &t.owner,
        )
        .await,
        t.get(&format!("~/dashboards?folderId={foreign_folder}"), &t.owner).await,
    ] {
        assert_eq!(r.code(), "not_found", "{}", r.body);
    }
    for odd in ["+1", "01"] {
        assert_eq!(t.get(&format!("~/dashboards/{id}/versions/{odd}"), &t.owner).await.code(), "not_found", "{odd}");
    }
}

async fn dashboards_go_through_the_trash(t: TestApp) {
    let id = t.post("~/dashboards", json!({ "model": model("Lager") }), &t.owner).await.body["id"]
        .as_str()
        .unwrap()
        .to_string();
    let live_purge = t.delete(&format!("~/dashboards/{id}/purge"), &t.owner).await;
    assert_eq!((live_purge.status, live_purge.code()), (StatusCode::CONFLICT, "conflict"));
    assert_eq!(t.delete(&format!("~/dashboards/{id}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.delete(&format!("~/dashboards/{id}"), &t.owner).await.status, StatusCode::NO_CONTENT, "again is fine");
    assert!(t.get("~/dashboards", &t.owner).await.body["items"].as_array().unwrap().is_empty());
    let trash = t.get("~/dashboards?trashed=true", &t.owner).await;
    assert_eq!(trash.body["items"][0]["id"], id.as_str());
    let edit = t.put(&format!("~/dashboards/{id}"), json!({ "model": model("x"), "version": 1 }), &t.owner).await;
    assert_eq!(edit.code(), "conflict");

    let restored = t.post(&format!("~/dashboards/{id}/restore"), json!({}), &t.owner).await;
    assert_eq!((restored.status, &restored.body["deletedAt"]), (StatusCode::OK, &Value::Null));
    assert_eq!(t.get("~/dashboards", &t.owner).await.body["items"].as_array().unwrap().len(), 1);

    t.delete(&format!("~/dashboards/{id}"), &t.owner).await;
    assert_eq!(t.delete(&format!("~/dashboards/{id}/purge"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&format!("~/dashboards/{id}"), &t.owner).await.code(), "not_found");
    let actions = t.actions().await;
    assert_eq!(
        &actions[actions.len() - 4..],
        ["dashboard.trashed", "dashboard.restored", "dashboard.trashed", "dashboard.purged"]
    );
}

async fn dashboard_lists_search_move_and_page(t: TestApp) {
    let folder =
        t.post("~/folders", json!({ "name": "Berichte" }), &t.owner).await.body["id"].as_str().unwrap().to_string();
    for title in ["Übersicht Umsatz", "Lager", "Umsatz je Region", "Kosten"] {
        t.post("~/dashboards", json!({ "model": model(title) }), &t.owner).await;
    }
    let search = t.get("~/dashboards?q=umsatz", &t.owner).await;
    let mut titles: Vec<&str> =
        search.body["items"].as_array().unwrap().iter().map(|d| d["title"].as_str().unwrap()).collect();
    // Where "Ü" sorts depends on the database's collation, so only the set is compared here.
    titles.sort();
    assert_eq!(titles, ["Umsatz je Region", "Übersicht Umsatz"]);
    let umlaut = t.get("~/dashboards?q=%C3%BCBERSICHT", &t.owner).await;
    assert_eq!(umlaut.body["items"].as_array().unwrap().len(), 1, "{}", umlaut.body);

    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let path = match &cursor {
            Some(c) => format!("~/dashboards?limit=3&cursor={c}"),
            None => "~/dashboards?limit=3".to_string(),
        };
        let page = t.get(&path, &t.owner).await;
        seen.extend(page.body["items"].as_array().unwrap().iter().map(|d| d["title"].as_str().unwrap().to_string()));
        match page.body["nextCursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
    }
    assert_eq!(&seen[..2], ["Kosten", "Lager"]);
    seen.sort();
    assert_eq!(seen, ["Kosten", "Lager", "Umsatz je Region", "Übersicht Umsatz"], "every dashboard once");

    // Saving with a folder moves the dashboard.
    let id = t.get("~/dashboards?q=Lager", &t.owner).await.body["items"][0]["id"].as_str().unwrap().to_string();
    let moved = t
        .put(
            &format!("~/dashboards/{id}"),
            json!({ "model": model("Lager"), "version": 1, "folderId": folder }),
            &t.owner,
        )
        .await;
    assert_eq!(moved.body["folderId"], folder.as_str(), "{}", moved.body);
    let in_folder = t.get(&format!("~/dashboards?folderId={folder}"), &t.owner).await;
    assert_eq!(in_folder.body["items"].as_array().unwrap().len(), 1);
    let kept = t.put(&format!("~/dashboards/{id}"), json!({ "model": model("Lager"), "version": 2 }), &t.owner).await;
    assert_eq!(kept.body["folderId"], folder.as_str(), "no folderId keeps the folder");
    let top = t
        .put(
            &format!("~/dashboards/{id}"),
            json!({ "model": model("Lager"), "version": 3, "folderId": null }),
            &t.owner,
        )
        .await;
    assert!(top.body["folderId"].is_null());
    let nowhere = t
        .put(
            &format!("~/dashboards/{id}"),
            json!({ "model": model("Lager"), "version": 4, "folderId": "nope" }),
            &t.owner,
        )
        .await;
    assert_eq!(nowhere.code(), "not_found");
    assert_eq!(t.get("~/dashboards?folderId=nope", &t.owner).await.code(), "not_found");
    assert_eq!(t.get("~/dashboards?limit=500", &t.owner).await.field(), "limit");
}

fn id_of(r: Reply) -> String {
    assert!(r.status.is_success(), "{}", r.body);
    r.body["id"].as_str().unwrap().to_string()
}

fn titles(r: &Reply) -> Vec<String> {
    let mut out: Vec<String> =
        r.body["items"].as_array().unwrap().iter().map(|d| d["title"].as_str().unwrap().to_string()).collect();
    out.sort();
    out
}

fn folder_names(nodes: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for n in nodes.as_array().unwrap() {
        out.push(n["name"].as_str().unwrap().to_string());
        out.extend(folder_names(&n["children"]));
    }
    out.sort();
    out
}

/// Grants open restricted folders: the folder, its subfolders (unless a nearer restricted folder
/// has no grant) and their dashboards, in single reads, lists and search alike.
async fn grants_open_restricted_folders(t: TestApp) {
    let vera = t.member("Vera", "viewer").await;
    let walter = t.member("Walter", "viewer").await;
    let secret = id_of(t.post("~/folders", json!({ "name": "Geheim", "restricted": true }), &t.owner).await);
    let sub = id_of(t.post("~/folders", json!({ "name": "Unter", "parentId": secret }), &t.owner).await);
    let inner =
        id_of(t.post("~/folders", json!({ "name": "Innen", "parentId": sub, "restricted": true }), &t.owner).await);
    let in_sub = id_of(t.post("~/dashboards", json!({ "folderId": sub, "model": model("Gehälter") }), &t.owner).await);
    let in_inner = id_of(t.post("~/dashboards", json!({ "folderId": inner, "model": model("Boni") }), &t.owner).await);
    t.grant("Vera", "folder", &secret, "view").await;

    // Vera sees the granted folder and what lies below, except the nearer restricted folder.
    assert_eq!(folder_names(&t.get("~/folders", &vera).await.body["items"]), ["Geheim", "Unter"]);
    assert_eq!(titles(&t.get("~/dashboards", &vera).await), ["Gehälter"]);
    assert_eq!(titles(&t.get("~/dashboards?q=geh%C3%A4", &vera).await), ["Gehälter"]);
    assert_eq!(t.get(&format!("~/dashboards/{in_sub}"), &vera).await.status, StatusCode::OK);
    assert_eq!(t.get(&format!("~/dashboards?folderId={sub}"), &vera).await.status, StatusCode::OK);
    for path in [format!("~/dashboards/{in_inner}"), format!("~/dashboards?folderId={inner}")] {
        assert_eq!(t.get(&path, &vera).await.code(), "not_found", "{path}");
    }
    // A view grant does not allow writing (the grant check refuses it, not the route: the route
    // is open to every member); an edit grant does, for a viewer too.
    let save = t.put(&format!("~/dashboards/{in_sub}"), json!({ "model": model("x"), "version": 1 }), &vera).await;
    assert_eq!(save.code(), "forbidden");
    assert!(save.body["error"]["message"].as_str().unwrap().contains("dashboards:write"), "{}", save.body);
    t.grant("Vera", "folder", &secret, "edit").await;
    let save =
        t.put(&format!("~/dashboards/{in_sub}"), json!({ "model": plain("Gehälter"), "version": 1 }), &vera).await;
    assert_eq!(save.status, StatusCode::OK, "{}", save.body);

    // Walter has no grant: nothing of it exists for him.
    assert!(t.get("~/folders", &walter).await.body["items"].as_array().unwrap().is_empty());
    assert!(t.get("~/dashboards?q=geh", &walter).await.body["items"].as_array().unwrap().is_empty());
    assert_eq!(t.get(&format!("~/dashboards/{in_sub}"), &walter).await.code(), "not_found");

    // A grant on one dashboard shows that dashboard, and not its folder.
    t.grant("Walter", "dashboard", &in_inner, "view").await;
    assert_eq!(titles(&t.get("~/dashboards", &walter).await), ["Boni"]);
    assert_eq!(t.get(&format!("~/dashboards/{in_inner}"), &walter).await.status, StatusCode::OK);
    assert!(t.get("~/folders", &walter).await.body["items"].as_array().unwrap().is_empty());

    // A grant below the restricted folder shows that subfolder at the top, without its hidden parent.
    t.grant("Walter", "folder", &sub, "view").await;
    let tree = t.get("~/folders", &walter).await;
    assert_eq!(tree.body["items"][0]["name"], "Unter", "{}", tree.body);
    assert!(tree.body["items"][0]["parentId"].is_null());
}

/// Purging a folder or a dashboard deletes the grants on it and on everything purged with it.
async fn purging_deletes_grants(t: TestApp) {
    t.member("Vera", "viewer").await;
    let top = id_of(t.post("~/folders", json!({ "name": "Oben" }), &t.owner).await);
    let below = id_of(t.post("~/folders", json!({ "name": "Unten", "parentId": top }), &t.owner).await);
    let inside = id_of(t.post("~/dashboards", json!({ "folderId": below, "model": model("Drin") }), &t.owner).await);
    let alone = id_of(t.post("~/dashboards", json!({ "model": model("Allein") }), &t.owner).await);
    let kept = id_of(t.post("~/dashboards", json!({ "model": model("Bleibt") }), &t.owner).await);
    for (kind, id) in
        [("folder", &top), ("folder", &below), ("dashboard", &inside), ("dashboard", &alone), ("dashboard", &kept)]
    {
        t.grant("Vera", kind, id, "view").await;
    }
    t.delete(&format!("~/folders/{top}"), &t.owner).await;
    // In the trash the grants stay, so a restore brings the access back.
    assert_eq!(t.grants_on(&[&top, &below, &inside]).await, 3);
    assert_eq!(t.delete(&format!("~/folders/{top}/purge"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.grants_on(&[&top, &below, &inside]).await, 0);

    t.delete(&format!("~/dashboards/{alone}"), &t.owner).await;
    assert_eq!(t.delete(&format!("~/dashboards/{alone}/purge"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.grants_on(&[&alone]).await, 0);
    assert_eq!(t.grants_on(&[&kept]).await, 1, "other grants stay");
}

/// Grants created while their resource is purged: either the grant comes first and goes with
/// the purge, or it answers not_found; never a grant on a resource that is gone.
async fn purges_and_new_grants_leave_no_orphans(t: TestApp) {
    t.member("Vera", "viewer").await;
    let vera = t.user_id("Vera").await;
    let grant = |resource_type: &str, id: &str| {
        json!({ "subjectType": "user", "subjectId": vera, "resourceType": resource_type, "resourceId": id,
                "level": "view" })
    };
    for round in 0..10 {
        let folder = id_of(t.post("~/folders", json!({ "name": format!("F{round}") }), &t.owner).await);
        let inside =
            id_of(t.post("~/dashboards", json!({ "folderId": folder, "model": model("Drin") }), &t.owner).await);
        let alone = id_of(t.post("~/dashboards", json!({ "model": model("Allein") }), &t.owner).await);
        t.delete(&format!("~/folders/{folder}"), &t.owner).await;
        t.delete(&format!("~/dashboards/{alone}"), &t.owner).await;
        let (purge_folder, purge_alone) = (format!("~/folders/{folder}/purge"), format!("~/dashboards/{alone}/purge"));
        let (pf, pa, gf, gi, ga) = tokio::join!(
            t.delete(&purge_folder, &t.owner),
            t.delete(&purge_alone, &t.owner),
            t.post("~/grants", grant("folder", &folder), &t.owner),
            t.post("~/grants", grant("dashboard", &inside), &t.owner),
            t.post("~/grants", grant("dashboard", &alone), &t.owner),
        );
        assert_eq!((pf.status, pa.status), (StatusCode::NO_CONTENT, StatusCode::NO_CONTENT));
        for g in [&gf, &gi, &ga] {
            assert!(matches!(g.status, StatusCode::CREATED | StatusCode::NOT_FOUND), "{} {}", g.status, g.body);
        }
        let (orphans,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM resource_grants g WHERE \
             (g.resource_type = 'folder' AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.id = g.resource_id)) \
             OR (g.resource_type = 'dashboard' AND NOT EXISTS (SELECT 1 FROM dashboards d WHERE d.id = g.resource_id))",
        )
        .fetch_one(&t.state.db)
        .await
        .unwrap();
        assert_eq!(orphans, 0, "round {round}");
    }
}

/// B1: trashing, restoring or purging a folder needs rights on every part of it that another
/// restricted folder governs, and on the dashboards that go along.
async fn subtree_actions_need_rights_on_every_part(t: TestApp) {
    let erika = t.member("Erika", "editor").await;
    let team = id_of(t.post("~/folders", json!({ "name": "Team" }), &t.owner).await);
    let secret =
        id_of(t.post("~/folders", json!({ "name": "Geheim", "parentId": team, "restricted": true }), &t.owner).await);
    let salaries =
        id_of(t.post("~/dashboards", json!({ "folderId": secret, "model": model("Gehälter") }), &t.owner).await);
    t.grant("Erika", "folder", &secret, "view").await;

    let r = t.delete(&format!("~/folders/{team}"), &erika).await;
    assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden"), "{}", r.body);
    assert!(t.get(&format!("~/dashboards/{salaries}"), &t.owner).await.body["deletedAt"].is_null());

    assert_eq!(t.delete(&format!("~/folders/{team}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    for r in [
        t.post(&format!("~/folders/{team}/restore"), json!({}), &erika).await,
        t.delete(&format!("~/folders/{team}/purge"), &erika).await,
    ] {
        assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden"), "{}", r.body);
    }
    assert_eq!(t.get(&format!("~/dashboards/{salaries}"), &t.owner).await.status, StatusCode::OK, "still there");

    // With an edit grant on the restricted part the editor may act on the whole.
    t.grant("Erika", "folder", &secret, "edit").await;
    assert_eq!(t.post(&format!("~/folders/{team}/restore"), json!({}), &erika).await.status, StatusCode::OK);
    assert_eq!(t.delete(&format!("~/folders/{team}"), &erika).await.status, StatusCode::NO_CONTENT);
}

/// B2 and M3: the parent a caller cannot see reads as `null`, sending it back is no move, and a
/// move into or out of a restricted folder needs `folders:permissions`.
async fn a_masked_parent_is_no_move_and_restriction_moves_need_permissions(t: TestApp) {
    let erika = t.member("Erika", "editor").await;
    let vera = t.member("Vera", "viewer").await;
    let secret = id_of(t.post("~/folders", json!({ "name": "Geheim", "restricted": true }), &t.owner).await);
    let sub = id_of(t.post("~/folders", json!({ "name": "Unter", "parentId": secret }), &t.owner).await);
    let inside = id_of(t.post("~/dashboards", json!({ "folderId": sub, "model": model("Lohn") }), &t.owner).await);
    let open = id_of(t.post("~/folders", json!({ "name": "Offen" }), &t.owner).await);
    t.grant("Erika", "folder", &sub, "edit").await;

    // A rename that echoes the parent as Erika sees it leaves the folder where it is.
    let renamed = t
        .patch(&format!("~/folders/{sub}"), json!({ "name": "Unter 2", "parentId": null, "version": 1 }), &erika)
        .await;
    assert_eq!((renamed.status, &renamed.body["parentId"]), (StatusCode::OK, &Value::Null), "{}", renamed.body);
    let (parent,): (Option<String>,) =
        sqlx::query_as("SELECT parent_id FROM folders WHERE id = $1").bind(&sub).fetch_one(&t.state.db).await.unwrap();
    assert_eq!(parent.as_deref(), Some(secret.as_str()), "still inside the restricted folder");
    assert_eq!(t.get(&format!("~/dashboards/{inside}"), &vera).await.code(), "not_found");

    // Moving it out of the restricted folder is a permissions change.
    let out = t.patch(&format!("~/folders/{sub}"), json!({ "parentId": open, "version": 2 }), &erika).await;
    assert_eq!((out.status, out.code()), (StatusCode::FORBIDDEN, "forbidden"), "{}", out.body);

    // M3: a folder with hidden content below cannot move, to the top level neither.
    let a = id_of(t.post("~/folders", json!({ "name": "A" }), &t.owner).await);
    let b = id_of(t.post("~/folders", json!({ "name": "B", "parentId": a }), &t.owner).await);
    t.post("~/folders", json!({ "name": "Geheim 2", "parentId": b, "restricted": true }), &t.owner).await;
    for body in [json!({ "parentId": null, "version": 1 }), json!({ "parentId": open, "version": 1 })] {
        let r = t.patch(&format!("~/folders/{b}"), body, &erika).await;
        assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden"), "{}", r.body);
    }

    // The trash list and the restore answer do not name the hidden parent either.
    t.delete(&format!("~/folders/{sub}"), &t.owner).await;
    let trash = t.get("~/folders?trashed=true", &erika).await;
    assert_eq!(trash.body["items"][0]["id"], sub.as_str(), "{}", trash.body);
    assert!(trash.body["items"][0]["parentId"].is_null());
    let restored = t.post(&format!("~/folders/{sub}/restore"), json!({}), &erika).await;
    assert_eq!((restored.status, &restored.body["parentId"]), (StatusCode::OK, &Value::Null), "{}", restored.body);
}

/// M1: a purge racing a restore never deletes the restored dashboard.
async fn purge_never_takes_a_restored_dashboard(t: TestApp) {
    for round in 0..40 {
        let id = id_of(t.post("~/dashboards", json!({ "model": model(&format!("D{round}")) }), &t.owner).await);
        t.delete(&format!("~/dashboards/{id}"), &t.owner).await;
        let (purge_path, restore_path) = (format!("~/dashboards/{id}/purge"), format!("~/dashboards/{id}/restore"));
        let (purged, restored) =
            tokio::join!(t.delete(&purge_path, &t.owner), t.post(&restore_path, json!({}), &t.owner));
        let stored = t.get(&format!("~/dashboards/{id}"), &t.owner).await;
        if restored.status == StatusCode::OK {
            assert_eq!(purged.code(), "conflict", "round {round}: {}", purged.body);
            assert_eq!(stored.status, StatusCode::OK, "round {round}: restored, then purged");
        } else {
            assert_eq!(restored.code(), "not_found", "round {round}: {}", restored.body);
            assert_eq!(purged.status, StatusCode::NO_CONTENT);
            assert_eq!(stored.code(), "not_found");
        }
    }
}

/// M2: grants extend a member's rights beyond their role; the top level keeps the org-wide rule.
async fn grants_extend_rights_beyond_the_role(t: TestApp) {
    let vera = t.member("Vera", "viewer").await;
    let shared = id_of(t.post("~/folders", json!({ "name": "Geteilt" }), &t.owner).await);
    let other = id_of(t.post("~/folders", json!({ "name": "Andere" }), &t.owner).await);
    let in_shared = id_of(t.post("~/dashboards", json!({ "folderId": shared, "model": model("A") }), &t.owner).await);
    let in_other = id_of(t.post("~/dashboards", json!({ "folderId": other, "model": model("B") }), &t.owner).await);
    t.grant("Vera", "folder", &shared, "edit").await;

    let save = t.put(&format!("~/dashboards/{in_shared}"), json!({ "model": plain("A2"), "version": 1 }), &vera).await;
    assert_eq!(save.status, StatusCode::OK, "{}", save.body);
    let created = t.post("~/dashboards", json!({ "folderId": shared, "model": plain("Neu") }), &vera).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let sub = t.post("~/folders", json!({ "name": "Unter", "parentId": shared }), &vera).await;
    assert_eq!(sub.status, StatusCode::CREATED, "{}", sub.body);
    assert_eq!(t.delete(&format!("~/dashboards/{in_shared}"), &vera).await.status, StatusCode::NO_CONTENT);

    // Elsewhere and at the top level the viewer role decides.
    let refused = [
        t.put(&format!("~/dashboards/{in_other}"), json!({ "model": model("B2"), "version": 1 }), &vera).await,
        t.post("~/dashboards", json!({ "model": model("Oben") }), &vera).await,
        t.post("~/folders", json!({ "name": "Oben" }), &vera).await,
        t.patch(&format!("~/folders/{shared}"), json!({ "restricted": true, "version": 1 }), &vera).await,
    ];
    for r in refused {
        assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden"), "{}", r.body);
    }
    // An admin grant on the folder allows restricting it.
    t.grant("Vera", "folder", &shared, "admin").await;
    let restricted = t.patch(&format!("~/folders/{shared}"), json!({ "restricted": true, "version": 1 }), &vera).await;
    assert_eq!(restricted.status, StatusCode::OK, "{}", restricted.body);
}

/// m1: a dashboard reached only through a grant on it does not name its hidden folder, and saving
/// it keeps the folder.
async fn a_dashboard_reached_by_its_own_grant_hides_its_folder(t: TestApp) {
    let walter = t.member("Walter", "viewer").await;
    let secret = id_of(t.post("~/folders", json!({ "name": "Geheim", "restricted": true }), &t.owner).await);
    let id = id_of(t.post("~/dashboards", json!({ "folderId": secret, "model": model("Boni") }), &t.owner).await);
    t.grant("Walter", "dashboard", &id, "edit").await;

    assert!(t.get(&format!("~/dashboards/{id}"), &walter).await.body["folderId"].is_null());
    assert!(t.get("~/dashboards", &walter).await.body["items"][0]["folderId"].is_null());
    for (version, body) in [
        (1, json!({ "model": plain("Boni 2"), "version": 1 })),
        (2, json!({ "model": plain("Boni 3"), "version": 2, "folderId": null })),
    ] {
        let saved = t.put(&format!("~/dashboards/{id}"), body, &walter).await;
        assert_eq!(saved.status, StatusCode::OK, "{version}: {}", saved.body);
        assert_eq!(t.get(&format!("~/dashboards/{id}"), &t.owner).await.body["folderId"], secret.as_str());
    }
}

/// m2: audit summaries do not name folders the reader cannot see, and purged restricted content
/// stays out of their view.
async fn audit_summaries_do_not_name_hidden_folders(t: TestApp) {
    let role = t.post("~/roles", json!({ "name": "Prüfer", "permissions": ["audit:read"] }), &t.owner).await;
    assert_eq!(role.status, StatusCode::CREATED, "{}", role.body);
    let auditor = t.member("Paula", role.body["id"].as_str().unwrap()).await;
    let secret = id_of(t.post("~/folders", json!({ "name": "Geheim", "restricted": true }), &t.owner).await);
    let sub = id_of(t.post("~/folders", json!({ "name": "Unter", "parentId": secret }), &t.owner).await);
    let dashboard =
        id_of(t.post("~/dashboards", json!({ "folderId": secret, "model": model("Boni") }), &t.owner).await);
    t.grant("Paula", "folder", &sub, "view").await;
    t.grant("Paula", "dashboard", &dashboard, "view").await;

    let events = |r: &Reply| r.body["items"].as_array().unwrap().clone();
    let seen = events(&t.get("~/audit", &auditor).await);
    let created_sub = seen.iter().find(|e| e["resourceId"] == sub.as_str()).expect("the granted folder's event");
    assert!(created_sub["summary"]["parentId"].is_null(), "{created_sub}");
    let created_dashboard = seen.iter().find(|e| e["resourceId"] == dashboard.as_str()).expect("the dashboard's event");
    assert!(created_dashboard["summary"]["folderId"].is_null(), "{created_dashboard}");
    assert!(!seen.iter().any(|e| e["resourceId"] == secret.as_str()));
    assert!(!seen.iter().any(|e| e.to_string().contains(&secret)), "the hidden folder is named nowhere");

    // Purged, the restricted content stays out of the auditor's view.
    t.delete(&format!("~/folders/{secret}"), &t.owner).await;
    t.delete(&format!("~/folders/{secret}/purge"), &t.owner).await;
    let after = events(&t.get("~/audit?limit=200", &auditor).await);
    for id in [&secret, &sub, &dashboard] {
        assert!(!after.iter().any(|e| e["resourceId"] == id.as_str()), "{id} visible after the purge");
    }
    let owner_view = events(&t.get("~/audit?limit=200", &t.owner).await);
    assert!(owner_view.iter().any(|e| e["resourceId"] == secret.as_str()), "owners still see it");
}

/// Answers say what the caller may do, grants included.
async fn answers_say_what_the_caller_may_do(t: TestApp) {
    let vera = t.member("Vera", "viewer").await;
    let shared = id_of(t.post("~/folders", json!({ "name": "Geteilt" }), &t.owner).await);
    let other = id_of(t.post("~/folders", json!({ "name": "Andere" }), &t.owner).await);
    let in_shared = id_of(t.post("~/dashboards", json!({ "folderId": shared, "model": model("A") }), &t.owner).await);
    let in_other = id_of(t.post("~/dashboards", json!({ "folderId": other, "model": model("B") }), &t.owner).await);
    t.grant("Vera", "folder", &shared, "edit").await;

    let all = json!({ "write": true, "delete": true, "permissions": true });
    let edit = json!({ "write": true, "delete": true, "permissions": false });
    let none = json!({ "write": false, "delete": false, "permissions": false });
    assert_eq!(t.get(&format!("~/dashboards/{in_shared}"), &vera).await.body["access"], edit);
    assert_eq!(t.get(&format!("~/dashboards/{in_other}"), &vera).await.body["access"], none);
    assert_eq!(t.get(&format!("~/dashboards/{in_other}"), &t.owner).await.body["access"], all);
    let list = t.get("~/dashboards", &vera).await;
    let by_title = |title: &str| {
        list.body["items"].as_array().unwrap().iter().find(|d| d["title"] == title).unwrap()["access"].clone()
    };
    assert_eq!((by_title("A"), by_title("B")), (edit.clone(), none.clone()));
    let tree = t.get("~/folders", &vera).await;
    let folder = |name: &str| {
        tree.body["items"].as_array().unwrap().iter().find(|f| f["name"] == name).unwrap()["access"].clone()
    };
    assert_eq!((folder("Geteilt"), folder("Andere")), (edit, none));
}

/// New dashboards without a time range start with the organization's default.
async fn new_dashboards_take_the_default_time_range(t: TestApp) {
    let range = json!({ "from": "now-24h", "to": "now" });
    let set =
        t.patch("~/settings/dashboards.default_time_range", json!({ "value": range, "version": 0 }), &t.owner).await;
    assert_eq!(set.status, StatusCode::OK, "{}", set.body);
    let mut bare = model("Ohne Zeitraum");
    bare.as_object_mut().unwrap().remove("timeRange");
    let created = t.post("~/dashboards", json!({ "model": bare }), &t.owner).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    assert_eq!(created.body["model"]["timeRange"], range);
    // A range given explicitly stays.
    let explicit = t.post("~/dashboards", json!({ "model": model("Mit") }), &t.owner).await;
    assert_eq!(explicit.body["model"]["timeRange"], json!({ "from": "now-6h", "to": "now" }));
}

/// N1: moving a dashboard into or out of a restricted folder needs `folders:permissions` on both
/// places; echoing the masked `null` stays no move.
async fn dashboard_moves_across_restriction_need_permissions(t: TestApp) {
    let erika = t.member("Erika", "editor").await;
    let vera = t.member("Vera", "viewer").await;
    let secret = id_of(t.post("~/folders", json!({ "name": "Geheim", "restricted": true }), &t.owner).await);
    let open = id_of(t.post("~/folders", json!({ "name": "Offen" }), &t.owner).await);
    let pay = id_of(t.post("~/dashboards", json!({ "folderId": secret, "model": plain("Lohn") }), &t.owner).await);
    let path = format!("~/dashboards/{pay}");
    let folder_of = || async {
        let (f,): (Option<String>,) = sqlx::query_as("SELECT folder_id FROM dashboards WHERE id = $1")
            .bind(&pay)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
        f
    };

    // A grant on the dashboard alone: out of the hidden folder is refused, the echo is no move.
    t.grant("Erika", "dashboard", &pay, "edit").await;
    let out = t.put(&path, json!({ "model": plain("Lohn"), "version": 1, "folderId": open }), &erika).await;
    assert_eq!((out.status, out.code()), (StatusCode::FORBIDDEN, "forbidden"), "{}", out.body);
    let echo = t.put(&path, json!({ "model": plain("Lohn"), "version": 1, "folderId": null }), &erika).await;
    assert_eq!(echo.status, StatusCode::OK, "{}", echo.body);
    assert_eq!(folder_of().await.as_deref(), Some(secret.as_str()));
    assert_eq!(t.get(&path, &vera).await.code(), "not_found");

    // An edit grant on the restricted folder is not enough to take it out, an admin grant is.
    t.grant("Erika", "folder", &secret, "edit").await;
    let top = t.put(&path, json!({ "model": plain("Lohn"), "version": 2, "folderId": null }), &erika).await;
    assert_eq!((top.status, top.code()), (StatusCode::FORBIDDEN, "forbidden"), "{}", top.body);
    assert_eq!(folder_of().await.as_deref(), Some(secret.as_str()));
    t.grant("Erika", "folder", &secret, "admin").await;
    let top = t.put(&path, json!({ "model": plain("Lohn"), "version": 2, "folderId": null }), &erika).await;
    assert_eq!(top.status, StatusCode::OK, "{}", top.body);
    assert_eq!(folder_of().await, None);
}

/// N2: whoever restricts a folder through an admin grant keeps access to it.
async fn restricting_through_an_admin_grant_keeps_access(t: TestApp) {
    let vera = t.member("Vera", "viewer").await;
    let team = id_of(t.post("~/folders", json!({ "name": "Team" }), &t.owner).await);
    t.grant("Vera", "folder", &team, "admin").await;
    let created = t.post("~/folders", json!({ "name": "Intern", "parentId": team, "restricted": true }), &vera).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    assert_eq!(created.body["access"]["permissions"], true);
    let names = |r: &Reply| folder_names(&r.body["items"]);
    assert!(names(&t.get("~/folders", &vera).await).contains(&"Intern".to_string()));

    // Restricting a subfolder through the grant on its parent, and a folder through its own grant.
    let sub = id_of(t.post("~/folders", json!({ "name": "Unter", "parentId": team }), &t.owner).await);
    let r = t.patch(&format!("~/folders/{sub}"), json!({ "restricted": true, "version": 1 }), &vera).await;
    assert_eq!((r.status, &r.body["restricted"]), (StatusCode::OK, &json!(true)), "{}", r.body);
    let own = id_of(t.post("~/folders", json!({ "name": "Eigen" }), &t.owner).await);
    t.grant("Vera", "folder", &own, "admin").await;
    let r = t.patch(&format!("~/folders/{own}"), json!({ "restricted": true, "version": 1 }), &vera).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let seen = names(&t.get("~/folders", &vera).await);
    for name in ["Unter", "Eigen"] {
        assert!(seen.contains(&name.to_string()), "{name} in {seen:?}");
    }
    let other = t.member("Walter", "viewer").await;
    assert!(
        names(&t.get("~/folders", &other).await).iter().all(|n| !["Intern", "Unter", "Eigen"].contains(&n.as_str()))
    );
}

/// N3: the top level belongs to no folder, so moving there needs the org-wide right.
async fn moving_a_folder_to_the_top_level_needs_the_org_wide_right(t: TestApp) {
    let vera = t.member("Vera", "viewer").await;
    let top = id_of(t.post("~/folders", json!({ "name": "Oben" }), &t.owner).await);
    let sub = id_of(t.post("~/folders", json!({ "name": "Unten", "parentId": top }), &t.owner).await);
    t.grant("Vera", "folder", &top, "edit").await;
    let r = t.patch(&format!("~/folders/{sub}"), json!({ "parentId": null, "version": 1 }), &vera).await;
    assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden"), "{}", r.body);
    // Within the granted folder, moving works.
    let other = id_of(t.post("~/folders", json!({ "name": "Daneben", "parentId": top }), &t.owner).await);
    let r = t.patch(&format!("~/folders/{sub}"), json!({ "parentId": other, "version": 1 }), &vera).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
}

/// A dashboard moved out of a restricted folder keeps its events hidden once purged.
async fn dashboards_moved_out_of_restriction_stay_hidden_once_purged(t: TestApp) {
    let role = t.post("~/roles", json!({ "name": "Prüfer", "permissions": ["audit:read"] }), &t.owner).await;
    let auditor = t.member("Paula", role.body["id"].as_str().unwrap()).await;
    let secret = id_of(t.post("~/folders", json!({ "name": "Geheim", "restricted": true }), &t.owner).await);
    let open = id_of(t.post("~/folders", json!({ "name": "Offen" }), &t.owner).await);
    let id = id_of(t.post("~/dashboards", json!({ "folderId": secret, "model": plain("Lohn") }), &t.owner).await);
    let moved = t
        .put(&format!("~/dashboards/{id}"), json!({ "model": plain("Lohn"), "version": 1, "folderId": open }), &t.owner)
        .await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.body);
    t.delete(&format!("~/dashboards/{id}"), &t.owner).await;
    assert_eq!(t.delete(&format!("~/dashboards/{id}/purge"), &t.owner).await.status, StatusCode::NO_CONTENT);
    let events = t.get("~/audit?limit=200", &auditor).await;
    assert!(
        !events.body["items"].as_array().unwrap().iter().any(|e| e["resourceId"] == id.as_str()),
        "{}",
        events.body
    );
}

async fn old_versions_beyond_the_retention_are_dropped(t: TestApp) {
    t.patch("/admin/settings/dashboards.version_retention", json!({ "value": 2, "version": 0 }), &t.owner).await;
    let id = t.post("~/dashboards", json!({ "model": model("v1") }), &t.owner).await.body["id"]
        .as_str()
        .unwrap()
        .to_string();
    for version in 1..4 {
        let r =
            t.put(&format!("~/dashboards/{id}"), json!({ "model": model("next"), "version": version }), &t.owner).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    }
    let versions = t.get(&format!("~/dashboards/{id}/versions"), &t.owner).await;
    let numbers: Vec<i64> =
        versions.body["items"].as_array().unwrap().iter().map(|v| v["version"].as_i64().unwrap()).collect();
    assert_eq!(numbers, [4, 3]);
}
