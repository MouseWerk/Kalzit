//! Provisioning sets and the Grafana import through the real router (on PostgreSQL too when
//! `KALZIT_TEST_POSTGRES_URL` is set): plan, apply, prune and export round trips, sets owning
//! their resources, secret references, read-only resources and unlocking, drift, the rights, and
//! the import of the Grafana fixtures in `tests/fixtures/grafana` (written for these tests).

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::ManualClock;
use kalzit::config::Config;
use kalzit::provisioning::grafana::{self, ItemStatus, SourceTarget};
use serde_json::{Value, json};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";

struct TestApp {
    app: Router,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
    sources: tempfile::TempDir,
    org: String,
    owner: String,
    schema: Option<common::PgSchema>,
}

struct Reply {
    status: StatusCode,
    body: Value,
}

impl Reply {
    fn reason(&self) -> &str {
        self.body["error"]["reason"].as_str().unwrap_or("")
    }
}

#[derive(Clone)]
enum Who {
    Owner,
    Token(String),
}

impl TestApp {
    async fn new() -> TestApp {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().to_path_buf();
        let schema = common::database().await;
        config.database.url = schema.as_ref().map(|s| s.url.clone());
        let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
        let clock = Arc::new(ManualClock::new(1_800_000_000_000));
        let state = AppState::new(config, pool, clock, Some(SETUP_CODE.into())).await.unwrap();
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let app = router(state.clone()).layer(MockConnectInfo(peer));
        let mut t = TestApp {
            app,
            state,
            dir: Arc::new(dir),
            sources: common::private_tempdir(),
            org: String::new(),
            owner: String::new(),
            schema,
        };
        let r = t
            .raw(
                Method::POST,
                "/api/setup",
                Some(json!({ "token": SETUP_CODE, "orgName": "MouseWerk", "name": "Lea Hoffmann",
                             "email": "lea@example.de", "password": PASSWORD })),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        t.org = r.body["orgs"][0]["id"].as_str().unwrap().to_string();
        // SQLite sources may read files of the test's folder.
        let folder = t.sources.path().to_string_lossy().to_string();
        let r = t
            .raw(
                Method::PATCH,
                "/api/admin/settings/datasources.sqlite_dirs",
                Some(json!({ "value": [folder], "version": 0 })),
                Some(&Who::Owner),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let pool = sqlx::SqlitePool::connect(&kalzit::config::sqlite_url(&t.sqlite_path())).await.unwrap();
        sqlx::raw_sql("CREATE TABLE m (host TEXT, v REAL, t INTEGER); INSERT INTO m VALUES ('a', 2.0, 0);")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        t
    }

    fn sqlite_path(&self) -> std::path::PathBuf {
        self.sources.path().join("lager.db")
    }

    async fn finish(mut self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone()).with_schema(self.schema.take());
        let sources = std::mem::replace(&mut self.sources, tempfile::tempdir().unwrap());
        drop(self);
        finish.finish().await;
        common::remove_dir(sources);
    }

    async fn raw(&mut self, method: Method, path: &str, body: Option<Value>, who: Option<&Who>) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        match who {
            Some(Who::Owner) => req = req.header(header::COOKIE, self.owner.clone()),
            Some(Who::Token(t)) => req = req.header(header::AUTHORIZATION, format!("Bearer {t}")),
            None => {}
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        if let Some(set) = res.headers().get(header::SET_COOKIE) {
            let set = set.to_str().unwrap();
            if set.starts_with("kalzit_session=") && self.owner.is_empty() {
                self.owner = set.split(';').next().unwrap().to_string();
            }
        }
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply { status, body }
    }

    async fn call(&mut self, who: &Who, method: Method, rest: &str, body: Option<Value>) -> Reply {
        let path = format!("/api/orgs/{}{rest}", self.org);
        self.raw(method, &path, body, Some(who)).await
    }

    async fn ok(&mut self, who: &Who, method: Method, rest: &str, body: Option<Value>) -> Value {
        let r = self.call(who, method.clone(), rest, body).await;
        assert!(r.status.is_success(), "{method} {rest}: {} {}", r.status, r.body);
        r.body
    }

    /// A token of a new service account with `role` (built-in name or custom role id).
    async fn token(&mut self, name: &str, role: &str) -> Who {
        let r = self
            .call(&Who::Owner, Method::POST, "/service-accounts", Some(json!({ "name": name, "role": role })))
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        let id = r.body["id"].as_str().unwrap().to_string();
        let path = format!("/service-accounts/{id}/tokens");
        let r = self.call(&Who::Owner, Method::POST, &path, Some(json!({ "name": "ci" }))).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        Who::Token(r.body["token"].as_str().unwrap().to_string())
    }

    /// The files of the test set: a SQLite source opted in to alerting, a role, a dashboard in
    /// new folders using the source, and a rule on the source linked to the dashboard.
    fn files(&self) -> BTreeMap<String, String> {
        let path = self.sqlite_path().to_string_lossy().replace('\\', "/");
        let mut files = BTreeMap::new();
        files.insert(
            "datasources/lager.yaml".into(),
            format!(
                "apiVersion: kalzit/v1\nkind: DataSource\nuid: lager\nspec:\n  name: Lager\n  type: sqlite\n  settings:\n    \
                 path: \"{path}\"\n  alerting:\n    enabled: true\n"
            ),
        );
        files.insert(
            "roles/auditors.yaml".into(),
            "kind: Role\nuid: auditors\nspec:\n  name: Prüfer\n  description: Liest das Audit-Log\n  permissions: [audit:read, dashboards:read]\n".into(),
        );
        files.insert(
            "dashboards/lager.yaml".into(),
            "kind: Dashboard\nuid: lager-board\nspec:\n  folder: Betrieb/Lager\n  model:\n    schemaVersion: 2\n    title: Lager\n    \
             timeRange: {from: now-6h, to: now}\n    panels:\n      - id: p1\n        type: table\n        title: Werte\n        \
             grid: {x: 0, y: 0, w: 12, h: 8}\n        targets:\n          - refId: A\n            datasourceId: lager\n            \
             query: {sql: \"SELECT host, v FROM m\"}\n"
                .into(),
        );
        files.insert(
            "alert-rules/hoch.json".into(),
            json!({
                "kind": "AlertRule", "uid": "lager-hoch",
                "spec": {
                    "name": "Lager hoch", "datasourceId": "lager",
                    "query": { "query": { "sql": "SELECT host, v FROM m" } },
                    "reduce": { "shape": "frame", "function": "last" },
                    "condition": { "op": "gt", "value": 1.5 },
                    "intervalSecs": 60, "noDataState": "ok", "labels": { "team": "lager" },
                    "dashboard": "lager-board", "panelId": "p1"
                }
            })
            .to_string(),
        );
        files
    }

    fn body(files: &BTreeMap<String, String>, extra: Value) -> Value {
        let list: Vec<Value> = files.iter().map(|(p, c)| json!({ "path": p, "content": c })).collect();
        let mut body = json!({ "files": list });
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        body
    }

    async fn plan(&mut self, who: &Who, files: &BTreeMap<String, String>, extra: Value) -> Reply {
        self.call(who, Method::POST, "/provisioning/plan", Some(Self::body(files, extra))).await
    }

    async fn apply(&mut self, who: &Who, files: &BTreeMap<String, String>, extra: Value) -> Reply {
        self.call(who, Method::POST, "/provisioning/apply", Some(Self::body(files, extra))).await
    }
}

fn actions(plan: &Value) -> Vec<(String, String, bool)> {
    plan["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (c["uid"].as_str().unwrap().to_string(), c["action"].as_str().unwrap().to_string(), c["drifted"] == true)
        })
        .collect()
}

fn count(plan: &Value, key: &str) -> u64 {
    plan["counts"][key].as_u64().unwrap()
}

fn id_of(plan: &Value, uid: &str) -> String {
    plan["changes"].as_array().unwrap().iter().find(|c| c["uid"] == uid).unwrap()["resourceId"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn plan_apply_prune_and_export_round_trip() {
    let mut t = TestApp::new().await;
    let admin = t.token("ci", "admin").await;
    let files = t.files();

    let plan = t.plan(&admin, &files, json!({})).await;
    assert_eq!(plan.status, StatusCode::OK, "{}", plan.body);
    assert_eq!(count(&plan.body, "create"), 4, "{}", plan.body);
    assert_eq!(plan.body["set"], "default");
    // A plan changes nothing.
    assert_eq!(t.ok(&Who::Owner, Method::GET, "/provisioning/resources", None).await["items"], json!([]));

    let applied = t.apply(&admin, &files, json!({})).await;
    assert_eq!(applied.status, StatusCode::OK, "{}", applied.body);
    assert_eq!(count(&applied.body["plan"], "create"), 4);
    assert_eq!(applied.body["warnings"], json!([]), "the SQLite source connects");

    // Applying the same files again changes nothing and nothing drifted.
    let again = t.plan(&admin, &files, json!({})).await.body;
    assert_eq!(count(&again, "unchanged"), 4, "{again}");
    assert_eq!(count(&again, "drifted"), 0, "{again}");
    let dashboard = id_of(&again, "lager-board");
    let source = id_of(&again, "lager");
    let rule = id_of(&again, "lager-hoch");
    let board = t.ok(&Who::Owner, Method::GET, &format!("/dashboards/{dashboard}"), None).await;
    assert_eq!(board["model"]["panels"][0]["targets"][0]["datasourceId"], source.as_str());
    let rule_view = t.ok(&Who::Owner, Method::GET, &format!("/alerting/rules/{rule}"), None).await;
    assert_eq!(rule_view["dashboardId"], dashboard.as_str());
    let listed = t.ok(&admin, Method::GET, "/provisioning/resources", None).await;
    assert_eq!(listed["items"].as_array().unwrap().len(), 4);

    // Export: the set's resources at their files, the round trip changes nothing.
    let export = t.ok(&admin, Method::GET, "/provisioning/export?set=default", None).await;
    let exported: BTreeMap<String, String> = export["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["path"].as_str().unwrap().to_string(), f["content"].as_str().unwrap().to_string()))
        .collect();
    assert!(exported.contains_key("org.yaml"));
    for path in files.keys() {
        assert!(exported.contains_key(path), "{path} missing from {:?}", exported.keys());
    }
    assert!(exported["datasources/lager.yaml"].contains("uid: lager"));
    let round = t.plan(&admin, &exported, json!({})).await;
    assert_eq!(round.status, StatusCode::OK, "{}", round.body);
    assert_eq!(count(&round.body, "unchanged"), 4, "{}", round.body);

    // A change in a file is an update naming the field.
    let mut changed = files.clone();
    let text = changed["dashboards/lager.yaml"].replace("title: Lager", "title: Lager neu");
    changed.insert("dashboards/lager.yaml".into(), text);
    let plan = t.plan(&admin, &changed, json!({})).await.body;
    let change = plan["changes"].as_array().unwrap().iter().find(|c| c["uid"] == "lager-board").unwrap().clone();
    assert_eq!(change["action"], "update");
    assert_eq!(change["fields"], json!(["model.title"]));

    // A file gone: orphaned and kept without prune, deleted with it.
    let mut fewer = files.clone();
    fewer.remove("roles/auditors.yaml");
    let applied = t.apply(&admin, &fewer, json!({})).await.body;
    assert!(actions(&applied["plan"]).contains(&("auditors".into(), "orphaned".into(), false)), "{applied}");
    let roles = t.ok(&Who::Owner, Method::GET, "/roles", None).await;
    assert!(roles["items"].as_array().unwrap().iter().any(|r| r["name"] == "Prüfer"));
    let applied = t.apply(&admin, &fewer, json!({ "prune": true })).await.body;
    assert!(actions(&applied["plan"]).contains(&("auditors".into(), "delete".into(), false)), "{applied}");
    let roles = t.ok(&Who::Owner, Method::GET, "/roles", None).await;
    assert!(!roles["items"].as_array().unwrap().iter().any(|r| r["name"] == "Prüfer"));

    // Every apply is audited, with each change.
    let audit = t.ok(&Who::Owner, Method::GET, "/audit?limit=200", None).await;
    let names: Vec<&str> = audit["items"].as_array().unwrap().iter().filter_map(|e| e["action"].as_str()).collect();
    assert!(names.iter().filter(|a| **a == "provisioning.applied").count() >= 3, "{names:?}");
    assert!(names.contains(&"role.deleted") && names.contains(&"alert_rule.created"), "{names:?}");
    t.finish().await;
}

#[tokio::test]
async fn managed_resources_are_read_only_until_unlocked() {
    let mut t = TestApp::new().await;
    let admin = t.token("ci", "admin").await;
    let files = t.files();
    let applied = t.apply(&admin, &files, json!({})).await;
    assert_eq!(applied.status, StatusCode::OK, "{}", applied.body);
    let plan = &applied.body["plan"];
    let (dashboard, source, rule, role) =
        (id_of(plan, "lager-board"), id_of(plan, "lager"), id_of(plan, "lager-hoch"), id_of(plan, "auditors"));

    let board = t.ok(&Who::Owner, Method::GET, &format!("/dashboards/{dashboard}"), None).await;
    let mut model = board["model"].clone();
    model["title"] = json!("Von Hand");
    let save = json!({ "model": model, "version": board["version"] });
    let r = t.call(&Who::Owner, Method::PUT, &format!("/dashboards/{dashboard}"), Some(save.clone())).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "provisioning.read_only"), "{}", r.body);
    assert_eq!(r.body["error"]["params"]["path"], "dashboards/lager.yaml", "{}", r.body);
    let r = t.call(&Who::Owner, Method::DELETE, &format!("/dashboards/{dashboard}"), None).await;
    assert_eq!(r.reason(), "provisioning.read_only");
    let r =
        t.call(&Who::Owner, Method::PATCH, &format!("/datasources/{source}"), Some(json!({ "name": "Anders" }))).await;
    assert_eq!(r.reason(), "provisioning.read_only", "{}", r.body);
    let r = t.call(&Who::Owner, Method::PATCH, &format!("/roles/{role}"), Some(json!({ "name": "Anders" }))).await;
    assert_eq!(r.reason(), "provisioning.read_only", "{}", r.body);
    let r = t.call(&Who::Owner, Method::DELETE, &format!("/alerting/rules/{rule}"), None).await;
    assert_eq!(r.reason(), "provisioning.read_only", "{}", r.body);
    let folder = board["folderId"].as_str().unwrap().to_string();
    let r = t.call(&Who::Owner, Method::DELETE, &format!("/folders/{folder}"), None).await;
    assert_eq!(r.reason(), "provisioning.read_only", "{}", r.body);

    // An emergency: an admin unlocks the dashboard and edits it; it has drifted.
    let r = t.call(&admin, Method::POST, "/provisioning/resources/dashboard/lager-board/unlock", None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.body["unlockedAt"].is_i64());
    let r = t.call(&Who::Owner, Method::PUT, &format!("/dashboards/{dashboard}"), Some(save)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let plan = t.plan(&admin, &files, json!({})).await.body;
    assert!(actions(&plan).contains(&("lager-board".into(), "update".into(), true)), "{plan}");
    let listed = t.ok(&admin, Method::GET, "/provisioning/resources", None).await;
    let entry = listed["items"].as_array().unwrap().iter().find(|p| p["uid"] == "lager-board").unwrap().clone();
    assert_eq!((entry["drifted"].clone(), entry["missing"].clone()), (json!(true), json!(false)));

    // The next apply overwrites it and locks it again.
    t.apply(&admin, &files, json!({})).await;
    let board = t.ok(&Who::Owner, Method::GET, &format!("/dashboards/{dashboard}"), None).await;
    assert_eq!(board["model"]["title"], "Lager");
    let save = json!({ "model": board["model"], "version": board["version"] });
    let r = t.call(&Who::Owner, Method::PUT, &format!("/dashboards/{dashboard}"), Some(save)).await;
    assert_eq!(r.reason(), "provisioning.read_only");

    // Deleted some other way (after an unlock): missing, made again by the next apply.
    t.ok(&admin, Method::POST, "/provisioning/resources/role/auditors/unlock", None).await;
    t.ok(&Who::Owner, Method::DELETE, &format!("/roles/{role}"), None).await;
    let plan = t.plan(&admin, &files, json!({})).await.body;
    assert!(actions(&plan).contains(&("auditors".into(), "create".into(), true)), "{plan}");
    let unlocked = t.ok(&Who::Owner, Method::GET, "/audit?limit=200", None).await;
    assert!(unlocked["items"].as_array().unwrap().iter().any(|e| e["action"] == "provisioning.unlocked"));
    t.finish().await;
}

#[tokio::test]
async fn secrets_come_from_references_and_connection_failures_warn() {
    let mut t = TestApp::new().await;
    let admin = t.token("ci", "admin").await;
    let pg = |secret: &str| {
        let mut files = BTreeMap::new();
        files.insert(
            "datasources/pg.yaml".to_string(),
            format!(
                "kind: DataSource\nuid: pg\nspec:\n  name: Postgres\n  type: postgres\n  settings:\n    host: 127.0.0.1\n    \
                 port: 9\n    database: lager\n    user: leser\n  secrets:\n    password: {secret}\n"
            ),
        );
        files
    };
    // The variable's value comes with the request; a missing one, Kalzit's own and a store
    // reference without a stored value are refused.
    let r = t.plan(&admin, &pg("{ env: PG_PASS }"), json!({})).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "provisioning.invalid_files"));
    assert!(r.body["error"]["message"].as_str().unwrap().contains("PG_PASS is not set"), "{}", r.body);
    let r = t
        .plan(&admin, &pg("{ env: KALZIT_SECRETS_KEY }"), json!({ "secretValues": { "KALZIT_SECRETS_KEY": "x" } }))
        .await;
    assert!(r.body["error"]["message"].as_str().unwrap().contains("Kalzit's own"), "{}", r.body);
    // A client sending a value of Kalzit's own is refused, whatever the files name.
    let r = t.plan(&admin, &pg("{ env: PG_PASS }"), json!({ "secretValues": { "kalzit_secrets_key": "x" } })).await;
    assert_eq!((r.status, r.body["error"]["field"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("secretValues")));
    // A file's value comes with the request under its path.
    let r = t
        .plan(&admin, &pg("{ fromFile: secrets/pg.txt }"), json!({ "secretValues": { "file:secrets/pg.txt": "x" } }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.plan(&admin, &pg("{ fromFile: /var/lib/kalzit/key }"), json!({})).await;
    assert!(r.body["error"]["message"].as_str().unwrap().contains("Kalzit's own files"), "{}", r.body);
    // A path out of a folder or into the system is refused before a value is looked at.
    for (bad, says) in [("/proc/self/environ", "system or device path"), ("../pw.txt", "without ..")] {
        let key = format!("file:{bad}");
        let r = t.plan(&admin, &pg(&format!("{{ fromFile: {bad} }}")), json!({ "secretValues": { key: "x" } })).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}: {}", r.body);
        assert!(r.body["error"]["message"].as_str().unwrap().contains(says), "{}", r.body);
    }
    // An absolute path is a folder given to the command line with --secret-dir; the server never
    // reads files, so it takes the value the command line sent.
    let r = t
        .plan(&admin, &pg("{ fromFile: /run/secrets/pg }"), json!({ "secretValues": { "file:/run/secrets/pg": "x" } }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.plan(&admin, &pg("{ store: true }"), json!({})).await;
    assert!(r.body["error"]["message"].as_str().unwrap().contains("store holds no value"), "{}", r.body);
    let r = t.plan(&admin, &pg("geheim"), json!({})).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "a secret in the file is refused: {}", r.body);

    let values = json!({ "secretValues": { "PG_PASS": "erstes-geheimnis" } });
    let r = t.apply(&admin, &pg("{ env: PG_PASS }"), values.clone()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // Nothing listens on port 9: the apply stands, with a warning.
    let warnings = r.body["warnings"].as_array().unwrap();
    assert_eq!(warnings.len(), 1, "{}", r.body);
    assert_eq!(warnings[0]["reason"], "datasource.connection_failed");
    let id = id_of(&r.body["plan"], "pg");
    let ds = t.ok(&Who::Owner, Method::GET, &format!("/datasources/{id}"), None).await;
    assert_eq!(ds["secrets"]["password"]["set"], true);
    assert!(!ds.to_string().contains("erstes-geheimnis"));

    // The same value changes nothing; another one is an update of the secret.
    let same = t.plan(&admin, &pg("{ env: PG_PASS }"), values).await.body;
    assert_eq!(count(&same, "unchanged"), 1, "{same}");
    let other = t.plan(&admin, &pg("{ env: PG_PASS }"), json!({ "secretValues": { "PG_PASS": "zweites" } })).await.body;
    assert_eq!(other["changes"][0]["fields"], json!(["secrets.password"]), "{other}");
    // Keeping the stored value is fine; the export names the variable, never the value.
    let keep = t.plan(&admin, &pg("{ store: true }"), json!({})).await;
    assert_eq!(keep.status, StatusCode::OK, "{}", keep.body);
    let export = t.ok(&admin, Method::GET, "/provisioning/export", None).await.to_string();
    assert!(export.contains("env: PG_PASS") && !export.contains("erstes-geheimnis"), "{export}");
    // A new host with the stored value is refused: the secret would go elsewhere.
    let moved = pg("{ store: true }")["datasources/pg.yaml"].replace("127.0.0.1", "127.0.0.2");
    let r = t.plan(&admin, &BTreeMap::from([("datasources/pg.yaml".to_string(), moved)]), json!({})).await;
    assert!(
        r.body["error"]["message"].as_str().unwrap().contains("change where the data source connects"),
        "{}",
        r.body
    );
    t.finish().await;
}

#[tokio::test]
async fn rights_and_sets_are_enforced() {
    let mut t = TestApp::new().await;
    let editor = t.token("editor-1", "editor").await;
    let files = t.files();
    let r = t.plan(&editor, &files, json!({})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t.call(&editor, Method::GET, "/provisioning/export", None).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);

    // Applying needs the right of every kind it changes: a role without roles:write cannot apply
    // the role's file.
    let role = t
        .ok(
            &Who::Owner,
            Method::POST,
            "/roles",
            Some(json!({ "name": "Bereitsteller", "permissions": [
                "provisioning:read", "provisioning:write", "dashboards:read", "dashboards:write", "folders:read",
                "folders:write", "datasources:query", "datasources:read", "datasources:write", "alerts:read", "alerts:write"
            ] })),
        )
        .await;
    let partial = t.token("partial", role["id"].as_str().unwrap()).await;
    let r = t.apply(&partial, &files, json!({})).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    assert!(r.body["error"]["message"].as_str().unwrap().contains("the Role files need roles:write"), "{}", r.body);
    let mut without_role = files.clone();
    without_role.remove("roles/auditors.yaml");
    let r = t.apply(&partial, &without_role, json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    // A resource has one set: another set cannot take it.
    let admin = t.token("ci", "admin").await;
    let r = t.plan(&admin, &without_role, json!({ "set": "zweiter" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    assert!(
        r.body["error"]["message"].as_str().unwrap().contains("belongs to the provisioning set default"),
        "{}",
        r.body
    );
    let r = t.plan(&admin, &without_role, json!({ "set": "kein set" })).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    // Unlocking is provisioning:write.
    let viewer = t.token("viewer-1", "viewer").await;
    let r = t.call(&viewer, Method::POST, "/provisioning/resources/dashboard/lager-board/unlock", None).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    t.finish().await;
}

/// Export and the list of managed resources leave out what the caller may not read: here data
/// sources, and so the rule on one (its query and data are for those who may read the source).
#[tokio::test]
async fn export_and_list_leave_out_what_the_caller_may_not_read() {
    let mut t = TestApp::new().await;
    let admin = t.token("ci", "admin").await;
    let files = t.files();
    let r = t.apply(&admin, &files, json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let role = t
        .ok(
            &Who::Owner,
            Method::POST,
            "/roles",
            Some(json!({ "name": "Leser", "permissions": [
                "provisioning:read", "dashboards:read", "folders:read", "alerts:read", "roles:read"
            ] })),
        )
        .await;
    let reader = t.token("reader", role["id"].as_str().unwrap()).await;
    let export = t.ok(&reader, Method::GET, "/provisioning/export", None).await;
    let paths: Vec<&str> = export["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert!(paths.contains(&"dashboards/lager.yaml") && paths.contains(&"roles/auditors.yaml"), "{paths:?}");
    assert!(!paths.iter().any(|p| p.starts_with("datasources/") || p.starts_with("alert-rules/")), "{paths:?}");
    let skipped = export["skipped"].to_string();
    assert!(skipped.contains("datasources:read") && skipped.contains("its data source"), "{skipped}");
    assert!(!skipped.contains("Lager hoch"), "a rule left out is not named: {skipped}");
    let listed = t.ok(&reader, Method::GET, "/provisioning/resources", None).await;
    let uids: Vec<&str> = listed["items"].as_array().unwrap().iter().map(|p| p["uid"].as_str().unwrap()).collect();
    assert_eq!(uids.len(), 2, "{uids:?}");
    assert!(!uids.contains(&"lager") && !uids.contains(&"lager-hoch"), "{uids:?}");
    t.finish().await;
}

#[tokio::test]
async fn invalid_files_are_reported_together() {
    let mut t = TestApp::new().await;
    let admin = t.token("ci", "admin").await;
    let mut files = t.files();
    files.insert("roles/bad.yaml".into(), "kind: Role\nuid: bad\nspec:\n  name: Admin\n  permissions: []\n".into());
    files.insert("dashboards/bad.yaml".into(), "kind: Dashboard\nuid: kaputt\nspec:\n  model: {title: \"\"}\n".into());
    files.insert("dashboards/dup.yaml".into(), "kind: Dashboard\nuid: lager-board\nspec: {model: {}}\n".into());
    files.insert(
        "x.yaml".into(),
        "kind: Dashboard\nuid: x\nspec: {model: {title: T, panels: [{id: p, type: table, \
        grid: {x: 0, y: 0, w: 4, h: 4}, targets: [{refId: A, datasourceId: unbekannt, query: {}}]}]}}\n"
            .into(),
    );
    let r = t.plan(&admin, &files, json!({})).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let message = r.body["error"]["message"].as_str().unwrap();
    assert!(message.contains("dashboards/dup.yaml"), "{message}");
    // The duplicate stops the reading; the checks of the specs follow once the files read.
    files.remove("dashboards/dup.yaml");
    let r = t.plan(&admin, &files, json!({})).await;
    let message = r.body["error"]["message"].as_str().unwrap();
    assert!(message.starts_with("3 problem(s)"), "{message}");
    assert!(message.contains("roles/bad.yaml") && message.contains("built-in role"), "{message}");
    assert!(
        message.contains("dashboards/bad.yaml") && message.contains("x.yaml: model: the data source unbekannt"),
        "{message}"
    );
    // Nothing was applied.
    let r = t.apply(&admin, &files, json!({})).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(t.ok(&admin, Method::GET, "/provisioning/resources", None).await["items"], json!([]));
    t.finish().await;
}

fn fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/grafana").join(name);
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn status_of(report: &grafana::ImportReport, name: &str) -> ItemStatus {
    report.items.iter().find(|i| i.name.contains(name)).unwrap_or_else(|| panic!("no item {name}")).status
}

#[test]
fn grafana_fixtures_convert_with_their_report() {
    let sources =
        BTreeMap::from([("DS_LAGER".to_string(), SourceTarget { id: "ds-lager".into(), kind: "sqlite".into() })]);
    let c = grafana::convert(&fixture("modern.json"), &sources).unwrap();
    let r = &c.report;
    assert_eq!(r.source_version, Some(39));
    assert_eq!(status_of(r, "panel 1 \"Bestand\""), ItemStatus::Converted);
    assert_eq!(status_of(r, "panel 2 \"Verlauf\""), ItemStatus::Approximated);
    assert_eq!(status_of(r, "panel 3 \"Standorte\""), ItemStatus::Skipped);
    assert_eq!(status_of(r, "panel 4 \"Ohne Zuordnung\""), ItemStatus::Skipped);
    // Its value mapping is taken over.
    assert_eq!(status_of(r, "panel 6 \"Alle Werte\""), ItemStatus::Converted);
    assert_eq!(status_of(r, "panel 7 \"Hinweis\""), ItemStatus::Approximated);
    assert_eq!(status_of(r, "panel 8 \"Weitere\""), ItemStatus::Skipped);
    assert_eq!(status_of(r, "panel 9 \"Library\""), ItemStatus::Skipped);
    assert_eq!(status_of(r, "variable host"), ItemStatus::Approximated);
    assert_eq!(status_of(r, "variable hosts_from_db"), ItemStatus::Approximated);
    assert_eq!(status_of(r, "variable filter"), ItemStatus::Skipped);
    assert_eq!(status_of(r, "variable step"), ItemStatus::Approximated);
    assert_eq!(status_of(r, "variable site"), ItemStatus::Converted);
    assert_eq!(status_of(r, "variable bad-name"), ItemStatus::Skipped);
    assert_eq!(status_of(r, "annotation Annotations"), ItemStatus::Skipped);
    assert_eq!(status_of(r, "annotation Lieferungen"), ItemStatus::Converted);
    assert_eq!(status_of(r, "link Mehr"), ItemStatus::Approximated);
    assert_eq!(status_of(r, "link Gefahr"), ItemStatus::Skipped);
    assert_eq!(r.counts.converted + r.counts.approximated + r.counts.skipped, r.items.len() as u32);

    let m = &c.model;
    // Skipped panels are not kept as placeholders.
    let ids: Vec<&str> = m["panels"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["p1", "p2", "p6", "p7"]);
    assert_eq!(m["panels"][1]["type"], "timeseries");
    assert_eq!(
        m["panels"][1]["targets"][0]["query"]["sql"],
        "SELECT t, v FROM m WHERE $__timeFilter(t) AND t < $__timeTo"
    );
    assert_eq!(m["panels"][0]["options"]["reducer"], "last");
    assert_eq!(m["panels"][0]["fieldConfig"]["defaults"]["thresholds"]["steps"][1]["tone"], "critical");
    assert_eq!((m["panels"][2]["rowId"].clone(), m["panels"][2]["grid"]["y"].clone()), (json!("row-5"), json!(0)));
    assert_eq!(m["rows"][0]["collapsed"], true);
    assert_eq!(m["panels"][3]["options"]["mode"], "plain");
    assert_eq!(m["timeRange"], json!({ "from": "now-24h", "to": "now" }));
    assert_eq!((m["refreshSeconds"].clone(), m["timeZone"].clone()), (json!(60), json!("Europe/Berlin")));
    assert_eq!(m["refreshIntervals"], json!([10, 60, 300]));
    assert_eq!((m["sharedCursor"].clone(), m["weekStart"].clone()), (json!("crosshair"), json!("monday")));
    assert_eq!(m["tags"], json!(["lager", "betrieb"]));
    assert_eq!(m["variables"][0]["options"][2], json!({ "value": "gamma", "label": "Gamma" }));
    // Standing on one value, not on "All": that value stays, the "All" entry is reported.
    assert_eq!((m["variables"][0]["current"].clone(), m["variables"][0].get("allByDefault")), (json!(["alpha"]), None));
    assert_eq!(
        m["panels"][2]["fieldConfig"]["defaults"]["mappings"],
        json!([{ "type": "value", "value": "1", "text": "an" }])
    );
    assert_eq!(m["panels"][0]["fieldConfig"]["defaults"]["unit"], "short");
    assert_eq!(m["annotations"][0]["enabled"], false);

    let sources =
        BTreeMap::from([("Lager".to_string(), SourceTarget { id: "ds-lager".into(), kind: "sqlite".into() })]);
    let c = grafana::convert(&fixture("legacy.json"), &sources).unwrap();
    let m = &c.model;
    assert_eq!(c.report.source_version, Some(14));
    assert_eq!(status_of(&c.report, "panel 1 \"Anzahl\""), ItemStatus::Approximated);
    assert_eq!(status_of(&c.report, "panel 4 \"Welt\""), ItemStatus::Skipped);
    let grids: Vec<Value> = m["panels"].as_array().unwrap().iter().map(|p| p["grid"].clone()).collect();
    assert_eq!(grids[0], json!({ "x": 0, "y": 0, "w": 8, "h": 9 }));
    assert_eq!(grids[1], json!({ "x": 8, "y": 0, "w": 16, "h": 9 }));
    assert_eq!(grids[2], json!({ "x": 0, "y": 9, "w": 24, "h": 9 }));
    assert_eq!(m["panels"][0]["targets"][0]["query"]["sql"], "SELECT COUNT(*) FROM m WHERE host = '$host'");
    assert_eq!(m["panels"][2]["targets"][0]["hide"], true);
    assert_eq!(m["timeRange"]["from"], "2026-01-01T00:00:00Z");
    assert_eq!(m["rows"].as_array().unwrap().len(), 2);
}

fn notes_of(report: &grafana::ImportReport, name: &str) -> Vec<String> {
    let item = report.items.iter().find(|i| i.name.contains(name)).unwrap_or_else(|| panic!("no item {name}"));
    item.notes.iter().map(|n| n.code.clone()).collect()
}

fn panel<'a>(model: &'a Value, id: &str) -> &'a Value {
    model["panels"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap_or_else(|| panic!("no panel {id}"))
}

/// A real export of a Grafana 13 dashboard (`shop-ops.json`, trimmed): units, overrides, value
/// mappings, series names, graph styles, table columns and "All" variables carry over, and the
/// report names only what has no counterpart.
#[test]
fn grafana_real_export_carries_units_overrides_mappings_and_styles() {
    let target = |id: &str, kind: &str| SourceTarget { id: id.into(), kind: kind.into() };
    let sources = BTreeMap::from([
        ("shop-pg".to_string(), target("ds-pg", "postgres")),
        ("prom".to_string(), target("ds-prom", "prometheus")),
        ("loki".to_string(), target("ds-loki", "loki")),
    ]);
    let c = grafana::convert(&fixture("shop-ops.json"), &sources).unwrap();
    let (m, r) = (&c.model, &c.report);
    assert_eq!(r.source_version, Some(41));

    // Units: Grafana's ids become Kalzit's catalog units.
    let revenue = panel(m, "p1");
    assert_eq!(revenue["fieldConfig"]["defaults"]["unit"], "currency:EUR");
    assert_eq!(revenue["fieldConfig"]["defaults"]["decimals"], 0);
    assert_eq!(
        revenue["options"],
        json!({ "reducer": "sum", "colorMode": "background", "graphMode": "area", "textMode": "valueAndName" })
    );
    let tones: Vec<&Value> = revenue["fieldConfig"]["defaults"]["thresholds"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| &s["tone"])
        .collect();
    assert_eq!(tones, [&json!("critical"), &json!("warn"), &json!("ok")]);
    assert_eq!(status_of(r, "panel 1 \"Revenue\""), ItemStatus::Converted);
    assert_eq!(panel(m, "p3")["fieldConfig"]["defaults"]["unit"], "percent");
    assert_eq!(panel(m, "p12")["fieldConfig"]["defaults"]["unit"], "percent");

    // Overrides by name.
    assert_eq!(
        panel(m, "p2")["fieldConfig"]["overrides"],
        json!([{ "matcher": { "type": "name", "value": "refunds" }, "properties": { "color": "critical" } }])
    );
    assert_eq!(status_of(r, "panel 2 \"Orders\""), ItemStatus::Converted);

    // Time series: graph style, legend with all its values, tooltip with its sort order.
    let per_region = panel(m, "p5");
    assert_eq!(
        per_region["fieldConfig"]["defaults"],
        json!({ "unit": "currency:EUR", "drawStyle": "line", "fill": "solid", "fillOpacity": 25,
                "lineInterpolation": "smooth", "stack": "normal" })
    );
    assert_eq!(
        per_region["options"],
        json!({ "legend": { "mode": "table", "placement": "right", "values": ["sum", "mean", "max"] },
                "tooltip": { "mode": "all", "sort": "desc" } })
    );
    assert!(notes_of(r, "panel 5 \"Revenue per region\"").is_empty());

    // Bar chart: the green-to-red scheme becomes threshold colours, horizontal bars are reported.
    let per_product = panel(m, "p6");
    assert_eq!(per_product["options"], json!({ "showValues": true }));
    assert_eq!(per_product["fieldConfig"]["defaults"]["thresholds"]["mode"], "percentage");
    assert_eq!(per_product["fieldConfig"]["defaults"]["unit"], "currency:EUR");
    assert_eq!(notes_of(r, "panel 6 \"Revenue per product\""), ["bar_orientation", "color_scheme_thresholds"]);

    let pie = panel(m, "p7");
    assert_eq!(
        pie["options"],
        json!({ "legend": { "mode": "table", "placement": "right" }, "pieType": "donut", "reducer": "last",
                "legendValues": ["value", "percent"] })
    );
    assert_eq!(status_of(r, "panel 7 \"Orders per channel\""), ItemStatus::Converted);

    // Table: the organize step becomes a step that renames the columns, the overrides match the
    // new names as in Grafana, cell displays and mappings carry over, the footer becomes Kalzit's,
    // the sort order is reported.
    let table = panel(m, "p8");
    let steps = table["transformations"].as_array().unwrap();
    assert_eq!(steps.len(), 1, "{steps:?}");
    assert_eq!(steps[0]["type"], "organize");
    assert_eq!(
        steps[0]["rename"],
        json!({ "country": "Country", "customer": "Customer", "last_status": "Last order", "orders": "Orders",
                "revenue": "Revenue", "segment": "Segment" })
    );
    assert_eq!(
        table["options"],
        json!({ "columnFilters": true, "footer": { "show": true, "over": "all", "columns": [
            { "column": "Orders", "calc": "sum" }, { "column": "Revenue", "calc": "sum" }
        ] } })
    );
    let overrides = table["fieldConfig"]["overrides"].as_array().unwrap();
    let column = |name: &str| {
        overrides
            .iter()
            .find(|o| o["matcher"] == json!({ "type": "name", "value": name }))
            .map(|o| o["properties"].clone())
            .unwrap_or_else(|| panic!("no override for {name}"))
    };
    assert_eq!(column("Revenue"), json!({ "unit": "currency:EUR", "cellDisplay": "gauge", "max": 3000.0 }));
    let status = column("Last order");
    assert_eq!(status["cellDisplay"], "color-background");
    assert!(status.get("displayName").is_none(), "{status}");
    assert_eq!(
        status["mappings"],
        json!([
            { "type": "value", "value": "paid", "text": "Paid", "tone": "ok" },
            { "type": "value", "value": "shipped", "text": "Shipped", "tone": "chart-1" },
            { "type": "value", "value": "refunded", "text": "Refunded", "tone": "warn" },
            { "type": "value", "value": "cancelled", "text": "Cancelled", "tone": "critical" },
        ])
    );
    let customer = column("Customer");
    assert_eq!(customer["cellDisplay"], "link");
    assert!(customer["link"].as_str().unwrap().contains("c.name='${__value}'"), "{customer}");
    // The step names the other columns; they need no override.
    assert_eq!(overrides.len(), 3, "{overrides:?}");
    assert_eq!(notes_of(r, "panel 8 \"Top customers\""), ["table_sort", "link_grafana_path"]);

    // Thresholds drawn as lines and areas; the transparent base step becomes neutral.
    let cpu = panel(m, "p9");
    assert_eq!(cpu["fieldConfig"]["defaults"]["thresholdDisplay"], "linesAndAreas");
    assert_eq!(cpu["fieldConfig"]["defaults"]["thresholds"]["steps"][0], json!({ "value": null, "tone": "neutral" }));
    assert_eq!(
        cpu["fieldConfig"]["overrides"],
        json!([{ "matcher": { "type": "name", "value": "db-1" }, "properties": { "color": "chart-6", "lineWidth": 3 } }])
    );
    assert_eq!(notes_of(r, "panel 9 \"CPU per host\""), ["threshold_transparent"]);

    // Heatmap: the data holds buckets; the colour scheme has no counterpart.
    let heatmap = panel(m, "p10");
    assert_eq!(heatmap["options"], json!({ "mode": "buckets" }));
    assert_eq!(heatmap["fieldConfig"]["defaults"]["unit"], "ms");
    assert_eq!(notes_of(r, "panel 10 \"Latency distribution\""), ["heatmap_colors"]);

    // Value mappings on the state timeline and the status history.
    assert_eq!(
        panel(m, "p11")["fieldConfig"]["defaults"]["mappings"],
        json!([{ "type": "range", "from": 0.0, "to": 0.0, "text": "OK", "tone": "ok" }])
    );
    assert_eq!(status_of(r, "panel 11 \"Errors per host\""), ItemStatus::Converted);
    assert_eq!(
        panel(m, "p14")["fieldConfig"]["defaults"]["mappings"],
        json!([
            { "type": "value", "value": "0", "text": "Down", "tone": "critical" },
            { "type": "value", "value": "1", "text": "Up", "tone": "ok" },
        ])
    );
    assert_eq!(notes_of(r, "panel 14 \"Scrape targets ($job)\""), ["legend_format"]);
    assert_eq!(
        panel(m, "p12")["options"],
        json!({ "reducer": "last", "displayMode": "lcd", "orientation": "horizontal" })
    );

    // Series names from the legend formats.
    assert_eq!(panel(m, "p13")["options"]["seriesName"], "{{mode}}");
    assert_eq!(notes_of(r, "panel 13 \"Node CPU busy\""), ["legend_format_mixed"]);
    let logs = panel(m, "p15");
    assert_eq!(logs["options"]["seriesName"], "{{level}}");
    assert_eq!(logs["fieldConfig"]["defaults"]["drawStyle"], "bars");
    assert_eq!(status_of(r, "panel 15 \"Log lines per level\""), ItemStatus::Converted);
    assert_eq!(status_of(r, "panel 16 \"Errors and warnings\""), ItemStatus::Skipped);

    // "All" variables start with every value picked; the "All" entry itself is reported.
    for (i, name) in ["region", "product", "host"].into_iter().enumerate() {
        let v = &m["variables"][i];
        assert_eq!(
            (v["name"].as_str(), v["multi"].as_bool(), v["allByDefault"].as_bool()),
            (Some(name), Some(true), Some(true))
        );
        assert!(v.get("current").is_none(), "{v}");
        assert_eq!(notes_of(r, &format!("variable {name}")), ["all_values"]);
    }
    assert_eq!(m["variables"][2]["options"], json!(["web-1", "web-2", "api-1", "api-2", "db-1"]));
    assert_eq!(status_of(r, "variable bucket"), ItemStatus::Converted);
    assert_eq!(status_of(r, "variable job"), ItemStatus::Skipped);

    // No panel fell back to its defaults, and no raw Grafana unit is left anywhere.
    assert!(r.items.iter().all(|i| i.notes.iter().all(|n| !n.code.starts_with("options_default"))), "{:#?}", r.items);
    assert!(!m.to_string().contains("currencyEUR"));
    assert_eq!(r.counts.skipped, 2, "{:#?}", r.items);
    assert_eq!(r.counts.converted + r.counts.approximated + r.counts.skipped, r.items.len() as u32);
}

#[tokio::test]
async fn grafana_import_saves_the_dashboard_with_its_report() {
    let mut t = TestApp::new().await;
    let path = t.sqlite_path().to_string_lossy().to_string();
    let ds = t
        .ok(
            &Who::Owner,
            Method::POST,
            "/datasources",
            Some(json!({ "name": "Lager", "kind": "sqlite", "settings": { "path": path } })),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let body =
        |dry: bool| json!({ "dashboard": fixture("modern.json"), "datasources": { "${DS_LAGER}": ds }, "dryRun": dry });
    let dry = t.ok(&Who::Owner, Method::POST, "/dashboards/import/grafana", Some(body(true))).await;
    assert!(dry["dashboard"].is_null());
    assert_eq!(dry["report"]["counts"]["skipped"], 9, "{}", dry["report"]);
    let saved = t.ok(&Who::Owner, Method::POST, "/dashboards/import/grafana", Some(body(false))).await;
    let id = saved["dashboard"]["id"].as_str().unwrap().to_string();
    assert_eq!(saved["dashboard"]["model"]["panels"].as_array().unwrap().len(), 4);
    let report = t.ok(&Who::Owner, Method::GET, &format!("/dashboards/{id}/import-report"), None).await;
    assert_eq!(report["source"], "grafana");
    assert_eq!(report["report"], saved["report"]);

    // A mapping to something that is not a data source here, an unreadable file and a viewer.
    let bad = json!({ "dashboard": fixture("modern.json"), "datasources": { "${DS_LAGER}": "nope" } });
    let r = t.call(&Who::Owner, Method::POST, "/dashboards/import/grafana", Some(bad)).await;
    assert_eq!((r.status, r.body["error"]["field"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("datasources")));
    let r = t
        .call(&Who::Owner, Method::POST, "/dashboards/import/grafana", Some(json!({ "dashboard": { "elements": {} } })))
        .await;
    assert_eq!(r.reason(), "dashboards.import_unreadable");
    let viewer = t.token("viewer-1", "viewer").await;
    let r = t.call(&viewer, Method::POST, "/dashboards/import/grafana", Some(body(false))).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    t.finish().await;
}

/// Dashboards imported before units were taken over still hold Grafana's unit ids: the
/// correction at start maps them into a new version, once, and leaves everything else alone.
#[tokio::test]
async fn stored_grafana_units_are_corrected_once_into_a_new_version() {
    let mut t = TestApp::new().await;
    let path = t.sqlite_path().to_string_lossy().to_string();
    let ds = t
        .ok(
            &Who::Owner,
            Method::POST,
            "/datasources",
            Some(json!({ "name": "Lager", "kind": "sqlite", "settings": { "path": path } })),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let body = json!({ "dashboard": fixture("modern.json"), "datasources": { "${DS_LAGER}": ds } });
    // Three imports: one plain, one managed by provisioning files, one in the trash.
    let mut ids = Vec::new();
    for _ in 0..3 {
        let saved = t.ok(&Who::Owner, Method::POST, "/dashboards/import/grafana", Some(body.clone())).await;
        ids.push((saved["dashboard"]["id"].as_str().unwrap().to_string(), saved["dashboard"].clone()));
    }
    // As an import before the change stored them: the raw ids.
    for (id, saved) in &ids {
        let mut model = saved["model"].clone();
        model["panels"][0]["fieldConfig"]["defaults"]["unit"] = json!("currencyEUR");
        model["panels"][0]["fieldConfig"]["overrides"] =
            json!([{ "matcher": { "type": "name", "value": "v" }, "properties": { "unit": "flux" } }]);
        sqlx::query("UPDATE dashboard_versions SET model = $1 WHERE dashboard_id = $2")
            .bind(model.to_string())
            .bind(id)
            .execute(&t.state.db)
            .await
            .unwrap();
    }
    let (id, saved) = &ids[0];
    let (managed, _) = &ids[1];
    let (trashed, _) = &ids[2];
    sqlx::query(
        "INSERT INTO provisioned_resources (org_id, set_name, kind, uid, resource_id, source_path, checksum, \
         state_hash, secret_digest, secret_refs, applied_at) \
         VALUES ($1, 'default', 'dashboard', 'lager', $2, 'dashboards/lager.json', 'x', 'x', '', '{}', 1)",
    )
    .bind(&t.org)
    .bind(managed)
    .execute(&t.state.db)
    .await
    .unwrap();
    sqlx::query("UPDATE dashboards SET deleted_at = 1 WHERE id = $1").bind(trashed).execute(&t.state.db).await.unwrap();

    let done = grafana::stored_units::run(&t.state).await.unwrap();
    assert_eq!(done, grafana::stored_units::Corrected { dashboards: 1, units: 1, left: 0 });
    let version = saved["version"].as_i64().unwrap();
    let current = t.ok(&Who::Owner, Method::GET, &format!("/dashboards/{id}"), None).await;
    assert_eq!(current["version"], version + 1, "{current}");
    let panel = &current["model"]["panels"][0]["fieldConfig"];
    assert_eq!(panel["defaults"]["unit"], "currency:EUR");
    // An id the table does not know is kept as it was.
    assert_eq!(panel["overrides"][0]["properties"]["unit"], "flux");
    // The version before stays in the history with the raw id.
    let model_at = |id: String, v: i64| {
        let db = t.state.db.clone();
        async move {
            let (model,): (String,) =
                sqlx::query_as("SELECT model FROM dashboard_versions WHERE dashboard_id = $1 AND version = $2")
                    .bind(id)
                    .bind(v)
                    .fetch_one(&db)
                    .await
                    .unwrap();
            model
        }
    };
    assert!(model_at(id.clone(), version).await.contains("currencyEUR"));
    // The managed and the trashed dashboard are left alone: no drift, nothing in the trash moved.
    for other in [managed, trashed] {
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM dashboard_versions WHERE dashboard_id = $1")
            .bind(other)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
        assert_eq!(count, 1, "{other}");
    }
    // One audit entry, by no person.
    let (actor, summary): (Option<String>, String) = sqlx::query_as(
        "SELECT actor_user_id, summary FROM audit_events WHERE action = 'dashboard.units_corrected' AND resource_id = $1",
    )
    .bind(id)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!(actor, None);
    assert!(summary.contains("\"units\":1"), "{summary}");
    // Done: the marker is set, a later start does not scan again, even with raw ids back.
    let (marker,): (String,) = sqlx::query_as("SELECT value FROM server_settings WHERE key = $1")
        .bind(grafana::stored_units::DONE_KEY)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(marker, grafana::stored_units::VERSION.to_string());
    sqlx::query("UPDATE dashboard_versions SET model = $1 WHERE dashboard_id = $2 AND version = $3")
        .bind(model_at(id.clone(), version).await)
        .bind(id)
        .bind(version + 1)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(grafana::stored_units::run(&t.state).await.unwrap(), Default::default());
    t.finish().await;
}

/// Grafana's default data source (a panel without one) maps to the organization's default when
/// the request does not map it, and the Grafana uid of an imported dashboard finds it again
/// (`/d/<uid>`), only for who may read it.
#[tokio::test]
async fn grafana_import_takes_the_default_source_and_keeps_the_uid() {
    let mut t = TestApp::new().await;
    let path = t.sqlite_path().to_string_lossy().to_string();
    let ds = t
        .ok(
            &Who::Owner,
            Method::POST,
            "/datasources",
            Some(json!({ "name": "Lager", "kind": "sqlite", "settings": { "path": path } })),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    // The fixture with its panels on Grafana's default source.
    let mut dashboard = fixture("modern.json");
    for panel in dashboard["panels"].as_array_mut().unwrap() {
        panel["datasource"] = Value::Null;
        if let Some(targets) = panel["targets"].as_array_mut() {
            for target in targets {
                target.as_object_mut().unwrap().remove("datasource");
            }
        }
    }
    let dry = json!({ "dashboard": dashboard, "dryRun": true });
    let unmapped = |report: &Value| report.to_string().matches("no_mapping_default").count();
    let before = t.ok(&Who::Owner, Method::POST, "/dashboards/import/grafana", Some(dry.clone())).await;
    assert!(unmapped(&before["report"]) > 0, "{}", before["report"]);
    t.ok(&Who::Owner, Method::PUT, &format!("/datasources/{ds}/default"), Some(json!({ "default": true }))).await;
    let after = t.ok(&Who::Owner, Method::POST, "/dashboards/import/grafana", Some(dry)).await;
    assert_eq!(unmapped(&after["report"]), 0, "{}", after["report"]);
    assert!(after["model"].to_string().contains(&ds), "the panels query the default source");

    // Before any import the uid names nothing; afterwards it names the imported dashboard.
    let r = t.call(&Who::Owner, Method::GET, "/dashboards/by-uid/lager-im-blick", None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);
    let saved = t
        .ok(
            &Who::Owner,
            Method::POST,
            "/dashboards/import/grafana",
            Some(json!({ "dashboard": fixture("modern.json"), "datasources": { "${DS_LAGER}": ds } })),
        )
        .await;
    let id = saved["dashboard"]["id"].as_str().unwrap().to_string();
    let found = t.ok(&Who::Owner, Method::GET, "/dashboards/by-uid/lager-im-blick", None).await;
    assert_eq!(found["id"], id.as_str());
    // A dashboard's own id works too; an unknown uid does not.
    assert_eq!(t.ok(&Who::Owner, Method::GET, &format!("/dashboards/by-uid/{id}"), None).await["id"], id.as_str());
    let r = t.call(&Who::Owner, Method::GET, "/dashboards/by-uid/gibt-es-nicht", None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // In the trash it is not found any more.
    let r = t.call(&Who::Owner, Method::DELETE, &format!("/dashboards/{id}"), None).await;
    assert!(r.status.is_success(), "{}", r.body);
    let r = t.call(&Who::Owner, Method::GET, "/dashboards/by-uid/lager-im-blick", None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    t.finish().await;
}

/// An importer who may not query the organization's default source does not get it mapped for
/// Grafana's default: it stays unmapped, as without a default.
#[tokio::test]
async fn grafana_import_maps_the_default_only_for_who_may_query_it() {
    let mut t = TestApp::new().await;
    let path = t.sqlite_path().to_string_lossy().to_string();
    let ds = t
        .ok(
            &Who::Owner,
            Method::POST,
            "/datasources",
            Some(json!({ "name": "Lager", "kind": "sqlite", "settings": { "path": path } })),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    t.ok(&Who::Owner, Method::PUT, &format!("/datasources/{ds}/default"), Some(json!({ "default": true }))).await;
    let permissions = ["dashboards:read", "dashboards:write", "folders:read", "datasources:read"];
    let role = t
        .ok(&Who::Owner, Method::POST, "/roles", Some(json!({ "name": "Gestalter", "permissions": permissions })))
        .await;
    let designer = t.token("gestalter", role["id"].as_str().unwrap()).await;
    let mut dashboard = fixture("modern.json");
    for panel in dashboard["panels"].as_array_mut().unwrap() {
        panel["datasource"] = Value::Null;
        if let Some(targets) = panel["targets"].as_array_mut() {
            for target in targets {
                target.as_object_mut().unwrap().remove("datasource");
            }
        }
    }
    let dry = json!({ "dashboard": dashboard, "dryRun": true });
    let r = t.call(&designer, Method::POST, "/dashboards/import/grafana", Some(dry.clone())).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.body["report"].to_string().contains("no_mapping_default"), "{}", r.body["report"]);
    assert!(!r.body["model"].to_string().contains(&ds), "the default is not used");
    // The owner may query it, so it is mapped for them.
    let mine = t.ok(&Who::Owner, Method::POST, "/dashboards/import/grafana", Some(dry)).await;
    assert!(mine["model"].to_string().contains(&ds));
    t.finish().await;
}

/// A crafted Grafana uid cannot take over an address that names something else: a dashboard's
/// id and a provisioned uid come first, and an import does not keep a uid that names either.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_imported_uid_cannot_take_over_another_dashboards_address() {
    let mut t = TestApp::new().await;
    let admin = t.token("ci", "admin").await;
    let files = t.files();
    let applied = t.apply(&admin, &files, json!({})).await;
    assert_eq!(applied.status, StatusCode::OK, "{}", applied.body);
    let provisioned = id_of(&applied.body["plan"], "lager-board");
    let ds = t.ok(&Who::Owner, Method::GET, "/datasources", None).await["items"][0]["id"].as_str().unwrap().to_string();
    let import = |uid: &str| {
        let mut dashboard = fixture("modern.json");
        dashboard["uid"] = json!(uid);
        dashboard["title"] = json!(format!("Import {uid}"));
        json!({ "dashboard": dashboard, "datasources": { "${DS_LAGER}": ds } })
    };
    // The provisioned uid.
    let saved = t.ok(&Who::Owner, Method::POST, "/dashboards/import/grafana", Some(import("lager-board"))).await;
    assert!(saved["report"].to_string().contains("uid_not_kept"), "{}", saved["report"]);
    let found = t.ok(&Who::Owner, Method::GET, "/dashboards/by-uid/lager-board", None).await;
    assert_eq!(found["id"], provisioned.as_str());
    // Another dashboard's id.
    let saved = t.ok(&Who::Owner, Method::POST, "/dashboards/import/grafana", Some(import(&provisioned))).await;
    assert!(saved["report"].to_string().contains("uid_not_kept"), "{}", saved["report"]);
    let found = t.ok(&Who::Owner, Method::GET, &format!("/dashboards/by-uid/{provisioned}"), None).await;
    assert_eq!(found["id"], provisioned.as_str());
    // Neither import kept the uid.
    let kept: Vec<(Option<String>,)> =
        sqlx::query_as("SELECT source_uid FROM dashboard_import_reports").fetch_all(&t.state.db).await.unwrap();
    assert_eq!(kept, [(None,), (None,)]);
    // "." and ".." name nothing.
    for uid in ["%2E", "%2E%2E"] {
        let r = t.call(&Who::Owner, Method::GET, &format!("/dashboards/by-uid/{uid}"), None).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{uid}: {}", r.body);
    }
    t.finish().await;
}

/// A dashboard with live public links changes through files only for people who hold
/// `dashboards:public` (owner decision D1), refused at plan and at apply alike.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_public_links_guard_provisioned_dashboards() {
    let mut t = TestApp::new().await;
    let admin = t.token("ci", "admin").await;
    let mut files = t.files();
    let applied = t.apply(&admin, &files, json!({})).await;
    assert_eq!(applied.status, StatusCode::OK, "{}", applied.body);
    let dashboard = id_of(&applied.body["plan"], "lager-board");
    let on = json!({ "value": true, "version": 0 });
    let r = t.raw(Method::PATCH, "/api/admin/settings/sharing.public_enabled", Some(on), Some(&Who::Owner)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.call(&Who::Owner, Method::POST, &format!("/dashboards/{dashboard}/public-links"), Some(json!({}))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);

    // Everything an admin may do through files, except `dashboards:public`.
    let permissions = [
        "provisioning:read",
        "provisioning:write",
        "dashboards:read",
        "dashboards:write",
        "dashboards:delete",
        "folders:read",
        "folders:write",
        "datasources:query",
        "datasources:read",
        "datasources:write",
        "roles:read",
        "roles:write",
        "audit:read",
        "alerts:read",
        "alerts:write",
        "alerts:contacts",
    ];
    let role = t
        .ok(&Who::Owner, Method::POST, "/roles", Some(json!({ "name": "Bereitstellung", "permissions": permissions })))
        .await;
    let deployer = t.token("deploy", role["id"].as_str().unwrap()).await;
    let changed = files["dashboards/lager.yaml"].replace("title: Lager", "title: Lager neu");
    files.insert("dashboards/lager.yaml".into(), changed);
    let plan = t.plan(&deployer, &files, json!({})).await;
    assert_eq!((plan.status, plan.reason()), (StatusCode::FORBIDDEN, "sharing.public_links_active"), "{}", plan.body);
    let apply = t.apply(&deployer, &files, json!({})).await;
    assert_eq!(
        (apply.status, apply.reason()),
        (StatusCode::FORBIDDEN, "sharing.public_links_active"),
        "{}",
        apply.body
    );
    let board = t.ok(&Who::Owner, Method::GET, &format!("/dashboards/{dashboard}"), None).await;
    assert_eq!(board["model"]["title"], "Lager", "nothing was applied");
    // With the permission the same files apply.
    let applied = t.apply(&admin, &files, json!({})).await;
    assert_eq!(applied.status, StatusCode::OK, "{}", applied.body);
    t.finish().await;
}

/// An admin moves a provisioned rule to another data source: the apply checks the source of the
/// locked rule through its own transaction (it holds the organization's lock), so it goes through
/// on SQLite too, and the rule takes the new source.
#[tokio::test]
async fn an_admin_moves_a_provisioned_rule_to_another_source() {
    let mut t = TestApp::new().await;
    let admin = t.token("ci", "admin").await;
    let mut files = t.files();
    let applied = t.apply(&admin, &files, json!({})).await;
    assert_eq!(applied.status, StatusCode::OK, "{}", applied.body);
    let path = t.sqlite_path().to_string_lossy().replace('\\', "/");
    files.insert(
        "datasources/lager2.yaml".into(),
        format!(
            "apiVersion: kalzit/v1\nkind: DataSource\nuid: lager2\nspec:\n  name: Lager 2\n  type: sqlite\n  settings:\n    \
             path: \"{path}\"\n  alerting:\n    enabled: true\n"
        ),
    );
    let mut rule: Value = serde_json::from_str(&files["alert-rules/hoch.json"]).unwrap();
    rule["spec"]["datasourceId"] = json!("lager2");
    files.insert("alert-rules/hoch.json".into(), rule.to_string());
    let applied = t.apply(&admin, &files, json!({})).await;
    assert_eq!(applied.status, StatusCode::OK, "{}", applied.body);
    let again = t.plan(&admin, &files, json!({})).await.body;
    let rule_id = id_of(&again, "lager-hoch");
    let moved = t.ok(&Who::Owner, Method::GET, &format!("/alerting/rules/{rule_id}"), None).await;
    assert_eq!(moved["datasourceId"].as_str(), Some(id_of(&again, "lager2").as_str()), "{moved}");
    t.finish().await;
}
