//! Usage insights through the real router and database (docs/api/usage.md): views and query runs
//! are counted per dashboard, panel and data source, only admins read them, and turning
//! recording off records nothing.

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

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const T0: i64 = 1_800_000_000_000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    _dir: tempfile::TempDir,
    sources: tempfile::TempDir,
    owner: String,
    org: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
}

impl Reply {
    fn ok(self) -> Value {
        assert_eq!(self.status, StatusCode::OK, "{}", self.body);
        self.body
    }
}

async fn test_app(db_url: Option<String>) -> TestApp {
    let dir = common::private_tempdir();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.database.url = db_url;
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(T0));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    let app = router(state.clone()).layer(MockConnectInfo(peer));
    let sources = common::private_tempdir();
    let mut t = TestApp { app, clock, state, _dir: dir, sources, owner: String::new(), org: String::new() };
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

    fn path(&self, path: &str) -> String {
        match path.strip_prefix('~') {
            Some(rest) => format!("/api/orgs/{}{rest}", self.org),
            None => format!("/api{path}"),
        }
    }

    async fn get(&self, path: &str, cookie: &str) -> Reply {
        self.send(Method::GET, &self.path(path), None, Some(cookie)).await
    }

    async fn post(&self, path: &str, body: Value, cookie: &str) -> Reply {
        self.send(Method::POST, &self.path(path), Some(body), Some(cookie)).await
    }

    async fn session_for(&self, user_id: &str) -> String {
        let cfg = &self.state.config.sessions;
        let token = kalzit::auth::session::create(&self.state.db, cfg, self.clock.now_ms(), user_id).await.unwrap();
        format!("kalzit_session={token}")
    }

    /// A new user who is a member of `org` with `role`; answers their session cookie.
    async fn member_of(&self, org: &str, name: &str, role: &str) -> String {
        let id = uuid::Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ($1, $2, $3, 0)")
            .bind(&id)
            .bind(format!("{}@example.de", name.to_lowercase()))
            .bind(name)
            .execute(&self.state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, $3, 0)")
            .bind(org)
            .bind(&id)
            .bind(role)
            .execute(&self.state.db)
            .await
            .unwrap();
        self.session_for(&id).await
    }

    async fn second_org(&self) -> String {
        let id = uuid::Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, 'Zweite GmbH', 0)")
            .bind(&id)
            .execute(&self.state.db)
            .await
            .unwrap();
        id
    }

    /// A SQLite source with `releases (ts DATETIME, text TEXT)` holding two rows, in a directory
    /// the server admin allowed.
    async fn source(&self, name: &str) -> String {
        let dir = self.sources.path();
        let allowed = self
            .send(
                Method::PATCH,
                "/api/admin/settings/datasources.sqlite_dirs",
                Some(json!({ "value": [dir.to_string_lossy()], "version": 0 })),
                Some(&self.owner),
            )
            .await;
        if allowed.status != StatusCode::OK {
            assert_eq!(allowed.status, StatusCode::CONFLICT, "{}", allowed.body);
        }
        let path = dir.join(format!("{name}.db"));
        let pool = sqlx::SqlitePool::connect(&kalzit::config::sqlite_url(&path)).await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE releases (ts DATETIME, text TEXT); \
             INSERT INTO releases VALUES (1799990000000, 'Release 2.4'), (1799990001000, 'Release 2.5');",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        let body = json!({ "name": name, "kind": "sqlite", "settings": { "path": path.to_string_lossy() } });
        let r = self.post("~/datasources", body, &self.owner).await;
        assert!(r.status.is_success(), "{}", r.body);
        r.body["id"].as_str().unwrap().to_string()
    }

    /// A dashboard with the panel `p1` ("Releases") reading `source`.
    async fn dashboard(&self, title: &str, source: &str) -> String {
        let model = json!({ "schemaVersion": 1, "title": title, "timeRange": { "from": "now-6h", "to": "now" },
            "panels": [{ "id": "p1", "type": "table", "title": "Releases",
                         "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                         "targets": [{ "refId": "A", "datasourceId": source,
                                       "query": { "sql": "SELECT text FROM releases" } }] }] });
        let r = self.post("~/dashboards", json!({ "folderId": null, "model": model }), &self.owner).await;
        assert!(r.status.is_success(), "{}", r.body);
        r.body["id"].as_str().unwrap().to_string()
    }

    async fn view(&self, dashboard: &str, cookie: &str) {
        let r = self.post(&format!("~/dashboards/{dashboard}/views"), json!(null), cookie).await;
        assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    }

    async fn run_panel(&self, dashboard: &str, cookie: &str) {
        let body = json!({ "timeRange": { "from": T0 - DAY, "to": T0 }, "variables": {} });
        self.post(&format!("~/dashboards/{dashboard}/panels/p1/query"), body, cookie).await.ok();
    }

    async fn free_query(&self, source: &str, sql: &str) -> Reply {
        let body = json!({
            "queries": [{ "refId": "A", "datasourceId": source, "query": { "sql": sql } }],
            "timeRange": { "from": T0 - DAY, "to": T0 },
            "variables": {}
        });
        self.post("~/query", body, &self.owner).await
    }

    /// Writes the pending counts, as the background task does.
    async fn flush(&self) {
        kalzit::usage::flush(&self.state.usage, &self.state.db).await.unwrap();
    }

    fn range(&self) -> String {
        format!("from={}&to={}", T0 - DAY, T0 + HOUR)
    }

    async fn rows(&self, table: &str) -> i64 {
        let (n,): (i64,) = sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
            .fetch_one(&self.state.db)
            .await
            .unwrap();
        n
    }

    async fn set(&self, key: &str, value: Value) -> Reply {
        let all = self.get("/admin/settings", &self.owner).await.ok();
        let current = all["items"].as_array().unwrap().iter().find(|s| s["key"] == key).unwrap().clone();
        let version = current["version"].as_i64().unwrap_or(0);
        self.send(
            Method::PATCH,
            &format!("/api/admin/settings/{key}"),
            Some(json!({ "value": value, "version": version })),
            Some(&self.owner),
        )
        .await
    }
}

/// Every flow runs on SQLite, and on PostgreSQL when `KALZIT_TEST_POSTGRES_URL` is set.
macro_rules! on_both_databases {
    ($($flow:ident,)*) => {
        mod sqlite {
            use super::*;
            $(
                #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
                async fn $flow() {
                    let t = test_app(None).await;
                    let state = t.state.clone();
                    super::$flow(t).await;
                    state.close().await;
                }
            )*
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn postgres_flows() {
            let Ok(base) = std::env::var("KALZIT_TEST_POSTGRES_URL") else {
                eprintln!("KALZIT_TEST_POSTGRES_URL not set, PostgreSQL flows not run");
                return;
            };
            sqlx::any::install_default_drivers();
            let admin = sqlx::AnyPool::connect(&base).await.unwrap();
            $(
                let schema = format!("kalzit_test_{}", uuid::Uuid::now_v7().simple());
                sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}"))).execute(&admin).await.unwrap();
                let sep = if base.contains('?') { '&' } else { '?' };
                let url = format!("{base}{sep}options=-csearch_path%3D{schema}");
                let t = test_app(Some(url)).await;
                let state = t.state.clone();
                $flow(t).await;
                state.close().await;
                sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE"))).execute(&admin).await.unwrap();
            )*
        }
    };
}

on_both_databases! {
    views_and_query_runs_show_up,
    unused_dashboards_are_those_without_views,
    org_admins_see_their_organization_only,
    server_admins_see_every_organization_or_one,
    recording_off_records_nothing,
    retention_is_a_bounded_setting,
    reports_check_their_period,
}

async fn views_and_query_runs_show_up(t: TestApp) {
    let source = t.source("shop").await;
    let dashboard = t.dashboard("Releases", &source).await;
    let viewer = t.member_of(&t.org, "Vera", "viewer").await;
    t.view(&dashboard, &t.owner).await;
    t.view(&dashboard, &viewer).await;
    for _ in 0..3 {
        t.run_panel(&dashboard, &viewer).await;
    }
    let failed = t.free_query(&source, "SELECT nothing FROM missing").await.ok();
    assert!(failed["results"]["A"]["error"].is_object(), "{failed}");
    // Nothing is in the database before the background write.
    assert_eq!(t.rows("usage_dashboard_views").await, 0);
    t.flush().await;

    let report = t.get(&format!("~/usage?{}", t.range()), &t.owner).await.ok();
    assert_eq!(report["recording"], true);
    assert_eq!(report["retentionDays"], 90);
    assert_eq!(report["totals"]["views"], 2, "{report}");
    assert_eq!(report["totals"]["panelRuns"], 3);
    assert_eq!(report["totals"]["panelErrors"], 0);
    assert_eq!(report["totals"]["queries"], 4);
    assert_eq!(report["totals"]["queryErrors"], 1);
    assert_eq!(report["dashboards"][0]["id"], dashboard.as_str());
    assert_eq!(report["dashboards"][0]["title"], "Releases");
    assert_eq!(report["dashboards"][0]["views"], 2);
    let panel = &report["slowPanels"][0];
    assert_eq!(panel["dashboardId"], dashboard.as_str());
    assert_eq!(panel["panelId"], "p1");
    assert_eq!(panel["panelTitle"], "Releases");
    assert_eq!(panel["runs"], 3);
    assert_eq!(panel["rows"], 6);
    assert!(panel["p50Ms"].is_i64() && panel["p95Ms"].is_i64(), "{panel}");
    assert_eq!(report["failingPanels"], json!([]));
    let s = &report["sources"][0];
    assert_eq!(s["id"], source.as_str());
    assert_eq!(s["name"], "shop");
    assert_eq!(s["kind"], "sqlite");
    assert_eq!(s["queries"], 4);
    assert_eq!(s["errors"], 1);
    assert_eq!(s["errorsSource"].as_i64().unwrap() + s["errorsRejected"].as_i64().unwrap(), 1, "{s}");
    // The SQLite source keeps answers: the first panel run asked it, the next two were hits.
    assert_eq!(s["cacheMisses"], 1, "{s}");
    assert_eq!(s["cacheHits"], 2, "{s}");
    assert_eq!(report["totals"]["cacheHits"], 2);
    // The trend has a point per hour of the day before, holding the counts in the hour of T0.
    let trend = report["trend"].as_array().unwrap();
    assert_eq!(report["stepMs"], HOUR);
    assert_eq!(trend.iter().map(|p| p["views"].as_i64().unwrap()).sum::<i64>(), 2);
    let last = trend.iter().find(|p| p["views"] == 2).unwrap();
    assert_eq!(last["at"].as_i64().unwrap(), T0 - T0.rem_euclid(HOUR));

    // A failing panel shows up as such.
    sqlx::query("UPDATE datasources SET settings = $1 WHERE id = $2")
        .bind(json!({ "path": t.sources.path().join("gone.db").to_string_lossy() }).to_string())
        .bind(&source)
        .execute(&t.state.db)
        .await
        .unwrap();
    t.state.datasources.forget(&source);
    let body = json!({ "timeRange": { "from": T0 - DAY, "to": T0 }, "variables": {}, "refresh": true });
    t.post(&format!("~/dashboards/{dashboard}/panels/p1/query"), body, &viewer).await.ok();
    t.flush().await;
    let report = t.get(&format!("~/usage?{}", t.range()), &t.owner).await.ok();
    assert_eq!(report["failingPanels"][0]["panelId"], "p1", "{report}");
    assert_eq!(report["failingPanels"][0]["errors"], 1);
    assert_eq!(report["totals"]["panelErrors"], 1);

    // Nothing in the tables holds the ids of the people who looked.
    let user_ids: Vec<(String,)> = sqlx::query_as("SELECT id FROM users").fetch_all(&t.state.db).await.unwrap();
    for table in ["usage_dashboard_views", "usage_panel_runs", "usage_source_queries"] {
        for (id,) in &user_ids {
            let sql = format!(
                "SELECT COUNT(*) FROM {table} WHERE org_id = $1 OR {} = $1",
                if table == "usage_source_queries" { "datasource_id" } else { "dashboard_id" }
            );
            let (n,): (i64,) = sqlx::query_as(sqlx::AssertSqlSafe(sql)).bind(id).fetch_one(&t.state.db).await.unwrap();
            assert_eq!(n, 0, "{table} holds a user id");
        }
    }
}

async fn unused_dashboards_are_those_without_views(t: TestApp) {
    let source = t.source("shop").await;
    let opened = t.dashboard("Opened", &source).await;
    let forgotten = t.dashboard("Forgotten", &source).await;
    let old = t.dashboard("Old", &source).await;
    // "Old" was last opened 40 days ago (counted as the view route would have then).
    t.state.usage.view(t.clock.now_ms() - 40 * DAY, &t.org, &old);
    t.view(&opened, &t.owner).await;
    t.flush().await;

    let ids = |v: &Value| -> Vec<String> {
        v["items"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap().to_string()).collect()
    };
    let thirty = t.get("~/usage/unused?days=30", &t.owner).await.ok();
    // Never opened first, then the longest unopened.
    assert_eq!(ids(&thirty), [forgotten.clone(), old.clone()], "{thirty}");
    assert_eq!(thirty["total"], 2);
    assert_eq!(thirty["items"][0]["lastViewedAt"], Value::Null);
    assert!(thirty["items"][1]["lastViewedAt"].is_i64());
    assert!(thirty["recordedSince"].is_i64());
    let ninety = t.get("~/usage/unused?days=90", &t.owner).await.ok();
    assert_eq!(ids(&ninety), [forgotten.clone()]);
    // The default is 30 days.
    assert_eq!(ids(&t.get("~/usage/unused", &t.owner).await.ok()), ids(&thirty));
    // A dashboard in the trash is not listed.
    let r = t.send(Method::DELETE, &t.path(&format!("~/dashboards/{forgotten}")), None, Some(&t.owner)).await;
    assert!(r.status.is_success(), "{}", r.body);
    assert_eq!(ids(&t.get("~/usage/unused?days=30", &t.owner).await.ok()), [old]);
    assert_eq!(t.get("~/usage/unused?days=0", &t.owner).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(t.get("~/usage/unused?days=366", &t.owner).await.status, StatusCode::UNPROCESSABLE_ENTITY);
}

async fn org_admins_see_their_organization_only(t: TestApp) {
    let source = t.source("shop").await;
    let dashboard = t.dashboard("Releases", &source).await;
    t.view(&dashboard, &t.owner).await;
    t.flush().await;

    let other = t.second_org().await;
    let admin = t.member_of(&other, "Anna", "admin").await;
    // Their own organization has nothing yet; the first one is not theirs.
    let own = t.send(Method::GET, &format!("/api/orgs/{other}/usage?{}", t.range()), None, Some(&admin)).await.ok();
    assert_eq!(own["totals"]["views"], 0, "{own}");
    assert_eq!(own["dashboards"], json!([]));
    assert_eq!(t.get(&format!("~/usage?{}", t.range()), &admin).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.get(&format!("/admin/usage?{}", t.range()), &admin).await.status, StatusCode::FORBIDDEN);
    // An admin of the first organization sees its counts.
    let local_admin = t.member_of(&t.org, "Otto", "admin").await;
    let report = t.get(&format!("~/usage?{}", t.range()), &local_admin).await.ok();
    assert_eq!(report["totals"]["views"], 1);
    // Viewers and editors may not read them; the server view is not an organization filter.
    for role in ["viewer", "editor"] {
        let cookie = t.member_of(&t.org, &format!("Member{role}"), role).await;
        assert_eq!(t.get(&format!("~/usage?{}", t.range()), &cookie).await.status, StatusCode::FORBIDDEN, "{role}");
        assert_eq!(t.get("~/usage/unused", &cookie).await.status, StatusCode::FORBIDDEN, "{role}");
    }
    let filtered = t.get(&format!("~/usage?{}&orgId={other}", t.range()), &local_admin).await;
    assert_eq!(filtered.status, StatusCode::UNPROCESSABLE_ENTITY);
    // Without a session.
    let anonymous = t.send(Method::GET, &t.path(&format!("~/usage?{}", t.range())), None, None).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
}

async fn server_admins_see_every_organization_or_one(t: TestApp) {
    let source = t.source("shop").await;
    let dashboard = t.dashboard("Releases", &source).await;
    t.view(&dashboard, &t.owner).await;
    t.flush().await;
    let other = t.second_org().await;
    let all = t.get(&format!("/admin/usage?{}", t.range()), &t.owner).await.ok();
    assert_eq!(all["totals"]["views"], 1);
    assert_eq!(all["dashboards"][0]["orgId"], t.org.as_str());
    assert_eq!(all["dashboards"][0]["orgName"], "Müller & Söhne");
    let first = t.get(&format!("/admin/usage?{}&orgId={}", t.range(), t.org), &t.owner).await.ok();
    assert_eq!(first["totals"]["views"], 1);
    let second = t.get(&format!("/admin/usage?{}&orgId={other}", t.range()), &t.owner).await.ok();
    assert_eq!(second["totals"]["views"], 0);
    let unused = t.get(&format!("/admin/usage/unused?days=30&orgId={other}"), &t.owner).await.ok();
    assert_eq!(unused["total"], 0);
    let missing = uuid::Uuid::now_v7();
    assert_eq!(
        t.get(&format!("/admin/usage?{}&orgId={missing}", t.range()), &t.owner).await.status,
        StatusCode::NOT_FOUND
    );
}

async fn recording_off_records_nothing(t: TestApp) {
    let source = t.source("shop").await;
    let dashboard = t.dashboard("Releases", &source).await;
    t.set("usage.enabled", json!(false)).await.ok();
    t.view(&dashboard, &t.owner).await;
    t.run_panel(&dashboard, &t.owner).await;
    t.free_query(&source, "SELECT text FROM releases").await.ok();
    t.flush().await;
    for table in ["usage_dashboard_views", "usage_panel_runs", "usage_source_queries"] {
        assert_eq!(t.rows(table).await, 0, "{table}");
    }
    let report = t.get(&format!("~/usage?{}", t.range()), &t.owner).await.ok();
    assert_eq!(report["recording"], false);
    // Undo: on again, and the next view counts.
    t.set("usage.enabled", json!(true)).await.ok();
    t.view(&dashboard, &t.owner).await;
    t.flush().await;
    assert_eq!(t.rows("usage_dashboard_views").await, 1);
}

async fn retention_is_a_bounded_setting(t: TestApp) {
    assert_eq!(t.set("usage.retention_days", json!(366)).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(t.set("usage.retention_days", json!(0)).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    t.set("usage.retention_days", json!(30)).await.ok();
    let source = t.source("shop").await;
    let dashboard = t.dashboard("Releases", &source).await;
    t.view(&dashboard, &t.owner).await;
    t.flush().await;
    t.clock.advance_ms(31 * DAY);
    let deleted = kalzit::usage::purge(&t.state.db, t.clock.now_ms(), kalzit::usage::retention_days(&t.state).await)
        .await
        .unwrap();
    assert_eq!(deleted, 1);
    assert_eq!(t.rows("usage_dashboard_views").await, 0);
}

async fn reports_check_their_period(t: TestApp) {
    for query in [format!("from={T0}&to={T0}"), format!("from={}&to={T0}", T0 - 367 * DAY), "from=1".to_string()] {
        let r = t.get(&format!("~/usage?{query}"), &t.owner).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{query}: {}", r.body);
    }
    let r = t.get(&format!("~/usage?from={}&to={T0}", T0 - 30 * DAY), &t.owner).await.ok();
    assert_eq!(r["stepMs"], DAY);
    assert_eq!(r["trend"].as_array().unwrap().len(), 31);
}
