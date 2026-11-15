//! Public links and snapshots through the real router and database (docs/api/sharing.md): the
//! happy paths per shape, every way a public token stops working (all answering alike), what a
//! visitor may and may not send, the snapshot size cap, expiry and revocation, and the cleanup.

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
use kalzit::dashboards::model::SCHEMA_VERSION;
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
    owner_id: String,
    org: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
}

impl Reply {
    fn reason(&self) -> &str {
        self.body["error"]["reason"].as_str().unwrap_or("")
    }

    fn ok(&self) -> &Value {
        assert!(self.status.is_success(), "{}: {}", self.status, self.body);
        &self.body
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

    async fn patch(&self, path: &str, body: Value, cookie: &str) -> Reply {
        self.send(Method::PATCH, &self.path(path), Some(body), Some(cookie)).await
    }

    /// A public route, without a session.
    async fn visit(&self, path: &str, body: Option<Value>) -> Reply {
        let method = if body.is_some() { Method::POST } else { Method::GET };
        self.send(method, &format!("/api/public{path}"), body, None).await
    }

    async fn session_for(&self, user_id: &str) -> String {
        let cfg = &self.state.config.sessions;
        let token = kalzit::auth::session::create(&self.state.db, cfg, self.clock.now_ms(), user_id).await.unwrap();
        format!("kalzit_session={token}")
    }

    /// A new member with `role`: their id and session.
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
        let session = self.session_for(&id).await;
        (id, session)
    }

    async fn set_role(&self, user_id: &str, role: &str) {
        sqlx::query("UPDATE org_members SET role = $1 WHERE org_id = $2 AND user_id = $3")
            .bind(role)
            .bind(&self.org)
            .bind(user_id)
            .execute(&self.state.db)
            .await
            .unwrap();
    }

    async fn setting(&self, scope: &str, key: &str, value: Value) {
        let (list, path) = match scope {
            "server" => ("/admin/settings".to_string(), format!("/admin/settings/{key}")),
            _ => ("~/settings".to_string(), format!("~/settings/{key}")),
        };
        let current = self.get(&list, &self.owner).await;
        let version = current.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["key"] == key)
            .map(|s| s["version"].as_i64().unwrap())
            .unwrap_or_else(|| panic!("{key} in {}", current.body));
        let r = self.patch(&path, json!({ "value": value, "version": version }), &self.owner).await;
        assert_eq!(r.status, StatusCode::OK, "{key}: {}", r.body);
    }

    async fn allow(&self, key: &str) {
        let dir = self.sources.path().to_string_lossy().to_string();
        self.setting("server", key, json!([dir])).await;
    }

    /// A SQLite source with `orders (region TEXT, amount INTEGER)`: frames.
    async fn sql_source(&self) -> String {
        self.allow("datasources.sqlite_dirs").await;
        let path = self.sources.path().join("orders.db");
        let pool = sqlx::SqlitePool::connect(&kalzit::config::sqlite_url(&path)).await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE orders (region TEXT, amount INTEGER); \
             INSERT INTO orders VALUES ('Nord', 120), ('Süd', 80);",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        let body =
            json!({ "name": "Bestellungen intern", "kind": "sqlite", "settings": { "path": path.to_string_lossy() } });
        self.post("~/datasources", body, &self.owner).await.ok()["id"].as_str().unwrap().to_string()
    }

    /// Writes to the SQLite source's file directly, as another program would.
    async fn change_orders(&self, sql: &str) {
        let path = self.sources.path().join("orders.db");
        let pool = sqlx::SqlitePool::connect(&kalzit::config::sqlite_url(&path)).await.unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string())).execute(&pool).await.unwrap();
        pool.close().await;
    }

    /// A JSON file source: documents.
    async fn json_source(&self) -> String {
        self.allow("datasources.file_dirs").await;
        let path = self.sources.path().join("tickets.json");
        std::fs::write(
            &path,
            r#"[{"id": 1, "title": "Drucker", "zeit": "2027-01-15T08:00:00Z"}, {"id": 2, "title": "VPN"}]"#,
        )
        .unwrap();
        let body = json!({ "name": "Tickets intern", "kind": "file", "settings": { "path": path.to_string_lossy() } });
        self.post("~/datasources", body, &self.owner).await.ok()["id"].as_str().unwrap().to_string()
    }

    async fn dashboard(&self, model: Value) -> String {
        self.post("~/dashboards", json!({ "folderId": null, "model": model }), &self.owner).await.ok()["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// A dashboard with a frame panel (`p1`), a documents panel (`p2`), a constant, a custom
    /// variable, an annotation and links: everything a visitor must not see.
    async fn shared_dashboard(&self) -> (String, String, String) {
        let sql = self.sql_source().await;
        let docs = self.json_source().await;
        let model = json!({
            "schemaVersion": SCHEMA_VERSION, "title": "Umsatz", "timeRange": { "from": "now-6h", "to": "now" },
            "variables": [
                { "name": "region", "type": "custom", "options": ["Nord", "Süd"], "current": { "value": "Nord" } },
                { "name": "geheim", "type": "constant", "current": "db-intern-01" }
            ],
            "annotations": [ { "id": "a", "name": "Wartungsfenster", "datasourceId": sql, "query": { "sql": "SELECT 1" } } ],
            "links": [ { "type": "url", "title": "Intranet", "url": "https://intranet.example/" } ],
            "panels": [
                { "id": "p1", "type": "table", "title": "Bestellungen", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                  "targets": [ { "refId": "A", "datasourceId": sql, "query": { "sql": "SELECT region, amount FROM orders ORDER BY region" } } ],
                  "links": [ { "title": "Details", "url": "/dashboards/anderes" } ] },
                { "id": "p2", "type": "documents", "title": "Tickets", "grid": { "x": 12, "y": 0, "w": 12, "h": 8 },
                  "targets": [ { "refId": "A", "datasourceId": docs, "query": {} } ] }
            ]
        });
        (self.dashboard(model).await, sql, docs)
    }

    async fn link(&self, dashboard: &str, body: Value, cookie: &str) -> Reply {
        self.post(&format!("~/dashboards/{dashboard}/public-links"), body, cookie).await
    }

    async fn link_status(&self, link_id: &str) -> (String, Value) {
        let list = self.get("~/public-links", &self.owner).await;
        let item = list.ok()["items"].as_array().unwrap().iter().find(|l| l["id"] == link_id).cloned().unwrap();
        (item["status"].as_str().unwrap().to_string(), item.get("suspendedReason").cloned().unwrap_or(Value::Null))
    }
}

fn range(from: i64, to: i64) -> Value {
    json!({ "timeRange": { "from": from, "to": to } })
}

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
            $(
                let schema = common::postgres_schema(&base).await;
                let url = schema.url.clone();
                $flow(test_app(Some(url)).await).await;
                schema.drop_now().await;
            )*
        }
    };
}

on_both_databases! {
    public_links_are_off_until_the_server_allows_them,
    public_links_serve_the_stored_queries_per_shape,
    every_link_that_does_not_work_answers_alike,
    visitors_choose_only_a_range_within_the_window,
    expiry_changes_and_revocation_are_final_and_audited,
    snapshots_freeze_results_in_their_shapes,
    snapshots_respect_rights_switches_and_size,
    ended_shares_are_deleted_after_30_days,
    public_requests_are_rate_limited_per_address,
}

async fn public_links_are_off_until_the_server_allows_them(t: TestApp) {
    let (dashboard, _, _) = t.shared_dashboard().await;
    let r = t.link(&dashboard, json!({}), &t.owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "sharing.public_off"), "{}", r.body);
    // Editors lack `dashboards:public`, whatever the switch says.
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (_, editor) = t.member("Erika", "editor").await;
    assert_eq!(t.link(&dashboard, json!({}), &editor).await.status, StatusCode::FORBIDDEN);
    // An organization can only turn it off.
    t.setting("org", "sharing.org_public_enabled", json!(false)).await;
    assert_eq!(t.link(&dashboard, json!({}), &t.owner).await.reason(), "sharing.public_off");
    t.setting("org", "sharing.org_public_enabled", json!(true)).await;
    assert_eq!(t.link(&dashboard, json!({}), &t.owner).await.status, StatusCode::CREATED);
}

async fn public_links_serve_the_stored_queries_per_shape(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, sql, docs) = t.shared_dashboard().await;
    let created = t.link(&dashboard, json!({}), &t.owner).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let token = created.body["token"].as_str().unwrap().to_string();
    let link = &created.body["link"];
    assert_eq!(link["expiresAt"], T0 + 30 * DAY);
    assert_eq!(link["maxWindowMs"], 7 * DAY);
    assert_eq!(link["timeRange"], json!({ "from": "now-6h", "to": "now" }));
    assert_eq!(link["variables"], json!({ "region": "Nord" }));
    assert_eq!(link["status"], "active");
    // The token is kept only as its hash.
    let (stored,): (String,) =
        sqlx::query_as("SELECT token_hash FROM public_links").fetch_one(&t.state.db).await.unwrap();
    assert!(stored.len() == 64 && stored != token);
    assert!(token.len() >= 22, "at least 128 bits");

    let page = t.visit(&format!("/dashboards/{token}"), None).await;
    let text = page.ok().to_string();
    for leak in [
        &sql,
        &docs,
        "SELECT",
        "orders",
        "Bestellungen intern",
        "db-intern-01",
        "geheim",
        "Wartungsfenster",
        "intranet.example",
        "/dashboards/anderes",
        "datasourceId",
    ] {
        assert!(!text.contains(leak), "{leak} in {text}");
    }
    assert_eq!(page.body["dashboard"]["title"], "Umsatz");
    assert_eq!(page.body["dashboard"]["variables"], json!([{ "name": "region", "type": "custom", "value": "Nord" }]));
    assert_eq!(page.body["dashboard"]["panels"][0]["targets"], json!([{ "refId": "A", "hide": false }]));

    let frame = t.visit(&format!("/dashboards/{token}/panels/p1/query"), Some(range(T0 - HOUR, T0))).await;
    let a = &frame.ok()["results"]["A"];
    assert_eq!(a["result"]["shape"], "frame", "{}", frame.body);
    assert_eq!(a["result"]["frame"]["fields"][1]["values"], json!([120, 80]), "{}", frame.body);
    assert!(a["result"]["frame"].get("meta").and_then(|m| m.get("executedQuery")).is_none(), "{}", frame.body);
    let documents = t.visit(&format!("/dashboards/{token}/panels/p2/query"), Some(range(T0 - HOUR, T0))).await;
    let d = &documents.ok()["results"]["A"]["result"];
    assert_eq!(d["shape"], "documents", "{}", documents.body);
    assert_eq!(d["documents"]["documents"][0]["title"], "Drucker", "{}", documents.body);
    assert!(d["documents"].get("executedQuery").is_none());

    // One page load counted; nothing about the visitor kept.
    let (views, last): (i64, Option<i64>) =
        sqlx::query_as("SELECT views, last_viewed_at FROM public_links").fetch_one(&t.state.db).await.unwrap();
    assert_eq!((views, last), (1, Some(T0)));
    let (audited,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE action = 'public_link.created'")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(audited, 1);
    let (with_token,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE summary LIKE $1")
        .bind(format!("%{token}%"))
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(with_token, 0);
}

async fn every_link_that_does_not_work_answers_alike(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, sql, _) = t.shared_dashboard().await;
    // The creator is an admin made for this test, so their rights can change.
    let (creator_id, creator) = t.member("Clara", "admin").await;
    let created = t.link(&dashboard, json!({}), &creator).await;
    let token = created.ok()["token"].as_str().unwrap().to_string();
    let link_id = created.body["link"]["id"].as_str().unwrap().to_string();
    let page = format!("/dashboards/{token}");
    let query = format!("/dashboards/{token}/panels/p1/query");
    let works = |t: &TestApp| {
        let (page, query) = (page.clone(), query.clone());
        async move {
            let a = t.visit(&page, None).await;
            let b = t.visit(&query, Some(range(T0 - HOUR, T0))).await;
            (a, b)
        }
    };
    let (ok, ran) = works(&t).await;
    assert_eq!((ok.status, ran.status), (StatusCode::OK, StatusCode::OK), "{} {}", ok.body, ran.body);

    // Guessing: an unknown token of the right shape and a malformed one.
    let unknown = t.visit(&format!("/dashboards/{}", "A".repeat(43)), None).await;
    assert_eq!((unknown.status, unknown.reason()), (StatusCode::NOT_FOUND, "sharing.unavailable"));
    let neutral = unknown.body.clone();
    assert_eq!(t.visit("/dashboards/kurz", None).await.body, neutral);
    assert_eq!(
        t.visit(&format!("/dashboards/{}/panels/p1/query", "A".repeat(43)), Some(range(T0 - HOUR, T0))).await.body,
        neutral
    );
    assert_eq!(
        t.visit(&format!("/dashboards/{token}/panels/fehlt/query"), Some(range(T0 - HOUR, T0))).await.body,
        neutral
    );

    let expect_closed = |status: &'static str, reason: Value| (status.to_string(), reason);
    async fn closed(t: &TestApp, page: &str, query: &str, neutral: &Value) {
        let a = t.visit(page, None).await;
        let b = t.visit(query, Some(range(T0 - HOUR, T0))).await;
        assert_eq!((a.status, &a.body), (StatusCode::NOT_FOUND, neutral));
        assert_eq!((b.status, &b.body), (StatusCode::NOT_FOUND, neutral));
    }

    // Each cause suspends the link; undoing it brings the link back.
    t.setting("server", "sharing.public_enabled", json!(false)).await;
    closed(&t, &page, &query, &neutral).await;
    assert_eq!(t.link_status(&link_id).await, expect_closed("suspended", json!("sharingOff")));
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    assert_eq!(works(&t).await.0.status, StatusCode::OK);

    t.setting("org", "sharing.org_public_enabled", json!(false)).await;
    closed(&t, &page, &query, &neutral).await;
    assert_eq!(t.link_status(&link_id).await, expect_closed("suspended", json!("sharingOff")));
    t.setting("org", "sharing.org_public_enabled", json!(true)).await;
    assert_eq!(works(&t).await.0.status, StatusCode::OK);

    // Downgraded to editor: no `dashboards:public` any more.
    t.set_role(&creator_id, "editor").await;
    closed(&t, &page, &query, &neutral).await;
    assert_eq!(t.link_status(&link_id).await, expect_closed("suspended", json!("creatorRights")));
    t.set_role(&creator_id, "admin").await;
    assert_eq!(works(&t).await.0.status, StatusCode::OK);

    // A custom role with `dashboards:public` but without query rights on the source.
    let role = t
        .post(
            "~/roles",
            json!({ "name": "Teilen ohne Abfrage", "description": "",
                                 "permissions": ["dashboards:read", "dashboards:public"] }),
            &t.owner,
        )
        .await;
    let role_id = role.ok()["id"].as_str().unwrap().to_string();
    t.set_role(&creator_id, &role_id).await;
    closed(&t, &page, &query, &neutral).await;
    assert_eq!(t.link_status(&link_id).await, expect_closed("suspended", json!("creatorRights")));
    // A query grant on the source alone brings it back.
    let grant = json!({ "subjectType": "user", "subjectId": creator_id, "resourceType": "datasource",
                        "resourceId": sql, "level": "query" });
    let g = t.post("~/grants", grant, &t.owner).await;
    assert!(g.status.is_success(), "{}", g.body);
    assert_eq!(works(&t).await.0.status, StatusCode::OK);
    t.set_role(&creator_id, "admin").await;

    // The dashboard in the trash.
    let trashed = t.send(Method::DELETE, &t.path(&format!("~/dashboards/{dashboard}")), None, Some(&t.owner)).await;
    assert!(trashed.status.is_success(), "{}", trashed.body);
    closed(&t, &page, &query, &neutral).await;
    assert_eq!(t.link_status(&link_id).await, expect_closed("suspended", json!("dashboardTrashed")));
    let restored = t.post(&format!("~/dashboards/{dashboard}/restore"), json!({}), &t.owner).await;
    assert!(restored.status.is_success(), "{}", restored.body);
    assert_eq!(works(&t).await.0.status, StatusCode::OK);

    // The creator leaves the organization.
    sqlx::query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(&t.org)
        .bind(&creator_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    closed(&t, &page, &query, &neutral).await;
    assert_eq!(t.link_status(&link_id).await, expect_closed("suspended", json!("creatorRemoved")));
    sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, 'admin', 0)")
        .bind(&t.org)
        .bind(&creator_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(works(&t).await.0.status, StatusCode::OK);

    // Expired: answers alike, and nothing brings it back.
    t.clock.advance_ms(30 * DAY);
    closed(&t, &page, &query, &neutral).await;
    assert_eq!(t.link_status(&link_id).await, expect_closed("expired", Value::Null));

    // Revoked.
    let second = t.link(&dashboard, json!({}), &t.owner).await;
    let token2 = second.ok()["token"].as_str().unwrap().to_string();
    let id2 = second.body["link"]["id"].as_str().unwrap().to_string();
    let r = t.post(&format!("~/public-links/{id2}/revoke"), json!({}), &t.owner).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    closed(&t, &format!("/dashboards/{token2}"), &format!("/dashboards/{token2}/panels/p1/query"), &neutral).await;
    assert_eq!(t.link_status(&id2).await, expect_closed("revoked", Value::Null));

    // The creator's account deleted: the link stays, suspended.
    let third = t.link(&dashboard, json!({}), &creator).await;
    let token3 = third.ok()["token"].as_str().unwrap().to_string();
    let id3 = third.body["link"]["id"].as_str().unwrap().to_string();
    sqlx::query("DELETE FROM users WHERE id = $1").bind(&creator_id).execute(&t.state.db).await.unwrap();
    closed(&t, &format!("/dashboards/{token3}"), &format!("/dashboards/{token3}/panels/p1/query"), &neutral).await;
    assert_eq!(t.link_status(&id3).await, expect_closed("suspended", json!("creatorRemoved")));
}

async fn visitors_choose_only_a_range_within_the_window(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, sql, _) = t.shared_dashboard().await;
    let created = t.link(&dashboard, json!({ "maxWindowMs": DAY }), &t.owner).await;
    let token = created.ok()["token"].as_str().unwrap().to_string();
    let query = format!("/dashboards/{token}/panels/p1/query");
    assert_eq!(t.visit(&query, Some(range(T0 - DAY, T0))).await.status, StatusCode::OK);
    // Older than the window, or wider than it, or in the future.
    for (from, to) in [(T0 - DAY - 1, T0), (T0 - 3 * DAY, T0 - 2 * DAY), (T0 - HOUR, T0 + HOUR)] {
        let r = t.visit(&query, Some(range(from, to))).await;
        assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "sharing.window_exceeded"), "{}", r.body);
    }
    // Variables, limits, cursors and refresh are not the visitor's to choose; free queries cannot
    // be sent at all.
    let time = json!({ "from": T0 - HOUR, "to": T0 });
    for body in [
        json!({ "timeRange": time, "variables": { "region": "Süd" } }),
        json!({ "timeRange": time, "variables": { "geheim": "anders" } }),
        json!({ "timeRange": time, "limit": 100000 }),
        json!({ "timeRange": time, "refresh": true }),
        json!({ "timeRange": time, "cursors": { "A": "x" } }),
        json!({ "timeRange": time, "queries": [ { "refId": "X", "datasourceId": sql, "query": { "sql": "SELECT 2" } } ] }),
    ] {
        let r = t.visit(&query, Some(body.clone())).await;
        assert_eq!(
            (r.status, r.reason()),
            (StatusCode::UNPROCESSABLE_ENTITY, "request.body_invalid"),
            "{body}: {}",
            r.body
        );
    }
    // The stored variable value is the one the panel ran with.
    let page = t.visit(&format!("/dashboards/{token}"), None).await;
    assert_eq!(page.body["dashboard"]["variables"][0]["value"], "Nord");
    // A link's window is at most the longest expiry, its variables must fit the dashboard.
    t.setting("server", "sharing.max_expiry_days", json!(10)).await;
    let r = t.link(&dashboard, json!({ "maxWindowMs": 11 * DAY }), &t.owner).await;
    assert_eq!(r.reason(), "sharing.window_invalid", "{}", r.body);
    let r = t.link(&dashboard, json!({ "variables": { "region": "West" } }), &t.owner).await;
    assert_eq!(r.reason(), "variables.not_an_option", "{}", r.body);
    let r = t.link(&dashboard, json!({ "variables": { "geheim": "x" } }), &t.owner).await;
    assert_eq!(r.reason(), "variables.constant", "{}", r.body);
    // A failing query shows only its code and a generic message.
    t.change_orders("DROP TABLE orders").await;
    let r = t.visit(&query, Some(range(T0 - HOUR, T0))).await;
    let error = &r.ok()["results"]["A"]["error"];
    assert_eq!(error["message"], "the query failed", "{}", r.body);
    assert!(error.get("reason").is_none() && error.get("params").is_none(), "{}", r.body);
    assert!(!r.body.to_string().contains("orders"), "{}", r.body);
}

async fn expiry_changes_and_revocation_are_final_and_audited(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    t.setting("server", "sharing.max_expiry_days", json!(60)).await;
    let (dashboard, _, _) = t.shared_dashboard().await;
    let r = t.link(&dashboard, json!({ "expiresAt": T0 + 61 * DAY }), &t.owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "sharing.expiry_invalid"));
    assert_eq!(t.link(&dashboard, json!({ "expiresAt": T0 }), &t.owner).await.reason(), "sharing.expiry_invalid");
    let (admin_id, admin) = t.member("Anna", "admin").await;
    let created = t.link(&dashboard, json!({ "expiresAt": T0 + 20 * DAY }), &admin).await;
    let id = created.ok()["link"]["id"].as_str().unwrap().to_string();

    // The longest expiry counts from today when changed: 60 days from day 10.
    t.clock.advance_ms(10 * DAY);
    let beyond = t.patch(&format!("~/public-links/{id}"), json!({ "expiresAt": T0 + 70 * DAY + 1 }), &admin).await;
    assert_eq!((beyond.status, beyond.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "sharing.expiry_invalid"));
    let r = t.patch(&format!("~/public-links/{id}"), json!({ "expiresAt": T0 + 70 * DAY }), &admin).await;
    assert_eq!(r.ok()["expiresAt"], T0 + 70 * DAY);
    assert_eq!(r.body["status"], "active");
    // An expired one cannot be brought back.
    let short = t.link(&dashboard, json!({ "expiresAt": T0 + 11 * DAY }), &admin).await.ok()["link"]["id"].clone();
    t.clock.advance_ms(DAY);
    let late = t
        .patch(&format!("~/public-links/{}", short.as_str().unwrap()), json!({ "expiresAt": T0 + 20 * DAY }), &admin)
        .await;
    assert_eq!((late.status, late.reason()), (StatusCode::CONFLICT, "sharing.expired"));

    // Someone else's link does not exist for a member; the creator and admins revoke.
    let (_, other_admin_session) = t.member("Otto", "admin").await;
    let (_, editor) = t.member("Erik", "editor").await;
    assert_eq!(t.post(&format!("~/public-links/{id}/revoke"), json!({}), &editor).await.status, StatusCode::NOT_FOUND);
    let listed = t.get("~/public-links", &editor).await;
    assert_eq!(listed.ok()["items"], json!([]));
    let r = t.post(&format!("~/public-links/{id}/revoke"), json!({}), &other_admin_session).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    // Final: no second revoke, no new expiry.
    let again = t.post(&format!("~/public-links/{id}/revoke"), json!({}), &admin).await;
    assert_eq!((again.status, again.reason()), (StatusCode::CONFLICT, "sharing.revoked"));
    let change = t.patch(&format!("~/public-links/{id}"), json!({ "expiresAt": T0 + 30 * DAY }), &admin).await;
    assert_eq!(change.reason(), "sharing.revoked");
    let mine = t.get("~/public-links?mine=true", &admin).await;
    let statuses: Vec<(&str, &str)> = mine.ok()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| (l["status"].as_str().unwrap(), l["createdBy"].as_str().unwrap()))
        .collect();
    assert_eq!(statuses, [("expired", admin_id.as_str()), ("revoked", admin_id.as_str())]);

    let actions: Vec<(String,)> = sqlx::query_as(
        "SELECT action FROM audit_events WHERE resource_type = 'public_link' ORDER BY created_at, action",
    )
    .fetch_all(&t.state.db)
    .await
    .unwrap();
    let actions: Vec<&str> = actions.iter().map(|(a,)| a.as_str()).collect();
    assert_eq!(
        actions,
        ["public_link.created", "public_link.created", "public_link.expiry_changed", "public_link.revoked"]
    );
}

async fn snapshots_freeze_results_in_their_shapes(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, _, _) = t.shared_dashboard().await;
    let (_, editor) = t.member("Erika", "editor").await;
    let body = json!({ "title": "Oktober", "timeRange": { "from": T0 - DAY, "to": T0 } });
    let created = t.post(&format!("~/dashboards/{dashboard}/snapshots"), body.clone(), &editor).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    assert!(created.body.get("token").is_none());
    let id = created.body["snapshot"]["id"].as_str().unwrap().to_string();
    assert_eq!(created.body["snapshot"]["public"], false);

    // The source changes; the snapshot does not.
    t.change_orders("UPDATE orders SET amount = 1").await;
    let (_, viewer) = t.member("Vera", "viewer").await;
    let seen = t.get(&format!("~/snapshots/{id}"), &viewer).await;
    let results = &seen.ok()["results"];
    assert_eq!(results["p1"]["A"]["result"]["shape"], "frame", "{}", seen.body);
    assert_eq!(results["p1"]["A"]["result"]["frame"]["fields"][1]["values"], json!([120, 80]));
    assert_eq!(results["p2"]["A"]["result"]["shape"], "documents");
    assert_eq!(results["p2"]["A"]["result"]["documents"]["documents"][1]["title"], "VPN");
    assert_eq!(seen.body["dashboard"]["title"], "Umsatz");
    assert!(!seen.body.to_string().contains("SELECT"));
    // Readers do not see the status; the creator does.
    assert!(seen.body["snapshot"].get("status").is_none(), "{}", seen.body);
    let listed = t.get(&format!("~/dashboards/{dashboard}/snapshots"), &viewer).await;
    assert_eq!(listed.ok()["items"].as_array().unwrap().len(), 1);
    let mine = t.get("~/snapshots", &editor).await;
    assert_eq!(mine.ok()["items"][0]["status"], "active");

    // A public snapshot is served by token and never runs a query.
    let public = t
        .post(
            &format!("~/dashboards/{dashboard}/snapshots"),
            json!({ "timeRange": { "from": T0 - DAY, "to": T0 }, "public": true }),
            &t.owner,
        )
        .await;
    assert_eq!(public.status, StatusCode::CREATED, "{}", public.body);
    let token = public.body["token"].as_str().unwrap().to_string();
    t.change_orders("DROP TABLE orders").await;
    let page = t.visit(&format!("/snapshots/{token}"), None).await;
    assert_eq!(page.ok()["results"]["p1"]["A"]["result"]["frame"]["fields"][1]["values"], json!([1, 1]));
    assert_eq!(page.body["timeRange"], json!({ "from": T0 - DAY, "to": T0 }));
    for leak in ["SELECT", "db-intern-01", "Bestellungen intern"] {
        assert!(!page.body.to_string().contains(leak), "{leak}");
    }
}

async fn snapshots_respect_rights_switches_and_size(t: TestApp) {
    let (dashboard, _, _) = t.shared_dashboard().await;
    let body = json!({ "timeRange": { "from": T0 - DAY, "to": T0 } });
    let path = format!("~/dashboards/{dashboard}/snapshots");
    // Internal snapshots need `dashboards:share`; viewers lack it.
    let (_, viewer) = t.member("Vera", "viewer").await;
    assert_eq!(t.post(&path, body.clone(), &viewer).await.status, StatusCode::FORBIDDEN);
    // Public ones need `dashboards:public` and the switch.
    let (_, editor) = t.member("Erika", "editor").await;
    let public = json!({ "timeRange": { "from": T0 - DAY, "to": T0 }, "public": true });
    assert_eq!(t.post(&path, public.clone(), &editor).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.post(&path, public.clone(), &t.owner).await.reason(), "sharing.public_off");
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let created = t.post(&path, public.clone(), &t.owner).await;
    let token = created.ok()["token"].as_str().unwrap().to_string();
    let id = created.body["snapshot"]["id"].as_str().unwrap().to_string();
    assert_eq!(t.visit(&format!("/snapshots/{token}"), None).await.status, StatusCode::OK);
    let neutral = t.visit(&format!("/snapshots/{}", "B".repeat(43)), None).await;
    assert_eq!(neutral.reason(), "sharing.unavailable");
    t.setting("org", "sharing.org_public_enabled", json!(false)).await;
    assert_eq!(t.visit(&format!("/snapshots/{token}"), None).await.body, neutral.body);
    t.setting("org", "sharing.org_public_enabled", json!(true)).await;
    // Internal snapshots have no token to visit.
    let internal = t.post(&path, body.clone(), &editor).await;
    let internal_id = internal.ok()["snapshot"]["id"].as_str().unwrap().to_string();
    let (hash,): (Option<String>,) = sqlx::query_as("SELECT token_hash FROM snapshots WHERE id = $1")
        .bind(&internal_id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert!(hash.is_none());
    // Revoking drops the frozen results at once and ends the public page.
    let r = t.post(&format!("~/snapshots/{id}/revoke"), json!({}), &t.owner).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    assert_eq!(t.visit(&format!("/snapshots/{token}"), None).await.body, neutral.body);
    let (results,): (String,) =
        sqlx::query_as("SELECT results FROM snapshots WHERE id = $1").bind(&id).fetch_one(&t.state.db).await.unwrap();
    assert_eq!(results, "{}");
    assert_eq!(t.get(&format!("~/snapshots/{id}"), &t.owner).await.status, StatusCode::NOT_FOUND);
    // Members who may read the dashboard but did not make a snapshot cannot revoke it.
    assert_eq!(
        t.post(&format!("~/snapshots/{internal_id}/revoke"), json!({}), &viewer).await.status,
        StatusCode::FORBIDDEN
    );

    // The size cap counts the dashboard and the answers together.
    t.change_orders(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000) \
         INSERT INTO orders SELECT 'Region mit langem Namen ' || i, i FROM n",
    )
    .await;
    t.setting("server", "sharing.snapshot_max_bytes", json!(64 * 1024)).await;
    let r = t.post(&path, body, &editor).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "sharing.snapshot_too_large"), "{}", r.body);
    assert_eq!(r.body["error"]["params"]["max"], "65536");
}

async fn ended_shares_are_deleted_after_30_days(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, _, _) = t.shared_dashboard().await;
    let expiring = t.link(&dashboard, json!({ "expiresAt": T0 + DAY }), &t.owner).await.ok()["link"]["id"].clone();
    let revoked = t.link(&dashboard, json!({}), &t.owner).await.ok()["link"]["id"].as_str().unwrap().to_string();
    t.post(&format!("~/public-links/{revoked}/revoke"), json!({}), &t.owner).await;
    let kept = t.link(&dashboard, json!({ "expiresAt": T0 + 90 * DAY }), &t.owner).await.ok()["link"]["id"].clone();
    let snapshot = t
        .post(
            &format!("~/dashboards/{dashboard}/snapshots"),
            json!({ "timeRange": { "from": T0 - DAY, "to": T0 }, "expiresAt": T0 + DAY }),
            &t.owner,
        )
        .await;
    assert!(snapshot.status.is_success(), "{}", snapshot.body);
    let purge = |at| kalzit::sharing::purge_ended(&t.state.db, at);
    // 30 days after expiry or revocation, not before.
    assert_eq!(purge(T0 + 30 * DAY).await.unwrap(), 1, "the revoked link");
    assert_eq!(purge(T0 + 31 * DAY).await.unwrap(), 2, "the expired link and snapshot");
    let ids: Vec<(String,)> = sqlx::query_as("SELECT id FROM public_links").fetch_all(&t.state.db).await.unwrap();
    assert_eq!(ids, [(kept.as_str().unwrap().to_string(),)]);
    assert_ne!(expiring, kept);
}

async fn public_requests_are_rate_limited_per_address(t: TestApp) {
    let unknown = format!("/dashboards/{}", "C".repeat(43));
    for _ in 0..kalzit::sharing::MAX_PER_ADDRESS {
        assert_eq!(t.visit(&unknown, None).await.status, StatusCode::NOT_FOUND);
    }
    let r = t.visit(&unknown, None).await;
    assert_eq!((r.status, r.reason()), (StatusCode::TOO_MANY_REQUESTS, "sharing.rate_limited"), "{}", r.body);
    // The window passes.
    t.clock.advance_ms(61_000);
    assert_eq!(t.visit(&unknown, None).await.status, StatusCode::NOT_FOUND);
}
