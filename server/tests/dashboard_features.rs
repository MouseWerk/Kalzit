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
    library_panel_queries_count_as_stored_queries,
    unhiding_or_moving_a_stored_query_counts_as_a_change,
    library_panel_queries_are_keyed_by_their_slot,
    hidden_targets_are_kept_but_not_run,
    time_options_are_stored_and_checked,
    colour_options_are_stored_and_checked,
    pins_keep_their_order_limit_and_access,
    panel_view_state_is_personal_and_follows_the_dashboard_access,
    panel_descriptions_and_transparency_are_stored_and_checked,
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

/// A dashboard with the constant `k` and, when `library` is set, a slot showing that library panel.
fn with_constant(title: &str, k: &str, library: Option<&str>) -> Value {
    let panels = match library {
        Some(id) => json!([ { "id": "lp", "type": "timeseries", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                              "libraryPanelId": id } ]),
        None => json!([]),
    };
    json!({
        "schemaVersion": SCHEMA_VERSION, "title": title, "timeRange": { "from": "now-6h", "to": "now" },
        "variables": [ { "name": "k", "type": "constant", "current": k } ],
        "panels": panels
    })
}

/// The queries of a linked library panel run with the dashboard's variables, so they are the
/// dashboard's stored queries: linking one, or changing a variable they read, needs
/// `datasources:query` on their source, as changing a panel's own query does.
async fn library_panel_queries_count_as_stored_queries(t: TestApp) {
    let source = t.working_source().await;
    let role = t
        .post(
            "~/roles",
            json!({ "name": "Gestalter", "permissions": ["dashboards:read", "dashboards:write", "folders:read", "datasources:read"] }),
            &t.owner,
        )
        .await;
    assert_eq!(role.status, StatusCode::CREATED, "{}", role.body);
    // May edit dashboards, but not query data sources.
    let designer = t.member("Gerd", role.body["id"].as_str().unwrap()).await;
    let editor = t.member("Emil", "editor").await;
    let viewer = t.member("Vera", "viewer").await;
    let mut content = library_model("Releases");
    content["targets"] =
        json!([{ "refId": "A", "datasourceId": source, "query": { "sql": "SELECT text FROM releases" } }]);
    let lib = t.post("~/library-panels", json!({ "name": "Releases", "model": content }), &t.owner).await.id();
    let id = t.dashboard(None, with_constant("Übersicht", "a", None), &t.owner).await;
    let path = format!("~/dashboards/{id}");
    let save = |model: Value, version: i64| json!({ "model": model, "version": version });

    // Linking the library panel adds its query: refused without the right, naming the source.
    let refused = t.put(&path, save(with_constant("Übersicht", "a", Some(&lib)), 1), &designer).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    assert!(refused.body["error"]["message"].as_str().unwrap().contains(&source), "{}", refused.body);
    let refused = t.post("~/dashboards", json!({ "model": with_constant("Neu", "a", Some(&lib)) }), &designer).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    // An editor, who may query the source, links it.
    let linked = t.put(&path, save(with_constant("Übersicht", "a", Some(&lib)), 1), &editor).await;
    assert_eq!(linked.status, StatusCode::OK, "{}", linked.body);

    // Renaming leaves the library panel's query as it was: no right needed.
    let renamed = t.put(&path, save(with_constant("Übersicht 2", "a", Some(&lib)), 2), &designer).await;
    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.body);
    // A changed variable changes what the library panel's query reads.
    let refused = t.put(&path, save(with_constant("Übersicht 2", "b", Some(&lib)), 3), &designer).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);
    let changed = t.put(&path, save(with_constant("Übersicht 2", "b", Some(&lib)), 3), &editor).await;
    assert_eq!(changed.status, StatusCode::OK, "{}", changed.body);

    // A viewer runs the stored library query, but saves nothing.
    let q = json!({ "timeRange": range(), "variables": {} });
    let ran = t.post(&format!("{path}/panels/lp/query"), q, &viewer).await;
    assert_eq!(ran.status, StatusCode::OK, "{}", ran.body);
    assert_eq!(ran.body["results"]["A"]["result"]["frame"]["fields"][0]["values"], json!(["Release 2.4"]));
    let refused = t.put(&path, save(with_constant("Übersicht 3", "b", Some(&lib)), 4), &viewer).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);

    // A stored library panel this server cannot read runs nothing: it neither blocks saving the
    // dashboard nor keeps it from opening, its slot just stays empty.
    sqlx::query("UPDATE library_panels SET model = '{ kaputt' WHERE id = $1")
        .bind(&lib)
        .execute(&t.state.db)
        .await
        .unwrap();
    let saved = t.put(&path, save(with_constant("Übersicht 3", "c", Some(&lib)), 4), &designer).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    assert_eq!(saved.body["libraryPanels"], json!({}), "{}", saved.body);
    assert_eq!(t.get(&path, &viewer).await.status, StatusCode::OK);
}

/// What a stored query shows depends on whether it runs and where: un-hiding it, letting a step
/// read it or moving it to another panel needs `datasources:query`, as changing its text does.
/// Moving or resizing the panel does not.
async fn unhiding_or_moving_a_stored_query_counts_as_a_change(t: TestApp) {
    let source = t.working_source().await;
    let role = t
        .post(
            "~/roles",
            json!({ "name": "Gestalter", "permissions": ["dashboards:read", "dashboards:write", "folders:read", "datasources:read"] }),
            &t.owner,
        )
        .await;
    assert_eq!(role.status, StatusCode::CREATED, "{}", role.body);
    let designer = t.member("Gerd", role.body["id"].as_str().unwrap()).await;
    let mut m = model("Versteckt");
    m["panels"][0]["targets"] = json!([
        { "refId": "A", "datasourceId": source, "query": { "sql": "SELECT text FROM releases" } },
        { "refId": "B", "datasourceId": source, "query": { "sql": "SELECT secret FROM releases" }, "hide": true }
    ]);
    m["panels"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "id": "p2", "type": "table", "grid": { "x": 12, "y": 0, "w": 12, "h": 8 }, "targets": [] }));
    let id = t.dashboard(None, m.clone(), &t.owner).await;
    let path = format!("~/dashboards/{id}");
    let save = |model: &Value| json!({ "model": model, "version": 1 });

    let mut unhidden = m.clone();
    unhidden["panels"][0]["targets"][1].as_object_mut().unwrap().remove("hide");
    let mut read_by_step = m.clone();
    read_by_step["panels"][0]["transformations"] =
        json!([{ "id": "s", "type": "calculate", "frame": "B", "name": "n", "expression": "1" }]);
    let mut moved = m.clone();
    let b = moved["panels"][0]["targets"].as_array_mut().unwrap().remove(1);
    moved["panels"][1]["targets"] = json!([b]);
    for (what, changed) in [("unhidden", &unhidden), ("read by a step", &read_by_step), ("moved", &moved)] {
        let refused = t.put(&path, save(changed), &designer).await;
        assert_eq!(refused.status, StatusCode::FORBIDDEN, "{what}: {}", refused.body);
    }

    // Moving and resizing the panel itself changes no query.
    let mut rearranged = m.clone();
    rearranged["panels"][0]["grid"] = json!({ "x": 0, "y": 8, "w": 24, "h": 6 });
    rearranged["panels"][0]["title"] = json!("Neu angeordnet");
    let saved = t.put(&path, save(&rearranged), &designer).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    // The owner may un-hide it.
    let saved = t.put(&path, json!({ "model": unhidden, "version": 2 }), &t.owner).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
}

/// A linked library panel's queries are keyed by the dashboard panel that shows them: showing it
/// in a second slot adds queries and needs `datasources:query`; moving the slot does not.
async fn library_panel_queries_are_keyed_by_their_slot(t: TestApp) {
    let source = t.working_source().await;
    let role = t
        .post(
            "~/roles",
            json!({ "name": "Gestalter", "permissions": ["dashboards:read", "dashboards:write", "folders:read", "datasources:read"] }),
            &t.owner,
        )
        .await;
    assert_eq!(role.status, StatusCode::CREATED, "{}", role.body);
    let designer = t.member("Gerd", role.body["id"].as_str().unwrap()).await;
    let mut content = library_model("Releases");
    content["targets"] =
        json!([{ "refId": "A", "datasourceId": source, "query": { "sql": "SELECT text FROM releases" } }]);
    let lib = t.post("~/library-panels", json!({ "name": "Releases", "model": content }), &t.owner).await.id();
    let model = showing("Übersicht", &lib);
    let id = t.dashboard(None, model.clone(), &t.owner).await;
    let path = format!("~/dashboards/{id}");

    let mut twice = model.clone();
    twice["panels"].as_array_mut().unwrap().push(
        json!({ "id": "lp2", "type": "timeseries", "grid": { "x": 12, "y": 0, "w": 12, "h": 8 }, "libraryPanelId": lib }),
    );
    let refused = t.put(&path, json!({ "model": twice, "version": 1 }), &designer).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.body);

    let mut moved = model.clone();
    moved["panels"][0]["grid"] = json!({ "x": 0, "y": 8, "w": 24, "h": 6 });
    let saved = t.put(&path, json!({ "model": moved, "version": 1 }), &designer).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    let saved = t.put(&path, json!({ "model": twice, "version": 2 }), &t.owner).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
}

async fn hidden_targets_are_kept_but_not_run(t: TestApp) {
    let source = t.working_source().await;
    let mut m = model("Versteckt");
    m["panels"][0]["targets"] = json!([
        { "refId": "A", "datasourceId": source, "query": { "sql": "SELECT text FROM releases" } },
        { "refId": "B", "datasourceId": source, "query": { "sql": "SELECT text FROM releases" }, "hide": true }
    ]);
    let id = t.dashboard(None, m.clone(), &t.owner).await;
    // Stored as sent; a target that runs carries no `hide`.
    let read = t.get(&format!("~/dashboards/{id}"), &t.owner).await;
    let targets = &read.body["model"]["panels"][0]["targets"];
    assert_eq!((targets[0].get("hide"), &targets[1]["hide"]), (None, &json!(true)), "{}", read.body);
    let q = json!({ "timeRange": range(), "variables": {} });
    let ran = t.post(&format!("~/dashboards/{id}/panels/p1/query"), q, &t.owner).await;
    assert_eq!(ran.status, StatusCode::OK, "{}", ran.body);
    assert!(ran.body["results"].get("A").is_some(), "{}", ran.body);
    assert!(ran.body["results"].get("B").is_none(), "{}", ran.body);

    // A hidden target that an enabled step reads is run, since the step needs its frame; a
    // disabled step does not count.
    let mut read_by_step = model("Versteckt, gelesen");
    read_by_step["panels"][0]["targets"] = m["panels"][0]["targets"].clone();
    read_by_step["panels"][0]["transformations"] =
        json!([{ "id": "s", "type": "calculate", "frame": "B", "name": "n", "expression": "1" }]);
    let read_id = t.dashboard(None, read_by_step.clone(), &t.owner).await;
    let q = json!({ "timeRange": range(), "variables": {} });
    let ran = t.post(&format!("~/dashboards/{read_id}/panels/p1/query"), q.clone(), &t.owner).await;
    assert!(ran.body["results"].get("B").is_some(), "{}", ran.body);
    read_by_step["title"] = json!("Versteckt, Schritt aus");
    read_by_step["panels"][0]["transformations"][0]["disabled"] = json!(true);
    let off_id = t.dashboard(None, read_by_step, &t.owner).await;
    let ran = t.post(&format!("~/dashboards/{off_id}/panels/p1/query"), q, &t.owner).await;
    assert!(ran.body["results"].get("B").is_none(), "{}", ran.body);

    // The export runs the shown query only; a panel whose queries are all hidden has nothing
    // to export.
    let file = json!({ "timeRange": range(), "variables": {}, "format": "json", "language": "en" });
    let exported = t.post(&format!("~/dashboards/{id}/panels/p1/export"), file.clone(), &t.owner).await;
    assert_eq!(exported.status, StatusCode::OK, "{}", exported.body);
    assert!(!exported.body.to_string().contains("\"B\""), "{}", exported.body);
    let mut all_hidden = model("Alles versteckt");
    all_hidden["panels"][0]["targets"] = json!([
        { "refId": "A", "datasourceId": source, "query": { "sql": "SELECT text FROM releases" }, "hide": true }
    ]);
    let hidden_id = t.dashboard(None, all_hidden, &t.owner).await;
    let refused = t.post(&format!("~/dashboards/{hidden_id}/panels/p1/export"), file, &t.owner).await;
    assert_eq!(refused.code(), "validation", "{}", refused.body);
    assert!(refused.body.to_string().contains("export.no_queries"), "{}", refused.body);
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

async fn time_options_are_stored_and_checked(t: TestApp) {
    let mut timed = plain("Geschäftsjahr");
    timed["timeRange"] = json!({ "from": "now-1fy/fy", "to": "now-1fy/fy" });
    timed["timeZone"] = json!("Europe/Zurich");
    timed["weekStart"] = json!("sunday");
    timed["fiscalYearStartMonth"] = json!(7);
    timed["nowDelay"] = json!("2m");
    timed["refreshIntervals"] = json!([15, 60, 600]);
    timed["sharedCursor"] = json!("crosshair");
    let id = t.dashboard(None, timed.clone(), &t.owner).await;
    let stored = t.get(&format!("~/dashboards/{id}"), &t.owner).await;
    assert_eq!(stored.status, StatusCode::OK, "{}", stored.body);
    for key in
        ["timeRange", "timeZone", "weekStart", "fiscalYearStartMonth", "nowDelay", "refreshIntervals", "sharedCursor"]
    {
        assert_eq!(stored.body["model"][key], timed[key], "{key}");
    }
    // Without them the stored model stays as it was: nothing is added.
    let other = t.dashboard(None, plain("Ohne"), &t.owner).await;
    let model = t.get(&format!("~/dashboards/{other}"), &t.owner).await.body["model"].clone();
    for key in ["timeZone", "weekStart", "fiscalYearStartMonth", "nowDelay", "refreshIntervals", "sharedCursor"] {
        assert!(model.get(key).is_none(), "{key}: {model}");
    }
    // Each one is checked on save, with its place named.
    for (key, value, expect) in [
        ("timeZone", json!("Mars/Olympus_Mons"), "model.timeZone"),
        ("fiscalYearStartMonth", json!(13), "model.fiscalYearStartMonth"),
        ("nowDelay", json!("1w"), "model.nowDelay"),
        ("refreshIntervals", json!([60, 10]), "model.refreshIntervals[1]"),
        ("sharedCursor", json!("everywhere"), "unknown variant `everywhere`"),
    ] {
        let mut bad = plain("Falsch");
        bad[key] = value;
        let refused = t.put(&format!("~/dashboards/{id}"), json!({ "model": bad, "version": 1 }), &t.owner).await;
        assert_eq!((refused.code(), refused.field()), ("validation", "model"), "{key}: {}", refused.body);
        assert!(refused.message().contains(expect), "{key}: {}", refused.body);
    }
    let mut odd_range = plain("Falsch");
    odd_range["timeRange"] = json!({ "from": "now-1fq", "to": "now" });
    let refused = t.post("~/dashboards", json!({ "model": odd_range }), &t.owner).await;
    assert_eq!((refused.code(), refused.field()), ("validation", "model"));
}

/// The panel editor's colours: a colour scheme, free colours next to the palette tones, series
/// overrides of colour, line style and opacity, and threshold steps with colours. They come back
/// as stored, panels stored with tones keep working, and invalid values are refused by place.
async fn colour_options_are_stored_and_checked(t: TestApp) {
    let field_config = json!({
        "defaults": {
            "colorScheme": "thresholds", "color": "#6aa3d8", "opacity": 90, "thresholdDisplay": "lines",
            "thresholds": { "mode": "absolute", "steps": [
                { "value": null, "tone": "neutral", "color": "#8a8a93" }, { "value": 80, "tone": "warn", "color": "#e8a33d" }
            ] }
        },
        "overrides": [
            { "matcher": { "type": "name", "value": "Vortag" },
              "properties": { "color": "#4FB3A9", "lineStyle": "dashed", "opacity": 85 } },
            { "matcher": { "type": "name", "value": "Umsatz" }, "properties": { "color": "chart-1" } }
        ]
    });
    let mut coloured = model("Farben");
    coloured["panels"][0]["fieldConfig"] = field_config.clone();
    let id = t.dashboard(None, coloured, &t.owner).await;
    let stored = t.get(&format!("~/dashboards/{id}"), &t.owner).await;
    assert_eq!(stored.status, StatusCode::OK, "{}", stored.body);
    assert_eq!(stored.body["model"]["panels"][0]["fieldConfig"], field_config);

    // A panel stored with a tone only, as before, still saves.
    let mut toned = model("Töne");
    toned["panels"][0]["fieldConfig"] = json!({ "defaults": { "color": "chart-4" }, "overrides": [] });
    let saved = t.put(&format!("~/dashboards/{id}"), json!({ "model": toned, "version": 1 }), &t.owner).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);

    for (path, value, expect) in [
        ("/defaults/color", json!("#12345"), "fieldConfig.defaults.color"),
        ("/defaults/opacity", json!(150), "fieldConfig.defaults.opacity"),
        ("/defaults/colorScheme", json!("rainbow"), "unknown variant `rainbow`"),
        ("/defaults/thresholdDisplay", json!("dots"), "unknown variant `dots`"),
        ("/defaults/thresholds/steps/1/color", json!("orange"), "steps[1].color"),
        ("/overrides/0/properties/color", json!("#zzzzzz"), "overrides[0].properties.color"),
    ] {
        let mut bad = model("Falsch");
        let mut config = field_config.clone();
        *config.pointer_mut(path).unwrap() = value;
        bad["panels"][0]["fieldConfig"] = config;
        let refused = t.put(&format!("~/dashboards/{id}"), json!({ "model": bad, "version": 2 }), &t.owner).await;
        assert_eq!((refused.code(), refused.field()), ("validation", "model"), "{path}: {}", refused.body);
        assert_eq!(refused.body["error"]["reason"], "dashboards.panel_options", "{path}: {}", refused.body);
        let detail = refused.body["error"]["params"]["detail"].as_str().unwrap_or_default();
        assert!(detail.contains(expect), "{path}: {}", refused.body);
    }
}

/// The panel inspector's own panel fields: a description and a transparent card. They come back as
/// stored, stay out of the model when unset, and an oversized description is refused by place.
async fn panel_descriptions_and_transparency_are_stored_and_checked(t: TestApp) {
    let mut described = model("Beschrieben");
    described["panels"][0]["description"] = json!("Netto-Umsatz pro Tag.\nVerglichen mit dem Vorjahr.");
    described["panels"][0]["transparent"] = json!(true);
    let id = t.dashboard(None, described.clone(), &t.owner).await;
    let stored = t.get(&format!("~/dashboards/{id}"), &t.owner).await;
    assert_eq!(stored.status, StatusCode::OK, "{}", stored.body);
    let panel = &stored.body["model"]["panels"][0];
    assert_eq!(panel["description"], described["panels"][0]["description"]);
    assert_eq!(panel["transparent"], true);
    let plain_id = t.dashboard(None, model("Schlicht"), &t.owner).await;
    let plain_panel = t.get(&format!("~/dashboards/{plain_id}"), &t.owner).await.body["model"]["panels"][0].clone();
    assert!(plain_panel.get("description").is_none() && plain_panel.get("transparent").is_none(), "{plain_panel}");
    let mut long = model("Zu lang");
    long["panels"][0]["description"] = json!("x".repeat(1001));
    let refused = t.put(&format!("~/dashboards/{id}"), json!({ "model": long, "version": 1 }), &t.owner).await;
    assert_eq!((refused.code(), refused.field()), ("validation", "model"), "{}", refused.body);
    assert!(refused.message().contains("panels[0].description"), "{}", refused.body);
}

/// Dashboards pinned to the sidebar: per user and organization, in the user's order, at most ten
/// readable ones, and pins of dashboards the user lost (access, trash) left out without an error.
async fn pins_keep_their_order_limit_and_access(t: TestApp) {
    let viewer = t.member("Vera", "viewer").await;
    let ids = |r: &Reply| -> Vec<String> {
        r.body["items"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap().to_string()).collect()
    };
    let mut boards = Vec::new();
    for i in 0..11 {
        boards.push(t.dashboard(None, plain(&format!("Tafel {i}")), &t.owner).await);
    }
    let pin = |id: &str| format!("~/dashboards/{id}/pin");
    for id in &boards[..3] {
        let r = t.put(&pin(id), json!({}), &viewer).await;
        assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    }
    // Again changes nothing; the order is the order of pinning.
    assert_eq!(t.put(&pin(&boards[0]), json!({}), &viewer).await.status, StatusCode::NO_CONTENT);
    let listed = t.get("~/pins", &viewer).await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
    assert_eq!(ids(&listed), boards[..3].to_vec());
    assert_eq!(listed.body["items"][0]["title"], "Tafel 0");
    // Pins are personal: the owner has none.
    assert!(ids(&t.get("~/pins", &t.owner).await).is_empty());

    // A new order names every pin once.
    let order = vec![boards[2].clone(), boards[0].clone(), boards[1].clone()];
    let ordered = t.put("~/pins", json!({ "dashboardIds": order }), &viewer).await;
    assert_eq!(ordered.status, StatusCode::OK, "{}", ordered.body);
    assert_eq!(ids(&ordered), order);
    assert_eq!(ids(&t.get("~/pins", &viewer).await), order);
    for bad in [json!([boards[0], boards[1]]), json!([boards[0], boards[0], boards[1], boards[2]]), json!([boards[5]])]
    {
        let refused = t.put("~/pins", json!({ "dashboardIds": bad }), &viewer).await;
        assert_eq!((refused.code(), refused.field()), ("validation", "dashboardIds"), "{}", refused.body);
    }

    // At most ten.
    for id in &boards[3..10] {
        assert_eq!(t.put(&pin(id), json!({}), &viewer).await.status, StatusCode::NO_CONTENT);
    }
    let refused = t.put(&pin(&boards[10]), json!({}), &viewer).await;
    assert_eq!(refused.code(), "validation", "{}", refused.body);
    assert!(refused.message().contains("at most 10"), "{}", refused.body);

    // Only readable dashboards: one in a restricted folder is not found, and a trashed one is a
    // conflict.
    let folder = t.folder("Geheim", true).await;
    let hidden = t.dashboard(Some(&folder), plain("Geheim"), &t.owner).await;
    assert_eq!(t.delete(&pin(&boards[9]), &viewer).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.put(&pin(&hidden), json!({}), &viewer).await.status, StatusCode::NOT_FOUND);

    // A grant makes it readable and pinnable; losing the grant hides the pin without an error, and
    // it frees a place for another pin.
    t.grant("Vera", "dashboard", &hidden, "view").await;
    assert_eq!(t.put(&pin(&hidden), json!({}), &viewer).await.status, StatusCode::NO_CONTENT);
    assert!(ids(&t.get("~/pins", &viewer).await).contains(&hidden));
    sqlx::query("DELETE FROM resource_grants WHERE resource_id = $1").bind(&hidden).execute(&t.state.db).await.unwrap();
    let after = t.get("~/pins", &viewer).await;
    assert_eq!(after.status, StatusCode::OK, "{}", after.body);
    assert!(!ids(&after).contains(&hidden));
    assert_eq!(ids(&after).len(), 9);
    // A reorder names only the pins the user sees; the hidden one keeps its place after them.
    let visible = ids(&after);
    let mut reversed = visible.clone();
    reversed.reverse();
    let ordered = t.put("~/pins", json!({ "dashboardIds": reversed.clone() }), &viewer).await;
    assert_eq!(ids(&ordered), reversed, "{}", ordered.body);

    // A trashed dashboard drops out; restored, it comes back in its place.
    let trashed = reversed[0].clone();
    assert_eq!(t.delete(&format!("~/dashboards/{trashed}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert!(!ids(&t.get("~/pins", &viewer).await).contains(&trashed));
    assert_eq!(t.put(&pin(&trashed), json!({}), &viewer).await.code(), "conflict");
    let restored = t.post(&format!("~/dashboards/{trashed}/restore"), json!({}), &t.owner).await;
    assert!(restored.status.is_success(), "{}", restored.body);
    assert_eq!(ids(&t.get("~/pins", &viewer).await)[0], trashed);
    // Unpinning is quiet, also for a dashboard that was never pinned.
    assert_eq!(t.delete(&pin(&boards[10]), &viewer).await.status, StatusCode::NO_CONTENT);

    // Access that came back can leave more than ten readable pins (here 12, the grant returns and
    // one more is stored as returning access would leave it): the list shows the first ten, and a
    // reorder names those ten; the others keep their place after them.
    t.grant("Vera", "dashboard", &hidden, "view").await;
    let (vera,): (String,) =
        sqlx::query_as("SELECT id FROM users WHERE name = $1").bind("Vera").fetch_one(&t.state.db).await.unwrap();
    for (position, id) in [(100, &boards[9]), (101, &boards[10])] {
        sqlx::query(
            "INSERT INTO dashboard_pins (user_id, org_id, dashboard_id, position, created_at) VALUES ($1, $2, $3, $4, 0) \
             ON CONFLICT (user_id, dashboard_id) DO NOTHING",
        )
        .bind(&vera)
        .bind(&t.org)
        .bind(id)
        .bind(position)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    let (stored,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM dashboard_pins WHERE user_id = $1")
        .bind(&vera)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(stored, 12);
    let shown = ids(&t.get("~/pins", &viewer).await);
    assert_eq!(shown.len(), 10);
    let mut turned = shown.clone();
    turned.reverse();
    let ordered = t.put("~/pins", json!({ "dashboardIds": turned.clone() }), &viewer).await;
    assert_eq!(ordered.status, StatusCode::OK, "{}", ordered.body);
    assert_eq!(ids(&ordered)[..10], turned[..]);
    assert_eq!(ids(&t.get("~/pins", &viewer).await), turned);
    // Pinning one that is already pinned stays a no-op beyond the limit; a new one is refused.
    assert_eq!(t.put(&pin(&boards[10]), json!({}), &viewer).await.status, StatusCode::NO_CONTENT);
    let extra = t.dashboard(None, plain("Noch eine"), &t.owner).await;
    assert_eq!(t.put(&pin(&extra), json!({}), &viewer).await.code(), "validation");
}

async fn panel_view_state_is_personal_and_follows_the_dashboard_access(t: TestApp) {
    let viewer = t.member("Vera", "viewer").await;
    let editor = t.member("Emil", "editor").await;
    let board = t.dashboard(None, model("Kundengraph"), &t.owner).await;
    let path = |board: &str, panel: &str| format!("~/dashboards/{board}/panels/{panel}/view-state");
    let state = json!({ "pinned": ["4:abc:1042", "17"], "selected": ["17"] });

    // Nothing kept yet: empty lists.
    let empty = t.get(&path(&board, "p1"), &viewer).await;
    assert_eq!(empty.status, StatusCode::OK, "{}", empty.body);
    assert_eq!(empty.body, json!({ "pinned": [], "selected": [] }));

    // A viewer keeps their own state; another user sees none of it.
    let saved = t.put(&path(&board, "p1"), state.clone(), &viewer).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);
    assert_eq!(t.get(&path(&board, "p1"), &viewer).await.body, state);
    assert_eq!(t.get(&path(&board, "p1"), &editor).await.body, json!({ "pinned": [], "selected": [] }));
    // Writing again replaces it.
    let next = json!({ "pinned": [], "selected": ["4:abc:1042"] });
    assert_eq!(t.put(&path(&board, "p1"), next.clone(), &viewer).await.status, StatusCode::OK);
    assert_eq!(t.get(&path(&board, "p1"), &viewer).await.body, next);

    // Ids are bounded and named once; unknown fields are refused.
    for (bad, field) in [
        (json!({ "pinned": ["a", "a"] }), "pinned"),
        (json!({ "selected": [""] }), "selected"),
        (json!({ "selected": ["a\nb"] }), "selected"),
        (json!({ "pinned": (0..=200).map(|i| i.to_string()).collect::<Vec<_>>() }), "pinned"),
    ] {
        let refused = t.put(&path(&board, "p1"), bad, &viewer).await;
        assert_eq!((refused.code(), refused.field()), ("validation", field), "{}", refused.body);
    }
    assert_eq!(t.put(&path(&board, "p1"), json!({ "properties": {} }), &viewer).await.code(), "validation");

    // A panel the dashboard does not have, and a dashboard in a restricted folder, are not found.
    assert_eq!(t.get(&path(&board, "nope"), &viewer).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.put(&path(&board, "nope"), state.clone(), &viewer).await.status, StatusCode::NOT_FOUND);
    let folder = t.folder("Geheim", true).await;
    let hidden = t.dashboard(Some(&folder), model("Geheim"), &t.owner).await;
    assert_eq!(t.get(&path(&hidden, "p1"), &viewer).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.put(&path(&hidden, "p1"), state.clone(), &viewer).await.status, StatusCode::NOT_FOUND);
    // A grant makes it readable; losing the grant hides the state again without deleting it.
    t.grant("Vera", "dashboard", &hidden, "view").await;
    assert_eq!(t.put(&path(&hidden, "p1"), state.clone(), &viewer).await.status, StatusCode::OK);
    sqlx::query("DELETE FROM resource_grants WHERE resource_id = $1").bind(&hidden).execute(&t.state.db).await.unwrap();
    assert_eq!(t.get(&path(&hidden, "p1"), &viewer).await.status, StatusCode::NOT_FOUND);

    // A trashed dashboard is not found; deleting the state is quiet either way.
    assert_eq!(t.delete(&format!("~/dashboards/{board}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&path(&board, "p1"), &viewer).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.delete(&path(&board, "p1"), &viewer).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.count("SELECT COUNT(*) FROM panel_view_state WHERE dashboard_id = $1", &board).await, 0);
    // Empty lists remove the row instead of keeping an empty one.
    let other = t.dashboard(None, model("Leer"), &t.owner).await;
    assert_eq!(t.put(&path(&other, "p1"), state.clone(), &viewer).await.status, StatusCode::OK);
    assert_eq!(t.put(&path(&other, "p1"), json!({}), &viewer).await.status, StatusCode::OK);
    assert_eq!(t.count("SELECT COUNT(*) FROM panel_view_state WHERE dashboard_id = $1", &other).await, 0);

    // A panel removed by a save takes the viewers' state with it, and is not found afterwards.
    assert_eq!(t.put(&path(&other, "p1"), state.clone(), &viewer).await.status, StatusCode::OK);
    let saved =
        t.put(&format!("~/dashboards/{other}"), json!({ "model": plain("Leer"), "version": 1 }), &t.owner).await;
    assert!(saved.status.is_success(), "{}", saved.body);
    assert_eq!(t.count("SELECT COUNT(*) FROM panel_view_state WHERE dashboard_id = $1", &other).await, 0);
    assert_eq!(t.get(&path(&other, "p1"), &viewer).await.status, StatusCode::NOT_FOUND);

    // Another organization's path does not reach this dashboard, even for its server admin.
    let third = t.dashboard(None, model("Dritte"), &t.owner).await;
    let (owner_id,): (String,) = sqlx::query_as("SELECT user_id FROM org_members WHERE org_id = $1 AND role = 'owner'")
        .bind(&t.org)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    let created = t.post("/admin/orgs", json!({ "name": "Zweite GmbH", "ownerUserId": owner_id }), &t.owner).await;
    let second = created.id();
    let foreign = format!("/orgs/{second}/dashboards/{third}/panels/p1/view-state");
    assert_eq!(t.get(&foreign, &t.owner).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.put(&foreign, state.clone(), &t.owner).await.status, StatusCode::NOT_FOUND);
    // A member of only the first organization is not a member of the second one.
    assert!(t.get(&foreign, &viewer).await.status.is_client_error());

    // A member who leaves the organization leaves their state behind with it.
    assert_eq!(t.put(&path(&third, "p1"), state, &viewer).await.status, StatusCode::OK);
    let (vera,): (String,) =
        sqlx::query_as("SELECT id FROM users WHERE name = $1").bind("Vera").fetch_one(&t.state.db).await.unwrap();
    let removed = t.delete(&format!("~/members/{vera}"), &t.owner).await;
    assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.body);
    assert_eq!(t.count("SELECT COUNT(*) FROM panel_view_state WHERE user_id = $1", &vera).await, 0);
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
    assert_eq!(uses.body["items"].as_array().unwrap().len(), 2);
    // Dashboards the caller cannot see are not counted either.
    assert!(uses.body.get("hidden").is_none(), "{}", uses.body);
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
    // A dashboard in another restricted folder is neither listed nor counted for whoever cannot
    // see it.
    let other = t.folder("Vorstand", true).await;
    t.dashboard(Some(&other), showing("Vorstand", &lib), &t.owner).await;
    let vera = t.member("Vera", "viewer").await;
    t.grant("Vera", "folder", &secret, "view").await;
    let partial = t.get(&format!("~/library-panels/{lib}/uses"), &vera).await;
    assert_eq!(partial.body["items"].as_array().unwrap().len(), 2, "{}", partial.body);
    assert_eq!(t.get(&format!("~/library-panels/{lib}"), &vera).await.body["uses"], 2);
    let all = t.get(&format!("~/library-panels/{lib}/uses"), &t.owner).await;
    assert_eq!(all.body["items"].as_array().unwrap().len(), 3);
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
