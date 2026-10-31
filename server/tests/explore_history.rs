//! Explore's query history through the real router and database (docs/api/explore-history.md).

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
const DAY: i64 = 24 * 3_600_000;

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    _dir: tempfile::TempDir,
    sources: tempfile::TempDir,
    owner: String,
    owner_id: String,
    org: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
}

impl Reply {
    fn ids(&self) -> Vec<String> {
        assert_eq!(self.status, StatusCode::OK, "{}", self.body);
        self.body["items"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap().to_string()).collect()
    }

    fn texts(&self) -> Vec<String> {
        assert_eq!(self.status, StatusCode::OK, "{}", self.body);
        self.body["items"].as_array().unwrap().iter().map(|e| e["query"]["sql"].as_str().unwrap().to_string()).collect()
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
    let mut t = TestApp {
        app,
        clock,
        state,
        _dir: dir,
        sources,
        owner: String::new(),
        owner_id: String::new(),
        org: String::new(),
    };
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
    t.owner_id = setup.body["id"].as_str().unwrap().to_string();
    t.owner = t.session_for(&t.owner_id).await;
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

    async fn delete(&self, path: &str, cookie: &str) -> Reply {
        self.send(Method::DELETE, &self.path(path), None, Some(cookie)).await
    }

    async fn session_for(&self, user_id: &str) -> String {
        let cfg = &self.state.config.sessions;
        let token = kalzit::auth::session::create(&self.state.db, cfg, self.clock.now_ms(), user_id).await.unwrap();
        format!("kalzit_session={token}")
    }

    async fn member(&self, name: &str, role: &str) -> (String, String) {
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
        let cookie = self.session_for(&id).await;
        (cookie, id)
    }

    async fn count(&self) -> i64 {
        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM explore_history").fetch_one(&self.state.db).await.unwrap();
        n
    }

    /// A SQLite source whose file holds `releases (ts DATETIME, text TEXT)` with two rows, in a
    /// directory the server admin allowed: its queries really run.
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
            // Already allowed by an earlier source of this app.
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

    /// Runs `sql` on `source` as Explore does (`explore: true`), or as any other client.
    async fn run(&self, source: &str, sql: &str, explore: bool, cookie: &str) -> Reply {
        let mut body = json!({
            "queries": [{ "refId": "A", "datasourceId": source, "query": { "sql": sql } }],
            "timeRange": { "from": T0 - DAY, "to": T0 },
            "variables": {}
        });
        if explore {
            body["explore"] = json!(true);
        }
        self.post("~/query", body, cookie).await
    }

    async fn history(&self, query: &str, cookie: &str) -> Reply {
        self.get(&format!("~/explore/history{query}"), cookie).await
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
                    super::$flow(test_app(None).await).await
                }
            )*
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn postgres_flows() {
            let Some(base) = common::postgres_url("PostgreSQL flows") else { return };
            sqlx::any::install_default_drivers();
            let admin = sqlx::AnyPool::connect(&base).await.unwrap();
            $(
                let schema = format!("kalzit_test_{}", uuid::Uuid::now_v7().simple());
                sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}"))).execute(&admin).await.unwrap();
                let sep = if base.contains('?') { '&' } else { '?' };
                let url = format!("{base}{sep}options=-csearch_path%3D{schema}");
                $flow(test_app(Some(url)).await).await;
                sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE"))).execute(&admin).await.unwrap();
            )*
        }
    };
}

on_both_databases! {
    explore_runs_are_recorded_and_others_are_not,
    identical_consecutive_queries_are_one_entry,
    an_entry_cap_keeps_the_newest,
    entries_expire_after_thirty_days,
    history_is_private_to_its_user_and_organization,
    lost_access_hides_entries,
    entries_are_deleted_one_by_one_and_all_at_once,
    listing_filters_searches_and_pages,
    every_route_checks_the_caller,
    pages_keep_their_order_when_times_are_equal,
    search_ignores_case_beyond_ascii,
    a_run_with_several_queries_is_recorded_in_order,
    a_query_over_64_kib_runs_but_is_not_kept,
}

async fn explore_runs_are_recorded_and_others_are_not(t: TestApp) {
    let source = t.source("shop").await;
    // A run that is not from Explore (a client, a script) leaves nothing.
    assert_eq!(t.run(&source, "SELECT text FROM releases", false, &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.count().await, 0);
    t.clock.advance_ms(1000);
    let ran = t.run(&source, "SELECT text FROM releases", true, &t.owner).await;
    assert_eq!(ran.status, StatusCode::OK, "{}", ran.body);
    let listed = t.history("", &t.owner).await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
    let item = &listed.body["items"][0];
    assert_eq!(item["query"], json!({ "sql": "SELECT text FROM releases" }));
    assert_eq!(item["datasourceId"], json!(source));
    assert_eq!((item["datasourceName"].as_str(), item["datasourceKind"].as_str()), (Some("shop"), Some("sqlite")));
    assert_eq!((item["shape"].as_str(), item["rowCount"].as_i64()), (Some("frame"), Some(2)));
    assert_eq!(item["createdAt"].as_i64(), Some(T0 + 1000));
    assert!(item["durationMs"].is_i64(), "{item}");
    assert!(listed.body["nextCursor"].is_null());

    // A query that fails is not kept, and neither is one the caller may not run.
    t.clock.advance_ms(1000);
    t.run(&source, "SELECT nope FROM nowhere", true, &t.owner).await;
    let (viewer, _) = t.member("Vera", "viewer").await;
    t.run(&source, "SELECT 1", true, &viewer).await;
    assert_eq!(t.count().await, 1);

    // Nothing but the query and its numbers is stored: no result, and nothing of the source's
    // settings (its file path).
    let rows: Vec<(String, String, String, String)> =
        sqlx::query_as("SELECT id, user_id, org_id, query FROM explore_history").fetch_all(&t.state.db).await.unwrap();
    let dump = format!("{rows:?}");
    assert!(!dump.contains("Release 2.4"), "{dump}");
    assert!(!dump.contains(&*t.sources.path().to_string_lossy()), "{dump}");
    assert_eq!(rows[0].3, r#"{"sql":"SELECT text FROM releases"}"#);
}

async fn identical_consecutive_queries_are_one_entry(t: TestApp) {
    let source = t.source("shop").await;
    let a = "SELECT text FROM releases";
    let b = "SELECT ts FROM releases";
    t.run(&source, a, true, &t.owner).await;
    t.clock.advance_ms(1000);
    t.run(&source, a, true, &t.owner).await;
    assert_eq!(t.count().await, 1);
    let first = t.history("", &t.owner).await;
    assert_eq!(first.body["items"][0]["createdAt"].as_i64(), Some(T0 + 1000), "bumped to the newest run");
    t.clock.advance_ms(1000);
    t.run(&source, b, true, &t.owner).await;
    // Only consecutive runs collapse: a again after b is a new entry.
    t.clock.advance_ms(1000);
    t.run(&source, a, true, &t.owner).await;
    assert_eq!(t.history("", &t.owner).await.texts(), [a, b, a]);
    // Another user's run in between does not break a streak.
    let (editor, _) = t.member("Edgar", "editor").await;
    t.run(&source, b, true, &editor).await;
    t.clock.advance_ms(1000);
    t.run(&source, a, true, &t.owner).await;
    assert_eq!(t.history("", &t.owner).await.texts(), [a, b, a]);
    assert_eq!(t.history("", &editor).await.texts(), [b]);
}

async fn an_entry_cap_keeps_the_newest(t: TestApp) {
    let source = t.source("shop").await;
    for i in 0..500 {
        sqlx::query(
            "INSERT INTO explore_history (id, user_id, org_id, datasource_id, query, search_text, shape, created_at) \
             VALUES ($1, $2, $3, $4, $5, $5, 'frame', $6)",
        )
        .bind(format!("old-{i:04}"))
        .bind(&t.owner_id)
        .bind(&t.org)
        .bind(&source)
        .bind(format!(r#"{{"sql":"SELECT {i}"}}"#))
        .bind(T0 + i)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    // Another user's entries do not count against the cap.
    let (editor, _) = t.member("Edgar", "editor").await;
    t.run(&source, "SELECT 'e'", true, &editor).await;
    t.clock.advance_ms(10_000);
    let ran = t.run(&source, "SELECT 'new'", true, &t.owner).await;
    assert_eq!(ran.status, StatusCode::OK, "{}", ran.body);
    let (mine,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM explore_history WHERE user_id = $1")
        .bind(&t.owner_id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(mine, 500);
    assert_eq!(t.count().await, 501);
    let all = t.history("?limit=200", &t.owner).await;
    assert_eq!(all.texts()[0], "SELECT 'new'");
    let (oldest,): (i64,) = sqlx::query_as("SELECT MIN(created_at) FROM explore_history WHERE user_id = $1")
        .bind(&t.owner_id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(oldest, T0 + 1, "the oldest entry went");
}

async fn entries_expire_after_thirty_days(t: TestApp) {
    let source = t.source("shop").await;
    t.run(&source, "SELECT 'alt'", true, &t.owner).await;
    t.clock.advance_ms(20 * DAY);
    // A session of its own, since the first one is long idle.
    let owner = t.session_for(&t.owner_id).await;
    t.run(&source, "SELECT 'mittel'", true, &owner).await;
    t.clock.advance_ms(11 * DAY);
    // 31 days after the first, 11 after the second.
    assert_eq!(kalzit::routes::explore_history::purge_expired(&t.state).await.unwrap(), 1);
    let owner = t.session_for(&t.owner_id).await;
    assert_eq!(t.history("", &owner).await.texts(), ["SELECT 'mittel'"]);
    t.clock.advance_ms(19 * DAY + 1);
    assert_eq!(kalzit::routes::explore_history::purge_expired(&t.state).await.unwrap(), 1);
    assert_eq!(t.count().await, 0);
}

async fn history_is_private_to_its_user_and_organization(t: TestApp) {
    let source = t.source("shop").await;
    let (editor, editor_id) = t.member("Edgar", "editor").await;
    let (admin, _) = t.member("Alma", "admin").await;
    t.run(&source, "SELECT 'a'", true, &t.owner).await;
    t.clock.advance_ms(1000);
    t.run(&source, "SELECT 'b'", true, &editor).await;
    assert_eq!(t.history("", &t.owner).await.texts(), ["SELECT 'a'"]);
    assert_eq!(t.history("", &editor).await.texts(), ["SELECT 'b'"]);
    // Not even an admin or the owner of the organization reads another user's entries.
    assert!(t.history("", &admin).await.ids().is_empty());
    let mine = t.history("", &t.owner).await.ids();
    let theirs = t.history("", &editor).await.ids();
    // Deleting someone else's entry is not found, and leaves it.
    assert_eq!(t.delete(&format!("~/explore/history/{}", theirs[0]), &t.owner).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.delete(&format!("~/explore/history/{}", mine[0]), &editor).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.count().await, 2);
    // Deleting all removes only the caller's own.
    assert_eq!(t.delete("~/explore/history", &admin).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.count().await, 2);

    // A second organization: the same user sees nothing of the first one there, and a member of
    // one organization only does not reach the other's route.
    let org2 = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, 'Zweite', 0)")
        .bind(&org2)
        .execute(&t.state.db)
        .await
        .unwrap();
    for user in [&t.owner_id, &editor_id] {
        let role = if user == &t.owner_id { "owner" } else { "editor" };
        sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, $3, 0)")
            .bind(&org2)
            .bind(user)
            .bind(role)
            .execute(&t.state.db)
            .await
            .unwrap();
    }
    let other = format!("/api/orgs/{org2}/explore/history");
    assert!(t.send(Method::GET, &other, None, Some(&t.owner)).await.ids().is_empty());
    assert_eq!(t.send(Method::DELETE, &other, None, Some(&t.owner)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.count().await, 2, "deleting in another organization leaves this one's entries");
    let foreign = t.send(Method::GET, &other, None, Some(&admin)).await;
    assert_eq!(foreign.status, StatusCode::NOT_FOUND, "{}", foreign.body);
    // The entry id of the first organization does not delete through the second.
    let cross = format!("{other}/{}", mine[0]);
    assert_eq!(t.send(Method::DELETE, &cross, None, Some(&t.owner)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.count().await, 2);
}

async fn lost_access_hides_entries(t: TestApp) {
    let shop = t.source("shop").await;
    let secret = t.source("geheim").await;
    let (viewer, viewer_id) = t.member("Vera", "viewer").await;
    for s in [&shop, &secret] {
        let body = json!({ "subjectType": "user", "subjectId": viewer_id, "resourceType": "datasource",
                           "resourceId": s, "level": "query" });
        let r = t.post("~/grants", body, &t.owner).await;
        assert!(r.status.is_success(), "{}", r.body);
    }
    t.run(&shop, "SELECT 'shop'", true, &viewer).await;
    t.clock.advance_ms(1000);
    t.run(&secret, "SELECT 'geheim'", true, &viewer).await;
    assert_eq!(t.history("", &viewer).await.texts(), ["SELECT 'geheim'", "SELECT 'shop'"]);

    // The grant on one source goes: its entries disappear, without an error and without a name.
    sqlx::query("DELETE FROM resource_grants WHERE resource_id = $1").bind(&secret).execute(&t.state.db).await.unwrap();
    let after = t.history("", &viewer).await;
    assert_eq!(after.texts(), ["SELECT 'shop'"]);
    assert!(!after.body.to_string().contains("geheim"), "{}", after.body);
    let filtered = t.history(&format!("?datasourceId={secret}"), &viewer).await;
    assert_eq!(filtered.status, StatusCode::OK, "{}", filtered.body);
    assert!(filtered.ids().is_empty());
    let searched = t.history("?q=geheim", &viewer).await;
    assert!(searched.ids().is_empty(), "{}", searched.body);
    // The entries stay stored and come back with the access.
    assert_eq!(t.count().await, 2);

    // A deleted source hides its entries too.
    sqlx::query("UPDATE datasources SET deleted_at = 1 WHERE id = $1").bind(&shop).execute(&t.state.db).await.unwrap();
    assert!(t.history("", &viewer).await.ids().is_empty());
    // Running an entry again is a normal query with its normal checks: no access, no run.
    let again = t.run(&secret, "SELECT 'geheim'", true, &viewer).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
    assert_eq!(again.body["results"]["A"]["error"]["code"], "not_found", "{}", again.body);
    assert_eq!(t.count().await, 2);
}

async fn entries_are_deleted_one_by_one_and_all_at_once(t: TestApp) {
    let source = t.source("shop").await;
    for sql in ["SELECT 1", "SELECT 2", "SELECT 3"] {
        t.clock.advance_ms(1000);
        t.run(&source, sql, true, &t.owner).await;
    }
    let ids = t.history("", &t.owner).await.ids();
    assert_eq!(ids.len(), 3);
    assert_eq!(t.delete(&format!("~/explore/history/{}", ids[1]), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.history("", &t.owner).await.texts(), ["SELECT 3", "SELECT 1"]);
    assert_eq!(t.delete(&format!("~/explore/history/{}", ids[1]), &t.owner).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.delete("~/explore/history", &t.owner).await.status, StatusCode::NO_CONTENT);
    assert!(t.history("", &t.owner).await.ids().is_empty());
    assert_eq!(t.count().await, 0);
    // Deleting all of an empty history is fine.
    assert_eq!(t.delete("~/explore/history", &t.owner).await.status, StatusCode::NO_CONTENT);
}

async fn listing_filters_searches_and_pages(t: TestApp) {
    let shop = t.source("shop").await;
    let logs = t.source("logs").await;
    for (s, sql) in [
        (&shop, "SELECT text FROM releases"),
        (&logs, "SELECT ts FROM releases"),
        (&shop, "SELECT '100%'"),
        (&shop, "SELECT 'Größe'"),
        (&logs, "SELECT 5"),
    ] {
        t.clock.advance_ms(1000);
        t.run(s, sql, true, &t.owner).await;
    }
    let all = t.history("", &t.owner).await.texts();
    assert_eq!(
        all,
        ["SELECT 5", "SELECT 'Größe'", "SELECT '100%'", "SELECT ts FROM releases", "SELECT text FROM releases"]
    );
    assert_eq!(
        t.history(&format!("?datasourceId={logs}"), &t.owner).await.texts(),
        ["SELECT 5", "SELECT ts FROM releases"]
    );
    assert_eq!(
        t.history("?q=RELEASES", &t.owner).await.texts(),
        ["SELECT ts FROM releases", "SELECT text FROM releases"]
    );
    // Wildcards in the search match themselves.
    assert_eq!(t.history("?q=100%25", &t.owner).await.texts(), ["SELECT '100%'"]);
    assert!(t.history("?q=%25_", &t.owner).await.ids().is_empty());
    assert_eq!(t.history("?q=gr%C3%B6%C3%9Fe", &t.owner).await.texts(), ["SELECT 'Größe'"]);
    assert_eq!(t.history("?q=gr", &t.owner).await.texts(), ["SELECT 'Größe'"]);
    assert_eq!(t.history(&format!("?datasourceId={logs}&q=text"), &t.owner).await.ids().len(), 0);

    // Pages follow the cursor without repeats or gaps.
    let mut seen = Vec::new();
    let mut cursor = String::new();
    loop {
        let page = t.history(&format!("?limit=2{cursor}"), &t.owner).await;
        assert_eq!(page.status, StatusCode::OK, "{}", page.body);
        seen.extend(page.texts());
        match page.body["nextCursor"].as_str() {
            Some(c) => cursor = format!("&cursor={c}"),
            None => break,
        }
    }
    assert_eq!(seen, all);
    for bad in ["?limit=0", "?limit=201", "?cursor=zz", "?unknown=1"] {
        let r = t.history(bad, &t.owner).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}: {}", r.body);
    }
    let long = t.history(&format!("?q={}", "x".repeat(101)), &t.owner).await;
    assert_eq!(long.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", long.body);
}

async fn every_route_checks_the_caller(t: TestApp) {
    let source = t.source("shop").await;
    t.run(&source, "SELECT 1", true, &t.owner).await;
    let id = t.history("", &t.owner).await.ids().remove(0);
    let routes = [
        (Method::GET, "/explore/history".to_string()),
        (Method::DELETE, "/explore/history".to_string()),
        (Method::DELETE, format!("/explore/history/{id}")),
    ];
    // A stranger to the organization: not found; not signed in: refused.
    let org2 = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, 'Zweite', 0)")
        .bind(&org2)
        .execute(&t.state.db)
        .await
        .unwrap();
    let outsider = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ($1, 'o@example.de', 'Olga', 0)")
        .bind(&outsider)
        .execute(&t.state.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, 'viewer', 0)")
        .bind(&org2)
        .bind(&outsider)
        .execute(&t.state.db)
        .await
        .unwrap();
    let outsider = t.session_for(&outsider).await;
    for (method, path) in routes {
        let url = format!("/api/orgs/{}{path}", t.org);
        let anonymous = t.send(method.clone(), &url, None, None).await;
        assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED, "{method} {path}: {}", anonymous.body);
        let stranger = t.send(method.clone(), &url, None, Some(&outsider)).await;
        assert_eq!(stranger.status, StatusCode::NOT_FOUND, "{method} {path}: {}", stranger.body);
    }
    assert_eq!(t.count().await, 1);
    // Any member may use their own history, a viewer included (an empty one).
    let (viewer, _) = t.member("Vera", "viewer").await;
    assert!(t.history("", &viewer).await.ids().is_empty());
    assert_eq!(t.delete("~/explore/history", &viewer).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.count().await, 1);
}

async fn pages_keep_their_order_when_times_are_equal(t: TestApp) {
    let source = t.source("shop").await;
    for id in ["t-a", "t-b", "t-c", "t-d", "t-e", "t-f", "t-g"] {
        sqlx::query(
            "INSERT INTO explore_history (id, user_id, org_id, datasource_id, query, search_text, shape, created_at) \
             VALUES ($1, $2, $3, $4, '{\"sql\":\"SELECT 1\"}', 'select 1', 'frame', $5)",
        )
        .bind(id)
        .bind(&t.owner_id)
        .bind(&t.org)
        .bind(&source)
        .bind(T0)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    let whole = t.history("?limit=50", &t.owner).await.ids();
    assert_eq!(whole.len(), 7);
    let mut paged = Vec::new();
    let mut cursor = String::new();
    loop {
        let page = t.history(&format!("?limit=3{cursor}"), &t.owner).await;
        paged.extend(page.ids());
        match page.body["nextCursor"].as_str() {
            Some(c) => cursor = format!("&cursor={c}"),
            None => break,
        }
    }
    assert_eq!(paged, whole, "equal times neither repeat nor skip an entry");
}

async fn search_ignores_case_beyond_ascii(t: TestApp) {
    let source = t.source("shop").await;
    t.run(&source, "SELECT 'ÄRGER' AS wut", true, &t.owner).await;
    t.clock.advance_ms(1000);
    t.run(&source, "SELECT 'Ruhe'", true, &t.owner).await;
    for needle in ["%C3%A4rger", "%C3%84RGER", "%C3%84rger", "WUT"] {
        let found = t.history(&format!("?q={needle}"), &t.owner).await;
        assert_eq!(found.texts(), ["SELECT 'ÄRGER' AS wut"], "{needle}");
    }
    // The text is searched, not the JSON around it: no key names, no quotes.
    assert!(t.history("?q=sql", &t.owner).await.ids().is_empty());
    assert!(t.history("?q=%22", &t.owner).await.ids().is_empty());
}

async fn a_run_with_several_queries_is_recorded_in_order(t: TestApp) {
    let source = t.source("shop").await;
    let body = json!({
        "queries": [
            { "refId": "A", "datasourceId": source, "query": { "sql": "SELECT 1" } },
            { "refId": "B", "datasourceId": source, "query": { "sql": "SELECT 2" } },
            { "refId": "C", "datasourceId": source, "query": { "sql": "SELECT nope FROM nowhere" } },
            { "refId": "D", "datasourceId": source, "query": { "sql": "SELECT 2" } }
        ],
        "timeRange": { "from": T0 - DAY, "to": T0 },
        "variables": {},
        "explore": true
    });
    let ran = t.post("~/query", body, &t.owner).await;
    assert_eq!(ran.status, StatusCode::OK, "{}", ran.body);
    // The failed item is left out; B and D are the same query, one entry after the other, so they
    // collapse. The time of a run is only known for a single query.
    let listed = t.history("", &t.owner).await;
    assert_eq!(listed.texts(), ["SELECT 2", "SELECT 1"], "{}", listed.body);
    assert!(listed.body["items"][0]["durationMs"].is_null(), "{}", listed.body);
}

async fn a_query_over_64_kib_runs_but_is_not_kept(t: TestApp) {
    let source = t.source("shop").await;
    let big = format!("SELECT '{}'", "x".repeat(70 * 1024));
    let ran = t.run(&source, &big, true, &t.owner).await;
    assert_eq!(ran.status, StatusCode::OK, "{}", ran.body);
    assert!(ran.body["results"]["A"].get("result").is_some(), "the query runs: {}", ran.body);
    assert_eq!(t.count().await, 0);
    t.run(&source, "SELECT 1", true, &t.owner).await;
    assert_eq!(t.count().await, 1);
}
