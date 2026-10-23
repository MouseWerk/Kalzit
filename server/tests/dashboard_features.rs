//! Annotations, playlists, library panels and the parts of dashboard model version 2 through the
//! real router and database (docs/api/dashboard-features.md).

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

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    _dir: tempfile::TempDir,
    /// A directory server admins allowed for SQLite sources, for queries that really run.
    sources: tempfile::TempDir,
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

    fn message(&self) -> &str {
        self.body["error"]["message"].as_str().unwrap_or("")
    }

    fn id(&self) -> String {
        assert!(self.status.is_success(), "{}: {}", self.status, self.body);
        self.body["id"].as_str().unwrap().to_string()
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

    async fn patch(&self, path: &str, body: Value, cookie: &str) -> Reply {
        self.send(Method::PATCH, &self.path(path), Some(body), Some(cookie)).await
    }

    async fn delete(&self, path: &str, cookie: &str) -> Reply {
        self.send(Method::DELETE, &self.path(path), None, Some(cookie)).await
    }

    async fn session_for(&self, user_id: &str) -> String {
        let cfg = &self.state.config.sessions;
        let token = kalzit::auth::session::create(&self.state.db, cfg, self.clock.now_ms(), user_id).await.unwrap();
        format!("kalzit_session={token}")
    }

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

    async fn grant(&self, user: &str, resource_type: &str, resource_id: &str, level: &str) {
        let (user_id,): (String,) =
            sqlx::query_as("SELECT id FROM users WHERE name = $1").bind(user).fetch_one(&self.state.db).await.unwrap();
        let body = json!({ "subjectType": "user", "subjectId": user_id, "resourceType": resource_type,
                           "resourceId": resource_id, "level": level });
        let r = self.post("~/grants", body, &self.owner).await;
        assert!(matches!(r.status, StatusCode::CREATED | StatusCode::OK), "{}", r.body);
    }

    async fn count(&self, sql: &str, id: &str) -> i64 {
        let (n,): (i64,) =
            sqlx::query_as(sqlx::AssertSqlSafe(sql.to_string())).bind(id).fetch_one(&self.state.db).await.unwrap();
        n
    }

    async fn dashboard(&self, folder: Option<&str>, model: Value, cookie: &str) -> String {
        self.post("~/dashboards", json!({ "folderId": folder, "model": model }), cookie).await.id()
    }

    /// A SQLite source whose file holds `releases (ts DATETIME, text TEXT)` with one row, in a
    /// directory the server admin allowed: its queries really run.
    async fn working_source(&self) -> String {
        let dir = self.sources.path();
        let allowed = self
            .send(
                Method::PATCH,
                "/api/admin/settings/datasources.sqlite_dirs",
                Some(json!({ "value": [dir.to_string_lossy()], "version": 0 })),
                Some(&self.owner),
            )
            .await;
        assert_eq!(allowed.status, StatusCode::OK, "{}", allowed.body);
        let path = dir.join("releases.db");
        let pool = sqlx::SqlitePool::connect(&kalzit::config::sqlite_url(&path)).await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE releases (ts DATETIME, text TEXT); \
             INSERT INTO releases VALUES (1799990000000, 'Release 2.4');",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        let body = json!({ "name": "Releases", "kind": "sqlite", "settings": { "path": path.to_string_lossy() } });
        self.post("~/datasources", body, &self.owner).await.id()
    }

    async fn folder(&self, name: &str, restricted: bool) -> String {
        self.post("~/folders", json!({ "name": name, "restricted": restricted }), &self.owner).await.id()
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
                $flow(test_app(Some(url)).await).await;
                sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE"))).execute(&admin).await.unwrap();
            )*
        }
    };
}

on_both_databases! {
    version_1_models_read_as_the_current_version,
    tags_find_dashboards_and_the_validate_route_checks_models,
    annotations_follow_the_dashboard_access,
    annotations_stay_hidden_in_restricted_folders,
    annotation_queries_run_as_stored_queries,
    playlists_show_only_readable_dashboards,
    library_panels_follow_their_folder,
    library_panels_are_shared_by_dashboards,
    library_panels_in_restricted_folders,
    library_panels_check_panel_options,
}

fn model(title: &str) -> Value {
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "title": title,
        "timeRange": { "from": "now-6h", "to": "now" },
        "panels": [
            { "id": "p1", "type": "timeseries", "title": "Bestellungen", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
              "targets": [ { "refId": "A", "datasourceId": "ds-1", "query": { "sql": "SELECT 1" } } ] }
        ]
    })
}

fn plain(title: &str) -> Value {
    json!({ "schemaVersion": SCHEMA_VERSION, "title": title, "timeRange": { "from": "now-6h", "to": "now" } })
}

fn library_model(title: &str) -> Value {
    json!({ "schemaVersion": SCHEMA_VERSION, "type": "timeseries", "title": title,
            "targets": [ { "refId": "A", "datasourceId": "ds-1", "query": { "sql": "SELECT 2" } } ] })
}

/// A model showing one library panel.
fn showing(title: &str, library: &str) -> Value {
    json!({
        "schemaVersion": SCHEMA_VERSION, "title": title, "timeRange": { "from": "now-6h", "to": "now" },
        "panels": [ { "id": "lp", "type": "timeseries", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                      "libraryPanelId": library } ]
    })
}

fn range() -> Value {
    json!({ "from": T0 - 6 * HOUR, "to": T0 })
}

async fn version_1_models_read_as_the_current_version(t: TestApp) {
    let id = t.dashboard(None, plain("Alt"), &t.owner).await;
    // A version stored before version 2 existed.
    let old = json!({ "schemaVersion": 1, "title": "Alt", "timeRange": { "from": "now-6h", "to": "now" },
                      "variables": [], "panels": [] });
    sqlx::query("UPDATE dashboard_versions SET model = $1 WHERE dashboard_id = $2")
        .bind(old.to_string())
        .bind(&id)
        .execute(&t.state.db)
        .await
        .unwrap();
    let got = t.get(&format!("~/dashboards/{id}"), &t.owner).await;
    assert_eq!(got.body["model"]["schemaVersion"], json!(SCHEMA_VERSION), "{}", got.body);
    // Saved as version 1 by an older client, it is stored as the current version.
    let saved = t
        .put(
            &format!("~/dashboards/{id}"),
            json!({ "model": { "schemaVersion": 1, "title": "Neu",
            "timeRange": { "from": "now-1h", "to": "now" } }, "version": 1 }),
            &t.owner,
        )
        .await;
    assert_eq!(saved.body["model"]["schemaVersion"], json!(SCHEMA_VERSION), "{}", saved.body);
    assert_eq!(saved.body["model"]["rows"], json!([]));

    // Version 2 parts survive a save and a read.
    let mut full = model("Voll");
    full["variables"] = json!([{ "name": "land", "type": "custom", "options": ["at", "de"], "multi": true }]);
    full["rows"] = json!([{ "id": "r1", "title": "Je Land", "collapsed": true, "repeat": { "variable": "land" } }]);
    full["panels"][0]["rowId"] = json!("r1");
    full["panels"][0]["timeFrom"] = json!("now-24h");
    full["panels"][0]["timeShift"] = json!("1d");
    full["panels"][0]["links"] = json!([{ "title": "Details", "url": "https://x.example/${land}", "newTab": true }]);
    let created = t.post("~/dashboards", json!({ "model": full }), &t.owner).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let read = t.get(&format!("~/dashboards/{}", created.id()), &t.owner).await;
    assert_eq!(read.body["model"]["rows"][0]["collapsed"], true);
    assert_eq!(read.body["model"]["panels"][0]["timeShift"], "1d");
    assert_eq!(read.body["model"]["variables"][0]["multi"], true);
}

async fn tags_find_dashboards_and_the_validate_route_checks_models(t: TestApp) {
    let mut tagged = plain("Umsatz");
    tagged["tags"] = json!(["Vertrieb", "Österreich"]);
    let a = t.dashboard(None, tagged, &t.owner).await;
    t.dashboard(None, plain("Anderes"), &t.owner).await;
    let found = t.get("~/dashboards?tag=vertrieb", &t.owner).await;
    let ids: Vec<&str> = found.body["items"].as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [a.as_str()]);
    assert_eq!(found.body["items"][0]["tags"], json!(["Vertrieb", "Österreich"]));
    assert_eq!(t.get("~/dashboards?tag=%C3%96STERREICH", &t.owner).await.body["items"].as_array().unwrap().len(), 1);
    // A new version without the tag drops it from the search.
    t.put(&format!("~/dashboards/{a}"), json!({ "model": plain("Umsatz"), "version": 1 }), &t.owner).await.id();
    assert!(t.get("~/dashboards?tag=vertrieb", &t.owner).await.body["items"].as_array().unwrap().is_empty());

    let viewer = t.member("Vera", "viewer").await;
    let ok = t.post("~/dashboards/validate", json!({ "model": plain("Prüfen") }), &viewer).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    assert_eq!(ok.body["model"]["schemaVersion"], json!(SCHEMA_VERSION));
    assert_eq!(ok.body["model"]["panels"], json!([]), "defaults are filled in");
    let mut bad = plain("Böse");
    bad["links"] = json!([{ "type": "url", "title": "x", "url": "javascript:alert(1)" }]);
    let refused = t.post("~/dashboards/validate", json!({ "model": bad.clone() }), &viewer).await;
    assert_eq!((refused.code(), refused.field()), ("validation", "model"));
    assert!(refused.message().contains("links[0].url"), "{}", refused.body);
    // Saving refuses it the same way.
    let saved = t.post("~/dashboards", json!({ "model": bad }), &t.owner).await;
    assert_eq!((saved.code(), saved.field()), ("validation", "model"));
    let nothing_stored = t.post("~/dashboards/validate", json!({ "model": plain("x"), "extra": 1 }), &viewer).await;
    assert_eq!(nothing_stored.code(), "validation");
}

async fn annotations_follow_the_dashboard_access(t: TestApp) {
    let viewer = t.member("Vera", "viewer").await;
    let editor = t.member("Emil", "editor").await;
    let walter = t.member("Walter", "viewer").await;
    let folder = t.folder("Betrieb", false).await;
    let id = t.dashboard(Some(&folder), model("Lager"), &t.owner).await;
    let path = format!("~/dashboards/{id}/annotations");
    let in_range = format!("{path}?from={}&to={}", T0 - 6 * HOUR, T0);
    assert_eq!(t.get(&in_range, &viewer).await.body["items"], json!([]));

    let note = json!({ "time": T0 - HOUR, "text": "Release 2.1", "tags": ["deploy"] });
    let refused = t.post(&path, note.clone(), &viewer).await;
    assert_eq!((refused.status, refused.code()), (StatusCode::FORBIDDEN, "forbidden"));
    let created = t.post(&path, note.clone(), &editor).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let ann = created.id();
    assert_eq!((created.body["version"].as_i64(), created.body["panelId"].is_null()), (Some(1), true));
    // A viewer with an edit grant on the dashboard writes annotations too.
    t.grant("Walter", "dashboard", &id, "edit").await;
    let span = json!({ "time": T0 - 3 * HOUR, "timeEnd": T0 - 2 * HOUR, "text": "Wartung", "panelId": "p1" });
    assert_eq!(t.post(&path, span, &walter).await.status, StatusCode::CREATED);
    // Outside the range, not listed; a span overlapping it is.
    t.post(&path, json!({ "time": T0 - 30 * HOUR, "text": "Alt" }), &editor).await.id();
    let shown = t.get(&in_range, &viewer).await;
    let texts: Vec<&str> =
        shown.body["items"].as_array().unwrap().iter().map(|a| a["text"].as_str().unwrap()).collect();
    assert_eq!(texts, ["Wartung", "Release 2.1"], "oldest first");
    let paged = t.get(&format!("{path}?from={}&to={}&limit=1", T0 - 6 * HOUR, T0), &viewer).await;
    let cursor = paged.body["nextCursor"].as_str().unwrap();
    let second = t.get(&format!("{path}?from={}&to={}&limit=1&cursor={cursor}", T0 - 6 * HOUR, T0), &viewer).await;
    assert_eq!(second.body["items"][0]["text"], "Release 2.1");

    for (body, field) in [
        (json!({ "time": T0, "timeEnd": T0 - 1, "text": "x" }), "timeEnd"),
        (json!({ "time": T0, "text": "  " }), "text"),
        (json!({ "time": T0, "text": "x", "tags": ["a", "A"] }), "tags"),
        (json!({ "time": T0, "text": "x".repeat(2001) }), "text"),
        (json!({ "time": T0, "text": "x", "panelId": "nope" }), "panelId"),
    ] {
        let r = t.post(&path, body, &editor).await;
        assert_eq!((r.code(), r.field()), ("validation", field), "{}", r.body);
    }

    let ann_path = format!("{path}/{ann}");
    let changed = t.patch(&ann_path, json!({ "version": 1, "text": "Release 2.1.1" }), &editor).await;
    assert_eq!((changed.status, changed.body["version"].as_i64()), (StatusCode::OK, Some(2)), "{}", changed.body);
    let stale = t.patch(&ann_path, json!({ "version": 1, "text": "x" }), &editor).await;
    assert_eq!((stale.code(), stale.body["current"]["text"].as_str()), ("version_conflict", Some("Release 2.1.1")));
    assert_eq!(t.patch(&ann_path, json!({ "version": 2, "text": "x" }), &viewer).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.delete(&ann_path, &viewer).await.status, StatusCode::FORBIDDEN);

    // Trashed: readable, not writable.
    assert_eq!(t.delete(&format!("~/dashboards/{id}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.post(&path, note.clone(), &editor).await.code(), "conflict");
    assert_eq!(t.get(&in_range, &viewer).await.status, StatusCode::OK);
    assert_eq!(t.post(&format!("~/dashboards/{id}/restore"), json!({}), &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.delete(&ann_path, &editor).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.delete(&ann_path, &editor).await.status, StatusCode::NOT_FOUND);

    let audit = t.get("~/audit?action=annotation.", &t.owner).await;
    let first = &audit.body["items"][0];
    assert_eq!(
        (first["action"].as_str(), first["resourceType"].as_str()),
        (Some("annotation.deleted"), Some("dashboard"))
    );

    // Purging the dashboard takes its annotations along.
    t.delete(&format!("~/dashboards/{id}"), &t.owner).await;
    assert_eq!(t.delete(&format!("~/dashboards/{id}/purge"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.count("SELECT COUNT(*) FROM annotations WHERE dashboard_id = $1", &id).await, 0);
}

async fn annotations_stay_hidden_in_restricted_folders(t: TestApp) {
    let editor = t.member("Emil", "editor").await;
    let secret = t.folder("Geheim", true).await;
    let id = t.dashboard(Some(&secret), plain("Boni"), &t.owner).await;
    let path = format!("~/dashboards/{id}/annotations");
    t.post(&path, json!({ "time": T0, "text": "intern" }), &t.owner).await.id();
    let list = t.get(&format!("{path}?from=0&to={T0}"), &editor).await;
    assert_eq!((list.status, list.code()), (StatusCode::NOT_FOUND, "not_found"));
    assert_eq!(t.post(&path, json!({ "time": T0, "text": "x" }), &editor).await.status, StatusCode::NOT_FOUND);
    // Another organization's member sees nothing either.
    let missing = t.get(&format!("~/dashboards/{}/annotations?from=0&to=1", uuid::Uuid::now_v7()), &t.owner).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    // A view grant opens reading; writing then comes from the editor's annotations:write.
    t.grant("Emil", "folder", &secret, "view").await;
    assert_eq!(t.get(&format!("{path}?from=0&to={T0}"), &editor).await.body["items"].as_array().unwrap().len(), 1);
    assert_eq!(t.post(&path, json!({ "time": T0, "text": "x" }), &editor).await.status, StatusCode::CREATED);
    let bad = t.get(&format!("{path}?from=1&to=0"), &editor).await;
    assert_eq!(bad.code(), "validation");
}

async fn annotation_queries_run_as_stored_queries(t: TestApp) {
    let viewer = t.member("Vera", "viewer").await;
    let walter = t.member("Walter", "viewer").await;
    let folder = t.folder("Betrieb", false).await;
    let source = t.working_source().await;
    let mut m = plain("Releases");
    m["annotations"] = json!([{ "id": "rel", "name": "Releases", "datasourceId": source,
                                 "query": { "sql": "SELECT ts AS time, text FROM releases" } }]);
    let id = t.dashboard(Some(&folder), m.clone(), &t.owner).await;
    let body = json!({ "timeRange": range(), "variables": {} });
    let ran = t.post(&format!("~/dashboards/{id}/annotation-queries/rel/query"), body.clone(), &viewer).await;
    assert_eq!(ran.status, StatusCode::OK, "{}", ran.body);
    // A viewer without any data source right gets the rows, as for a panel's stored query.
    let fields = &ran.body["results"]["rel"]["result"]["frame"]["fields"];
    assert_eq!(fields[0]["type"], "time", "{}", ran.body);
    assert_eq!(fields[0]["values"], json!([1_799_990_000_000_i64]));
    assert_eq!(fields[1]["values"], json!(["Release 2.4"]));
    let unknown = t.post(&format!("~/dashboards/{id}/annotation-queries/nope/query"), body.clone(), &viewer).await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    let foreign_var = json!({ "timeRange": range(), "variables": { "nope": "x" } });
    let refused = t.post(&format!("~/dashboards/{id}/annotation-queries/rel/query"), foreign_var, &viewer).await;
    assert_eq!((refused.code(), refused.field()), ("validation", "variables"));

    // Someone who may edit the dashboard but not query the source cannot add an annotation query.
    t.grant("Walter", "dashboard", &id, "edit").await;
    let m_saved = m.clone();
    let mut changed = m;
    changed["annotations"][0]["query"] = json!({ "sql": "SELECT 2" });
    let save = t.put(&format!("~/dashboards/{id}"), json!({ "model": changed, "version": 1 }), &walter).await;
    assert_eq!((save.status, save.code()), (StatusCode::FORBIDDEN, "forbidden"), "{}", save.body);
    // Renaming it alone is not a new query.
    let mut renamed = m_saved;
    renamed["title"] = json!("Releases neu");
    let ok = t.put(&format!("~/dashboards/{id}"), json!({ "model": renamed, "version": 1 }), &walter).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
}

async fn playlists_show_only_readable_dashboards(t: TestApp) {
    let viewer = t.member("Vera", "viewer").await;
    let editor = t.member("Emil", "editor").await;
    let secret = t.folder("Geheim", true).await;
    let mut tagged = plain("Wand B");
    tagged["tags"] = json!(["Wand"]);
    let b = t.dashboard(None, tagged.clone(), &t.owner).await;
    tagged["title"] = json!("Wand A");
    let a = t.dashboard(None, tagged.clone(), &t.owner).await;
    tagged["title"] = json!("Wand geheim");
    let hidden_tagged = t.dashboard(Some(&secret), tagged, &t.owner).await;
    let hidden = t.dashboard(Some(&secret), plain("Boni"), &t.owner).await;

    let body = json!({ "name": "Empfang", "intervalSeconds": 30, "items": [
        { "type": "dashboard", "dashboardId": hidden },
        { "type": "dashboard", "dashboardId": b },
        { "type": "tag", "tag": "wand" }
    ] });
    assert_eq!(t.post("~/playlists", body.clone(), &viewer).await.status, StatusCode::FORBIDDEN);
    // The editor cannot name a dashboard hidden from them.
    let refused = t.post("~/playlists", body.clone(), &editor).await;
    assert_eq!((refused.code(), refused.field()), ("validation", "items"), "{}", refused.body);
    let id = t.post("~/playlists", body, &t.owner).await.id();
    for (bad, field) in [
        (json!({ "name": "x", "intervalSeconds": 5 }), "intervalSeconds"),
        (json!({ "name": "", "intervalSeconds": 30 }), "name"),
        (json!({ "name": "x", "intervalSeconds": 30, "items": [{ "type": "tag", "tag": "" }] }), "items"),
    ] {
        let r = t.post("~/playlists", bad, &t.owner).await;
        assert_eq!((r.code(), r.field()), ("validation", field), "{}", r.body);
    }

    // The editor sees the playlist without the hidden entry, and plays only what they may read.
    let seen = t.get(&format!("~/playlists/{id}"), &editor).await;
    assert_eq!(seen.body["items"].as_array().unwrap().len(), 2, "{}", seen.body);
    let play = t.get(&format!("~/playlists/{id}/play"), &viewer).await;
    let order: Vec<&str> = play.body["items"].as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap()).collect();
    assert_eq!(order, [b.as_str(), a.as_str()], "each once, tags by title, nothing hidden");
    let owner_play = t.get(&format!("~/playlists/{id}/play"), &t.owner).await;
    assert_eq!(owner_play.body["items"].as_array().unwrap().len(), 4);
    assert!(owner_play.body["items"].as_array().unwrap().iter().any(|d| d["id"] == json!(hidden_tagged)));

    // Saving as the editor keeps the entry they cannot see, at its place (it was first).
    let save = json!({ "version": 1, "name": "Empfang neu", "intervalSeconds": 60,
                       "items": [{ "type": "dashboard", "dashboardId": b }, { "type": "dashboard", "dashboardId": a }] });
    let saved = t.put(&format!("~/playlists/{id}"), save.clone(), &editor).await;
    assert_eq!((saved.status, saved.body["version"].as_i64()), (StatusCode::OK, Some(2)), "{}", saved.body);
    let stored = t.get(&format!("~/playlists/{id}"), &t.owner).await;
    assert_eq!(
        stored.body["items"],
        json!([{ "type": "dashboard", "dashboardId": hidden },
               { "type": "dashboard", "dashboardId": b },
               { "type": "dashboard", "dashboardId": a }])
    );
    // A purged dashboard's entry is dropped on the next save.
    t.delete(&format!("~/dashboards/{hidden}"), &t.owner).await;
    t.delete(&format!("~/dashboards/{hidden}/purge"), &t.owner).await;
    let owner_save = json!({ "version": 2, "name": "Empfang neu", "intervalSeconds": 60,
                             "items": [{ "type": "dashboard", "dashboardId": b }, { "type": "dashboard", "dashboardId": a }] });
    let resaved = t.put(&format!("~/playlists/{id}"), owner_save, &editor).await;
    assert_eq!(resaved.status, StatusCode::OK, "{}", resaved.body);
    let stored = t.get(&format!("~/playlists/{id}"), &t.owner).await;
    assert_eq!(stored.body["items"].as_array().unwrap().len(), 2, "{}", stored.body);
    // The limit counts the entries kept for others too.
    let secret_id = t.dashboard(Some(&secret), plain("Noch geheim"), &t.owner).await;
    let full: Vec<Value> = (0..100).map(|_| json!({ "type": "tag", "tag": "x" })).collect();
    let mut with_hidden = full.clone();
    with_hidden.insert(0, json!({ "type": "dashboard", "dashboardId": secret_id }));
    let owner_full =
        json!({ "version": 3, "name": "Voll", "intervalSeconds": 60, "items": with_hidden[..100].to_vec() });
    assert_eq!(t.put(&format!("~/playlists/{id}"), owner_full, &t.owner).await.status, StatusCode::OK);
    let too_many = json!({ "version": 4, "name": "Voll", "intervalSeconds": 60, "items": full });
    let refused = t.put(&format!("~/playlists/{id}"), too_many, &editor).await;
    assert_eq!((refused.code(), refused.field()), ("validation", "items"), "{}", refused.body);
    t.put(&format!("~/playlists/{id}"), json!({ "version": 4, "name": "Empfang neu", "intervalSeconds": 60, "items": [{ "type": "dashboard", "dashboardId": a }] }), &t.owner).await.id();
    let stale = t.put(&format!("~/playlists/{id}"), save, &editor).await;
    assert_eq!((stale.code(), stale.body["current"]["name"].as_str()), ("version_conflict", Some("Empfang neu")));
    let listed = t.get("~/playlists", &viewer).await;
    assert_eq!(listed.body["items"][0]["name"], "Empfang neu");
    assert_eq!(t.delete(&format!("~/playlists/{id}"), &viewer).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.delete(&format!("~/playlists/{id}"), &editor).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&format!("~/playlists/{id}"), &editor).await.status, StatusCode::NOT_FOUND);
}

async fn library_panels_follow_their_folder(t: TestApp) {
    let viewer = t.member("Vera", "viewer").await;
    let editor = t.member("Emil", "editor").await;
    let folder = t.folder("Bausteine", false).await;
    let body = json!({ "name": "Umsatz je Tag", "folderId": folder, "model": library_model("Umsatz") });
    assert_eq!(t.post("~/library-panels", body.clone(), &viewer).await.status, StatusCode::FORBIDDEN);
    let created = t.post("~/library-panels", body, &editor).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let id = created.id();
    assert_eq!(created.body["model"]["schemaVersion"], json!(SCHEMA_VERSION));
    assert_eq!(created.body["access"], json!({ "write": true, "delete": true }));

    let read = t.get(&format!("~/library-panels/{id}"), &viewer).await;
    assert_eq!((read.status, read.body["access"]["write"].as_bool()), (StatusCode::OK, Some(false)));
    let mut changed = library_model("Umsatz je Woche");
    let save = json!({ "version": 1, "name": "Umsatz", "model": changed.clone() });
    assert_eq!(t.put(&format!("~/library-panels/{id}"), save.clone(), &viewer).await.status, StatusCode::FORBIDDEN);
    let saved = t.put(&format!("~/library-panels/{id}"), save.clone(), &editor).await;
    assert_eq!((saved.status, saved.body["version"].as_i64()), (StatusCode::OK, Some(2)), "{}", saved.body);
    let stale = t.put(&format!("~/library-panels/{id}"), save, &editor).await;
    assert_eq!((stale.code(), stale.body["current"]["version"].as_i64()), ("version_conflict", Some(2)));

    // Place and content rules.
    changed["grid"] = json!({ "x": 0, "y": 0, "w": 1, "h": 1 });
    let placed = t.post("~/library-panels", json!({ "name": "x", "model": changed }), &editor).await;
    assert_eq!((placed.code(), placed.field()), ("validation", "model"));
    let mut wrong = library_model("x");
    wrong["targets"][0]["datasourceId"] = json!("nope");
    let missing = t.post("~/library-panels", json!({ "name": "x", "model": wrong }), &editor).await;
    assert_eq!((missing.code(), missing.field()), ("validation", "model"), "{}", missing.body);

    // A stored version 1 is migrated on read.
    let old = json!({ "schemaVersion": 1, "type": "stat", "title": "Alt", "targets": [] });
    sqlx::query("UPDATE library_panels SET model = $1 WHERE id = $2")
        .bind(old.to_string())
        .bind(&id)
        .execute(&t.state.db)
        .await
        .unwrap();
    let migrated = t.get(&format!("~/library-panels/{id}"), &viewer).await;
    assert_eq!(migrated.body["model"]["schemaVersion"], json!(SCHEMA_VERSION), "{}", migrated.body);
    assert_eq!(migrated.body["model"]["type"], "stat");

    let listed = t.get("~/library-panels?q=UMSATZ", &viewer).await;
    assert_eq!(listed.body["items"][0]["id"], json!(id));
    assert_eq!(
        t.get(&format!("~/library-panels?folderId={folder}"), &viewer).await.body["items"].as_array().unwrap().len(),
        1
    );
    assert_eq!(t.delete(&format!("~/library-panels/{id}"), &viewer).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.delete(&format!("~/library-panels/{id}"), &editor).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&format!("~/library-panels/{id}"), &editor).await.status, StatusCode::NOT_FOUND);
}

/// Creating and saving a library panel run the panel option checks of a dashboard write; a save
/// that leaves the stored options as they are keeps working.
async fn library_panels_check_panel_options(t: TestApp) {
    let editor = t.member("Emil", "editor").await;
    let mut odd = library_model("");
    odd["fieldConfig"] = json!({ "defaults": { "decimals": 99 }, "overrides": [] });
    let refused = t.post("~/library-panels", json!({ "name": "Umsatz", "model": odd.clone() }), &editor).await;
    assert_eq!(
        (refused.status, refused.code(), refused.field()),
        (StatusCode::UNPROCESSABLE_ENTITY, "validation", "model")
    );
    let reason = &refused.body["error"]["reason"];
    assert_eq!(reason, "dashboards.panel_options", "{}", refused.body);
    assert_eq!(refused.body["error"]["params"]["panel"], "Umsatz", "{}", refused.body);
    assert_eq!(
        refused.body["error"]["params"]["detail"].as_str().unwrap().split(' ').next(),
        Some("model.fieldConfig.defaults.decimals"),
        "{}",
        refused.body
    );

    // Stored with options from before a rule.
    let id =
        t.post("~/library-panels", json!({ "name": "Umsatz", "model": library_model("Umsatz") }), &editor).await.id();
    let mut stored = odd.clone();
    stored["title"] = json!("Umsatz");
    sqlx::query("UPDATE library_panels SET model = $1 WHERE id = $2")
        .bind(stored.to_string())
        .bind(&id)
        .execute(&t.state.db)
        .await
        .unwrap();
    let path = format!("~/library-panels/{id}");
    let mut renamed = stored.clone();
    renamed["title"] = json!("Umsatz neu");
    let kept = t.put(&path, json!({ "version": 1, "name": "Umsatz neu", "model": renamed }), &editor).await;
    assert_eq!((kept.status, kept.body["version"].as_i64()), (StatusCode::OK, Some(2)), "{}", kept.body);

    let mut worse = stored.clone();
    worse["fieldConfig"]["defaults"]["decimals"] = json!(98);
    let refused = t.put(&path, json!({ "version": 2, "name": "Umsatz", "model": worse }), &editor).await;
    assert_eq!((refused.status, refused.code()), (StatusCode::UNPROCESSABLE_ENTITY, "validation"), "{}", refused.body);
    assert_eq!(refused.body["error"]["reason"], "dashboards.panel_options", "{}", refused.body);
    assert_eq!(refused.body["error"]["params"]["panel"], "Umsatz", "{}", refused.body);

    let mut fixed = stored;
    fixed["fieldConfig"]["defaults"]["decimals"] = json!(2);
    let saved = t.put(&path, json!({ "version": 2, "name": "Umsatz", "model": fixed.clone() }), &editor).await;
    assert_eq!((saved.status, saved.body["version"].as_i64()), (StatusCode::OK, Some(3)), "{}", saved.body);
    assert_eq!(saved.body["model"]["fieldConfig"]["defaults"]["decimals"], 2);

    // A change to the overrides alone is checked; without a title the library panel name is named.
    let detail = |r: &Reply| r.body["error"]["params"]["detail"].as_str().unwrap_or("").to_string();
    let mut overridden = fixed;
    overridden["title"] = json!("");
    overridden["fieldConfig"]["overrides"] =
        json!([{ "matcher": { "type": "name", "value": "url" }, "properties": { "width": 10 } }]);
    let body = json!({ "version": 3, "name": "Umsatz je Tag", "model": overridden.clone() });
    let refused = t.put(&path, body, &editor).await;
    assert_eq!((refused.status, refused.code()), (StatusCode::UNPROCESSABLE_ENTITY, "validation"), "{}", refused.body);
    assert_eq!(refused.body["error"]["reason"], "dashboards.panel_options", "{}", refused.body);
    assert_eq!(refused.body["error"]["params"]["panel"], "Umsatz je Tag", "{}", refused.body);
    assert!(detail(&refused).starts_with("model.fieldConfig.overrides[0]"), "{}", refused.body);
    overridden["fieldConfig"]["overrides"][0]["properties"]["width"] = json!(120);
    let body = json!({ "version": 3, "name": "Umsatz je Tag", "model": overridden });
    let saved = t.put(&path, body, &editor).await;
    assert_eq!((saved.status, saved.body["version"].as_i64()), (StatusCode::OK, Some(4)), "{}", saved.body);

    // A change of the type alone is checked against the new type's options.
    let mut lines = library_model("Linien");
    lines["options"] = json!({ "lineWidth": 2 });
    let other = t.post("~/library-panels", json!({ "name": "Linien", "model": lines.clone() }), &editor).await.id();
    lines["type"] = json!("table");
    let body = json!({ "version": 1, "name": "Linien", "model": lines });
    let refused = t.put(&format!("~/library-panels/{other}"), body, &editor).await;
    assert_eq!((refused.status, refused.code()), (StatusCode::UNPROCESSABLE_ENTITY, "validation"), "{}", refused.body);
    assert_eq!(refused.body["error"]["reason"], "dashboards.panel_options", "{}", refused.body);
    assert_eq!(refused.body["error"]["params"]["panel"], "Linien", "{}", refused.body);
    assert!(detail(&refused).starts_with("model.options"), "{}", refused.body);
}

async fn library_panels_are_shared_by_dashboards(t: TestApp) {
    let editor = t.member("Emil", "editor").await;
    let viewer = t.member("Vera", "viewer").await;
    let folder = t.folder("Bausteine", false).await;
    let source = t.working_source().await;
    let mut content = library_model("Umsatz");
    content["targets"] =
        json!([{ "refId": "A", "datasourceId": source, "query": { "sql": "SELECT text FROM releases" } }]);
    let lib = t
        .post("~/library-panels", json!({ "name": "Umsatz", "folderId": folder, "model": content }), &editor)
        .await
        .id();
    let a = t.dashboard(None, showing("A", &lib), &editor).await;
    // A library panel with an analysis step of its own: the step is checked against the library
    // panel's queries, and a dashboard showing it saves with an empty slot.
    let mut stepped = content.clone();
    stepped["transformations"] =
        json!([{ "id": "s", "type": "calculate", "frame": "A", "name": "laenge", "expression": "1" }]);
    let with_step = t
        .post("~/library-panels", json!({ "name": "Mit Schritt", "folderId": folder, "model": stepped }), &editor)
        .await;
    assert_eq!(with_step.status, StatusCode::CREATED, "{}", with_step.body);
    assert_eq!(with_step.body["model"]["transformations"][0]["frame"], "A");
    let mut wrong = content.clone();
    wrong["transformations"] =
        json!([{ "id": "s", "type": "calculate", "frame": "B", "name": "x", "expression": "1" }]);
    let refused = t.post("~/library-panels", json!({ "name": "Falsch", "model": wrong }), &editor).await;
    assert_eq!((refused.code(), refused.field()), ("validation", "model"), "{}", refused.body);
    let holder = t.post("~/dashboards", json!({ "model": showing("Mit Schritt", &with_step.id()) }), &editor).await;
    assert_eq!(holder.status, StatusCode::CREATED, "{}", holder.body);
    assert_eq!(holder.body["libraryPanels"][with_step.id()]["model"]["transformations"][0]["id"], "s");
    let b = t.dashboard(None, showing("B", &lib), &t.owner).await;
    let read = t.get(&format!("~/dashboards/{a}"), &viewer).await;
    assert_eq!(read.body["libraryPanels"][&lib]["model"]["title"], "Umsatz", "{}", read.body);

    // A change shows on every dashboard.
    let mut renamed = content.clone();
    renamed["title"] = json!("Umsatz neu");
    let save = json!({ "version": 1, "name": "Umsatz", "model": renamed });
    t.put(&format!("~/library-panels/{lib}"), save, &editor).await.id();
    let again = t.get(&format!("~/dashboards/{b}"), &viewer).await;
    assert_eq!(again.body["libraryPanels"][&lib]["model"]["title"], "Umsatz neu");
    assert_eq!(again.body["libraryPanels"][&lib]["version"], 2);

    // The panel route runs the library panel's queries for whoever may read the dashboard.
    let q = json!({ "timeRange": range(), "variables": {} });
    let ran = t.post(&format!("~/dashboards/{a}/panels/lp/query"), q, &viewer).await;
    assert_eq!(ran.status, StatusCode::OK, "{}", ran.body);
    // The library panel's own query ran, not the empty slot's.
    assert_eq!(
        ran.body["results"]["A"]["result"]["frame"]["fields"][0]["values"],
        json!(["Release 2.4"]),
        "{}",
        ran.body
    );

    let uses = t.get(&format!("~/library-panels/{lib}/uses"), &viewer).await;
    assert_eq!((uses.body["items"].as_array().unwrap().len(), uses.body["hidden"].as_i64()), (2, Some(0)));
    assert_eq!(t.get(&format!("~/library-panels/{lib}"), &viewer).await.body["uses"], 2);
    // The list counts the same, for every row at once.
    let listed = t.get("~/library-panels", &viewer).await;
    let row = listed.body["items"].as_array().unwrap().iter().find(|p| p["id"] == json!(lib)).unwrap();
    assert_eq!(row["uses"], 2, "{}", listed.body);
    let refused = t.delete(&format!("~/library-panels/{lib}"), &editor).await;
    assert_eq!((refused.status, refused.code()), (StatusCode::CONFLICT, "conflict"));

    // A library panel has the queries; a linked panel with its own is refused.
    let mut both = showing("C", &lib);
    both["panels"][0]["targets"] = json!([{ "refId": "A", "datasourceId": "ds-1", "query": {} }]);
    assert_eq!(t.post("~/dashboards", json!({ "model": both }), &editor).await.field(), "model");
    let unknown = t.post("~/dashboards", json!({ "model": showing("D", "nope") }), &editor).await;
    assert_eq!((unknown.code(), unknown.field()), ("validation", "model"));

    // Purging a dashboard ends its use; the other dashboard keeps it.
    t.delete(&format!("~/dashboards/{a}"), &t.owner).await;
    t.delete(&format!("~/dashboards/{a}/purge"), &t.owner).await;
    assert_eq!(t.get(&format!("~/library-panels/{lib}"), &viewer).await.body["uses"], 1);
    t.put(&format!("~/dashboards/{b}"), json!({ "model": plain("B"), "version": 1 }), &t.owner).await.id();
    assert_eq!(t.delete(&format!("~/library-panels/{lib}"), &editor).await.status, StatusCode::NO_CONTENT);

    // Purging a folder takes its library panels along.
    let other = t
        .post("~/library-panels", json!({ "name": "Weg", "folderId": folder, "model": library_model("Weg") }), &editor)
        .await
        .id();
    assert_eq!(t.delete(&format!("~/folders/{folder}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert!(t.get("~/library-panels", &t.owner).await.body["items"].as_array().unwrap().is_empty(), "trashed folder");
    // Gone everywhere while its folder is in the trash: read, uses, and new references.
    assert_eq!(t.get(&format!("~/library-panels/{other}"), &t.owner).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.get(&format!("~/library-panels/{other}/uses"), &t.owner).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.post("~/dashboards", json!({ "model": showing("Neu", &other) }), &t.owner).await.field(), "model");
    assert_eq!(t.delete(&format!("~/folders/{folder}/purge"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.count("SELECT COUNT(*) FROM library_panels WHERE id = $1", &other).await, 0);
}

async fn library_panels_in_restricted_folders(t: TestApp) {
    let editor = t.member("Emil", "editor").await;
    let secret = t.folder("Geheim", true).await;
    let lib = t
        .post(
            "~/library-panels",
            json!({ "name": "Boni", "folderId": secret, "model": library_model("Boni") }),
            &t.owner,
        )
        .await
        .id();
    assert_eq!(t.get(&format!("~/library-panels/{lib}"), &editor).await.status, StatusCode::NOT_FOUND);
    assert!(t.get("~/library-panels", &editor).await.body["items"].as_array().unwrap().is_empty());
    assert_eq!(t.get(&format!("~/library-panels?folderId={secret}"), &editor).await.status, StatusCode::NOT_FOUND);
    // Using it is refused as if it did not exist.
    let refused = t.post("~/dashboards", json!({ "model": showing("A", &lib) }), &editor).await;
    assert_eq!((refused.code(), refused.field()), ("validation", "model"), "{}", refused.body);
    assert!(refused.message().contains("does not exist"));
    // A dashboard the owner made shows it to the editor; the uses list counts the hidden ones.
    let shown = t.dashboard(None, showing("Öffentlich", &lib), &t.owner).await;
    t.dashboard(Some(&secret), showing("Intern", &lib), &t.owner).await;
    assert_eq!(t.get(&format!("~/dashboards/{shown}"), &editor).await.body["libraryPanels"][&lib]["name"], "Boni");
    // Keeping an existing reference needs no access to it.
    let kept = t
        .put(&format!("~/dashboards/{shown}"), json!({ "model": showing("Umbenannt", &lib), "version": 1 }), &editor)
        .await;
    assert_eq!(kept.status, StatusCode::OK, "{}", kept.body);
    // The editor cannot open the library panel itself, so its uses are not theirs to list.
    assert_eq!(t.get(&format!("~/library-panels/{lib}/uses"), &editor).await.status, StatusCode::NOT_FOUND);
    // A dashboard in another restricted folder counts as hidden for whoever cannot see it.
    let other = t.folder("Vorstand", true).await;
    t.dashboard(Some(&other), showing("Vorstand", &lib), &t.owner).await;
    let vera = t.member("Vera", "viewer").await;
    t.grant("Vera", "folder", &secret, "view").await;
    let partial = t.get(&format!("~/library-panels/{lib}/uses"), &vera).await;
    assert_eq!(
        (partial.body["items"].as_array().unwrap().len(), partial.body["hidden"].as_i64()),
        (2, Some(1)),
        "{}",
        partial.body
    );
    let all = t.get(&format!("~/library-panels/{lib}/uses"), &t.owner).await;
    assert_eq!((all.body["items"].as_array().unwrap().len(), all.body["hidden"].as_i64()), (3, Some(0)));
    t.grant("Emil", "folder", &secret, "view").await;
    let uses = t.get(&format!("~/library-panels/{lib}/uses"), &editor).await;
    assert_eq!(uses.body["items"].as_array().unwrap().len(), 2, "{}", uses.body);
    // Moving it out of the restricted folder needs folders:permissions.
    t.grant("Emil", "folder", &secret, "edit").await;
    let moved = t
        .put(
            &format!("~/library-panels/{lib}"),
            json!({ "version": 1, "name": "Boni", "model": library_model("Boni"), "folderId": null }),
            &editor,
        )
        .await;
    assert_eq!((moved.status, moved.code()), (StatusCode::FORBIDDEN, "forbidden"), "{}", moved.body);
    assert!(moved.message().contains("folders:permissions"), "{}", moved.body);
}
