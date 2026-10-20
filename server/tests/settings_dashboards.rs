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

    async fn actions(&self) -> Vec<String> {
        let rows: Vec<(String,)> = sqlx::query_as("SELECT action FROM audit_events ORDER BY created_at, id")
            .fetch_all(&self.state.db)
            .await
            .unwrap();
        rows.into_iter().map(|r| r.0).collect()
    }
}

/// Every flow runs on SQLite, and on PostgreSQL when `KALZIT_TEST_POSTGRES_URL` is set (in a
/// throwaway schema per flow, so the test database is left as it was).
macro_rules! on_both_databases {
    ($($flow:ident: $tweak:expr;)*) => {
        mod sqlite {
            use super::*;
            $(
                #[tokio::test]
                async fn $flow() {
                    super::$flow(test_app(None, $tweak).await).await
                }
            )*
        }

        #[tokio::test]
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
    server_settings_report_sources_and_save_with_versions: |c| c.sessions.lifetime_hours = 10;
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
    let foreign_parent = t.post("~/folders", create("X", Some(&uuid::Uuid::now_v7().to_string())), &t.owner).await;
    assert_eq!(foreign_parent.code(), "not_found");

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
    let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM folders").fetch_one(&t.state.db).await.unwrap();
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
    let other_org = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, 'Andere', 0)")
        .bind(&other_org)
        .execute(&t.state.db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO dashboards (id, org_id, title, version, created_at, updated_at) VALUES ('fremd', $1, 'Fremd', 1, 0, 0)",
    )
    .bind(&other_org)
    .execute(&t.state.db)
    .await
    .unwrap();
    assert_eq!(t.get("~/dashboards/fremd", &t.owner).await.code(), "not_found");
    assert_eq!(t.delete("~/dashboards/fremd", &t.owner).await.code(), "not_found");
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
