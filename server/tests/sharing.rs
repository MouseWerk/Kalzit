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
    headers: axum::http::HeaderMap,
}

/// Sends `req` to `app`.
async fn call(app: &Router, req: Request<Body>) -> Reply {
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    Reply { status, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null), headers }
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
        call(&self.app, req).await
    }

    /// A public route from another client address.
    async fn visit_from(&self, address: &str, path: &str) -> Reply {
        let peer: SocketAddr = format!("{address}:50000").parse().unwrap();
        let app = router(self.state.clone()).layer(MockConnectInfo(peer));
        let req = Request::builder()
            .method(Method::GET)
            .uri(format!("/api/public{path}"))
            .header(header::HOST, "kalzit.test")
            .body(Body::empty())
            .unwrap();
        call(&app, req).await
    }

    /// An organization route with an API token instead of a session.
    async fn post_with_token(&self, path: &str, body: Value, token: &str) -> Reply {
        self.with_token(Method::POST, path, body, token).await
    }

    async fn with_token(&self, method: Method, path: &str, body: Value, token: &str) -> Reply {
        let req = Request::builder()
            .method(method)
            .uri(self.path(path))
            .header(header::HOST, "kalzit.test")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        call(&self.app, req).await
    }

    async fn put(&self, path: &str, body: Value, cookie: &str) -> Reply {
        self.send(Method::PUT, &self.path(path), Some(body), Some(cookie)).await
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
    guessing_costs_only_the_guesser,
    one_visitor_cannot_use_up_a_link,
    public_answers_are_neither_kept_nor_indexed,
    api_tokens_cannot_publish,
    saving_what_a_live_link_shows_needs_the_permission,
    visitors_get_only_what_the_panel_shows,
    restores_and_analyses_behind_live_links_need_the_permission,
    public_pages_are_not_indexed,
    a_flood_of_visitors_is_slowed_never_refused,
    lists_show_ended_links_without_checking_their_creator,
    a_busy_server_answer_is_never_reused,
    snapshots_are_capped_per_organization_and_person,
    visitors_run_in_query_slots_of_their_own,
    views_are_counted_in_memory_and_written_in_batches,
    a_page_of_more_panels_than_slots_waits_for_them,
    only_so_many_visitors_wait_for_a_slot,
    snapshot_titles_are_hidden_like_dashboard_titles,
    a_shared_all_reads_the_values_when_it_runs,
}

async fn public_links_are_off_until_the_server_allows_them(t: TestApp) {
    let (dashboard, _, _) = t.shared_dashboard().await;
    let r = t.link(&dashboard, json!({}), &t.owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "sharing.public_off"), "{}", r.body);
    // Editors lack `dashboards:public`, whatever the switch says.
    let (_, editor) = t.member("Erika", "editor").await;
    // Every member reads the switches and limits in effect, for the Share dialog.
    let off = t.get("~/sharing", &editor).await;
    assert_eq!(
        off.ok(),
        &json!({ "serverPublic": false, "orgPublic": true, "maxExpiryDays": 365, "snapshotMaxBytes": 10 * 1024 * 1024 }),
    );
    // Members only: someone who left the organization, or has no session, learns nothing.
    let (gone_id, gone) = t.member("Gunnar", "viewer").await;
    assert_eq!(t.get("~/sharing", &gone).await.status, StatusCode::OK);
    sqlx::query("DELETE FROM org_members WHERE user_id = $1").bind(&gone_id).execute(&t.state.db).await.unwrap();
    let refused = t.get("~/sharing", &gone).await;
    assert!(
        matches!(refused.status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND),
        "{}: {}",
        refused.status,
        refused.body
    );
    assert!(refused.body.get("serverPublic").is_none(), "{}", refused.body);
    let anonymous = t.send(Method::GET, &t.path("~/sharing"), None, None).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED, "{}", anonymous.body);
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    assert_eq!(t.link(&dashboard, json!({}), &editor).await.status, StatusCode::FORBIDDEN);
    // An organization can only turn it off.
    t.setting("org", "sharing.org_public_enabled", json!(false)).await;
    assert_eq!(t.link(&dashboard, json!({}), &t.owner).await.reason(), "sharing.public_off");
    let org_off = t.get("~/sharing", &editor).await;
    assert_eq!((&org_off.ok()["serverPublic"], &org_off.body["orgPublic"]), (&json!(true), &json!(false)));
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
    // The server's clock, which the window is counted from: the page works its ranges out from it.
    assert_eq!(page.body["now"], T0);
    assert_eq!(page.body["dashboard"]["variables"], json!([{ "name": "region", "type": "custom", "value": "Nord" }]));
    assert_eq!(page.body["dashboard"]["panels"][0]["targets"], json!([{ "refId": "A", "hide": false }]));

    let frame = t.visit(&format!("/dashboards/{token}/panels/p1/query"), Some(range(T0 - HOUR, T0))).await;
    let a = &frame.ok()["results"]["A"];
    assert_eq!(a["result"]["shape"], "frame", "{}", frame.body);
    assert_eq!(a["result"]["frame"]["fields"][1]["values"], json!(["120", "80"]), "{}", frame.body);
    assert!(a["result"]["frame"].get("meta").and_then(|m| m.get("executedQuery")).is_none(), "{}", frame.body);
    let documents = t.visit(&format!("/dashboards/{token}/panels/p2/query"), Some(range(T0 - HOUR, T0))).await;
    let d = &documents.ok()["results"]["A"]["result"];
    assert_eq!(d["shape"], "documents", "{}", documents.body);
    assert_eq!(d["documents"]["documents"][0]["title"], "Drucker", "{}", documents.body);
    assert!(d["documents"].get("executedQuery").is_none());

    // One page load counted (in memory, written in batches); nothing about the visitor kept.
    kalzit::sharing::flush_views(&t.state).await.unwrap();
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

async fn every_link_that_does_not_work_answers_alike(mut t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, sql, docs) = t.shared_dashboard().await;
    // The creator is an admin made for this test, so their rights can change.
    let (creator_id, mut creator) = t.member("Clara", "admin").await;
    let created = t.link(&dashboard, json!({}), &creator).await;
    let token = created.ok()["token"].as_str().unwrap().to_string();
    let link_id = created.body["link"]["id"].as_str().unwrap().to_string();
    let page = format!("/dashboards/{token}");
    let query = format!("/dashboards/{token}/panels/p1/query");
    async fn both(t: &TestApp, page: &str, query: &str) -> (Reply, Reply) {
        let a = t.visit(page, None).await;
        let b = t.visit(query, Some(range(T0 - HOUR, T0))).await;
        (a, b)
    }
    let (ok, ran) = both(&t, &page, &query).await;
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
    assert_eq!(both(&t, &page, &query).await.0.status, StatusCode::OK);

    t.setting("org", "sharing.org_public_enabled", json!(false)).await;
    closed(&t, &page, &query, &neutral).await;
    assert_eq!(t.link_status(&link_id).await, expect_closed("suspended", json!("sharingOff")));
    t.setting("org", "sharing.org_public_enabled", json!(true)).await;
    assert_eq!(both(&t, &page, &query).await.0.status, StatusCode::OK);

    // Downgraded to editor: no `dashboards:public` any more.
    t.set_role(&creator_id, "editor").await;
    closed(&t, &page, &query, &neutral).await;
    assert_eq!(t.link_status(&link_id).await, expect_closed("suspended", json!("creatorRights")));
    t.set_role(&creator_id, "admin").await;
    assert_eq!(both(&t, &page, &query).await.0.status, StatusCode::OK);

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
    // Query grants on the sources alone bring it back: one is not enough.
    for (n, source) in [&sql, &docs].into_iter().enumerate() {
        if n == 1 {
            closed(&t, &page, &query, &neutral).await;
        }
        let grant = json!({ "subjectType": "user", "subjectId": creator_id, "resourceType": "datasource",
                            "resourceId": source, "level": "query" });
        let g = t.post("~/grants", grant, &t.owner).await;
        assert!(g.status.is_success(), "{}", g.body);
    }
    assert_eq!(both(&t, &page, &query).await.0.status, StatusCode::OK);
    t.set_role(&creator_id, "admin").await;

    // The dashboard in the trash.
    let trashed = t.send(Method::DELETE, &t.path(&format!("~/dashboards/{dashboard}")), None, Some(&t.owner)).await;
    assert!(trashed.status.is_success(), "{}", trashed.body);
    closed(&t, &page, &query, &neutral).await;
    assert_eq!(t.link_status(&link_id).await, expect_closed("suspended", json!("dashboardTrashed")));
    let restored = t.post(&format!("~/dashboards/{dashboard}/restore"), json!({}), &t.owner).await;
    assert!(restored.status.is_success(), "{}", restored.body);
    assert_eq!(both(&t, &page, &query).await.0.status, StatusCode::OK);

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
    assert_eq!(both(&t, &page, &query).await.0.status, StatusCode::OK);

    // Expired: answers alike, and nothing brings it back.
    t.clock.advance_ms(30 * DAY);
    // Sessions end while the clock jumps a month ahead; fresh ones.
    let owner_id = t.owner_id.clone();
    t.owner = t.session_for(&owner_id).await;
    creator = t.session_for(&creator_id).await;
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
    // The whole window as a page names it a moment before the request arrives, or from a browser
    // clock that is a little behind: the start has a minute of slack, like the end.
    assert_eq!(t.visit(&query, Some(range(T0 - DAY - 500, T0 - 500))).await.status, StatusCode::OK);
    assert_eq!(t.visit(&query, Some(range(T0 - DAY - 60_000, T0))).await.status, StatusCode::OK);
    // Older than the window and its slack, or wider than it, or in the future.
    for (from, to) in [(T0 - DAY - 60_001, T0), (T0 - 3 * DAY, T0 - 2 * DAY), (T0 - HOUR, T0 + HOUR)] {
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
    // The same answer is reused for a while, even when the source changed meanwhile.
    let first = t.visit(&query, Some(range(T0 - HOUR, T0))).await;
    assert_eq!(first.ok()["results"]["A"]["result"]["shape"], "frame", "{}", first.body);
    t.change_orders("DROP TABLE orders").await;
    let reused = t.visit(&query, Some(range(T0 - HOUR, T0))).await;
    assert_eq!(reused.body, first.body);
    assert!(t.state.sharing.shown_bytes() > 0);
    // Once that time is over (and the source's own query cache has let go of its answer too), the
    // same range runs again: a failing query shows only its code and a generic message.
    let cache_secs = i64::try_from(kalzit::datasources::cache::DEFAULT_TTL_SECS).unwrap();
    t.clock.advance_ms(kalzit::sharing::SHOWN_TTL_MS.max(cache_secs * 1000 + 1));
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
    let (admin_id, mut admin) = t.member("Anna", "admin").await;
    let created = t.link(&dashboard, json!({ "expiresAt": T0 + 20 * DAY }), &admin).await;
    let id = created.ok()["link"]["id"].as_str().unwrap().to_string();

    // The longest expiry counts from today when changed: 60 days from day 10.
    t.clock.advance_ms(10 * DAY);
    // Sessions end while the clock jumps days ahead; a fresh one each time.
    admin = t.session_for(&admin_id).await;
    let beyond = t.patch(&format!("~/public-links/{id}"), json!({ "expiresAt": T0 + 70 * DAY + 1 }), &admin).await;
    assert_eq!((beyond.status, beyond.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "sharing.expiry_invalid"));
    let r = t.patch(&format!("~/public-links/{id}"), json!({ "expiresAt": T0 + 70 * DAY }), &admin).await;
    assert_eq!(r.ok()["expiresAt"], T0 + 70 * DAY);
    assert_eq!(r.body["status"], "active");
    // An expired one cannot be brought back.
    let short = t.link(&dashboard, json!({ "expiresAt": T0 + 11 * DAY }), &admin).await.ok()["link"]["id"].clone();
    t.clock.advance_ms(DAY);
    admin = t.session_for(&admin_id).await;
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
    assert_eq!(results["p1"]["results"]["A"]["result"]["shape"], "frame", "{}", seen.body);
    assert_eq!(results["p1"]["results"]["A"]["result"]["frame"]["fields"][1]["values"], json!(["120", "80"]));
    assert_eq!(results["p2"]["results"]["A"]["result"]["shape"], "documents");
    assert_eq!(results["p2"]["results"]["A"]["result"]["documents"]["documents"][1]["title"], "VPN");
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
    assert_eq!(page.ok()["results"]["p1"]["results"]["A"]["result"]["frame"]["fields"][1]["values"], json!(["1", "1"]));
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
    let revoked_link = t.link(&dashboard, json!({}), &t.owner).await;
    let revoked = revoked_link.ok()["link"]["id"].as_str().unwrap().to_string();
    let revoked_token = revoked_link.body["token"].as_str().unwrap().to_string();
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
    // The two deleted links leave their token hashes behind, nothing else (the internal snapshot
    // had no token).
    async fn tombstones(t: &TestApp) -> i64 {
        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM share_tombstones").fetch_one(&t.state.db).await.unwrap();
        n
    }
    assert_eq!(tombstones(&t).await, 2);
    // A tombstoned token answers like any other that does not work, but never counts against the
    // address as a guess.
    let neutral = t.visit(&format!("/dashboards/{}", "Z".repeat(43)), None).await.body;
    for _ in 0..=kalzit::sharing::MAX_UNKNOWN_PER_ADDRESS {
        let r = t.visit(&format!("/dashboards/{revoked_token}"), None).await;
        assert_eq!((r.status, &r.body), (StatusCode::NOT_FOUND, &neutral));
    }
    // After 90 days those tombstones go too; the one left is the kept link's, deleted by the same
    // run since it has ended meanwhile.
    kalzit::sharing::purge_ended(&t.state.db, T0 + 31 * DAY + kalzit::sharing::KEEP_TOMBSTONES_MS).await.unwrap();
    assert_eq!(tombstones(&t).await, 1);
    let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM public_links").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(left, 0);
}

async fn guessing_costs_only_the_guesser(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, _, _) = t.shared_dashboard().await;
    let token = t.link(&dashboard, json!({}), &t.owner).await.ok()["token"].as_str().unwrap().to_string();
    let page = format!("/dashboards/{token}");
    // Unknown and malformed tokens count against the address that sends them.
    for i in 0..kalzit::sharing::MAX_UNKNOWN_PER_ADDRESS {
        let fake = if i % 2 == 0 { format!("/dashboards/{}", "C".repeat(43)) } else { "/dashboards/kurz".to_string() };
        assert_eq!(t.visit(&fake, None).await.status, StatusCode::NOT_FOUND);
    }
    // Then that address is refused for every token, the real one too: no hint which is real.
    let fake = t.visit(&format!("/dashboards/{}", "D".repeat(43)), None).await;
    assert_eq!((fake.status, fake.reason()), (StatusCode::TOO_MANY_REQUESTS, "sharing.rate_limited"), "{}", fake.body);
    assert_eq!(t.visit(&page, None).await.status, StatusCode::TOO_MANY_REQUESTS);
    // Everyone else still reaches the link, however many fake tokens were sprayed.
    assert_eq!(t.visit_from("192.0.2.7", &page).await.status, StatusCode::OK);
    for i in 0..5 {
        let r = t.visit_from(&format!("198.51.100.{i}"), &format!("/dashboards/{}", "E".repeat(43))).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND);
    }
    assert_eq!(t.visit_from("192.0.2.8", &page).await.status, StatusCode::OK);
    // The window passes.
    t.clock.advance_ms(61_000);
    assert_eq!(t.visit(&page, None).await.status, StatusCode::OK);
}

async fn one_visitor_cannot_use_up_a_link(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, _, _) = t.shared_dashboard().await;
    let token = t.link(&dashboard, json!({}), &t.owner).await.ok()["token"].as_str().unwrap().to_string();
    let page = format!("/dashboards/{token}");
    for _ in 0..kalzit::sharing::MAX_PER_VISITOR {
        assert_eq!(t.visit(&page, None).await.status, StatusCode::OK);
    }
    let r = t.visit(&page, None).await;
    assert_eq!((r.status, r.reason()), (StatusCode::TOO_MANY_REQUESTS, "sharing.rate_limited"), "{}", r.body);
    assert_eq!(t.visit_from("192.0.2.9", &page).await.status, StatusCode::OK, "another visitor");
}

async fn public_answers_are_neither_kept_nor_indexed(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, _, _) = t.shared_dashboard().await;
    let token = t.link(&dashboard, json!({}), &t.owner).await.ok()["token"].as_str().unwrap().to_string();
    let snapshot = t
        .post(
            &format!("~/dashboards/{dashboard}/snapshots"),
            json!({ "timeRange": { "from": T0 - DAY, "to": T0 }, "public": true }),
            &t.owner,
        )
        .await;
    let snapshot_token = snapshot.ok()["token"].as_str().unwrap().to_string();
    let answers = [
        t.visit(&format!("/dashboards/{token}"), None).await,
        t.visit(&format!("/dashboards/{token}/panels/p1/query"), Some(range(T0 - HOUR, T0))).await,
        t.visit(&format!("/dashboards/{token}/panels/p1/query"), Some(json!({ "variables": {} }))).await,
        t.visit(&format!("/snapshots/{snapshot_token}"), None).await,
        t.visit(&format!("/dashboards/{}", "F".repeat(43)), None).await,
        t.visit(&format!("/snapshots/{}", "F".repeat(43)), None).await,
    ];
    for r in &answers {
        assert_eq!(r.headers.get(header::CACHE_CONTROL).unwrap(), "no-store", "{}: {}", r.status, r.body);
        assert_eq!(r.headers.get(header::REFERRER_POLICY).unwrap(), "no-referrer");
        assert_eq!(r.headers.get("x-robots-tag").unwrap(), "noindex");
    }
    assert_eq!(answers.iter().map(|r| r.status.as_u16()).collect::<Vec<_>>(), [200, 200, 422, 200, 404, 404]);
}

async fn api_tokens_cannot_publish(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, _, _) = t.shared_dashboard().await;
    let account = t.post("~/service-accounts", json!({ "name": "bot", "role": "admin" }), &t.owner).await;
    let account = account.ok()["id"].as_str().unwrap().to_string();
    let token = t.post(&format!("~/service-accounts/{account}/tokens"), json!({ "name": "ci" }), &t.owner).await;
    let token = token.ok()["token"].as_str().unwrap().to_string();
    let r = t.post_with_token(&format!("~/dashboards/{dashboard}/public-links"), json!({}), &token).await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "token.not_for_this_route"), "{}", r.body);
    let path = format!("~/dashboards/{dashboard}/snapshots");
    let range = json!({ "from": T0 - DAY, "to": T0 });
    let r = t.post_with_token(&path, json!({ "timeRange": range, "public": true }), &token).await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "token.not_for_this_route"), "{}", r.body);
    // Internal snapshots stay possible for automation.
    let r = t.post_with_token(&path, json!({ "timeRange": range }), &token).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let snapshot = r.body["snapshot"]["id"].as_str().unwrap().to_string();
    let (links,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM public_links").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(links, 0);
    // Keeping a link or snapshot longer, or switching sharing for the organization, is a
    // person's decision too.
    let link = t.link(&dashboard, json!({}), &t.owner).await.ok()["link"]["id"].as_str().unwrap().to_string();
    let later = json!({ "expiresAt": T0 + 40 * DAY });
    for path in [format!("~/public-links/{link}"), format!("~/snapshots/{snapshot}")] {
        let r = t.with_token(Method::PATCH, &path, later.clone(), &token).await;
        assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "token.not_for_this_route"), "{path}: {}", r.body);
    }
    let r = t
        .with_token(
            Method::PATCH,
            "~/settings/sharing.org_public_enabled",
            json!({ "value": false, "version": 0 }),
            &token,
        )
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "token.not_for_this_route"), "{}", r.body);
}

async fn saving_what_a_live_link_shows_needs_the_permission(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let sql = t.sql_source().await;
    let library = t
        .post("~/library-panels", json!({ "name": "Umsatz je Region", "model": {
            "schemaVersion": SCHEMA_VERSION, "type": "table", "title": "Umsatz je Region",
            "targets": [ { "refId": "A", "datasourceId": sql, "query": { "sql": "SELECT region, amount FROM orders" } } ] } }), &t.owner)
        .await;
    let library = library.ok()["id"].as_str().unwrap().to_string();
    let model = json!({
        "schemaVersion": SCHEMA_VERSION, "title": "Live", "timeRange": { "from": "now-6h", "to": "now" },
        "panels": [ { "id": "lp", "type": "table", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 }, "libraryPanelId": library } ]
    });
    let dashboard = t.dashboard(model.clone()).await;
    let (_, editor) = t.member("Erika", "editor").await;
    let mut renamed = model.clone();
    renamed["title"] = json!("Live, umbenannt");
    // Without a live link an editor saves as before.
    let saved = t.put(&format!("~/dashboards/{dashboard}"), json!({ "model": renamed, "version": 1 }), &editor).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    let link = t.link(&dashboard, json!({}), &t.owner).await;
    let link_id = link.ok()["link"]["id"].as_str().unwrap().to_string();
    let token = link.body["token"].as_str().unwrap().to_string();

    renamed["title"] = json!("Live, nochmal");
    let refused = t.put(&format!("~/dashboards/{dashboard}"), json!({ "model": renamed, "version": 2 }), &editor).await;
    assert_eq!(
        (refused.status, refused.reason()),
        (StatusCode::FORBIDDEN, "sharing.public_links_active"),
        "{}",
        refused.body
    );
    assert_eq!(refused.body["error"]["field"], "model");
    assert_eq!(refused.body["error"]["params"]["links"], "1");
    // The library panel the dashboard shows is guarded too.
    let lib_body = json!({ "version": 1, "name": "Umsatz je Region", "model": {
        "schemaVersion": SCHEMA_VERSION, "type": "table", "title": "Anders",
        "targets": [ { "refId": "A", "datasourceId": sql, "query": { "sql": "SELECT region, amount FROM orders" } } ] } });
    let refused = t.put(&format!("~/library-panels/{library}"), lib_body.clone(), &editor).await;
    assert_eq!(refused.reason(), "sharing.public_links_active", "{}", refused.body);
    // The link stays live; holders of `dashboards:public` save.
    assert_eq!(t.visit(&format!("/dashboards/{token}"), None).await.status, StatusCode::OK);
    let saved = t.put(&format!("~/dashboards/{dashboard}"), json!({ "model": renamed, "version": 2 }), &t.owner).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    // A revoked link no longer holds anyone back.
    t.post(&format!("~/public-links/{link_id}/revoke"), json!({}), &t.owner).await;
    renamed["title"] = json!("Live, frei");
    let saved = t.put(&format!("~/dashboards/{dashboard}"), json!({ "model": renamed, "version": 3 }), &editor).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    let saved = t.put(&format!("~/library-panels/{library}"), lib_body, &editor).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
}

async fn visitors_get_only_what_the_panel_shows(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let sql = t.sql_source().await;
    let model = json!({
        "schemaVersion": SCHEMA_VERSION, "title": "Gezeigt", "timeRange": { "from": "now-6h", "to": "now" },
        "panels": [ {
            "id": "p1", "type": "table", "title": "Umsatz", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
            "targets": [
                { "refId": "A", "datasourceId": sql, "query": { "sql": "SELECT region, amount FROM orders ORDER BY region" } },
                { "refId": "B", "datasourceId": sql, "query": { "sql": "SELECT 'geheim' AS kennwort" }, "hide": true }
            ],
            // The hidden query runs because a step reads it; its answer still stays on the server.
            "transformations": [ { "id": "s", "type": "calculate", "frame": "A", "name": "brutto", "expression": "amount * 2" },
                                 { "id": "t", "type": "calculate", "frame": "B", "name": "x", "expression": "1" } ]
        } ]
    });
    let dashboard = t.dashboard(model).await;
    let token = t.link(&dashboard, json!({}), &t.owner).await.ok()["token"].as_str().unwrap().to_string();
    let page = t.visit(&format!("/dashboards/{token}"), None).await;
    let panel = &page.ok()["dashboard"]["panels"][0];
    assert_eq!(panel["targets"], json!([{ "refId": "A", "hide": false }]), "{}", page.body);
    assert!(panel.get("transformations").is_none(), "{}", page.body);
    let r = t.visit(&format!("/dashboards/{token}/panels/p1/query"), Some(range(T0 - HOUR, T0))).await;
    let results = &r.ok()["results"];
    assert!(results.get("B").is_none(), "{}", r.body);
    assert!(!r.body.to_string().contains("geheim"), "{}", r.body);
    let fields = &results["A"]["result"]["frame"]["fields"];
    assert_eq!(fields[2]["name"], "brutto", "{}", r.body);
    assert_eq!(fields[2]["values"], json!([240.0, 160.0]), "{}", r.body);
    // A public snapshot holds the same.
    let snapshot = t
        .post(
            &format!("~/dashboards/{dashboard}/snapshots"),
            json!({ "timeRange": { "from": T0 - DAY, "to": T0 }, "public": true }),
            &t.owner,
        )
        .await;
    let snapshot_token = snapshot.ok()["token"].as_str().unwrap().to_string();
    let frozen = t.visit(&format!("/snapshots/{snapshot_token}"), None).await;
    assert!(!frozen.ok().to_string().contains("geheim"), "{}", frozen.body);
    assert_eq!(
        frozen.body["results"]["p1"]["results"]["A"]["result"]["frame"]["fields"][2]["values"],
        json!([240.0, 160.0])
    );
}

async fn restores_and_analyses_behind_live_links_need_the_permission(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let sql = t.sql_source().await;
    let analysis_model = |title: &str| {
        json!({ "schemaVersion": 1, "title": title, "timeRange": { "from": "now-7d", "to": "now" },
                "targets": [ { "refId": "A", "datasourceId": sql, "query": { "sql": "SELECT region, amount FROM orders" } } ],
                "steps": [], "visualization": { "type": "table", "options": {} } })
    };
    let analysis = t.post("~/analyses", json!({ "model": analysis_model("Umsatz") }), &t.owner).await;
    let analysis = analysis.ok()["id"].as_str().unwrap().to_string();
    let model = |title: &str| {
        json!({ "schemaVersion": SCHEMA_VERSION, "title": title, "timeRange": { "from": "now-6h", "to": "now" },
                "panels": [ { "id": "a1", "type": "table", "title": "Umsatz", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                              "analysisId": analysis } ] })
    };
    let dashboard = t.dashboard(model("Mit Auswertung")).await;
    // A second version of each, so there is one to go back to.
    let saved =
        t.put(&format!("~/dashboards/{dashboard}"), json!({ "model": model("Zweite"), "version": 1 }), &t.owner).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    let saved = t
        .put(&format!("~/analyses/{analysis}"), json!({ "model": analysis_model("Zweite"), "version": 1 }), &t.owner)
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    let link = t.link(&dashboard, json!({}), &t.owner).await;
    let link_id = link.ok()["link"]["id"].as_str().unwrap().to_string();
    let (_, editor) = t.member("Erika", "editor").await;

    let refused = |r: &Reply, field: &str| {
        assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "sharing.public_links_active"), "{}", r.body);
        assert_eq!(r.body["error"]["field"], field, "{}", r.body);
    };
    let r = t
        .put(&format!("~/analyses/{analysis}"), json!({ "model": analysis_model("Dritte"), "version": 2 }), &editor)
        .await;
    refused(&r, "model");
    let r = t.post(&format!("~/analyses/{analysis}/versions/1/restore"), json!(null), &editor).await;
    refused(&r, "version");
    let r = t.post(&format!("~/dashboards/{dashboard}/versions/1/restore"), json!({}), &editor).await;
    refused(&r, "version");
    // The same with the permission, or once the link is revoked.
    let r = t.post(&format!("~/analyses/{analysis}/versions/1/restore"), json!(null), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.post(&format!("~/public-links/{link_id}/revoke"), json!({}), &t.owner).await;
    let r = t.post(&format!("~/dashboards/{dashboard}/versions/1/restore"), json!({}), &editor).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
}

async fn public_pages_are_not_indexed(t: TestApp) {
    for path in [format!("/public/dashboards/{}", "A".repeat(43)), format!("/public/snapshots/{}", "B".repeat(43))] {
        let r = t.send(Method::GET, &path, None, None).await;
        assert_eq!(r.headers.get("x-robots-tag").map(|v| v.to_str().unwrap()), Some("noindex"), "{path}");
        assert_eq!(r.headers.get(header::REFERRER_POLICY).unwrap(), "no-referrer", "{path}");
    }
    // Other pages keep the server's referrer policy and are not marked.
    let r = t.send(Method::GET, "/dashboards", None, None).await;
    assert!(r.headers.get("x-robots-tag").is_none());
    assert_ne!(r.headers.get(header::REFERRER_POLICY).unwrap(), "no-referrer");
}

async fn a_flood_of_visitors_is_slowed_never_refused(t: TestApp) {
    let hash = "0".repeat(64);
    let info = |i: u32| kalzit::net::RequestInfo {
        client_ip: std::net::IpAddr::from([10, 0, (i / 250) as u8, (i % 250) as u8]),
        https: false,
        host: None,
    };
    let per_visitor = kalzit::sharing::MAX_PER_VISITOR;
    let addresses = kalzit::sharing::SOFT_MAX_PER_TOKEN.div_ceil(per_visitor);
    for i in 0..addresses {
        for _ in 0..per_visitor {
            t.state.sharing.admit_known(&t.state, &info(i), &hash).await.unwrap();
        }
    }
    // Past the soft cap a new visitor still gets in, after a wait.
    let started = std::time::Instant::now();
    t.state.sharing.admit_known(&t.state, &info(addresses), &hash).await.unwrap();
    assert!(started.elapsed() >= kalzit::sharing::TOKEN_THROTTLE, "{:?}", started.elapsed());
}

async fn lists_show_ended_links_without_checking_their_creator(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, _, _) = t.shared_dashboard().await;
    let revoked = t.link(&dashboard, json!({}), &t.owner).await.ok()["link"]["id"].as_str().unwrap().to_string();
    t.post(&format!("~/public-links/{revoked}/revoke"), json!({}), &t.owner).await;
    let active = t.link(&dashboard, json!({}), &t.owner).await.ok()["link"]["id"].as_str().unwrap().to_string();
    // With sharing off an open link is suspended; an ended one stays what it is.
    t.setting("server", "sharing.public_enabled", json!(false)).await;
    assert_eq!(t.link_status(&revoked).await, ("revoked".to_string(), Value::Null));
    assert_eq!(t.link_status(&active).await, ("suspended".to_string(), json!("sharingOff")));
}

async fn a_busy_server_answer_is_never_reused(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let sql = t.sql_source().await;
    let model = json!({
        "schemaVersion": SCHEMA_VERSION, "title": "Mit Schritt", "timeRange": { "from": "now-6h", "to": "now" },
        "panels": [ {
            "id": "p1", "type": "table", "title": "Umsatz", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
            "targets": [ { "refId": "A", "datasourceId": sql, "query": { "sql": "SELECT region, amount FROM orders" } } ],
            "transformations": [ { "id": "s", "type": "calculate", "frame": "A", "name": "brutto", "expression": "amount * 2" } ]
        } ]
    });
    let dashboard = t.dashboard(model).await;
    let token = t.link(&dashboard, json!({}), &t.owner).await.ok()["token"].as_str().unwrap().to_string();
    let query = format!("/dashboards/{token}/panels/p1/query");
    // Every step slot taken: the visitor gets the neutral error after a short wait.
    let slots = t.state.sharing.take_all_step_slots(std::time::Duration::from_millis(50));
    let busy = t.visit(&query, Some(range(T0 - HOUR, T0))).await;
    assert_eq!(busy.ok()["results"]["A"]["error"]["message"], "the query failed", "{}", busy.body);
    assert_eq!(t.state.sharing.shown_count(), 0, "an error is not kept");
    drop(slots);
    // The next visitor of the same range gets the real answer, not the error.
    let r = t.visit(&query, Some(range(T0 - HOUR, T0))).await;
    assert_eq!(r.ok()["results"]["A"]["result"]["frame"]["fields"][2]["name"], "brutto", "{}", r.body);
    assert_eq!(t.state.sharing.shown_count(), 1);
    assert!(t.state.sharing.shown_bytes() >= kalzit::sharing::SHOWN_ENTRY_OVERHEAD);
}

async fn snapshots_are_capped_per_organization_and_person(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, _, _) = t.shared_dashboard().await;
    let path = format!("~/dashboards/{dashboard}/snapshots");
    let body = json!({ "timeRange": { "from": T0 - DAY, "to": T0 } });
    // Without an expiry an internal snapshot stays a week, a public one 30 days.
    let internal = t.post(&path, body.clone(), &t.owner).await;
    assert_eq!(internal.ok()["snapshot"]["expiresAt"], T0 + 7 * DAY, "{}", internal.body);
    let public = t.post(&path, json!({ "timeRange": { "from": T0 - DAY, "to": T0 }, "public": true }), &t.owner).await;
    assert_eq!(public.ok()["snapshot"]["expiresAt"], T0 + 30 * DAY, "{}", public.body);

    // The number of snapshots an organization keeps.
    t.setting("server", "sharing.snapshots_per_org", json!(2)).await;
    let full = t.post(&path, body.clone(), &t.owner).await;
    assert_eq!((full.status, full.reason()), (StatusCode::CONFLICT, "sharing.too_many_snapshots"), "{}", full.body);
    assert_eq!(full.body["error"]["params"]["max"], "2");
    // An expired one still holds its results until it is deleted, so it still counts; revoking
    // frees its place at once.
    let internal_id = internal.body["snapshot"]["id"].as_str().unwrap().to_string();
    sqlx::query("UPDATE snapshots SET expires_at = $1 WHERE id = $2")
        .bind(T0)
        .bind(&internal_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(t.post(&path, body.clone(), &t.owner).await.reason(), "sharing.too_many_snapshots");
    let r = t.post(&format!("~/snapshots/{internal_id}/revoke"), json!({}), &t.owner).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    // Revoking drops what the snapshot stored, the dashboard as shared too, not only its place.
    let (model, results): (i64, i64) = sqlx::query_as(
        "SELECT CAST(LENGTH(model) AS BIGINT), CAST(LENGTH(results) AS BIGINT) FROM snapshots WHERE id = $1",
    )
    .bind(&internal_id)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!((model, results), (2, 2));
    assert_eq!(t.get(&format!("~/snapshots/{internal_id}"), &t.owner).await.status, StatusCode::NOT_FOUND);
    let third = t.post(&path, body.clone(), &t.owner).await;
    assert_eq!(third.status, StatusCode::CREATED, "{}", third.body);

    // The bytes they take together.
    t.setting("server", "sharing.snapshots_per_org", json!(100)).await;
    t.setting("server", "sharing.snapshot_bytes_per_org", json!(1024 * 1024)).await;
    let third_id = third.body["snapshot"]["id"].as_str().unwrap().to_string();
    sqlx::query("UPDATE snapshots SET size_bytes = $1 WHERE id = $2")
        .bind(1024 * 1024 - 100)
        .bind(&third_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    let r = t.post(&path, body.clone(), &t.owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "sharing.snapshot_storage_full"), "{}", r.body);
    assert_eq!(r.body["error"]["params"]["max"], (1024 * 1024).to_string());
    // Nothing was stored for the refused ones.
    let (stored,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM snapshots").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(stored, 3);
    t.setting("server", "sharing.snapshot_bytes_per_org", json!(1024 * 1024 * 1024)).await;

    // One person makes only so many a minute; someone else is not held up by it.
    let (_, editor) = t.member("Erika", "editor").await;
    for _ in 0..kalzit::sharing::MAX_SNAPSHOTS_PER_USER {
        let r = t.post(&path, body.clone(), &editor).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    }
    let r = t.post(&path, body.clone(), &editor).await;
    assert_eq!((r.status, r.reason()), (StatusCode::TOO_MANY_REQUESTS, "sharing.snapshot_rate_limited"), "{}", r.body);
    assert!(r.headers.get(header::RETRY_AFTER).is_some());
    assert_eq!(t.post(&path, body.clone(), &t.owner).await.status, StatusCode::CREATED);
    t.clock.advance_ms(61_000);
    assert_eq!(t.post(&path, body, &editor).await.status, StatusCode::CREATED);
}

async fn visitors_run_in_query_slots_of_their_own(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, _, _) = t.shared_dashboard().await;
    let token = t.link(&dashboard, json!({}), &t.owner).await.ok()["token"].as_str().unwrap().to_string();
    let query = format!("/dashboards/{token}/panels/p1/query");
    // The creator's own query slots all busy: visitors do not wait for them.
    let creator = t.state.datasources.take_all_user_slots(&t.owner_id);
    let started = std::time::Instant::now();
    let r = t.visit(&query, Some(range(T0 - HOUR, T0))).await;
    assert_eq!(r.ok()["results"]["A"]["result"]["shape"], "frame", "{}", r.body);
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());
    drop(creator);

    // The organization's public slots all busy: a range that must run waits (shortened here) and
    // is then refused; an answer kept for the link is still served without waiting.
    let busy = t.state.sharing.take_all_public_runs(&t.org, std::time::Duration::from_millis(50));
    let r = t.visit(&query, Some(range(T0 - 2 * HOUR, T0))).await;
    assert_eq!((r.status, r.reason()), (StatusCode::TOO_MANY_REQUESTS, "sharing.busy"), "{}", r.body);
    assert!(r.headers.get(header::RETRY_AFTER).is_some());
    assert_eq!(r.headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
    let kept = t.visit(&query, Some(range(T0 - HOUR, T0))).await;
    assert_eq!(kept.status, StatusCode::OK, "{}", kept.body);
    drop(busy);
    assert_eq!(t.visit(&query, Some(range(T0 - 2 * HOUR, T0))).await.status, StatusCode::OK);

    // A link's visitors run only so many distinct ranges a minute; ranges run already pass.
    let mut ran = 2;
    let mut minute = 3;
    while ran < kalzit::sharing::MAX_RANGES_PER_LINK {
        let r = t.visit(&query, Some(range(T0 - minute * 60_000, T0))).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        ran += 1;
        minute += 1;
    }
    let r = t.visit(&query, Some(range(T0 - minute * 60_000, T0))).await;
    assert_eq!((r.status, r.reason()), (StatusCode::TOO_MANY_REQUESTS, "sharing.rate_limited"), "{}", r.body);
    // The same range on another panel was run in this minute: it passes.
    let docs = t.visit(&format!("/dashboards/{token}/panels/p2/query"), Some(range(T0 - HOUR, T0))).await;
    assert_eq!(docs.status, StatusCode::OK, "{}", docs.body);
    // The next minute it runs.
    t.clock.advance_ms(61_000);
    let r = t.visit(&query, Some(range(T0 - minute * 60_000, T0))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
}

async fn views_are_counted_in_memory_and_written_in_batches(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, _, _) = t.shared_dashboard().await;
    let created = t.link(&dashboard, json!({}), &t.owner).await;
    let token = created.ok()["token"].as_str().unwrap().to_string();
    let link_id = created.body["link"]["id"].as_str().unwrap().to_string();
    let snapshot = t
        .post(
            &format!("~/dashboards/{dashboard}/snapshots"),
            json!({ "timeRange": { "from": T0 - DAY, "to": T0 }, "public": true }),
            &t.owner,
        )
        .await;
    let snapshot_token = snapshot.ok()["token"].as_str().unwrap().to_string();
    let snapshot_id = snapshot.body["snapshot"]["id"].as_str().unwrap().to_string();
    async fn stored(t: &TestApp, table: &str, id: &str) -> (i64, Option<i64>) {
        sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT views, last_viewed_at FROM {table} WHERE id = $1")))
            .bind(id)
            .fetch_one(&t.state.db)
            .await
            .unwrap()
    }
    for _ in 0..3 {
        assert_eq!(t.visit(&format!("/dashboards/{token}"), None).await.status, StatusCode::OK);
    }
    t.clock.advance_ms(5_000);
    assert_eq!(t.visit(&format!("/snapshots/{snapshot_token}"), None).await.status, StatusCode::OK);
    assert_eq!(t.get(&format!("~/snapshots/{snapshot_id}"), &t.owner).await.status, StatusCode::OK);
    // A page load writes nothing itself.
    assert_eq!(stored(&t, "public_links", &link_id).await, (0, None));
    assert_eq!(stored(&t, "snapshots", &snapshot_id).await, (0, None));
    assert_eq!(t.state.sharing.pending_views(), 5);
    // One batch writes them all, with the latest load.
    assert_eq!(kalzit::sharing::flush_views(&t.state).await.unwrap(), 2);
    assert_eq!(stored(&t, "public_links", &link_id).await, (3, Some(T0)));
    assert_eq!(stored(&t, "snapshots", &snapshot_id).await, (2, Some(T0 + 5_000)));
    assert_eq!(t.state.sharing.pending_views(), 0);
    assert_eq!(kalzit::sharing::flush_views(&t.state).await.unwrap(), 0);
    // A list shows the loads counted so far: it writes them first.
    t.visit(&format!("/dashboards/{token}"), None).await;
    let listed = t.get("~/public-links", &t.owner).await;
    let item = listed.ok()["items"].as_array().unwrap().iter().find(|l| l["id"] == link_id.as_str()).cloned().unwrap();
    assert_eq!(item["views"], 4);
}

async fn snapshot_titles_are_hidden_like_dashboard_titles(t: TestApp) {
    let (dashboard, _, _) = t.shared_dashboard().await;
    let (erika_id, erika) = t.member("Erika", "editor").await;
    let path = format!("~/dashboards/{dashboard}/snapshots");
    // Without a title the snapshot takes the dashboard's.
    let created = t.post(&path, json!({ "timeRange": { "from": T0 - DAY, "to": T0 } }), &erika).await;
    assert_eq!(created.ok()["snapshot"]["title"], "Umsatz");
    let mine = t.get("~/snapshots", &erika).await;
    assert_eq!(mine.ok()["items"][0]["title"], "Umsatz");
    assert_eq!(mine.body["items"][0]["dashboardTitle"], "Umsatz");
    // Erika may no longer read the dashboard: her list names neither the dashboard nor the
    // snapshot, whose title would give the dashboard's away.
    let role = t
        .post("~/roles", json!({ "name": "Ohne Lesen", "description": "", "permissions": ["alerts:read"] }), &t.owner)
        .await;
    t.set_role(&erika_id, role.ok()["id"].as_str().unwrap()).await;
    let hidden = t.get("~/snapshots", &erika).await;
    let item = &hidden.ok()["items"][0];
    assert!(item.get("dashboardTitle").is_none(), "{item}");
    assert!(item.get("title").is_none(), "{item}");
    assert!(!hidden.body.to_string().contains("Umsatz"), "{}", hidden.body);
    // Who may read the dashboard still sees both.
    let all = t.get("~/snapshots", &t.owner).await;
    assert_eq!(all.ok()["items"][0]["title"], "Umsatz");
}

async fn a_page_of_more_panels_than_slots_waits_for_them(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let (dashboard, _, _) = t.shared_dashboard().await;
    let token = t.link(&dashboard, json!({}), &t.owner).await.ok()["token"].as_str().unwrap().to_string();
    let query = format!("/dashboards/{token}/panels/p1/query");
    // A page asks for all its panels at once, more than the organization has slots for, while
    // every slot is busy for a moment: they wait for a slot instead of being refused.
    let busy = t.state.sharing.take_all_public_runs(&t.org, kalzit::sharing::PUBLIC_SLOT_WAIT);
    let panels = 3 * kalzit::sharing::PUBLIC_RUNS_PER_ORG;
    let asks =
        (1..=panels).map(|minute| t.visit(&query, Some(range(T0 - i64::try_from(minute).unwrap() * 60_000, T0))));
    let release = async {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        drop(busy);
    };
    let (answers, ()) = tokio::join!(futures_util::future::join_all(asks), release);
    for r in &answers {
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        assert_eq!(r.body["results"]["A"]["result"]["shape"], "frame", "{}", r.body);
    }
}

async fn only_so_many_visitors_wait_for_a_slot(t: TestApp) {
    use kalzit::sharing::MAX_PUBLIC_WAITERS_PER_ORG;
    // Every slot busy for a while: the first waiters queue, one more is refused at once instead
    // of waiting behind them.
    let busy = t.state.sharing.take_all_public_runs(&t.org, std::time::Duration::from_secs(5));
    let waiters = (0..MAX_PUBLIC_WAITERS_PER_ORG).map(|_| async {
        // Each gives its slot back at once, so the others get theirs.
        t.state.sharing.public_run(&t.org).await.map(drop)
    });
    let one_more = async {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let started = std::time::Instant::now();
        let refused = t.state.sharing.public_run(&t.org).await.map(drop).unwrap_err();
        assert!(started.elapsed() < std::time::Duration::from_secs(1), "{:?}", started.elapsed());
        drop(busy);
        refused
    };
    let (waited, refused) = tokio::join!(futures_util::future::join_all(waiters), one_more);
    assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(refused.reason.as_ref().map(|r| r.code.as_str()), Some("sharing.busy"));
    for w in waited {
        assert!(w.is_ok(), "a waiter got a slot once they were free");
    }
    // With the queue empty again a request gets its slot.
    drop(t.state.sharing.public_run(&t.org).await.unwrap());
}

/// A query variable at "All" without a custom value, shared without values: the link keeps the
/// marker and every run reads the variable's options anew as the creator, with its order, so the
/// list is never frozen at creation. A failing options query is an error, never an empty list.
async fn a_shared_all_reads_the_values_when_it_runs(t: TestApp) {
    t.setting("server", "sharing.public_enabled", json!(true)).await;
    let sql = t.sql_source().await;
    let panel = |id: &str, query: &str| {
        json!({ "id": id, "type": "table", "title": id, "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                "targets": [ { "refId": "A", "datasourceId": sql, "query": { "sql": query } } ] })
    };
    let model = json!({
        "schemaVersion": SCHEMA_VERSION, "title": "Alle", "timeRange": { "from": "now-6h", "to": "now" },
        "variables": [
            { "name": "region", "type": "query", "datasourceId": sql, "query": { "sql": "SELECT region FROM orders" },
              "multi": true, "includeAll": true, "current": "$__all", "sort": "alphabeticalDesc" },
            { "name": "kaputt", "type": "query", "datasourceId": sql, "query": { "sql": "SELECT region FROM fehlt" },
              "multi": true, "includeAll": true, "current": "$__all" }
        ],
        "panels": [
            panel("p1", "SELECT region, amount FROM orders WHERE region IN ($region) ORDER BY region"),
            panel("p2", "SELECT COUNT(*) AS n FROM orders WHERE region IN ($kaputt)")
        ]
    });
    let dashboard = t.dashboard(model).await;

    let created = t.link(&dashboard, json!({}), &t.owner).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    assert_eq!(created.body["link"]["variables"], json!({ "region": "$__all", "kaputt": "$__all" }));
    let token = created.body["token"].as_str().unwrap().to_string();
    let rows = |r: &Reply| r.ok()["results"]["A"]["result"]["frame"]["fields"][1]["values"].clone();
    let first = t.visit(&format!("/dashboards/{token}/panels/p1/query"), Some(range(T0 - HOUR, T0))).await;
    assert_eq!(rows(&first), json!(["120", "80"]), "{}", first.body);

    // A new value appears in the source: the next run reads it, the link did not freeze the list.
    t.change_orders("INSERT INTO orders VALUES ('West', 5)").await;
    let later = t.visit(&format!("/dashboards/{token}/panels/p1/query"), Some(range(T0 - 2 * HOUR, T0))).await;
    assert_eq!(rows(&later), json!(["120", "80", "5"]), "{}", later.body);

    // The options query of the other variable fails: no answer with an empty list.
    let broken = t.visit(&format!("/dashboards/{token}/panels/p2/query"), Some(range(T0 - HOUR, T0))).await;
    assert_ne!(broken.status, StatusCode::OK, "{}", broken.body);

    // Signed in, the panel route fills in a sent "All" the same way and names the variable when
    // its options fail.
    let path = format!("~/dashboards/{dashboard}/panels/p2/query");
    let body = json!({ "timeRange": { "from": T0 - HOUR, "to": T0 }, "variables": { "kaputt": "$__all" } });
    let failed = t.post(&path, body, &t.owner).await;
    assert_eq!(failed.reason(), "variables.all_options_failed", "{}", failed.body);
    assert_eq!(failed.body["error"]["params"]["name"], "kaputt");
    let path = format!("~/dashboards/{dashboard}/panels/p1/query");
    // Another range: the query cache keeps the answers of the first visit for a while, as for
    // the dashboard itself.
    let body = json!({ "timeRange": { "from": T0 - 3 * HOUR, "to": T0 }, "variables": { "region": ["$__all"] } });
    assert_eq!(rows(&t.post(&path, body, &t.owner).await), json!(["120", "80", "5"]));

    // The preview of an unsaved variable: "All" of another one needs the saved dashboard.
    let variable = json!({ "name": "menge", "type": "query", "datasourceId": sql,
                            "query": { "sql": "SELECT amount FROM orders WHERE region IN ($region)" } });
    let preview = |extra: Value| {
        let mut body = json!({ "variable": variable, "timeRange": { "from": T0 - 4 * HOUR, "to": T0 },
                               "variables": { "region": "$__all" } });
        body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        body
    };
    let unresolved = t.post("~/query/variable-options", preview(json!({})), &t.owner).await;
    assert_eq!(unresolved.reason(), "variables.all_unresolved", "{}", unresolved.body);
    let filled = t.post("~/query/variable-options", preview(json!({ "dashboardId": dashboard })), &t.owner).await;
    assert_eq!(filled.ok()["options"].as_array().unwrap().len(), 3, "{}", filled.body);
}
