//! Saved analyses through the real router and database (docs/api/analyses.md): create, read,
//! save with the version check, trash, restore, purge, access per role, folder, grant and team
//! space, the query right on save, running the stored queries, and the audit trail.

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
    org: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
    /// The answer as text, for files.
    text: String,
}

impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }

    fn titles(&self) -> Vec<String> {
        assert_eq!(self.status, StatusCode::OK, "{}", self.body);
        self.body["items"].as_array().unwrap().iter().map(|i| i["title"].as_str().unwrap().to_string()).collect()
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
        let text = String::from_utf8_lossy(&bytes).into_owned();
        Reply { status, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null), text }
    }

    /// `~` stands for `/api/orgs/<the org>`.
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

    async fn put(&self, path: &str, body: Value, cookie: &str) -> Reply {
        self.send(Method::PUT, &self.path(path), Some(body), Some(cookie)).await
    }

    async fn delete(&self, path: &str, cookie: &str) -> Reply {
        self.send(Method::DELETE, &self.path(path), None, Some(cookie)).await
    }

    async fn session_for(&self, user_id: &str) -> String {
        let cfg = &self.state.config.sessions;
        let token = kalzit::auth::session::create(&self.state.db, cfg, self.clock.now_ms(), user_id).await.unwrap();
        format!("kalzit_session={token}")
    }

    /// A new user in the organization with `role`, signed in: (user id, cookie).
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
        (id, cookie)
    }

    async fn team(&self, name: &str) -> String {
        id_of(self.post("~/teams", json!({ "name": name }), &self.owner).await)
    }

    async fn join(&self, team: &str, user: &str, role: &str) {
        let r = self.put(&format!("~/teams/{team}/members/{user}"), json!({ "role": role }), &self.owner).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    }

    async fn folder(&self, name: &str, restricted: bool) -> String {
        id_of(self.post("~/folders", json!({ "name": name, "restricted": restricted }), &self.owner).await)
    }

    async fn grant(&self, subject_type: &str, subject: &str, resource_type: &str, resource: &str, level: &str) {
        let body = json!({ "subjectType": subject_type, "subjectId": subject, "resourceType": resource_type,
                           "resourceId": resource, "level": level });
        let r = self.post("~/grants", body, &self.owner).await;
        assert!(r.status.is_success(), "{}", r.body);
    }

    /// A SQLite source whose file holds `orders (country TEXT, amount INTEGER)` with three rows, in
    /// a directory the server admin allowed: its queries really run.
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
            "CREATE TABLE orders (country TEXT, amount INTEGER); \
             INSERT INTO orders VALUES ('AT', 10), ('DE', 20), ('DE', 5);",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        let body = json!({ "name": name, "kind": "sqlite", "settings": { "path": path.to_string_lossy() } });
        id_of(self.post("~/datasources", body, &self.owner).await)
    }

    async fn create(&self, title: &str, source: &str, folder: Option<&str>, cookie: &str) -> Reply {
        self.post("~/analyses", json!({ "folderId": folder, "model": model(title, source, SQL) }), cookie).await
    }

    /// Saves `model` over the analysis at the version it has now, as `cookie`.
    async fn save(&self, id: &str, model: Value, cookie: &str) -> Reply {
        let current = self.get(&format!("~/analyses/{id}"), &self.owner).await;
        self.put(&format!("~/analyses/{id}"), json!({ "model": model, "version": current.body["version"] }), cookie)
            .await
    }

    async fn run(&self, id: &str, cookie: &str) -> Reply {
        let body = json!({ "timeRange": { "from": T0 - DAY, "to": T0 } });
        self.post(&format!("~/analyses/{id}/query"), body, cookie).await
    }

    /// The audit actions about `resource_id`, oldest first.
    async fn actions(&self, resource_id: &str) -> Vec<String> {
        let r = self.get(&format!("~/audit?resourceType=analysis&resourceId={resource_id}"), &self.owner).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let mut out: Vec<String> =
            r.body["items"].as_array().unwrap().iter().map(|e| e["action"].as_str().unwrap().to_string()).collect();
        out.reverse();
        out
    }
}

const SQL: &str = "SELECT country, SUM(amount) AS amount FROM orders GROUP BY country ORDER BY country";

fn id_of(r: Reply) -> String {
    assert!(r.status.is_success(), "{}", r.body);
    r.body["id"].as_str().unwrap().to_string()
}

fn model(title: &str, source: &str, sql: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "title": title,
        "description": "Umsatz je Land, für die Wochenrunde",
        "timeRange": { "from": "now-7d", "to": "now" },
        "targets": [{ "refId": "A", "datasourceId": source, "query": { "sql": sql } }],
        "steps": [{ "id": "s1", "type": "reduce", "frame": "A", "fields": ["amount"], "stats": ["sum"] }],
        "visualization": { "type": "table", "options": {} }
    })
}

/// Every flow runs on SQLite, and on PostgreSQL when `KALZIT_TEST_POSTGRES_URL` is set (in a
/// throwaway schema per flow, so the test database is left as it was).
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

/// The sort key refresh at startup holds its advisory lock and does its work on one connection,
/// so a server with `database.max_connections = 1` still starts on PostgreSQL, and fills keys
/// that are missing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_sort_key_refresh_needs_one_connection() {
    let Some(base) = common::postgres_url("the sort key refresh on one connection") else { return };
    let schema = common::postgres_schema(&base).await;
    let connect = kalzit::db::connect(&schema.url, 1);
    let db = tokio::time::timeout(std::time::Duration::from_secs(60), connect).await.expect("starts").unwrap();
    sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ('o', 'O', 0)").execute(&db).await.unwrap();
    sqlx::query(
        "INSERT INTO dashboards (id, org_id, title, search_title, version, created_at, updated_at) \
         VALUES ('d', 'o', 'Äpfel', 'äpfel', 1, 0, 0)",
    )
    .execute(&db)
    .await
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(60), kalzit::collation::refresh(&db))
        .await
        .expect("refreshes")
        .unwrap();
    let (stored,): (Vec<u8>,) = sqlx::query_as("SELECT sort_title FROM dashboards").fetch_one(&db).await.unwrap();
    assert_eq!(stored, kalzit::collation::key("Äpfel"));
    db.close().await;
    schema.drop_now().await;
}

on_both_databases! {
    create_read_save_and_list,
    lists_follow_the_language_order_on_every_database,
    saves_check_the_version,
    invalid_models_are_refused_with_their_place,
    trash_restore_and_purge,
    every_change_is_audited,
    roles_decide_without_folders,
    restricted_folders_and_grants_decide,
    team_spaces_and_team_ownership,
    saving_rechecks_the_query_right,
    readers_run_the_stored_queries_only,
    distributions_follow_the_stored_query_rule,
    folder_trash_takes_analyses_along,
    other_organizations_see_nothing,
    the_time_range_is_optional,
    every_save_is_kept_in_the_history,
    dashboards_link_analyses,
    links_keep_analyses_in_place,
    lists_filter_sort_and_tell_what_the_caller_may_do,
    answers_name_who_created_and_saved,
    folder_changes_keep_linked_analyses_visible,
    links_respect_the_analysis_audience,
    purging_needs_the_admin_level_and_no_link,
    linked_queries_change_only_with_the_query_right,
    linked_panels_export,
    trash_and_link_race,
    purge_and_restore_race,
}

async fn create_read_save_and_list(t: TestApp) {
    let source = t.source("shop").await;
    let created = t.create("Umsatz je Land", &source, None, &t.owner).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let id = created.body["id"].as_str().unwrap().to_string();
    assert_eq!(created.body["version"], 1);
    assert_eq!(created.body["title"], "Umsatz je Land");
    assert_eq!(created.body["model"]["targets"][0]["query"]["sql"], SQL);
    assert_eq!(created.body["model"]["visualization"]["fieldConfig"], json!({}), "defaults are filled in");
    assert_eq!(created.body["access"], json!({ "write": true, "delete": true, "permissions": true }));
    assert_eq!(created.body["ownerTeam"], Value::Null);
    assert_eq!(created.body["deletedAt"], Value::Null);

    let one = t.get(&format!("~/analyses/{id}"), &t.owner).await;
    assert_eq!(one.status, StatusCode::OK);
    assert_eq!(one.body["model"], created.body["model"]);

    t.clock.advance_ms(1000);
    let mut changed = model("Umsatz nach Land", &source, SQL);
    changed["visualization"] = json!({ "type": "bar" });
    let saved = t.save(&id, changed, &t.owner).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    assert_eq!(saved.body["version"], 2);
    assert_eq!(saved.body["updatedAt"], T0 + 1000);
    assert_eq!(saved.body["model"]["visualization"]["type"], "bar");

    // Listing: by title in the language order ("Ö" next to "O"), searchable in any case (also
    // beyond ASCII), filtered by folder.
    let folder = t.folder("Vertrieb", false).await;
    t.create("Öffnungszeiten", &source, Some(&folder), &t.owner).await;
    t.create("Abbrüche", &source, None, &t.owner).await;
    assert_eq!(t.get("~/analyses", &t.owner).await.titles(), ["Abbrüche", "Öffnungszeiten", "Umsatz nach Land"]);
    assert_eq!(t.get("~/analyses?q=%C3%96FFNUNG", &t.owner).await.titles(), ["Öffnungszeiten"]);
    assert_eq!(t.get("~/analyses?q=land", &t.owner).await.titles(), ["Umsatz nach Land"]);
    assert_eq!(t.get(&format!("~/analyses?folderId={folder}"), &t.owner).await.titles(), ["Öffnungszeiten"]);
    // `%` and `_` match themselves.
    assert!(t.get("~/analyses?q=%25", &t.owner).await.titles().is_empty());
    // Pages keep their order.
    let first = t.get("~/analyses?limit=2", &t.owner).await;
    assert_eq!(first.titles(), ["Abbrüche", "Öffnungszeiten"]);
    let cursor = first.body["nextCursor"].as_str().unwrap().to_string();
    assert_eq!(t.get(&format!("~/analyses?limit=2&cursor={cursor}"), &t.owner).await.titles(), ["Umsatz nach Land"]);
    // A folder that does not exist is not found; an unknown parameter is refused.
    let missing = uuid::Uuid::now_v7();
    assert_eq!(t.get(&format!("~/analyses?folderId={missing}"), &t.owner).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.get("~/analyses?tag=x", &t.owner).await.status, StatusCode::UNPROCESSABLE_ENTITY);
}

/// Lists order by the rules of the UI languages, not by the database's collation: German puts
/// "Ä" and "Ö" next to "A" and "O" and sorts "ß" like "ss"; English follows the Unicode collation;
/// case does not count. SQLite and PostgreSQL answer the same order, and pages keep it across
/// every umlaut boundary.
async fn lists_follow_the_language_order_on_every_database(t: TestApp) {
    let source = t.source("shop").await;
    let german = t.folder("Deutsch", false).await;
    let english = t.folder("English", false).await;
    let mut zebra = String::new();
    for title in ["Zebra", "ß", "Äpfel", "O", "Apfel", "Ö"] {
        let r = t.create(title, &source, Some(&german), &t.owner).await;
        assert_eq!(r.status, StatusCode::CREATED);
        if title == "Zebra" {
            zebra = id_of(r);
        }
    }
    for title in ["cherry", "Éclair", "banana", "apple pie", "Apple", "Delta"] {
        assert_eq!(t.create(title, &source, Some(&english), &t.owner).await.status, StatusCode::CREATED);
    }
    let german_order = ["Apfel", "Äpfel", "O", "Ö", "ß", "Zebra"];
    let english_order = ["Apple", "apple pie", "banana", "cherry", "Delta", "Éclair"];
    assert_eq!(t.get(&format!("~/analyses?folderId={german}"), &t.owner).await.titles(), german_order);
    assert_eq!(t.get(&format!("~/analyses?folderId={english}"), &t.owner).await.titles(), english_order);

    // One title per page: every step crosses a boundary (A/Ä, O/Ö, ß/Z), none repeats or skips.
    for (folder, expected) in [(&german, &german_order[..]), (&english, &english_order[..])] {
        let mut seen = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let path = match &cursor {
                Some(c) => format!("~/analyses?folderId={folder}&limit=1&cursor={c}"),
                None => format!("~/analyses?folderId={folder}&limit=1"),
            };
            let page = t.get(&path, &t.owner).await;
            seen.extend(page.titles());
            match page.body["nextCursor"].as_str() {
                Some(c) => cursor = Some(c.to_string()),
                None => break,
            }
        }
        assert_eq!(seen, expected);
    }
    // A rename moves the analysis to its new place.
    let renamed = t.save(&zebra, model("aal", &source, SQL), &t.owner).await;
    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.body);
    assert_eq!(
        t.get(&format!("~/analyses?folderId={german}"), &t.owner).await.titles(),
        ["aal", "Apfel", "Äpfel", "O", "Ö", "ß"]
    );
    let back = t.save(&zebra, model("Zebra", &source, SQL), &t.owner).await;
    assert_eq!(back.status, StatusCode::OK, "{}", back.body);

    // Titles equal but for case keep a stable order by id, also across pages.
    let first = id_of(t.create("umsatz", &source, None, &t.owner).await);
    let second = id_of(t.create("UMSATZ", &source, None, &t.owner).await);
    let ids = |r: &Reply| -> Vec<String> {
        r.body["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap().to_string()).collect()
    };
    let mut by_id = [first, second];
    by_id.sort();
    let page = t.get("~/analyses?q=umsatz&limit=1", &t.owner).await;
    assert_eq!(ids(&page), [by_id[0].clone()]);
    let cursor = page.body["nextCursor"].as_str().unwrap().to_string();
    let rest = t.get(&format!("~/analyses?q=umsatz&limit=1&cursor={cursor}"), &t.owner).await;
    assert_eq!(ids(&rest), [by_id[1].clone()]);

    // Dashboards follow the same order.
    for title in ["Zebra", "ß", "Äpfel", "O", "Apfel", "Ö"] {
        let body = json!({ "model": { "schemaVersion": 1, "title": title, "panels": [] } });
        let r = t.post("~/dashboards", body, &t.owner).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    }
    assert_eq!(t.get("~/dashboards", &t.owner).await.titles(), german_order);
    let page = t.get("~/dashboards?limit=3", &t.owner).await;
    assert_eq!(page.titles(), ["Apfel", "Äpfel", "O"]);
    let cursor = page.body["nextCursor"].as_str().unwrap().to_string();
    assert_eq!(t.get(&format!("~/dashboards?limit=3&cursor={cursor}"), &t.owner).await.titles(), ["Ö", "ß", "Zebra"]);
}

async fn saves_check_the_version(t: TestApp) {
    let source = t.source("shop").await;
    let id = id_of(t.create("Umsatz", &source, None, &t.owner).await);
    let (_, eva) = t.member("Eva", "editor").await;
    let body = |title: &str, version: i64| json!({ "model": model(title, &source, SQL), "version": version });
    let first = t.put(&format!("~/analyses/{id}"), body("Erste", 1), &eva).await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    // A save that started from version 1 lost the race: 409 with the stored analysis.
    let late = t.put(&format!("~/analyses/{id}"), body("Zweite", 1), &t.owner).await;
    assert_eq!((late.status, late.code()), (StatusCode::CONFLICT, "version_conflict"), "{}", late.body);
    assert_eq!(late.body["current"]["version"], 2);
    assert_eq!(late.body["current"]["title"], "Erste");
    assert_eq!(late.body["current"]["model"]["title"], "Erste");
    // A version from the future is a conflict as well, and nothing changed.
    let ahead = t.put(&format!("~/analyses/{id}"), body("Dritte", 7), &t.owner).await;
    assert_eq!(ahead.code(), "version_conflict");
    assert_eq!(t.get(&format!("~/analyses/{id}"), &t.owner).await.body["title"], "Erste");
    // Saving from the current version goes through.
    let ok = t.put(&format!("~/analyses/{id}"), body("Zweite", 2), &t.owner).await;
    assert_eq!((ok.status, ok.body["version"].clone()), (StatusCode::OK, json!(3)));
    // The version is required.
    let r = t.put(&format!("~/analyses/{id}"), json!({ "model": model("X", &source, SQL) }), &t.owner).await;
    assert!(r.status.is_client_error(), "{}", r.body);
}

async fn invalid_models_are_refused_with_their_place(t: TestApp) {
    let source = t.source("shop").await;
    let cases: [(&str, Value, &str); 7] = [
        ("title", json!(""), "model.title"),
        ("targets", json!([]), "model.targets"),
        ("timeRange", json!({ "from": "gestern", "to": "now" }), "model.timeRange"),
        (
            "steps",
            json!([{ "id": "s1", "type": "reduce", "frame": "B", "fields": ["amount"], "stats": ["sum"] }]),
            "model.steps[0]",
        ),
        ("visualization", json!({ "type": "timeseries", "options": { "lineWidth": 99 } }), "model.visualization"),
        ("schemaVersion", json!(9), "model.schemaVersion"),
        ("panels", json!([]), "model:"),
    ];
    for (key, value, place) in cases {
        let mut m = model("Umsatz", &source, SQL);
        m[key] = value;
        let r = t.post("~/analyses", json!({ "model": m }), &t.owner).await;
        assert_eq!((r.status, r.code()), (StatusCode::UNPROCESSABLE_ENTITY, "validation"), "{key}: {}", r.body);
        assert_eq!(r.body["error"]["field"], "model", "{key}");
        let message = r.body["error"]["message"].as_str().unwrap();
        assert!(message.starts_with(place), "{key}: {message}");
    }
    // A data source that does not exist in the organization is refused by name.
    let missing = uuid::Uuid::now_v7().to_string();
    let r = t.post("~/analyses", json!({ "model": model("Umsatz", &missing, SQL) }), &t.owner).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    // A folder in the trash takes no new analyses.
    let folder = t.folder("Alt", false).await;
    assert_eq!(t.delete(&format!("~/folders/{folder}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    let r = t.create("Umsatz", &source, Some(&folder), &t.owner).await;
    assert_eq!((r.status, r.body["error"]["field"].clone()), (StatusCode::UNPROCESSABLE_ENTITY, json!("folderId")));
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM analyses").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(count.0, 0);
}

async fn trash_restore_and_purge(t: TestApp) {
    let source = t.source("shop").await;
    let id = id_of(t.create("Umsatz", &source, None, &t.owner).await);
    let path = format!("~/analyses/{id}");
    // Purging needs the trash first.
    let r = t.delete(&format!("{path}/purge"), &t.owner).await;
    assert_eq!((r.status, r.code()), (StatusCode::CONFLICT, "conflict"));
    assert_eq!(t.delete(&path, &t.owner).await.status, StatusCode::NO_CONTENT);
    // Twice is fine and changes nothing.
    assert_eq!(t.delete(&path, &t.owner).await.status, StatusCode::NO_CONTENT);
    assert!(t.get("~/analyses", &t.owner).await.titles().is_empty());
    assert_eq!(t.get("~/analyses?trashed=true", &t.owner).await.titles(), ["Umsatz"]);
    let trashed = t.get(&path, &t.owner).await;
    assert_eq!(trashed.body["deletedAt"], T0);
    // Saving and running a trashed analysis are refused.
    let r = t.put(&path, json!({ "model": model("Neu", &source, SQL), "version": 1 }), &t.owner).await;
    assert_eq!((r.status, r.code()), (StatusCode::CONFLICT, "conflict"));
    assert_eq!(t.run(&id, &t.owner).await.status, StatusCode::NOT_FOUND);

    let restored = t.post(&format!("{path}/restore"), json!(null), &t.owner).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.body);
    assert_eq!(restored.body["deletedAt"], Value::Null);
    assert_eq!(t.get("~/analyses", &t.owner).await.titles(), ["Umsatz"]);

    assert_eq!(t.delete(&path, &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.delete(&format!("{path}/purge"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&path, &t.owner).await.status, StatusCode::NOT_FOUND);
    assert!(t.get("~/analyses?trashed=true", &t.owner).await.titles().is_empty());
}

async fn every_change_is_audited(t: TestApp) {
    let source = t.source("shop").await;
    let id = id_of(t.create("Umsatz", &source, None, &t.owner).await);
    let path = format!("~/analyses/{id}");
    assert_eq!(t.save(&id, model("Umsatz neu", &source, SQL), &t.owner).await.status, StatusCode::OK);
    // Reading and running leave no trace.
    t.get(&path, &t.owner).await;
    assert_eq!(t.run(&id, &t.owner).await.status, StatusCode::OK);
    t.delete(&path, &t.owner).await;
    t.post(&format!("{path}/restore"), json!(null), &t.owner).await;
    t.delete(&path, &t.owner).await;
    t.delete(&format!("{path}/purge"), &t.owner).await;
    assert_eq!(
        t.actions(&id).await,
        [
            "analysis.created",
            "analysis.updated",
            "analysis.deleted",
            "analysis.restored",
            "analysis.deleted",
            "analysis.purged"
        ]
    );
    let r = t.get(&format!("~/audit?action=analysis.updated&resourceId={id}"), &t.owner).await;
    assert_eq!(r.body["items"][0]["summary"], json!({ "version": 2, "moved": false }));
    // Summaries hold no query text.
    let rows: Vec<(String,)> = sqlx::query_as("SELECT summary FROM audit_events WHERE resource_type = 'analysis'")
        .fetch_all(&t.state.db)
        .await
        .unwrap();
    assert!(rows.iter().all(|(s,)| !s.contains("SELECT")), "{rows:?}");
}

async fn roles_decide_without_folders(t: TestApp) {
    let source = t.source("shop").await;
    let id = id_of(t.create("Umsatz", &source, None, &t.owner).await);
    let path = format!("~/analyses/{id}");
    let (_, viewer) = t.member("Vera", "viewer").await;
    let (_, editor) = t.member("Emil", "editor").await;
    let (_, admin) = t.member("Ada", "admin").await;

    // Viewers read and run; they change nothing.
    assert_eq!(t.get("~/analyses", &viewer).await.titles(), ["Umsatz"]);
    let one = t.get(&path, &viewer).await;
    assert_eq!(one.status, StatusCode::OK);
    assert_eq!(one.body["access"], json!({ "write": false, "delete": false, "permissions": false }));
    assert_eq!(t.run(&id, &viewer).await.status, StatusCode::OK);
    let forbidden = |r: Reply| assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    forbidden(t.create("Eigen", &source, None, &viewer).await);
    forbidden(t.save(&id, model("Umbenannt", &source, SQL), &viewer).await);
    forbidden(t.delete(&path, &viewer).await);
    forbidden(t.put(&format!("{path}/owner"), json!({ "ownerTeamId": null, "visibility": "shared" }), &viewer).await);

    // Editors and admins do everything.
    for (cookie, title) in [(&editor, "Von Emil"), (&admin, "Von Ada")] {
        let mine = id_of(t.create(title, &source, None, cookie).await);
        assert_eq!(t.save(&mine, model(&format!("{title} 2"), &source, SQL), cookie).await.status, StatusCode::OK);
        assert_eq!(t.delete(&format!("~/analyses/{mine}"), cookie).await.status, StatusCode::NO_CONTENT);
        let r = t.post(&format!("~/analyses/{mine}/restore"), json!(null), cookie).await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(t.delete(&format!("~/analyses/{mine}"), cookie).await.status, StatusCode::NO_CONTENT);
        assert_eq!(t.delete(&format!("~/analyses/{mine}/purge"), cookie).await.status, StatusCode::NO_CONTENT);
    }
    assert_eq!(t.save(&id, model("Von Emil geändert", &source, SQL), &editor).await.status, StatusCode::OK);

    // A custom role without `analyses:read` does not list them at all.
    sqlx::query("INSERT INTO roles (id, org_id, name, name_key, description, created_at)          VALUES ('nur-teams', $1, 'Nur Teams', 'nur teams', '', 0)",)
        .bind(&t.org)
        .execute(&t.state.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO role_permissions (role_id, permission) VALUES ('nur-teams', 'teams:read')")
        .execute(&t.state.db)
        .await
        .unwrap();
    let (_, teams_only) = t.member("Theo", "nur-teams").await;
    assert_eq!(t.get("~/analyses", &teams_only).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.get(&path, &teams_only).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.run(&id, &teams_only).await.status, StatusCode::NOT_FOUND);
}

async fn restricted_folders_and_grants_decide(t: TestApp) {
    let source = t.source("shop").await;
    let secret = t.folder("Vorstand", true).await;
    let id = id_of(t.create("Margen", &source, Some(&secret), &t.owner).await);
    let path = format!("~/analyses/{id}");
    let (vera_id, vera) = t.member("Vera", "viewer").await;
    let (emil_id, emil) = t.member("Emil", "editor").await;

    // Without a grant the restricted folder hides the analysis from everyone but admins.
    for cookie in [&vera, &emil] {
        assert!(t.get("~/analyses", cookie).await.titles().is_empty());
        assert_eq!(t.get(&path, cookie).await.status, StatusCode::NOT_FOUND);
        assert_eq!(t.run(&id, cookie).await.status, StatusCode::NOT_FOUND);
        assert_eq!(t.save(&id, model("X", &source, SQL), cookie).await.status, StatusCode::NOT_FOUND);
        assert_eq!(t.delete(&path, cookie).await.status, StatusCode::NOT_FOUND);
        assert_eq!(t.create("Neu", &source, Some(&secret), cookie).await.status, StatusCode::NOT_FOUND);
    }

    // A view grant on the folder: read and run, nothing else.
    t.grant("user", &emil_id, "folder", &secret, "view").await;
    assert_eq!(t.get("~/analyses", &emil).await.titles(), ["Margen"]);
    assert_eq!(t.run(&id, &emil).await.status, StatusCode::OK);
    assert_eq!(t.save(&id, model("X", &source, SQL), &emil).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.create("Neu", &source, Some(&secret), &emil).await.status, StatusCode::FORBIDDEN);
    // An edit grant on the folder: change and create inside.
    t.grant("user", &emil_id, "folder", &secret, "edit").await;
    assert_eq!(t.save(&id, model("Margen 2", &source, SQL), &emil).await.status, StatusCode::OK);
    assert_eq!(t.create("Neu", &source, Some(&secret), &emil).await.status, StatusCode::CREATED);

    // A grant on the analysis alone opens that analysis, not the folder or its other analyses.
    t.grant("user", &vera_id, "analysis", &id, "view").await;
    assert_eq!(t.get("~/analyses", &vera).await.titles(), ["Margen 2"]);
    let one = t.get(&path, &vera).await;
    assert_eq!(one.status, StatusCode::OK);
    assert_eq!(one.body["folderId"], Value::Null, "the hidden folder is not named");
    assert_eq!(t.run(&id, &vera).await.status, StatusCode::OK);
    assert_eq!(t.save(&id, model("X", &source, SQL), &vera).await.status, StatusCode::FORBIDDEN);
    // An edit grant on the analysis lets a viewer save what does not change the queries.
    t.grant("user", &vera_id, "analysis", &id, "edit").await;
    let current = t.get(&path, &vera).await;
    let mut renamed = current.body["model"].clone();
    renamed["title"] = json!("Margen umbenannt");
    let r = t.put(&path, json!({ "model": renamed, "version": current.body["version"] }), &vera).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // Sending the hidden folder back as `null` is no move.
    let mut again = r.body["model"].clone();
    again["title"] = json!("Margen erneut");
    let r = t.put(&path, json!({ "model": again, "version": r.body["version"], "folderId": null }), &vera).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let (folder,): (Option<String>,) =
        sqlx::query_as("SELECT folder_id FROM analyses WHERE id = $1").bind(&id).fetch_one(&t.state.db).await.unwrap();
    assert_eq!(folder.as_deref(), Some(secret.as_str()));

    // Grants on analyses are managed with `dashboards:share`: the editor with an admin grant on
    // the folder may, the viewer may not.
    let list = format!("~/grants?resourceType=analysis&resourceId={id}");
    assert_eq!(t.get(&list, &vera).await.status, StatusCode::FORBIDDEN);
    t.grant("user", &emil_id, "folder", &secret, "admin").await;
    assert_eq!(t.get(&list, &emil).await.status, StatusCode::OK);
    // Moving out of the restricted folder needs `folders:permissions` on it: admins only here.
    let open = t.folder("Offen", false).await;
    let current = t.get(&path, &emil).await;
    let body = json!({ "model": current.body["model"], "version": current.body["version"], "folderId": open });
    assert_eq!(t.put(&path, body.clone(), &vera).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.put(&path, body, &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.get(&path, &emil).await.body["folderId"], open.as_str());
}

async fn team_spaces_and_team_ownership(t: TestApp) {
    let source = t.source("shop").await;
    let betrieb = t.team("Betrieb").await;
    let vertrieb = t.team("Vertrieb").await;
    let (anna_id, anna) = t.member("Anna", "editor").await;
    let (bert_id, bert) = t.member("Bert", "editor").await;
    let (vera_id, vera) = t.member("Vera", "viewer").await;
    t.join(&betrieb, &anna_id, "maintainer").await;
    t.join(&betrieb, &vera_id, "member").await;
    t.join(&vertrieb, &bert_id, "maintainer").await;
    let space = id_of(t.post("~/folders", json!({ "name": "Betrieb", "ownerTeamId": betrieb }), &anna).await);

    // Inside the team's space: the team works, everyone else does not see it.
    let id = id_of(t.create("Störungen", &source, Some(&space), &anna).await);
    let path = format!("~/analyses/{id}");
    assert_eq!(t.get(&path, &vera).await.status, StatusCode::OK, "members read with their role");
    assert_eq!(t.save(&id, model("X", &source, SQL), &vera).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.get(&path, &bert).await.status, StatusCode::NOT_FOUND);
    assert!(t.get("~/analyses", &bert).await.titles().is_empty());
    assert_eq!(t.create("Fremd", &source, Some(&space), &bert).await.status, StatusCode::NOT_FOUND);
    // The team context lists the team's space for its members and leaves it out for others.
    assert_eq!(t.get(&format!("~/analyses?team={betrieb}"), &anna).await.titles(), ["Störungen"]);
    let r = t.get(&format!("~/analyses?team={betrieb}"), &bert).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    // Sharing the space with the other team gives it read access.
    t.grant("team", &vertrieb, "folder", &space, "view").await;
    assert_eq!(t.run(&id, &bert).await.status, StatusCode::OK);
    assert_eq!(t.save(&id, model("X", &source, SQL), &bert).await.status, StatusCode::FORBIDDEN);
    // Moving out of the space is for the team's maintainers and org admins.
    let open = t.folder("Allgemein", false).await;
    let current = t.get(&path, &anna).await;
    let body = json!({ "model": current.body["model"], "version": current.body["version"], "folderId": open });
    let (carl_id, carl) = t.member("Carl", "editor").await;
    t.join(&betrieb, &carl_id, "member").await;
    assert_eq!(t.put(&path, body.clone(), &carl).await.status, StatusCode::FORBIDDEN);
    let moved = t.put(&path, body, &anna).await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.body);
    assert_eq!(t.actions(&id).await.iter().filter(|a| *a == "team_space.moved_out").count(), 1);

    // Content of the organization goes to a team through whoever manages the folder's
    // permissions, not through the team itself.
    let to_team = json!({ "ownerTeamId": betrieb, "visibility": "shared" });
    let r = t.put(&format!("{path}/owner"), to_team.clone(), &anna).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    // Team ownership in a shared folder: everyone reads, only the team edits.
    let owned = t.put(&format!("{path}/owner"), to_team, &t.owner).await;
    assert_eq!(owned.status, StatusCode::OK, "{}", owned.body);
    assert_eq!(owned.body["ownerTeam"]["name"], "Betrieb");
    let (_, eva) = t.member("Eva", "editor").await;
    let seen = t.get(&path, &eva).await;
    assert_eq!(seen.status, StatusCode::OK);
    assert_eq!(seen.body["access"]["write"], false);
    assert_eq!(t.save(&id, model("Fremd geändert", &source, SQL), &eva).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.delete(&path, &eva).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.save(&id, model("Störungen 2", &source, SQL), &anna).await.status, StatusCode::OK);
    // Another team cannot take it over.
    let r = t.put(&format!("{path}/owner"), json!({ "ownerTeamId": vertrieb, "visibility": "shared" }), &bert).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    // Team only: outsiders lose sight of it, also in lists; the audit names the change.
    let r = t.put(&format!("{path}/owner"), json!({ "ownerTeamId": betrieb, "visibility": "team" }), &anna).await;
    assert_eq!((r.status, r.body["teamOnly"].clone()), (StatusCode::OK, json!(true)));
    assert_eq!(t.get(&path, &eva).await.status, StatusCode::NOT_FOUND);
    assert!(t.get("~/analyses", &eva).await.titles().is_empty());
    assert_eq!(t.get(&path, &vera).await.status, StatusCode::OK);
    assert!(t.actions(&id).await.contains(&"analysis.owner_changed".to_string()));

    // A team that owns analyses is deleted only with a handover.
    let r = t.delete(&format!("~/teams/{betrieb}"), &t.owner).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.body);
    let r = t.delete(&format!("~/teams/{betrieb}?transferTo={vertrieb}"), &t.owner).await;
    assert!(r.status.is_success(), "{}", r.body);
    let (team,): (Option<String>,) = sqlx::query_as("SELECT owner_team_id FROM analyses WHERE id = $1")
        .bind(&id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(team.as_deref(), Some(vertrieb.as_str()));
}

async fn saving_rechecks_the_query_right(t: TestApp) {
    let shop = t.source("shop").await;
    let lager = t.source("lager").await;
    let folder = t.folder("Vertrieb", false).await;
    let id = id_of(t.create("Umsatz", &shop, Some(&folder), &t.owner).await);
    // A viewer with an edit grant on the folder writes analyses there but may not query.
    let (vera_id, vera) = t.member("Vera", "viewer").await;
    t.grant("user", &vera_id, "folder", &folder, "edit").await;

    // New queries need `datasources:query` on their source, also on create.
    let r = t.create("Eigen", &shop, Some(&folder), &vera).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    assert!(r.body["error"]["message"].as_str().unwrap().contains(&shop));
    let changed = model("Umsatz", &shop, "SELECT * FROM orders");
    assert_eq!(t.save(&id, changed, &vera).await.status, StatusCode::FORBIDDEN);
    let other_source = model("Umsatz", &lager, SQL);
    assert_eq!(t.save(&id, other_source, &vera).await.status, StatusCode::FORBIDDEN);
    // What leaves the queries alone saves: title, steps, visualization.
    let mut same_queries = model("Umsatz je Land", &shop, SQL);
    same_queries["visualization"] = json!({ "type": "bar" });
    same_queries["steps"] = json!([]);
    assert_eq!(t.save(&id, same_queries, &vera).await.status, StatusCode::OK);
    // A query grant on the source is enough for that source only.
    t.grant("user", &vera_id, "datasource", &shop, "query").await;
    assert_eq!(t.save(&id, model("Umsatz", &shop, "SELECT * FROM orders"), &vera).await.status, StatusCode::OK);
    assert_eq!(t.save(&id, model("Umsatz", &lager, SQL), &vera).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.create("Eigen", &shop, Some(&folder), &vera).await.status, StatusCode::CREATED);
    // Nothing was written by the refused saves.
    let stored = t.get(&format!("~/analyses/{id}"), &t.owner).await;
    assert_eq!(stored.body["model"]["targets"][0]["datasourceId"], shop.as_str());
}

async fn readers_run_the_stored_queries_only(t: TestApp) {
    let source = t.source("shop").await;
    let id = id_of(t.create("Umsatz", &source, None, &t.owner).await);
    let (_, vera) = t.member("Vera", "viewer").await;
    // The stored query runs for a viewer, who may read the analysis.
    let r = t.run(&id, &vera).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let result = &r.body["results"]["A"];
    let fields = result["result"]["frame"]["fields"].as_array().unwrap_or_else(|| panic!("{result}"));
    assert_eq!(fields[0]["values"], json!(["AT", "DE"]));
    let sums = fields[1]["values"].to_string().replace('"', "");
    assert_eq!(sums, "[10,25]");
    // The same query sent as a free query is not theirs to run.
    let free = json!({
        "queries": [{ "refId": "A", "datasourceId": source, "query": { "sql": SQL } }],
        "timeRange": { "from": T0 - DAY, "to": T0 }
    });
    let r = t.post("~/query", free, &vera).await;
    assert!(r.body["results"]["A"]["error"].is_object(), "{}", r.body);
    // An analysis has no variables to send.
    let body = json!({ "timeRange": { "from": T0 - DAY, "to": T0 }, "variables": { "land": "AT" } });
    let r = t.post(&format!("~/analyses/{id}/query"), body, &vera).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    // Running records nothing in the Explore history.
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM explore_history").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(n, 0);
}

/// Field distributions of an analysis follow its query route: readers ask for the stored
/// queries it runs, nothing else.
async fn distributions_follow_the_stored_query_rule(t: TestApp) {
    let source = t.source("shop").await;
    let mut m = model("Umsatz", &source, SQL);
    m["targets"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "refId": "H", "datasourceId": source, "query": { "sql": SQL }, "hide": true }));
    let id = id_of(t.post("~/analyses", json!({ "model": m }), &t.owner).await);
    let (_, vera) = t.member("Vera", "viewer").await;
    let ask = |ref_id: &str| json!({ "refId": ref_id, "timeRange": { "from": T0 - DAY, "to": T0 }, "path": ["land"] });
    let path = format!("~/analyses/{id}/distribution");
    // The stored query is theirs to ask about; a SQL source counts in the browser and says so.
    let r = t.post(&path, ask("A"), &vera).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    assert_eq!(r.body["error"]["reason"], "distribution.unsupported", "{}", r.body);
    // A hidden query no step reads is not run, and an unknown one does not exist.
    for ref_id in ["H", "Z"] {
        assert_eq!(t.post(&path, ask(ref_id), &vera).await.status, StatusCode::NOT_FOUND, "{ref_id}");
    }
    // No variables, and the same query as a free distribution is not theirs.
    let mut with_variables = ask("A");
    with_variables["variables"] = json!({ "land": "AT" });
    let r = t.post(&path, with_variables, &vera).await;
    assert_eq!((r.status, r.body["error"]["field"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("variables")));
    let free = json!({ "datasourceId": source, "query": { "sql": SQL }, "path": ["land"],
                       "timeRange": { "from": T0 - DAY, "to": T0 } });
    assert_eq!(t.post("~/query/distribution", free, &vera).await.status, StatusCode::NOT_FOUND);
    // A trashed analysis answers nothing.
    assert_eq!(t.delete(&format!("~/analyses/{id}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.post(&path, ask("A"), &vera).await.status, StatusCode::NOT_FOUND);
}

async fn folder_trash_takes_analyses_along(t: TestApp) {
    let source = t.source("shop").await;
    let folder = t.folder("Vertrieb", false).await;
    let id = id_of(t.create("Umsatz", &source, Some(&folder), &t.owner).await);
    let alone = id_of(t.create("Einzeln", &source, Some(&folder), &t.owner).await);
    // Trashed on its own first: the folder's restore leaves it in the trash.
    assert_eq!(t.delete(&format!("~/analyses/{alone}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    // An editor whose role cannot write analyses cannot trash a folder holding them.
    sqlx::query("INSERT INTO roles (id, org_id, name, name_key, description, created_at)          VALUES ('ordner', $1, 'Ordner', 'ordner', '', 0)",)
        .bind(&t.org)
        .execute(&t.state.db)
        .await
        .unwrap();
    for p in ["folders:read", "folders:write", "dashboards:read", "analyses:read"] {
        sqlx::query("INSERT INTO role_permissions (role_id, permission) VALUES ('ordner', $1)")
            .bind(p)
            .execute(&t.state.db)
            .await
            .unwrap();
    }
    let (_, otto) = t.member("Otto", "ordner").await;
    let r = t.delete(&format!("~/folders/{folder}"), &otto).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);

    assert_eq!(t.delete(&format!("~/folders/{folder}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert!(t.get(&format!("~/analyses/{id}"), &t.owner).await.body["deletedAt"].is_number());
    // Restoring the analysis alone waits for its folder.
    let r = t.post(&format!("~/analyses/{id}/restore"), json!(null), &t.owner).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.body);
    let r = t.post(&format!("~/folders/{folder}/restore"), json!(null), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.get("~/analyses", &t.owner).await.titles(), ["Umsatz"]);
    // Purging the folder purges what is in it, with its grants.
    let (vera_id, _) = t.member("Vera", "viewer").await;
    t.grant("user", &vera_id, "analysis", &id, "edit").await;
    assert_eq!(t.delete(&format!("~/folders/{folder}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.delete(&format!("~/folders/{folder}/purge"), &t.owner).await.status, StatusCode::NO_CONTENT);
    let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM analyses").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(left, 0);
    let (grants,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM resource_grants WHERE resource_type = 'analysis'")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(grants, 0);
    let r = t.get("~/audit?action=folder.purged", &t.owner).await;
    assert_eq!(r.body["items"][0]["summary"]["analyses"], 2, "{}", r.body);
}

async fn other_organizations_see_nothing(t: TestApp) {
    let source = t.source("shop").await;
    let id = id_of(t.create("Umsatz", &source, None, &t.owner).await);
    let (stranger_id, stranger) = t.member("Fremd", "viewer").await;
    let body = json!({ "name": "Andere GmbH", "ownerUserId": stranger_id });
    let other = id_of(t.post("/admin/orgs", body, &t.owner).await);
    sqlx::query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(&t.org)
        .bind(&stranger_id)
        .execute(&t.state.db)
        .await
        .unwrap();
    // Their own organization's routes do not reach this analysis.
    let r = t.get(&format!("/orgs/{other}/analyses/{id}"), &stranger).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert!(t.get(&format!("/orgs/{other}/analyses"), &stranger).await.titles().is_empty());
    let r = t
        .post(&format!("/orgs/{other}/analyses/{id}/query"), json!({ "timeRange": { "from": 0, "to": 1 } }), &stranger)
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // An analysis there may not name this organization's data source.
    let r =
        t.post(&format!("/orgs/{other}/analyses"), json!({ "model": model("Klau", &source, SQL) }), &stranger).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    // This organization's routes are not theirs.
    assert_eq!(t.get(&format!("~/analyses/{id}"), &stranger).await.status, StatusCode::NOT_FOUND);
}

/// A dashboard with one panel that links the analysis `id`.
fn linking(title: &str, id: &str) -> Value {
    json!({ "schemaVersion": 2, "title": title, "timeRange": { "from": "now-6h", "to": "now" },
            "panels": [{ "id": "p1", "type": "table", "title": "Umsatz", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                         "analysisId": id }] })
}

async fn the_time_range_is_optional(t: TestApp) {
    let source = t.source("shop").await;
    let mut m = model("Ohne Zeitraum", &source, SQL);
    m["timeRange"] = Value::Null;
    let r = t.post("~/analyses", json!({ "model": m }), &t.owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["model"]["timeRange"], Value::Null);
    let id = r.body["id"].as_str().unwrap().to_string();
    let mut m = model("Ohne Zeitraum", &source, SQL);
    m.as_object_mut().unwrap().remove("timeRange");
    let r = t.post("~/analyses", json!({ "model": m }), &t.owner).await;
    assert_eq!((r.status, r.body["model"]["timeRange"].clone()), (StatusCode::CREATED, Value::Null));
    // It runs with the range the run names.
    assert_eq!(t.run(&id, &t.owner).await.status, StatusCode::OK);
}

async fn every_save_is_kept_in_the_history(t: TestApp) {
    let source = t.source("shop").await;
    let id = id_of(t.create("Erste", &source, None, &t.owner).await);
    let (_, eva) = t.member("Eva", "editor").await;
    let path = format!("~/analyses/{id}");
    let body = |title: &str, version: i64| json!({ "model": model(title, &source, SQL), "version": version });
    assert_eq!(t.put(&path, body("Von Eva", 1), &eva).await.status, StatusCode::OK);
    // The owner started from version 1: a conflict answers what Eva saved, and overwriting it
    // needs only edit rights; Eva's version stays in the history.
    let late = t.put(&path, body("Vom Eigentümer", 1), &t.owner).await;
    assert_eq!(late.code(), "version_conflict");
    let current = late.body["current"]["version"].as_i64().unwrap();
    let (_, emil) = t.member("Emil", "editor").await;
    let r = t.put(&path, body("Von Emil", current), &emil).await;
    assert_eq!((r.status, r.body["version"].clone()), (StatusCode::OK, json!(3)));

    let history = t.get(&format!("{path}/versions"), &t.owner).await;
    assert_eq!(history.status, StatusCode::OK, "{}", history.body);
    let versions: Vec<i64> =
        history.body["items"].as_array().unwrap().iter().map(|v| v["version"].as_i64().unwrap()).collect();
    assert_eq!(versions, [3, 2, 1]);
    assert_eq!(history.body["items"][1]["authorName"], "Eva");
    let two = t.get(&format!("{path}/versions/2"), &t.owner).await;
    assert_eq!(two.body["model"]["title"], "Von Eva");
    assert_eq!(t.get(&format!("{path}/versions/02"), &t.owner).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.get(&format!("{path}/versions/9"), &t.owner).await.status, StatusCode::NOT_FOUND);
    // Viewers read the history; bringing a version back is a save.
    let (_, vera) = t.member("Vera", "viewer").await;
    assert_eq!(t.get(&format!("{path}/versions"), &vera).await.status, StatusCode::OK);
    let r = t.post(&format!("{path}/versions/2/restore"), json!(null), &vera).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = t.post(&format!("{path}/versions/2/restore?expectedVersion=2"), json!(null), &t.owner).await;
    assert_eq!(r.code(), "version_conflict");
    let r = t.post(&format!("{path}/versions/2/restore?expectedVersion=3"), json!(null), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!((r.body["version"].clone(), r.body["title"].clone()), (json!(4), json!("Von Eva")));
    let r = t.get(&format!("~/audit?action=analysis.updated&resourceId={id}"), &t.owner).await;
    assert_eq!(r.body["items"][0]["summary"], json!({ "version": 4, "restoredFrom": 2 }));
}

async fn dashboards_link_analyses(t: TestApp) {
    let source = t.source("shop").await;
    let id = id_of(t.create("Umsatz", &source, None, &t.owner).await);
    let d = id_of(t.post("~/dashboards", json!({ "model": linking("Wochenrunde", &id) }), &t.owner).await);
    // The dashboard carries the analysis it links.
    let one = t.get(&format!("~/dashboards/{d}"), &t.owner).await;
    assert_eq!(one.body["analyses"][&id]["title"], "Umsatz", "{}", one.body);
    assert_eq!(one.body["analyses"][&id]["model"]["targets"][0]["query"]["sql"], SQL);
    // A viewer runs the linked panel under the dashboard's stored-query rule.
    let (_, vera) = t.member("Vera", "viewer").await;
    let body = json!({ "timeRange": { "from": T0 - DAY, "to": T0 } });
    let r = t.post(&format!("~/dashboards/{d}/panels/p1/query"), body.clone(), &vera).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["results"]["A"]["result"]["frame"]["fields"][0]["values"], json!(["AT", "DE"]));
    // A change of the analysis shows in the dashboard at once.
    let mut changed = model("Umsatz", &source, "SELECT country FROM orders WHERE country = 'AT'");
    changed["steps"] = json!([]);
    assert_eq!(t.save(&id, changed, &t.owner).await.status, StatusCode::OK);
    let r = t.post(&format!("~/dashboards/{d}/panels/p1/query"), body, &vera).await;
    assert_eq!(r.body["results"]["A"]["result"]["frame"]["fields"][0]["values"], json!(["AT"]), "{}", r.body);

    // The analysis knows where it is used.
    let uses = t.get(&format!("~/analyses/{id}/uses"), &t.owner).await;
    assert_eq!(uses.body["items"][0]["title"], "Wochenrunde", "{}", uses.body);
    assert_eq!(t.get(&format!("~/analyses/{id}"), &t.owner).await.body["uses"], 1);
    // It stays out of the trash while linked, also while the dashboard is in the trash.
    let r = t.delete(&format!("~/analyses/{id}"), &t.owner).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.body);
    assert_eq!(r.body["error"]["reason"], "analysis.in_use", "{}", r.body);
    assert_eq!(r.body["error"]["params"]["dashboards"], "1");
    assert_eq!(t.delete(&format!("~/dashboards/{d}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.delete(&format!("~/analyses/{id}"), &t.owner).await.status, StatusCode::CONFLICT);
    // Purging the dashboard ends the link.
    assert_eq!(t.delete(&format!("~/dashboards/{d}/purge"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.delete(&format!("~/analyses/{id}"), &t.owner).await.status, StatusCode::NO_CONTENT);

    // A trashed analysis, one that does not exist and one the caller cannot read are not linked.
    let r = t.post("~/dashboards", json!({ "model": linking("Neu", &id) }), &t.owner).await;
    assert_eq!((r.status, r.body["error"]["field"].clone()), (StatusCode::UNPROCESSABLE_ENTITY, json!("model")));
    let missing = uuid::Uuid::now_v7().to_string();
    let r = t.post("~/dashboards", json!({ "model": linking("Neu", &missing) }), &t.owner).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let secret = t.folder("Vorstand", true).await;
    let hidden = id_of(t.create("Margen", &source, Some(&secret), &t.owner).await);
    let (_, emil) = t.member("Emil", "editor").await;
    let r = t.post("~/dashboards", json!({ "model": linking("Neu", &hidden) }), &emil).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    // Linking needs query rights on the analysis's sources, as the dashboard's own queries do.
    sqlx::query(
        "INSERT INTO roles (id, org_id, name, name_key, description, created_at) \
         VALUES ('ohne-abfrage', $1, 'Ohne Abfrage', 'ohne abfrage', '', 0)",
    )
    .bind(&t.org)
    .execute(&t.state.db)
    .await
    .unwrap();
    for p in ["dashboards:read", "dashboards:write", "analyses:read"] {
        sqlx::query("INSERT INTO role_permissions (role_id, permission) VALUES ('ohne-abfrage', $1)")
            .bind(p)
            .execute(&t.state.db)
            .await
            .unwrap();
    }
    let (_, otto) = t.member("Otto", "ohne-abfrage").await;
    let open = id_of(t.create("Offen", &source, None, &t.owner).await);
    let r = t.post("~/dashboards", json!({ "model": linking("Von Otto", &open) }), &otto).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    // A slot holds the place only.
    let mut slot = linking("Doppelt", &open);
    slot["panels"][0]["targets"] = json!([{ "refId": "A", "datasourceId": source, "query": {} }]);
    let r = t.post("~/dashboards", json!({ "model": slot }), &t.owner).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
}

async fn links_keep_analyses_in_place(t: TestApp) {
    let source = t.source("shop").await;
    let folder = t.folder("Vertrieb", false).await;
    let id = id_of(t.create("Umsatz", &source, Some(&folder), &t.owner).await);
    let d = id_of(t.post("~/dashboards", json!({ "model": linking("Wochenrunde", &id) }), &t.owner).await);
    // The folder cannot go to the trash while a dashboard outside links into it.
    let r = t.delete(&format!("~/folders/{folder}"), &t.owner).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.body);
    assert_eq!(r.body["error"]["reason"], "analysis.in_use");
    // Team only is refused while linked.
    let team = t.team("Betrieb").await;
    let owner = |visibility: &str| json!({ "ownerTeamId": team, "visibility": visibility });
    let r = t.put(&format!("~/analyses/{id}/owner"), owner("team"), &t.owner).await;
    assert_eq!(r.body["error"]["reason"], "analysis.in_use", "{}", r.body);
    let r = t.put(&format!("~/analyses/{id}/owner"), owner("shared"), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // Into a team space only while no dashboard outside it links the analysis.
    let space = id_of(t.post("~/folders", json!({ "name": "Betrieb", "ownerTeamId": team }), &t.owner).await);
    let current = t.get(&format!("~/analyses/{id}"), &t.owner).await;
    let body = json!({ "model": current.body["model"], "version": current.body["version"], "folderId": space });
    let r = t.put(&format!("~/analyses/{id}"), body.clone(), &t.owner).await;
    assert_eq!(r.body["error"]["reason"], "analysis.in_use", "{}", r.body);
    // Without the link everything goes.
    let unlinked =
        json!({ "schemaVersion": 2, "title": "Wochenrunde", "timeRange": { "from": "now-6h", "to": "now" } });
    let r = t.put(&format!("~/dashboards/{d}"), json!({ "model": unlinked, "version": 1 }), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.put(&format!("~/analyses/{id}"), body, &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.delete(&format!("~/folders/{folder}"), &t.owner).await.status, StatusCode::NO_CONTENT);
}

async fn lists_filter_sort_and_tell_what_the_caller_may_do(t: TestApp) {
    let shop = t.source("shop").await;
    let lager = t.source("lager").await;
    let team = t.team("Betrieb").await;
    let (emil_id, emil) = t.member("Emil", "editor").await;
    t.create("Anfang", &shop, None, &t.owner).await;
    t.clock.advance_ms(1000);
    let lager_id = id_of(t.create("Bestand", &lager, None, &emil).await);
    t.clock.advance_ms(1000);
    let owned = id_of(t.create("Charge", &shop, None, &t.owner).await);
    let body = json!({ "ownerTeamId": team, "visibility": "shared" });
    let r = t.put(&format!("~/analyses/{owned}/owner"), body, &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    assert_eq!(t.get(&format!("~/analyses?datasourceId={lager}"), &t.owner).await.titles(), ["Bestand"]);
    assert_eq!(t.get(&format!("~/analyses?createdBy={emil_id}"), &t.owner).await.titles(), ["Bestand"]);
    assert_eq!(t.get(&format!("~/analyses?ownerTeamId={team}"), &t.owner).await.titles(), ["Charge"]);
    assert_eq!(t.get("~/analyses?sort=updated", &t.owner).await.titles(), ["Charge", "Bestand", "Anfang"]);
    // Pages of the newest-first order keep it.
    let first = t.get("~/analyses?sort=updated&limit=2", &t.owner).await;
    assert_eq!(first.titles(), ["Charge", "Bestand"]);
    let cursor = first.body["nextCursor"].as_str().unwrap().to_string();
    let next = t.get(&format!("~/analyses?sort=updated&limit=2&cursor={cursor}"), &t.owner).await;
    assert_eq!(next.titles(), ["Anfang"]);
    assert_eq!(t.get("~/analyses?sort=random", &t.owner).await.status, StatusCode::UNPROCESSABLE_ENTITY);

    // Per row: its sources, and whether the caller may query them; viewers run it anyway.
    let row = |r: &Reply, title: &str| {
        r.body["items"].as_array().unwrap().iter().find(|i| i["title"] == title).cloned().unwrap()
    };
    let as_editor = t.get("~/analyses", &emil).await;
    assert_eq!(row(&as_editor, "Bestand")["datasourceIds"], json!([lager]));
    assert_eq!(row(&as_editor, "Bestand")["mayQuery"], true);
    let (vera_id, vera) = t.member("Vera", "viewer").await;
    let as_viewer = t.get("~/analyses", &vera).await;
    assert_eq!(row(&as_viewer, "Bestand")["mayQuery"], false);
    assert_eq!(t.run(&lager_id, &vera).await.status, StatusCode::OK);
    t.grant("user", &vera_id, "datasource", &lager, "query").await;
    let as_viewer = t.get("~/analyses", &vera).await;
    assert_eq!(row(&as_viewer, "Bestand")["mayQuery"], true);
    assert_eq!(row(&as_viewer, "Anfang")["mayQuery"], false);
    assert_eq!(row(&as_viewer, "Anfang")["uses"], 0);
}

/// A folder's version as the tree answers it.
async fn answers_name_who_created_and_saved(t: TestApp) {
    let source = t.source("shop").await;
    let (eva_id, eva) = t.member("Eva", "editor").await;
    let id = id_of(t.create("Von Eva", &source, None, &eva).await);
    let r = t
        .put(&format!("~/analyses/{id}"), json!({ "model": model("Von Eva", &source, SQL), "version": 1 }), &t.owner)
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(
        (r.body["createdByName"].clone(), r.body["updatedByName"].clone()),
        (json!("Eva"), json!("Jörg Müller"))
    );
    let names = |reply: &Reply| {
        let item = reply.body["items"].as_array().unwrap().iter().find(|i| i["id"] == json!(id)).unwrap().clone();
        (item["createdBy"].clone(), item["createdByName"].clone(), item["updatedByName"].clone())
    };
    let list = t.get("~/analyses", &t.owner).await;
    assert_eq!(names(&list), (json!(eva_id), json!("Eva"), json!("Jörg Müller")));

    // A removed account leaves its id and no name.
    sqlx::query("DELETE FROM users WHERE id = $1").bind(&eva_id).execute(&t.state.db).await.unwrap();
    let list = t.get("~/analyses", &t.owner).await;
    assert_eq!(names(&list), (json!(eva_id), Value::Null, json!("Jörg Müller")));
    let one = t.get(&format!("~/analyses/{id}"), &t.owner).await;
    assert_eq!(one.body["createdByName"], Value::Null);
}

async fn folder_version(t: &TestApp, id: &str) -> Value {
    let tree = t.get("~/folders", &t.owner).await;
    fn find(nodes: &[Value], id: &str) -> Option<Value> {
        nodes.iter().find_map(|n| if n["id"] == id { Some(n.clone()) } else { find(n["children"].as_array()?, id) })
    }
    find(tree.body["items"].as_array().unwrap(), id).unwrap()["version"].clone()
}

async fn folder_changes_keep_linked_analyses_visible(t: TestApp) {
    let source = t.source("shop").await;
    let folder = t.folder("Vertrieb", false).await;
    let id = id_of(t.create("Umsatz", &source, Some(&folder), &t.owner).await);
    let outside = id_of(t.post("~/dashboards", json!({ "model": linking("Außen", &id) }), &t.owner).await);
    let in_use = |r: &Reply| {
        assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.body);
        assert_eq!(r.body["error"]["reason"], "analysis.in_use", "{}", r.body);
    };
    let path = t.path(&format!("~/folders/{folder}"));
    let patch = |body: Value| t.send(Method::PATCH, &path, Some(body), Some(&t.owner));
    // Restricting the folder would hide the analysis from the readers of the dashboard outside.
    let v = folder_version(&t, &folder).await;
    in_use(&patch(json!({ "restricted": true, "version": v })).await);
    // So would making it team only, or moving it into a team space or under a restricted folder.
    let team = t.team("Betrieb").await;
    let r = t
        .put(&format!("~/folders/{folder}/owner"), json!({ "ownerTeamId": team, "visibility": "team" }), &t.owner)
        .await;
    in_use(&r);
    let space = id_of(t.post("~/folders", json!({ "name": "Betrieb", "ownerTeamId": team }), &t.owner).await);
    in_use(&patch(json!({ "parentId": space, "version": v })).await);
    let secret = t.folder("Vorstand", true).await;
    in_use(&patch(json!({ "parentId": secret, "version": v })).await);
    // Moving under an open folder, or renaming, changes nobody's view.
    let open = t.folder("Offen", false).await;
    let r = patch(json!({ "parentId": open, "name": "Vertrieb neu", "version": v })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // A linking dashboard inside the folder goes along, so the folder may be restricted.
    let unlinked = json!({ "schemaVersion": 2, "title": "Außen", "timeRange": { "from": "now-6h", "to": "now" } });
    let r = t.put(&format!("~/dashboards/{outside}"), json!({ "model": unlinked, "version": 1 }), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.post("~/dashboards", json!({ "folderId": folder, "model": linking("Innen", &id) }), &t.owner).await;
    let v = folder_version(&t, &folder).await;
    let r = patch(json!({ "restricted": true, "version": v })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
}

async fn links_respect_the_analysis_audience(t: TestApp) {
    let source = t.source("shop").await;
    let secret = t.folder("Vorstand", true).await;
    let inner = id_of(t.create("Margen", &source, Some(&secret), &t.owner).await);
    let forbidden = |r: Reply| assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    // An analysis in a restricted folder is linked only by dashboards that folder governs; org
    // admins are held to it as well.
    forbidden(t.post("~/dashboards", json!({ "model": linking("Offen", &inner) }), &t.owner).await);
    let d = id_of(
        t.post("~/dashboards", json!({ "folderId": secret, "model": linking("Intern", &inner) }), &t.owner).await,
    );
    // Moving that dashboard out of the folder would show the analysis to its new readers.
    let r = t
        .put(
            &format!("~/dashboards/{d}"),
            json!({ "model": linking("Intern", &inner), "version": 1, "folderId": null }),
            &t.owner,
        )
        .await;
    forbidden(r);
    // A team-only analysis is never linked.
    let team = t.team("Betrieb").await;
    let only = id_of(t.create("Nur Team", &source, None, &t.owner).await);
    let r = t
        .put(&format!("~/analyses/{only}/owner"), json!({ "ownerTeamId": team, "visibility": "team" }), &t.owner)
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    forbidden(t.post("~/dashboards", json!({ "model": linking("Team", &only) }), &t.owner).await);
    // A linked open analysis does not move into a restricted folder the dashboard is outside of.
    let open = id_of(t.create("Offen", &source, None, &t.owner).await);
    t.post("~/dashboards", json!({ "model": linking("Überall", &open) }), &t.owner).await;
    let current = t.get(&format!("~/analyses/{open}"), &t.owner).await;
    let body = json!({ "model": current.body["model"], "version": current.body["version"], "folderId": secret });
    let r = t.put(&format!("~/analyses/{open}"), body, &t.owner).await;
    assert_eq!(
        (r.status, r.body["error"]["reason"].clone()),
        (StatusCode::CONFLICT, json!("analysis.in_use")),
        "{}",
        r.body
    );
}

async fn purging_needs_the_admin_level_and_no_link(t: TestApp) {
    let source = t.source("shop").await;
    // A viewer with an edit grant may trash, not purge.
    let id = id_of(t.create("Umsatz", &source, None, &t.owner).await);
    let (vera_id, vera) = t.member("Vera", "viewer").await;
    t.grant("user", &vera_id, "analysis", &id, "edit").await;
    assert_eq!(t.delete(&format!("~/analyses/{id}"), &vera).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.delete(&format!("~/analyses/{id}/purge"), &vera).await.status, StatusCode::FORBIDDEN);
    t.grant("user", &vera_id, "analysis", &id, "admin").await;
    assert_eq!(t.delete(&format!("~/analyses/{id}/purge"), &vera).await.status, StatusCode::NO_CONTENT);

    // A folder's trash takes an analysis and the dashboard linking it along; the analysis alone
    // is not purged while the dashboard may come back.
    let folder = t.folder("Vertrieb", false).await;
    let linked = id_of(t.create("Verknüpft", &source, Some(&folder), &t.owner).await);
    t.post("~/dashboards", json!({ "folderId": folder, "model": linking("Innen", &linked) }), &t.owner).await;
    assert_eq!(t.delete(&format!("~/folders/{folder}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    let r = t.delete(&format!("~/analyses/{linked}/purge"), &t.owner).await;
    assert_eq!(
        (r.status, r.body["error"]["reason"].clone()),
        (StatusCode::CONFLICT, json!("analysis.in_use")),
        "{}",
        r.body
    );
    // Purging the folder takes both.
    assert_eq!(t.delete(&format!("~/folders/{folder}/purge"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&format!("~/analyses/{linked}"), &t.owner).await.status, StatusCode::NOT_FOUND);
    let (uses,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM analysis_uses").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(uses, 0);
}

async fn linked_queries_change_only_with_the_query_right(t: TestApp) {
    let source = t.source("shop").await;
    let id = id_of(t.create("Umsatz", &source, None, &t.owner).await);
    let d = id_of(t.post("~/dashboards", json!({ "model": linking("Wochenrunde", &id) }), &t.owner).await);
    let (vera_id, vera) = t.member("Vera", "viewer").await;
    t.grant("user", &vera_id, "analysis", &id, "edit").await;
    // Vera may write the analysis but not query its source: a new query is refused.
    let r = t.save(&id, model("Umsatz", &source, "SELECT country FROM orders"), &vera).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    // The dashboard's readers keep what the authorized query answers.
    let body = json!({ "timeRange": { "from": T0 - DAY, "to": T0 } });
    let r = t.post(&format!("~/dashboards/{d}/panels/p1/query"), body, &vera).await;
    let fields = &r.body["results"]["A"]["result"]["frame"]["fields"];
    assert_eq!(fields[0]["values"], json!(["AT", "DE"]), "{}", r.body);
    assert_eq!(fields.as_array().unwrap().len(), 2);
}

async fn linked_panels_export(t: TestApp) {
    let source = t.source("shop").await;
    let mut m = model("Umsatz", &source, SQL);
    m["steps"] = json!([]);
    let id = id_of(t.post("~/analyses", json!({ "model": m }), &t.owner).await);
    let d = id_of(t.post("~/dashboards", json!({ "model": linking("Wochenrunde", &id) }), &t.owner).await);
    let body = json!({ "timeRange": { "from": T0 - DAY, "to": T0 }, "format": "csv", "language": "en" });
    let r = t.post(&format!("~/dashboards/{d}/panels/p1/export"), body, &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.text.contains("AT") && r.text.contains("DE"), "{}", r.text);
}

async fn trash_and_link_race(t: TestApp) {
    let source = t.source("shop").await;
    for round in 0..4 {
        let id = id_of(t.create(&format!("Rennen {round}"), &source, None, &t.owner).await);
        let path = format!("~/analyses/{id}");
        let trash = t.delete(&path, &t.owner);
        let link = t.post("~/dashboards", json!({ "model": linking("Rennen", &id) }), &t.owner);
        let (trashed, linked) = tokio::join!(trash, link);
        let trashed = trashed.status == StatusCode::NO_CONTENT;
        let linked = linked.status == StatusCode::CREATED;
        // Never both: a link to a trashed analysis, or a trash under a link.
        assert!(!(trashed && linked), "round {round}: both went through");
        let stored = t.get(&format!("~/analyses/{id}"), &t.owner).await;
        let (uses,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM analysis_uses WHERE analysis_id = $1")
            .bind(&id)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
        assert!(!(stored.body["deletedAt"].is_number() && uses > 0), "round {round}: a trashed analysis is linked");
    }
}

async fn purge_and_restore_race(t: TestApp) {
    let source = t.source("shop").await;
    for round in 0..4 {
        let id = id_of(t.create(&format!("Rennen {round}"), &source, None, &t.owner).await);
        assert_eq!(t.delete(&format!("~/analyses/{id}"), &t.owner).await.status, StatusCode::NO_CONTENT);
        let (purge_path, restore_path) = (format!("~/analyses/{id}/purge"), format!("~/analyses/{id}/restore"));
        let purge = t.delete(&purge_path, &t.owner);
        let restore = t.post(&restore_path, json!(null), &t.owner);
        let (purged, restored) = tokio::join!(purge, restore);
        let purged = purged.status == StatusCode::NO_CONTENT;
        let restored = restored.status == StatusCode::OK;
        assert!(!(purged && restored), "round {round}: both went through");
        let stored = t.get(&format!("~/analyses/{id}"), &t.owner).await;
        if purged {
            assert_eq!(stored.status, StatusCode::NOT_FOUND);
        } else {
            assert_eq!(stored.status, StatusCode::OK);
        }
        if restored {
            assert_eq!(stored.body["deletedAt"], Value::Null);
        }
    }
}
