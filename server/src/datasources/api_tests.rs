//! The data source and query routes through the real router, with SQLite files and a fake
//! Prometheus server (always run). Real PostgreSQL, MySQL, SQL Server and Prometheus are tested
//! in `server/tests/datasources.rs` when their `KALZIT_TEST_*_URL` is set.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::app::{AppState, router};
use crate::clock::ManualClock;
use crate::config::Config;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";

struct T {
    app: Router,
    state: AppState,
    org: String,
    owner: String,
    dir: tempfile::TempDir,
}

struct Reply {
    status: StatusCode,
    body: Value,
    text: String,
}

impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }
}

impl T {
    async fn new() -> T {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().join("data");
        std::fs::create_dir_all(&config.paths.data_dir).unwrap();
        let pool = crate::db::connect(&config.database_url(), 4).await.unwrap();
        let clock = Arc::new(ManualClock::new(1_800_000_000_000));
        let state = AppState::new(config, pool, clock, Some(SETUP_CODE.into())).await.unwrap();
        let allowed = dir.path().join("erlaubt");
        std::fs::create_dir_all(&allowed).unwrap();
        state
            .datasources
            .test_settings
            .lock()
            .unwrap()
            .insert("datasources.sqlite_dirs".into(), json!([allowed.to_string_lossy()]));
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let app = router(state.clone()).layer(MockConnectInfo(peer));
        let mut t = T { app, state, org: String::new(), owner: String::new(), dir };
        let r = t
            .send(
                Method::POST,
                "/api/setup",
                Some(json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg",
                             "email": "joerg@example.de", "password": PASSWORD })),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
        t.org = r.body["orgs"][0]["id"].as_str().unwrap().to_string();
        t.owner = t.session_for_role("owner-already", None).await;
        t
    }

    fn allowed_dir(&self) -> PathBuf {
        self.dir.path().join("erlaubt")
    }

    fn set(&self, key: &str, value: Value) {
        self.state.datasources.test_settings.lock().unwrap().insert(key.into(), value);
    }

    /// A signed-in user: the owner from setup (`role` None), or a new member with `role`.
    async fn session_for_role(&self, name: &str, role: Option<&str>) -> String {
        let db = &self.state.db;
        let user_id = match role {
            None => {
                let (id,): (String,) = sqlx::query_as("SELECT id FROM users WHERE email = 'joerg@example.de'")
                    .fetch_one(db)
                    .await
                    .unwrap();
                id
            }
            Some(role) => {
                let id = uuid::Uuid::now_v7().to_string();
                sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ($1, $2, $3, 0)")
                    .bind(&id)
                    .bind(format!("{name}@example.de"))
                    .bind(name)
                    .execute(db)
                    .await
                    .unwrap();
                if role != "stranger" {
                    sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, $3, 0)")
                        .bind(&self.org)
                        .bind(&id)
                        .bind(role)
                        .execute(db)
                        .await
                        .unwrap();
                }
                id
            }
        };
        let now = 1_800_000_000_000;
        let token = crate::auth::session::create(db, &self.state.config.sessions, now, &user_id).await.unwrap();
        format!("kalzit_session={token}")
    }

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
        let text = String::from_utf8_lossy(&bytes).to_string();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply { status, body, text }
    }

    fn path(&self, rest: &str) -> String {
        format!("/api/orgs/{}{rest}", self.org)
    }

    async fn post(&self, rest: &str, body: Value) -> Reply {
        self.send(Method::POST, &self.path(rest), Some(body), Some(&self.owner)).await
    }

    async fn get(&self, rest: &str) -> Reply {
        self.send(Method::GET, &self.path(rest), None, Some(&self.owner)).await
    }

    /// A SQLite file in the allowed directory, filled by `sql`.
    async fn sqlite_file(&self, name: &str, sql: &str) -> PathBuf {
        let path = self.allowed_dir().join(name);
        let url = crate::config::sqlite_url(&path);
        let pool = sqlx::SqlitePool::connect(&url).await.unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string())).execute(&pool).await.unwrap();
        pool.close().await;
        path
    }

    async fn create_sqlite(&self, name: &str, path: &std::path::Path) -> String {
        let r = self
            .post(
                "/datasources",
                json!({ "name": name, "kind": "sqlite", "settings": { "path": path.to_string_lossy() } }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
        r.body["id"].as_str().unwrap().to_string()
    }

    async fn query(&self, cookie: &str, queries: Value) -> Reply {
        let body =
            json!({ "queries": queries, "timeRange": { "from": 1_700_000_000_000_i64, "to": 1_800_000_000_000_i64 } });
        self.send(Method::POST, &self.path("/query"), Some(body), Some(cookie)).await
    }
}

const SALES: &str = "CREATE TABLE verkauf (id INTEGER PRIMARY KEY, land TEXT, betrag REAL, am DATETIME, bezahlt BOOLEAN);
INSERT INTO verkauf VALUES (1, 'Österreich', 12.5, '2025-01-01 10:00:00', 1), (2, 'Schweiz', 7.25, '2026-01-01 10:00:00', 0),
(9007199254740993, 'Deutschland', NULL, NULL, NULL);";

#[tokio::test]
async fn kinds_describe_their_settings_forms() {
    let t = T::new().await;
    let r = t.get("/datasource-kinds").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let kinds: Vec<&str> = r.body["items"].as_array().unwrap().iter().map(|k| k["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["postgres", "mysql", "sqlite", "mssql", "prometheus"]);
    let pg = &r.body["items"][0];
    assert_eq!(pg["shapes"], json!(["frame"]));
    assert_eq!(pg["hintKey"], "datasources.kinds.postgres.hint");
    let password = pg["settings"].as_array().unwrap().iter().find(|f| f["name"] == "password").unwrap();
    assert_eq!((password["secret"].as_bool(), password["type"].as_str()), (Some(true), Some("string")));
    let ssl = pg["settings"].as_array().unwrap().iter().find(|f| f["name"] == "sslMode").unwrap();
    assert_eq!(ssl["default"], "prefer");
    assert!(ssl["options"].as_array().unwrap().contains(&json!("verify-full")));
    assert!(pg["settings"].as_array().unwrap().iter().any(|f| f["name"] == "maxRows"));
    assert!(r.body["nextCursor"].is_null());
}

#[tokio::test]
async fn create_read_update_trash_and_restore() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let id = t.create_sqlite("Umsätze", &file).await;

    let one = t.get(&format!("/datasources/{id}")).await;
    assert_eq!(one.status, StatusCode::OK);
    assert_eq!(one.body["name"], "Umsätze");
    assert_eq!(one.body["settings"]["path"], file.to_string_lossy().as_ref());
    assert_eq!(one.body["secrets"], json!({}));

    let dup = t
        .post(
            "/datasources",
            json!({ "name": "Umsätze", "kind": "sqlite", "settings": { "path": file.to_string_lossy() } }),
        )
        .await;
    assert_eq!((dup.status, dup.code()), (StatusCode::CONFLICT, "conflict"));

    let renamed = t
        .send(
            Method::PATCH,
            &t.path(&format!("/datasources/{id}")),
            Some(json!({ "name": "Umsatz 2026" })),
            Some(&t.owner),
        )
        .await;
    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.text);
    assert_eq!(renamed.body["name"], "Umsatz 2026");

    let list = t.get("/datasources").await;
    assert_eq!(list.body["items"][0]["id"], id.as_str());
    assert_eq!(list.body["items"][0]["kind"], "sqlite");
    assert!(list.body["items"][0].get("settings").is_none(), "lists carry no settings");

    let del = t.send(Method::DELETE, &t.path(&format!("/datasources/{id}")), None, Some(&t.owner)).await;
    assert_eq!(del.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&format!("/datasources/{id}")).await.status, StatusCode::NOT_FOUND);
    assert!(t.get("/datasources").await.body["items"].as_array().unwrap().is_empty());
    let trash = t.get("/datasources?trash=true").await;
    assert_eq!(trash.body["items"][0]["id"], id.as_str());
    assert!(trash.body["items"][0]["deletedAt"].is_i64());

    // A new source may take the trashed one's name; restoring the old one then conflicts.
    let other = t.create_sqlite("Umsatz 2026", &file).await;
    let blocked = t.post(&format!("/datasources/{id}/restore"), json!({})).await;
    assert_eq!((blocked.status, blocked.code()), (StatusCode::CONFLICT, "conflict"));
    t.send(Method::DELETE, &t.path(&format!("/datasources/{other}")), None, Some(&t.owner)).await;
    let restored = t.post(&format!("/datasources/{id}/restore"), json!({})).await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.text);
    assert!(restored.body.get("deletedAt").is_none());
    assert_eq!(t.post(&format!("/datasources/{id}/restore"), json!({})).await.status, StatusCode::NOT_FOUND);

    let actions: Vec<(String,)> =
        // Insertion order: several events share a millisecond on the test clock.
        sqlx::query_as("SELECT action FROM audit_events WHERE resource_type = 'datasource' ORDER BY rowid")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    let actions: Vec<&str> = actions.iter().map(|a| a.0.as_str()).collect();
    assert_eq!(
        actions,
        [
            "datasource.created",
            "datasource.updated",
            "datasource.deleted",
            "datasource.created",
            "datasource.deleted",
            "datasource.restored"
        ]
    );
}

#[tokio::test]
async fn pages_are_bounded_and_continue_with_the_cursor() {
    let t = T::new().await;
    let file = t.sqlite_file("a.db", "CREATE TABLE x (a INT);").await;
    for i in 0..3 {
        t.create_sqlite(&format!("Quelle {i}"), &file).await;
    }
    let first = t.get("/datasources?limit=2").await;
    assert_eq!(first.body["items"].as_array().unwrap().len(), 2);
    assert_eq!(first.body["items"][0]["name"], "Quelle 2", "newest first");
    let cursor = first.body["nextCursor"].as_str().unwrap().to_string();
    let second = t.get(&format!("/datasources?limit=2&cursor={cursor}")).await;
    assert_eq!(second.body["items"].as_array().unwrap().len(), 1);
    assert!(second.body["nextCursor"].is_null());
    for bad in ["?limit=201", "?limit=0", "?limit=viele", "?cursor=nein", "?trash=vielleicht", "?sort=name"] {
        let r = t.get(&format!("/datasources{bad}")).await;
        assert_eq!(r.code(), "validation", "{bad}: {}", r.text);
    }
}

#[tokio::test]
async fn secrets_are_never_returned_and_follow_patch_semantics() {
    let t = T::new().await;
    let r = t
        .post(
            "/datasources",
            json!({ "name": "Lager", "kind": "postgres",
                    "settings": { "host": "db.intern", "database": "lager", "user": "leser" },
                    "secrets": { "password": "Sehr-Geheim-42" } }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert!(!r.text.contains("Sehr-Geheim-42"));
    assert_eq!(r.body["secrets"], json!({ "password": { "set": true } }));
    let id = r.body["id"].as_str().unwrap().to_string();
    let path = t.path(&format!("/datasources/{id}"));

    // Omitted keeps the secret.
    let r = t
        .send(
            Method::PATCH,
            &path,
            Some(json!({ "settings": { "host": "db2.intern", "database": "lager", "user": "leser" } })),
            Some(&t.owner),
        )
        .await;
    assert_eq!(r.body["secrets"], json!({ "password": { "set": true } }), "{}", r.text);
    // A string sets it.
    let r =
        t.send(Method::PATCH, &path, Some(json!({ "secrets": { "password": "Neu-Geheim-43" } })), Some(&t.owner)).await;
    assert!(!r.text.contains("Neu-Geheim-43"));
    // null removes it.
    let r = t.send(Method::PATCH, &path, Some(json!({ "secrets": { "password": null } })), Some(&t.owner)).await;
    assert_eq!(r.body["secrets"], json!({}));

    let audit: Vec<(String,)> = sqlx::query_as("SELECT summary FROM audit_events WHERE resource_type = 'datasource'")
        .fetch_all(&t.state.db)
        .await
        .unwrap();
    let all = audit.iter().map(|a| a.0.clone()).collect::<Vec<_>>().join("\n");
    assert!(!all.contains("Geheim") && !all.contains("db2.intern"), "{all}");
    assert!(all.contains("secrets.password") && all.contains("settings.host"), "{all}");
    let stored: Vec<(String,)> =
        sqlx::query_as("SELECT settings FROM datasources").fetch_all(&t.state.db).await.unwrap();
    assert!(!stored[0].0.contains("Geheim"));
}

#[tokio::test]
async fn settings_and_secrets_are_validated() {
    let t = T::new().await;
    let pg = |settings: Value, secrets: Value| json!({ "name": "X", "kind": "postgres", "settings": settings, "secrets": secrets });
    for (body, field) in [
        (json!({ "name": "X", "kind": "oracle", "settings": {} }), "kind"),
        (json!({ "name": " ", "kind": "sqlite", "settings": { "path": "/x" } }), "name"),
        (pg(json!({ "database": "d", "user": "u" }), json!({})), "host"),
        (pg(json!({ "host": "h", "database": "d", "user": "u", "password": "x" }), json!({})), "password"),
        (pg(json!({ "host": "h", "database": "d", "user": "u" }), json!({ "apiKey": "x" })), "secrets"),
        (pg(json!({ "host": "h", "database": "d", "user": "u", "port": 70000 }), json!({})), "port"),
        (json!({ "name": "P", "kind": "prometheus", "settings": { "url": "https://admin:pw@prom.intern" } }), "url"),
        (json!({ "name": "S", "kind": "sqlite", "settings": { "path": "relativ.db" } }), "path"),
    ] {
        let r = t.post("/datasources", body.clone()).await;
        assert_eq!((r.status, r.code()), (StatusCode::UNPROCESSABLE_ENTITY, "validation"), "{body}: {}", r.text);
        assert_eq!(r.body["error"]["field"], field, "{body}");
        assert!(!r.text.contains("admin:pw"));
    }
    let r = t.post("/datasources", json!({ "name": "X", "kind": "sqlite", "settings": {}, "extra": 1 })).await;
    assert_eq!(r.code(), "validation");
}

#[tokio::test]
async fn blocked_targets_are_refused_when_saving_and_querying() {
    let t = T::new().await;
    let outside = t.dir.path().join("anderswo");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("x.db"), b"").unwrap();
    let own = t.dir.path().join("data").join("kalzit.db");
    for path in [outside.join("x.db"), own] {
        let r = t
            .post(
                "/datasources",
                json!({ "name": "S", "kind": "sqlite", "settings": { "path": path.to_string_lossy() } }),
            )
            .await;
        assert_eq!((r.status, r.code()), (StatusCode::UNPROCESSABLE_ENTITY, "datasource_target_blocked"), "{}", r.text);
        assert_eq!(r.body["error"]["field"], "path");
    }
    let meta = json!({ "name": "M", "kind": "prometheus", "settings": { "url": "http://169.254.169.254/" } });
    assert_eq!(t.post("/datasources", meta).await.code(), "datasource_target_blocked");
    let pg =
        json!({ "name": "P", "kind": "postgres", "settings": { "host": "fe80::1", "database": "d", "user": "u" } });
    assert_eq!(t.post("/datasources", pg).await.code(), "datasource_target_blocked");

    // A rule added later applies to sources saved before.
    let file = t.sqlite_file("ok.db", "CREATE TABLE x (a INT); INSERT INTO x VALUES (1);").await;
    let id = t.create_sqlite("Ok", &file).await;
    let ok =
        t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "sql": "SELECT a FROM x" } }])).await;
    assert!(ok.body["results"]["A"]["result"].is_object(), "{}", ok.text);
    t.set("datasources.sqlite_dirs", json!([]));
    let r =
        t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "sql": "SELECT a FROM x" } }])).await;
    assert_eq!(r.body["results"]["A"]["error"]["code"], "datasource_target_blocked", "{}", r.text);
    let h = t.post(&format!("/datasources/{id}/health"), json!({})).await;
    assert_eq!((h.body["ok"].as_bool(), h.body["code"].as_str()), (Some(false), Some("datasource_target_blocked")));
}

#[tokio::test]
async fn sqlite_queries_answer_typed_frames() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let id = t.create_sqlite("Umsätze", &file).await;
    let r = t
        .query(
            &t.owner,
            json!([{ "refId": "A", "datasourceId": id,
                     "query": { "sql": "SELECT id, land, betrag, am, bezahlt FROM verkauf ORDER BY id" } }]),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let frame = &r.body["results"]["A"]["result"]["frame"];
    assert_eq!(r.body["results"]["A"]["result"]["shape"], "frame");
    let types: Vec<&str> = frame["fields"].as_array().unwrap().iter().map(|f| f["type"].as_str().unwrap()).collect();
    assert_eq!(types, ["int64", "string", "number", "time", "bool"]);
    // Beyond 2^53, so only a string keeps it exact.
    assert_eq!(frame["fields"][0]["values"], json!(["1", "2", "9007199254740993"]));
    assert_eq!(frame["fields"][1]["values"], json!(["Österreich", "Schweiz", "Deutschland"]));
    assert_eq!(frame["fields"][2]["values"], json!([12.5, 7.25, null]));
    assert_eq!(frame["fields"][3]["values"], json!([1_735_725_600_000_i64, 1_767_261_600_000_i64, null]));
    assert_eq!(frame["fields"][4]["values"], json!([true, false, null]));
    assert_eq!(frame["meta"]["executedQuery"], "SELECT id, land, betrag, am, bezahlt FROM verkauf ORDER BY id");
}

#[tokio::test]
async fn macros_and_variables_are_bound() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let id = t.create_sqlite("Umsätze", &file).await;
    let body = json!({
        "queries": [{ "refId": "A", "datasourceId": id,
                      "query": { "sql": "SELECT land FROM verkauf WHERE $__timeFilter(am) AND land IN ($laender) AND land <> $boese" } }],
        // 2025-06-01 to 2026-06-01
        "timeRange": { "from": 1_748_736_000_000_i64, "to": 1_780_272_000_000_i64 },
        "variables": { "laender": ["Schweiz", "Österreich"], "boese": "x' OR '1'='1" }
    });
    let r = t.send(Method::POST, &t.path("/query"), Some(body), Some(&t.owner)).await;
    let frame = &r.body["results"]["A"]["result"]["frame"];
    assert_eq!(frame["fields"][0]["values"], json!(["Schweiz"]), "{}", r.text);
    assert_eq!(
        frame["meta"]["executedQuery"],
        "SELECT land FROM verkauf WHERE (am BETWEEN ? AND ?) AND land IN (?, ?) AND land <> ?"
    );

    let ident = json!({
        "queries": [{ "refId": "A", "datasourceId": id, "query": { "sql": "SELECT ${spalte:identifier} FROM verkauf WHERE id = 1" } }],
        "timeRange": { "from": 0, "to": 1 },
        "variables": { "spalte": "land" }
    });
    let r = t.send(Method::POST, &t.path("/query"), Some(ident.clone()), Some(&t.owner)).await;
    assert_eq!(r.body["results"]["A"]["result"]["frame"]["fields"][0]["values"], json!(["Österreich"]), "{}", r.text);
    let mut evil = ident;
    evil["variables"]["spalte"] = json!("sqlite_version()");
    let r = t.send(Method::POST, &t.path("/query"), Some(evil), Some(&t.owner)).await;
    assert_eq!(r.body["results"]["A"]["error"]["code"], "query_rejected");
}

#[tokio::test]
async fn writes_are_rejected_and_each_query_answers_on_its_own() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let id = t.create_sqlite("Umsätze", &file).await;
    let r = t
        .query(
            &t.owner,
            json!([
                { "refId": "ok", "datasourceId": id, "query": { "sql": "SELECT COUNT(*) AS n FROM verkauf" } },
                { "refId": "del", "datasourceId": id, "query": { "sql": "DELETE FROM verkauf" } },
                { "refId": "ext", "datasourceId": id, "query": { "sql": "SELECT load_extension('/tmp/x')" } },
                { "refId": "form", "datasourceId": id, "query": { "rawSql": "SELECT 1" } },
                { "refId": "gone", "datasourceId": uuid::Uuid::now_v7().to_string(), "query": { "sql": "SELECT 1" } },
            ]),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let res = &r.body["results"];
    assert_eq!(res["ok"]["result"]["frame"]["fields"][0]["values"], json!(["3"]));
    for refid in ["del", "ext", "form"] {
        assert_eq!(res[refid]["error"]["code"], "query_rejected", "{refid}: {}", r.text);
    }
    assert_eq!(res["gone"]["error"]["code"], "not_found");
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM verkauf")
        .fetch_one(&sqlx::SqlitePool::connect(&crate::config::sqlite_url(&file)).await.unwrap())
        .await
        .unwrap();
    assert_eq!(n, 3);

    for bad in [
        json!({ "queries": [], "timeRange": { "from": 0, "to": 1 } }),
        json!({ "queries": [{ "refId": "A", "datasourceId": id, "query": {} }, { "refId": "A", "datasourceId": id, "query": {} }], "timeRange": { "from": 0, "to": 1 } }),
        json!({ "queries": [{ "refId": "A", "datasourceId": id, "query": {} }], "timeRange": { "from": 2, "to": 1 } }),
        json!({ "queries": [{ "refId": "A", "datasourceId": id, "query": {} }], "timeRange": { "from": 0, "to": 1 }, "extra": true }),
    ] {
        let r = t.send(Method::POST, &t.path("/query"), Some(bad.clone()), Some(&t.owner)).await;
        assert_eq!(r.code(), "validation", "{bad}: {}", r.text);
    }
}

#[tokio::test]
async fn row_limits_truncate_with_a_notice() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let r = t
        .post(
            "/datasources",
            json!({ "name": "U", "kind": "sqlite", "settings": { "path": file.to_string_lossy(), "maxRows": 2 } }),
        )
        .await;
    let id = r.body["id"].as_str().unwrap().to_string();
    let r = t
        .query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "sql": "SELECT id FROM verkauf" } }]))
        .await;
    let frame = &r.body["results"]["A"]["result"]["frame"];
    assert_eq!(frame["fields"][0]["values"].as_array().unwrap().len(), 2, "{}", r.text);
    assert_eq!(frame["meta"]["rowsTruncated"], true);
    assert!(!frame["meta"]["notices"].as_array().unwrap().is_empty());

    t.set("datasources.max_response_bytes", json!(20));
    let r = t
        .query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "sql": "SELECT land FROM verkauf" } }]))
        .await;
    assert_eq!(r.body["results"]["A"]["result"]["frame"]["meta"]["rowsTruncated"], true, "{}", r.text);
}

const SLOW: &str = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT COUNT(*) FROM n";

#[tokio::test]
async fn slow_queries_time_out_and_the_source_stays_usable() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let r = t
        .post("/datasources", json!({ "name": "U", "kind": "sqlite", "settings": { "path": file.to_string_lossy(), "queryTimeoutSecs": 1 } }))
        .await;
    let id = r.body["id"].as_str().unwrap().to_string();
    let started = std::time::Instant::now();
    let r = t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "sql": SLOW } }])).await;
    assert_eq!(r.body["results"]["A"]["error"]["code"], "query_timeout", "{}", r.text);
    assert!(started.elapsed() < Duration::from_secs(10));
    let r =
        t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "sql": "SELECT 1 AS eins" } }])).await;
    assert_eq!(r.body["results"]["A"]["result"]["frame"]["fields"][0]["values"], json!(["1"]), "{}", r.text);
}

/// A request that goes away drops its queries: the user's query slots are free again at once
/// and SQLite stops the statement.
#[tokio::test]
async fn a_dropped_request_cancels_its_queries() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let id = t.create_sqlite("U", &file).await;
    let user_id: (String,) = sqlx::query_as("SELECT id FROM users").fetch_one(&t.state.db).await.unwrap();
    let ctx = crate::authz::OrgCtx {
        user: crate::auth::SessionUser {
            id: user_id.0.clone(),
            email: "x".into(),
            name: "x".into(),
            is_server_admin: 1,
        },
        org_id: t.org.clone(),
        role: "owner".into(),
        permissions: crate::authz::BuiltinRole::Owner.permissions(),
    };
    let items: Vec<crate::shapes::QueryItem> = (0..3)
        .map(|i| {
            serde_json::from_value(json!({ "refId": format!("q{i}"), "datasourceId": id, "query": { "sql": SLOW } }))
                .unwrap()
        })
        .collect();
    let vars = Default::default();
    let range = crate::shapes::TimeRange { from: 0, to: 1 };
    let run = super::run_queries(&t.state, &ctx, items, range, None, None, &vars);
    assert!(tokio::time::timeout(Duration::from_millis(300), run).await.is_err(), "the slow queries are still running");
    let slots = t.state.datasources.user_slots(&ctx.user.id);
    assert_eq!(slots.available_permits(), super::MAX_PARALLEL_QUERIES_PER_USER);
    // The pool's connections were freed by the interrupted statements.
    let started = std::time::Instant::now();
    let r = t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "sql": "SELECT 2" } }])).await;
    assert!(r.body["results"]["A"]["result"].is_object(), "{}", r.text);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn health_and_schema_of_a_sqlite_file() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let id = t.create_sqlite("U", &file).await;
    let h = t.post(&format!("/datasources/{id}/health"), json!({})).await;
    assert_eq!(h.body["ok"], true, "{}", h.text);
    assert!(h.body["message"].as_str().unwrap().contains("read-only"));
    assert!(h.body["latencyMs"].is_u64());
    let s = t.get(&format!("/datasources/{id}/schema")).await;
    assert_eq!(s.body["kind"], "tables", "{}", s.text);
    assert_eq!(s.body["tables"][0]["name"], "verkauf");
    assert_eq!(s.body["tables"][0]["columns"][1], json!({ "name": "land", "type": "TEXT" }));
}

#[tokio::test]
async fn changed_settings_rebuild_the_connection() {
    let t = T::new().await;
    let a = t.sqlite_file("a.db", "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('a');").await;
    let b = t.sqlite_file("b.db", "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('b');").await;
    let id = t.create_sqlite("Wechsel", &a).await;
    let q = json!([{ "refId": "A", "datasourceId": id, "query": { "sql": "SELECT v FROM t" } }]);
    assert_eq!(
        t.query(&t.owner, q.clone()).await.body["results"]["A"]["result"]["frame"]["fields"][0]["values"],
        json!(["a"])
    );
    let r = t
        .send(
            Method::PATCH,
            &t.path(&format!("/datasources/{id}")),
            Some(json!({ "settings": { "path": b.to_string_lossy() } })),
            Some(&t.owner),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(t.query(&t.owner, q).await.body["results"]["A"]["result"]["frame"]["fields"][0]["values"], json!(["b"]));
}

#[tokio::test]
async fn roles_and_organizations_are_enforced() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let id = t.create_sqlite("U", &file).await;
    let editor = t.session_for_role("editor", Some("editor")).await;
    let viewer = t.session_for_role("viewer", Some("viewer")).await;
    let stranger = t.session_for_role("fremd", Some("stranger")).await;
    let one = t.path(&format!("/datasources/{id}"));
    let q = json!([{ "refId": "A", "datasourceId": id, "query": { "sql": "SELECT 1" } }]);

    // Editors read and query, but do not change data sources.
    assert_eq!(t.send(Method::GET, &t.path("/datasources"), None, Some(&editor)).await.status, StatusCode::OK);
    assert_eq!(t.send(Method::GET, &one, None, Some(&editor)).await.status, StatusCode::OK);
    assert!(t.query(&editor, q.clone()).await.body["results"]["A"]["result"].is_object());
    let create = json!({ "name": "N", "kind": "sqlite", "settings": { "path": file.to_string_lossy() } });
    for (method, path, body) in [
        (Method::POST, t.path("/datasources"), Some(create.clone())),
        (Method::PATCH, one.clone(), Some(json!({ "name": "N" }))),
        (Method::DELETE, one.clone(), None),
        (Method::POST, format!("{one}/restore"), Some(json!({}))),
        (Method::GET, t.path("/datasources?trash=true"), None),
    ] {
        let r = t.send(method.clone(), &path, body, Some(&editor)).await;
        assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden"), "{method} {path}");
    }
    // Viewers use data sources only through dashboards.
    for (method, path) in [
        (Method::GET, t.path("/datasources")),
        (Method::POST, t.path("/query")),
        (Method::POST, format!("{one}/health")),
        (Method::GET, format!("{one}/schema")),
    ] {
        let body = (method == Method::POST).then(|| json!({ "queries": q, "timeRange": { "from": 0, "to": 1 } }));
        let r = t.send(method.clone(), &path, body, Some(&viewer)).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{method} {path}: {}", r.text);
    }
    let r = t.send(Method::GET, &one, None, Some(&viewer)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "viewers do not see data sources");
    assert_eq!(t.send(Method::GET, &t.path("/datasource-kinds"), None, Some(&viewer)).await.status, StatusCode::OK);

    // Another organization: its routes do not exist for a stranger, and its ids are not found
    // from inside this one.
    assert_eq!(t.send(Method::GET, &one, None, Some(&stranger)).await.status, StatusCode::NOT_FOUND);
    let other_org = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, 'Andere', 0)")
        .bind(&other_org)
        .execute(&t.state.db)
        .await
        .unwrap();
    let foreign = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO datasources (id, org_id, name, kind, settings, created_at, updated_at) VALUES ($1, $2, 'F', 'sqlite', $3, 0, 0)")
        .bind(&foreign)
        .bind(&other_org)
        .bind(json!({ "path": file.to_string_lossy() }).to_string())
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(t.get(&format!("/datasources/{foreign}")).await.status, StatusCode::NOT_FOUND);
    let r = t.query(&t.owner, json!([{ "refId": "A", "datasourceId": foreign, "query": { "sql": "SELECT 1" } }])).await;
    assert_eq!(r.body["results"]["A"]["error"]["code"], "not_found");
    assert_eq!(t.get("/datasources/not-a-uuid").await.status, StatusCode::NOT_FOUND);
}

// ---- Prometheus against a fake server ----

#[expect(clippy::disallowed_methods, reason = "a fake Prometheus, not an API route")]
async fn fake_prometheus() -> SocketAddr {
    use axum::extract::RawQuery;
    use axum::http::HeaderMap;
    let app = Router::new()
        .route(
            "/api/v1/query_range",
            axum::routing::get(|RawQuery(q): RawQuery| async move {
                let q = q.unwrap_or_default();
                if q.contains("kaputt") {
                    return (
                        StatusCode::BAD_REQUEST,
                        axum::Json(json!({ "status": "error", "errorType": "bad_data", "error": "parse error" })),
                    );
                }
                (
                    StatusCode::OK,
                    axum::Json(json!({ "status": "success", "data": { "resultType": "matrix", "result": [
                    { "metric": { "__name__": "up", "job": "api" }, "values": [[1700000000, "1"], [1700000060, "0"]] }
                ] }, "warnings": ["nur ein Test"] })),
                )
            }),
        )
        .route(
            "/api/v1/query",
            // Echoes the credentials it received, like a careless proxy error page would.
            axum::routing::get(|headers: HeaderMap| async move {
                let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                let decoded = auth
                    .strip_prefix("Basic ")
                    .and_then(|b| base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b).ok())
                    .map(|b| String::from_utf8_lossy(&b).to_string())
                    .unwrap_or_default();
                (
                    StatusCode::UNAUTHORIZED,
                    axum::Json(json!({ "status": "error", "error": format!("denied for {auth} ({decoded})") })),
                )
            }),
        )
        .route(
            "/api/v1/label/__name__/values",
            axum::routing::get(|| async {
                axum::Json(json!({ "status": "success", "data": ["up", "http_requests_total"] }))
            }),
        )
        .route(
            "/api/v1/labels",
            axum::routing::get(|| async { axum::Json(json!({ "status": "success", "data": ["job", "instance"] })) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

#[tokio::test]
async fn prometheus_through_the_client_factory() {
    let t = T::new().await;
    let addr = fake_prometheus().await;
    let r = t
        .post(
            "/datasources",
            json!({ "name": "Prom", "kind": "prometheus",
                    "settings": { "url": format!("http://{addr}"), "basicAuthUser": "grafik" },
                    "secrets": { "basicAuthPassword": "Pr0m-Passwort!" } }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let id = r.body["id"].as_str().unwrap().to_string();

    let q =
        t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "expr": "up{job=\"api\"}" } }])).await;
    let frame = &q.body["results"]["A"]["result"]["frame"];
    assert_eq!(frame["fields"][0]["values"], json!([1_700_000_000_000_i64, 1_700_000_060_000_i64]), "{}", q.text);
    assert_eq!(frame["fields"][1]["labels"]["job"], "api");
    assert_eq!(frame["meta"]["notices"][0]["text"], "nur ein Test");

    let bad = t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "expr": "kaputt(" } }])).await;
    assert_eq!(bad.body["results"]["A"]["error"]["code"], "datasource_error");
    assert!(bad.text.contains("parse error"));

    // The server repeats the password in its error; it never reaches the client.
    let h = t.post(&format!("/datasources/{id}/health"), json!({})).await;
    assert_eq!(h.body["ok"], false, "{}", h.text);
    assert!(h.text.contains("denied"), "{}", h.text);
    assert!(!h.text.contains("Pr0m-Passwort"), "{}", h.text);
    assert!(
        !h.text.contains(&base64::Engine::encode(&base64::engine::general_purpose::STANDARD, "grafik:Pr0m-Passwort!"))
    );
    let inst = t
        .query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "expr": "up", "instant": true } }]))
        .await;
    assert!(!inst.text.contains("Pr0m-Passwort"), "{}", inst.text);
    assert_eq!(inst.body["results"]["A"]["error"]["code"], "datasource_error");

    let s = t.get(&format!("/datasources/{id}/schema")).await;
    assert_eq!(
        s.body,
        json!({ "kind": "metrics", "metrics": ["up", "http_requests_total"], "labels": ["job", "instance"] })
    );

    // The allow-list applies to HTTP sources too.
    t.set("datasources.allowed_targets", json!(["10.0.0.0/8"]));
    let blocked = t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "expr": "up" } }])).await;
    assert_eq!(blocked.body["results"]["A"]["error"]["code"], "datasource_target_blocked", "{}", blocked.text);
}
