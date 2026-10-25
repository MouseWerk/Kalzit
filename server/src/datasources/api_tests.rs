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
    /// Closes the app and deletes its directory (`app::finish_test_app`).
    async fn finish(self) {
        let T { app, state, dir, .. } = self;
        drop(app);
        crate::app::finish_test_app(state, dir).await;
    }

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
        // A data source PATCH names the version it changes, as the edit page does; these tests
        // change the stored one unless they name a version themselves.
        let body = match body {
            Some(Value::Object(mut fields)) if method == Method::PATCH && !fields.contains_key("expectedUpdatedAt") => {
                let id = path.split_once("/datasources/").map(|(_, id)| id).filter(|id| !id.contains(['/', '?']));
                if let Some(id) = id {
                    let row: Option<(i64,)> = sqlx::query_as("SELECT updated_at FROM datasources WHERE id = $1")
                        .bind(id)
                        .fetch_optional(&self.state.db)
                        .await
                        .unwrap();
                    if let Some((at,)) = row {
                        fields.insert("expectedUpdatedAt".into(), json!(at));
                    }
                }
                Some(Value::Object(fields))
            }
            other => other,
        };
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
    assert_eq!(
        kinds,
        [
            "postgres",
            "mysql",
            "sqlite",
            "mssql",
            "prometheus",
            "elasticsearch",
            "file",
            "http_json",
            "mongodb",
            "neo4j",
            "memgraph",
            "tigergraph"
        ]
    );
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
    t.finish().await;
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
    t.finish().await;
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
    t.finish().await;
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
            Some(json!({ "name": "Lager 2", "settings": { "host": "db.intern", "database": "lager", "user": "leser", "maxRows": 10 } })),
            Some(&t.owner),
        )
        .await;
    assert_eq!(r.body["secrets"], json!({ "password": { "set": true } }), "{}", r.text);
    // Changing where the source connects needs the stored secrets again.
    for settings in [
        json!({ "host": "anderswo.example", "database": "lager", "user": "leser" }),
        json!({ "host": "db2.intern", "database": "lager", "user": "leser", "port": 6543 }),
        json!({ "host": "db2.intern", "database": "lager", "user": "leser", "sslMode": "disable" }),
    ] {
        let r = t.send(Method::PATCH, &path, Some(json!({ "settings": settings })), Some(&t.owner)).await;
        assert_eq!((r.status, r.code()), (StatusCode::UNPROCESSABLE_ENTITY, "validation"), "{}", r.text);
        assert_eq!(r.body["error"]["field"], "password");
    }
    let moved = json!({ "settings": { "host": "anderswo.example", "database": "lager", "user": "leser" },
                        "secrets": { "password": "Sehr-Geheim-42" } });
    let r = t.send(Method::PATCH, &path, Some(moved), Some(&t.owner)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let back = json!({ "settings": { "host": "db2.intern", "database": "lager", "user": "leser" }, "secrets": { "password": null } });
    let r = t.send(Method::PATCH, &path, Some(back), Some(&t.owner)).await;
    assert_eq!(r.body["secrets"], json!({}), "{}", r.text);
    let again = json!({ "secrets": { "password": "Sehr-Geheim-42" } });
    t.send(Method::PATCH, &path, Some(again), Some(&t.owner)).await;
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
    t.finish().await;
}

#[tokio::test]
async fn settings_and_secrets_are_validated() {
    let t = T::new().await;
    let pg = |settings: Value, secrets: Value| json!({ "name": "X", "kind": "postgres", "settings": settings, "secrets": secrets });
    for (body, field, reason) in [
        (json!({ "name": "X", "kind": "oracle", "settings": {} }), "kind", Some("datasource.kind_unknown")),
        (json!({ "name": " ", "kind": "sqlite", "settings": { "path": "/x" } }), "name", Some("request.name_length")),
        (pg(json!({ "database": "d", "user": "u" }), json!({})), "host", Some("settings.required")),
        (
            pg(json!({ "host": "h", "database": "d", "user": "u", "password": "x" }), json!({})),
            "password",
            Some("settings.secret_in_settings"),
        ),
        (
            pg(json!({ "host": "h", "database": "d", "user": "u" }), json!({ "apiKey": "x" })),
            "secrets",
            Some("secrets.unknown"),
        ),
        (
            pg(json!({ "host": "h", "database": "d", "user": "u", "port": 70000 }), json!({})),
            "port",
            Some("settings.port_invalid"),
        ),
        (
            json!({ "name": "P", "kind": "prometheus", "settings": { "url": "https://admin:pw@prom.intern" } }),
            "url",
            Some("settings.url_credentials"),
        ),
        (
            json!({ "name": "S", "kind": "sqlite", "settings": { "path": "relativ.db" } }),
            "path",
            Some("settings.path_relative"),
        ),
    ] {
        let r = t.post("/datasources", body.clone()).await;
        assert_eq!((r.status, r.code()), (StatusCode::UNPROCESSABLE_ENTITY, "validation"), "{body}: {}", r.text);
        assert_eq!(r.body["error"]["field"], field, "{body}");
        if let Some(reason) = reason {
            assert_eq!(r.body["error"]["reason"], reason, "{body}: {}", r.text);
            let param = if field == "kind" { "kind" } else { "field" };
            if field == "name" {
                assert_eq!(r.body["error"]["params"]["max"], "100", "{body}: {}", r.text);
            }
            assert!(r.body["error"]["params"][param].is_string(), "{body}: {}", r.text);
        }
        assert!(!r.text.contains("admin:pw"));
    }
    let r = t.post("/datasources", json!({ "name": "X", "kind": "sqlite", "settings": {}, "extra": 1 })).await;
    assert_eq!(r.code(), "validation");
    // Only a choice names its options.
    let r =
        t.post("/datasources", pg(json!({ "host": "h", "database": "d", "user": "u", "port": "x" }), json!({}))).await;
    assert_eq!(r.body["error"]["reason"], "settings.expected_number", "{}", r.text);
    assert_eq!(r.body["error"]["params"], json!({ "field": "port" }), "{}", r.text);
    let r = t
        .post("/datasources", pg(json!({ "host": "h", "database": "d", "user": "u", "sslMode": "x" }), json!({})))
        .await;
    assert_eq!(r.body["error"]["reason"], "settings.expected_option", "{}", r.text);
    assert_eq!(r.body["error"]["params"]["options"], "disable, prefer, require, verify-ca, verify-full", "{}", r.text);
    t.finish().await;
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
        assert_eq!(r.body["error"]["reason"], "target.sqlite_path_refused", "{}", r.text);
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
    assert_eq!(r.body["results"]["A"]["error"]["reason"], "target.sqlite_path_refused", "{}", r.text);
    let h = t.post(&format!("/datasources/{id}/health"), json!({})).await;
    assert_eq!((h.body["ok"].as_bool(), h.body["code"].as_str()), (Some(false), Some("datasource_target_blocked")));
    assert_eq!(h.body["reason"], "target.sqlite_path_refused", "{}", h.text);
    t.finish().await;
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
    t.finish().await;
}

/// A NUMERIC column (and an expression) whose first values are whole numbers keeps the decimals
/// that come later: the column becomes a number instead of int64 with empty decimals.
#[tokio::test]
async fn sqlite_numeric_columns_keep_decimals_after_whole_numbers() {
    let t = T::new().await;
    let file = t
        .sqlite_file(
            "preise.db",
            "CREATE TABLE p (id INTEGER, preis NUMERIC(10, 2), ganz NUMERIC);
             INSERT INTO p VALUES (1, 10, 1), (2, 12.5, 2), (3, 7, 3), (4, NULL, 4), (5, -0.25, 5);",
        )
        .await;
    let id = t.create_sqlite("Preise", &file).await;
    let r = t
        .query(
            &t.owner,
            json!([{ "refId": "A", "datasourceId": id,
                     "query": { "sql": "SELECT preis, ganz, preis * 2 AS doppelt FROM p ORDER BY id" } }]),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let frame = &r.body["results"]["A"]["result"]["frame"];
    let types: Vec<&str> = frame["fields"].as_array().unwrap().iter().map(|f| f["type"].as_str().unwrap()).collect();
    assert_eq!(types, ["number", "int64", "number"], "{}", r.text);
    assert_eq!(frame["fields"][0]["values"], json!([10.0, 12.5, 7.0, null, -0.25]));
    assert_eq!(frame["fields"][1]["values"], json!(["1", "2", "3", "4", "5"]));
    assert_eq!(frame["fields"][2]["values"], json!([20.0, 25.0, 14.0, null, -0.5]));
    assert!(frame["meta"]["notices"].as_array().unwrap().is_empty(), "no value was lost: {}", r.text);

    // Whole numbers beyond 2^53 in a column that turns out to hold decimals are rounded, and
    // the answer says how many: one read before the first decimal, one after it.
    let r = t
        .query(
            &t.owner,
            json!([{ "refId": "A", "datasourceId": id,
                     "query": { "sql": "SELECT column1 AS x FROM (VALUES (9007199254740993), (2), (1.5), (9007199254740995))" } }]),
        )
        .await;
    let frame = &r.body["results"]["A"]["result"]["frame"];
    assert_eq!(frame["fields"][0]["type"], "number", "{}", r.text);
    let notice = frame["meta"]["notices"].as_array().unwrap().iter().find(|n| n["code"] == "frame.value_rounded");
    assert_eq!(notice.map(|n| n["params"].clone()), Some(json!({ "column": "x", "count": "2" })), "{}", r.text);
    t.finish().await;
}

/// `$__timeFilter` on SQLite compares times, not text: ISO values with "T" or a space and Unix
/// seconds or milliseconds all match exactly at the range edges.
#[tokio::test]
async fn sqlite_time_filter_compares_times_in_every_stored_form() {
    let t = T::new().await;
    // The range is 2026-01-01 10:00:00 to 2026-01-01 12:00:00 UTC.
    const FROM: i64 = 1_767_261_600_000;
    const TO: i64 = 1_767_268_800_000;
    let file = t
        .sqlite_file(
            "zeiten.db",
            &format!(
                "CREATE TABLE e (name TEXT, am);
                 INSERT INTO e VALUES
                 ('iso_t_from', '2026-01-01T10:00:00'), ('iso_t_to', '2026-01-01T12:00:00.000Z'),
                 ('iso_t_inside', '2026-01-01T11:00:00'), ('iso_t_before', '2026-01-01T09:59:59.999'),
                 ('iso_t_after', '2026-01-01T12:00:00.001'), ('iso_t_zone', '2026-01-01T12:30:00+01:00'),
                 ('space_from', '2026-01-01 10:00:00'), ('space_to', '2026-01-01 12:00:00'),
                 ('space_before', '2026-01-01 09:59:59.999'), ('space_after', '2026-01-01 12:00:00.001'),
                 ('s_from', {s_from}), ('s_to', {s_to}), ('s_before', {s_before}), ('s_after', {s_after}),
                 ('s_real', {s_real}),
                 ('ms_from', {FROM}), ('ms_to', {TO}), ('ms_before', {ms_before}), ('ms_after', {ms_after}),
                 ('leer', NULL);",
                s_from = FROM / 1000,
                s_to = TO / 1000,
                s_before = FROM / 1000 - 1,
                s_after = TO / 1000 + 1,
                s_real = (FROM as f64 + 500.0) / 1000.0,
                ms_before = FROM - 1,
                ms_after = TO + 1,
            ),
        )
        .await;
    let id = t.create_sqlite("Zeiten", &file).await;
    let body = json!({
        "queries": [{ "refId": "A", "datasourceId": id,
                      "query": { "sql": "SELECT name FROM e WHERE $__timeFilter(am) ORDER BY name" } }],
        "timeRange": { "from": FROM, "to": TO }
    });
    let r = t.send(Method::POST, &t.path("/query"), Some(body), Some(&t.owner)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(
        r.body["results"]["A"]["result"]["frame"]["fields"][0]["values"],
        json!([
            "iso_t_from",
            "iso_t_inside",
            "iso_t_to",
            "iso_t_zone",
            "ms_from",
            "ms_to",
            "s_from",
            "s_real",
            "s_to",
            "space_from",
            "space_to"
        ]),
        "{}",
        r.text
    );
    t.finish().await;
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
        concat!(
            "SELECT land FROM verkauf WHERE ((am BETWEEN ? AND ? OR am BETWEEN ? AND ? OR am BETWEEN ? AND ?) AND ",
            "(CASE WHEN typeof(am) IN ('integer', 'real') THEN (CASE WHEN abs(am) > 100000000000 THEN am ELSE ",
            "am * 1000 END) BETWEEN ? AND ? ELSE julianday(am) BETWEEN julianday(?) AND julianday(?) END)) ",
            "AND land IN (?, ?) AND land <> ?"
        )
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
    t.finish().await;
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
    for (refid, reason) in
        [("del", "sql.not_select"), ("ext", "sql.function_not_allowed"), ("form", "query.invalid_form")]
    {
        assert_eq!(res[refid]["error"]["code"], "query_rejected", "{refid}: {}", r.text);
        assert_eq!(res[refid]["error"]["reason"], reason, "{refid}: {}", r.text);
    }
    assert_eq!(res["ext"]["error"]["params"]["name"], "load_extension", "{}", r.text);
    assert_eq!(res["gone"]["error"]["code"], "not_found");
    assert!(res["gone"]["error"].get("reason").is_none(), "the code says it all: {}", r.text);
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM verkauf")
        .fetch_one(&sqlx::SqlitePool::connect(&crate::config::sqlite_url(&file)).await.unwrap())
        .await
        .unwrap();
    assert_eq!(n, 3);

    for (bad, reason) in [
        (json!({ "queries": [], "timeRange": { "from": 0, "to": 1 } }), Some("query.count")),
        (
            json!({ "queries": [{ "refId": "A", "datasourceId": id, "query": {} }, { "refId": "A", "datasourceId": id, "query": {} }], "timeRange": { "from": 0, "to": 1 } }),
            Some("query.ref_id"),
        ),
        (
            json!({ "queries": [{ "refId": "A", "datasourceId": id, "query": {} }], "timeRange": { "from": 2, "to": 1 } }),
            Some("query.range_reversed"),
        ),
        (
            json!({ "queries": [{ "refId": "A", "datasourceId": id, "query": {} }], "timeRange": { "from": 0, "to": 1 }, "extra": true }),
            Some("request.body_invalid"),
        ),
    ] {
        let r = t.send(Method::POST, &t.path("/query"), Some(bad.clone()), Some(&t.owner)).await;
        assert_eq!(r.code(), "validation", "{bad}: {}", r.text);
        if let Some(reason) = reason {
            assert_eq!(r.body["error"]["reason"], reason, "{bad}: {}", r.text);
        }
    }
    t.finish().await;
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
    assert_eq!(frame["meta"]["notices"][0]["code"], "frame.row_limit", "{}", r.text);
    assert_eq!(frame["meta"]["notices"][0]["params"]["rows"], "2", "{}", r.text);

    t.set("datasources.max_response_bytes", json!(20));
    let r = t
        .query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "sql": "SELECT land FROM verkauf" } }]))
        .await;
    assert_eq!(r.body["results"]["A"]["result"]["frame"]["meta"]["rowsTruncated"], true, "{}", r.text);
    t.finish().await;
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
    t.finish().await;
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
    t.finish().await;
}

#[tokio::test]
async fn empty_sqlite_tables_keep_their_declared_types() {
    let t = T::new().await;
    let file = t
        .sqlite_file(
            "leer.db",
            "CREATE TABLE leer (i INTEGER, r REAL, s TEXT, d DATETIME, b BOOLEAN, v VARCHAR(20), f DOUBLE, n NUMERIC);",
        )
        .await;
    let id = t.create_sqlite("Leer", &file).await;
    let sql = "SELECT i, r, s, d, b, v, f, n, r * 2 AS e FROM leer";
    let r = t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "sql": sql } }])).await;
    let frame = &r.body["results"]["A"]["result"]["frame"];
    let types: Vec<&str> =
        frame["fields"].as_array().expect(&r.text).iter().map(|f| f["type"].as_str().unwrap()).collect();
    // NUMERIC and the expression have no type SQLite can name before a row exists: the
    // documented default, string.
    assert_eq!(types, ["int64", "number", "string", "time", "bool", "string", "number", "string", "string"]);
    assert_eq!(frame["fields"][1]["values"], json!([]));
    t.finish().await;
}

/// Values are converted to the column's type where nothing is lost: a whole REAL in an int64
/// column is its integer, a fraction in a declared INTEGER column is `null` and counted, and a
/// column typed by its values becomes `number` at its first fraction; numbers in a time column
/// are Unix seconds up to 10^11 and milliseconds above.
#[tokio::test]
async fn sqlite_values_keep_to_their_column_type() {
    let t = T::new().await;
    let file = t
        .sqlite_file(
            "werte.db",
            // INTEGER affinity stores 3.0 as the integer 3 and keeps 1.5 and 2.5 as REAL.
            "CREATE TABLE z (i INTEGER); INSERT INTO z VALUES (1), (3.0), (1.5), (2.5);
             CREATE VIEW plus AS SELECT i + 1 AS j FROM z;
             CREATE TABLE e (d DATETIME);
             INSERT INTO e VALUES (1767261600), (1767261600000), (1767261600.5), ('2026-01-01 10:00:00'),
                                  (9000000000000000), (1e300);",
        )
        .await;
    let id = t.create_sqlite("Werte", &file).await;
    let run = |sql: &str| {
        let t = &t;
        let q = json!([{ "refId": "A", "datasourceId": id, "query": { "sql": sql } }]);
        async move {
            let r = t.query(&t.owner, q).await;
            let frame = r.body["results"]["A"]["result"]["frame"].clone();
            assert!(frame.is_object(), "{}", r.text);
            frame
        }
    };
    let mismatch = |frame: &Value| {
        frame["meta"]["notices"].as_array().unwrap().iter().find(|n| n["code"] == "frame.value_mismatch").cloned()
    };

    // Declared INTEGER: the fractions are empty, counted once per column.
    let frame = run("SELECT i FROM z ORDER BY rowid").await;
    assert_eq!(frame["fields"][0]["type"], "int64");
    assert_eq!(frame["fields"][0]["values"], json!(["1", "3", null, null]));
    let notice = mismatch(&frame).expect("a mismatch notice");
    assert_eq!(notice["params"], json!({ "column": "i", "count": "2" }));
    assert_eq!(frame["meta"]["notices"].as_array().unwrap().len(), 1, "one notice per column: {frame}");

    // The view's expression has no declared type: its first values make it int64, and its first
    // fraction makes it a number, with the values before it converted.
    let frame = run("SELECT j FROM plus").await;
    assert_eq!(frame["fields"][0]["type"], "number");
    assert_eq!(frame["fields"][0]["values"], json!([2.0, 4.0, 2.5, 3.5]));
    assert!(mismatch(&frame).is_none(), "{frame}");

    // A whole number stored as REAL stays an integer until the first fraction.
    let frame = run("SELECT 1 AS n UNION ALL SELECT 4.0").await;
    assert_eq!(
        (frame["fields"][0]["type"].clone(), frame["fields"][0]["values"].clone()),
        (json!("int64"), json!(["1", "4"]))
    );
    let frame = run("SELECT 1 AS n UNION ALL SELECT 4.0 UNION ALL SELECT 2.5").await;
    assert_eq!(frame["fields"][0]["values"], json!([1.0, 4.0, 2.5]));
    assert!(mismatch(&frame).is_none(), "{frame}");

    // Seconds, milliseconds, fractional seconds and text all name the same time; numbers past
    // the year 9999 are no time.
    let frame = run("SELECT d FROM e ORDER BY rowid").await;
    assert_eq!(frame["fields"][0]["type"], "time");
    let ms = 1_767_261_600_000_i64;
    assert_eq!(frame["fields"][0]["values"], json!([ms, ms, ms + 500, ms, null, null]));
    assert_eq!(mismatch(&frame).unwrap()["params"], json!({ "column": "d", "count": "2" }));

    // A row the limit cuts is not in the answer, so its mismatch is not counted.
    let limited = |limit: u32| {
        let t = &t;
        let q = json!([{ "refId": "A", "datasourceId": id, "query": { "sql": "SELECT i FROM z ORDER BY rowid" }, "limit": limit }]);
        async move { t.query(&t.owner, q).await.body["results"]["A"]["result"]["frame"].clone() }
    };
    let frame = limited(2).await;
    assert_eq!(frame["fields"][0]["values"], json!(["1", "3"]));
    assert!(mismatch(&frame).is_none(), "the cut row holds the first fraction: {frame}");
    let frame = limited(3).await;
    assert_eq!(frame["fields"][0]["values"], json!(["1", "3", null]));
    assert_eq!(mismatch(&frame).unwrap()["params"]["count"], "1");
    t.finish().await;
}

#[tokio::test]
async fn a_recreated_sqlite_table_answers_with_its_new_types() {
    let t = T::new().await;
    let file = t.sqlite_file("wandel.db", "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('a');").await;
    let id = t.create_sqlite("Wandel", &file).await;
    let q = json!([{ "refId": "A", "datasourceId": id, "query": { "sql": "SELECT v FROM t" } }]);
    let field = |r: &Reply| r.body["results"]["A"]["result"]["frame"]["fields"][0].clone();
    let before = t.query(&t.owner, q.clone()).await;
    assert_eq!(field(&before)["type"], "string", "{}", before.text);
    // Recreated under the running server, whose pool keeps its connection open.
    t.sqlite_file("wandel.db", "DROP TABLE t; CREATE TABLE t (v REAL); INSERT INTO t VALUES (1.5);").await;
    let after = t.query(&t.owner, q).await;
    assert_eq!(field(&after)["type"], "number", "{}", after.text);
    assert_eq!(field(&after)["values"], json!([1.5]));
    t.finish().await;
}

#[tokio::test]
async fn health_and_schema_of_a_sqlite_file() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let id = t.create_sqlite("U", &file).await;
    let h = t.post(&format!("/datasources/{id}/health"), json!({})).await;
    assert_eq!(h.body["ok"], true, "{}", h.text);
    // The UI translates the reason with its params; the message is the English fallback.
    assert_eq!(h.body["reason"], "health.connected_read_only", "{}", h.text);
    assert_eq!(h.body["params"]["engine"], "SQLite");
    assert!(h.body["params"]["version"].as_str().is_some_and(|v| v.starts_with('3')), "{}", h.text);
    assert!(h.body["message"].as_str().unwrap().contains("read-only"));
    assert!(h.body.get("code").is_none());
    assert!(h.body["latencyMs"].is_u64());
    let s = t.get(&format!("/datasources/{id}/schema")).await;
    assert_eq!(s.body["kind"], "tables", "{}", s.text);
    assert_eq!(s.body["tables"][0]["name"], "verkauf");
    assert_eq!(s.body["tables"][0]["columns"][1], json!({ "name": "land", "type": "TEXT" }));
    t.finish().await;
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
    t.finish().await;
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
    let trashed = t.create_sqlite("Papierkorb", &file).await;
    t.send(Method::DELETE, &t.path(&format!("/datasources/{trashed}")), None, Some(&t.owner)).await;
    for (method, path, body) in [
        (Method::POST, t.path("/datasources"), Some(create.clone())),
        (Method::PATCH, one.clone(), Some(json!({ "name": "N" }))),
        (Method::DELETE, one.clone(), None),
        (Method::POST, t.path(&format!("/datasources/{trashed}/restore")), Some(json!({}))),
    ] {
        let r = t.send(method.clone(), &path, body, Some(&editor)).await;
        assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden"), "{method} {path}");
    }
    // The trash lists only what the caller may restore: nothing, for an editor.
    let r = t.send(Method::GET, &t.path("/datasources?trash=true"), None, Some(&editor)).await;
    assert_eq!((r.status, r.body["items"].as_array().map(Vec::len)), (StatusCode::OK, Some(0)), "{}", r.text);
    // Viewers have no data source rights of their own: the list is empty, queries do not find
    // the source, and its routes do not exist for them.
    let r = t.send(Method::GET, &t.path("/datasources"), None, Some(&viewer)).await;
    assert_eq!((r.status, r.body["items"].as_array().map(Vec::len)), (StatusCode::OK, Some(0)), "{}", r.text);
    let r = t.query(&viewer, q.clone()).await;
    assert_eq!(r.body["results"]["A"]["error"]["code"], "not_found", "{}", r.text);
    for (method, path) in
        [(Method::POST, format!("{one}/health")), (Method::GET, format!("{one}/schema")), (Method::GET, one.clone())]
    {
        let body = (method == Method::POST).then(|| json!({}));
        let r = t.send(method.clone(), &path, body, Some(&viewer)).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{method} {path}: {}", r.text);
    }
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
    t.finish().await;
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
                if q.contains("gross") {
                    let values: Vec<Value> = (0..5_000).map(|i| json!([1_700_000_000 + i, "1.5"])).collect();
                    let body = json!({ "status": "success", "data": { "resultType": "matrix", "result": [
                        { "metric": { "__name__": "gross" }, "values": values }
                    ] } });
                    return (StatusCode::OK, axum::Json(body));
                }
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

    // `$__interval` and `$__rate_interval` follow the step actually asked for: the minimum step
    // when it is above the panel's interval, and the point limit's step over a long range.
    let interval_query = |range: (i64, i64), min_step: Option<u64>| {
        let mut query =
            json!({ "expr": "rate(up[$__rate_interval]) / avg_over_time(up[$__interval]) > $__interval_ms" });
        if let Some(step) = min_step {
            query["minStepMs"] = json!(step);
        }
        json!({ "queries": [{ "refId": "A", "datasourceId": id, "query": query }],
                "timeRange": { "from": range.0, "to": range.1 }, "intervalMs": 15_000 })
    };
    let hour = (1_700_000_000_000_i64, 1_700_003_600_000_i64);
    for (body, expected) in [
        (interval_query(hour, None), "rate(up[1m]) / avg_over_time(up[15s]) > 15000"),
        (interval_query(hour, Some(120_000)), "rate(up[8m]) / avg_over_time(up[2m]) > 120000"),
        // 110 days at 11,000 points per series need a step of 864,001 ms.
        (
            interval_query((1_700_000_000_000, 1_700_000_000_000 + 110 * 86_400_000), None),
            "rate(up[3456004ms]) / avg_over_time(up[864001ms]) > 864001",
        ),
    ] {
        let r = t.send(Method::POST, &t.path("/query"), Some(body), Some(&t.owner)).await;
        assert_eq!(r.body["results"]["A"]["result"]["frame"]["meta"]["executedQuery"], expected, "{}", r.text);
    }

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

    // A large answer is charged to the request's budget while it is read, and everything is
    // given back afterwards.
    t.set("datasources.max_response_bytes", json!(10_000));
    let big = t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "expr": "gross" } }])).await;
    assert_eq!(big.body["results"]["A"]["error"]["code"], "datasource_error", "{}", big.text);
    assert!(big.text.contains("larger than"), "{}", big.text);
    assert_eq!(t.state.datasources.inflight_available(), 1_073_741_824);
    t.set("datasources.max_response_bytes", json!(1_000_000));
    let ok = t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "expr": "gross" } }])).await;
    assert_eq!(ok.body["results"]["A"]["result"]["frame"]["fields"][1]["values"].as_array().unwrap().len(), 5_000);
    assert_eq!(t.state.datasources.inflight_available(), 1_073_741_824);

    // The allow-list applies to HTTP sources too.
    t.set("datasources.allowed_targets", json!(["10.0.0.0/8"]));
    let blocked = t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "expr": "up" } }])).await;
    assert_eq!(blocked.body["results"]["A"]["error"]["code"], "datasource_target_blocked", "{}", blocked.text);
    t.finish().await;
}

// ---- a dashboard's stored queries ----

fn dashboard_model(ds: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "title": "Umsatz",
        "timeRange": { "from": "now-6h", "to": "now" },
        "variables": [
            { "name": "land", "type": "query", "datasourceId": ds,
              "query": { "sql": "SELECT land, land || '!' AS label FROM verkauf ORDER BY id" } },
            { "name": "kaputt", "type": "query", "datasourceId": ds, "query": { "sql": "DELETE FROM verkauf" } },
            { "name": "fest", "type": "constant" }
        ],
        "panels": [{
            "id": "p1", "type": "table", "title": "Verkäufe", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
            "targets": [
                { "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT id FROM verkauf WHERE land = $land" } },
                { "refId": "B", "datasourceId": ds, "query": { "sql": "DELETE FROM verkauf" } },
                { "refId": "C", "datasourceId": ds, "query": { "sql": "SELECT id FROM verkauf ORDER BY id" } }
            ],
            "transformations": [], "options": {}, "fieldConfig": {}
        }]
    })
}

impl T {
    async fn dashboard(&self, ds: &str, folder: Option<&str>) -> String {
        let mut body = json!({ "model": dashboard_model(ds) });
        if let Some(f) = folder {
            body["folderId"] = json!(f);
        }
        let r = self.post("/dashboards", body).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
        r.body["id"].as_str().unwrap().to_string()
    }

    async fn panel(&self, cookie: &str, dashboard: &str, panel: &str, body: Value) -> Reply {
        let path = self.path(&format!("/dashboards/{dashboard}/panels/{panel}/query"));
        self.send(Method::POST, &path, Some(body), Some(cookie)).await
    }

    async fn options(&self, cookie: &str, dashboard: &str, name: &str, body: Value) -> Reply {
        let path = self.path(&format!("/dashboards/{dashboard}/variables/{name}/options"));
        self.send(Method::POST, &path, Some(body), Some(cookie)).await
    }
}

fn range() -> Value {
    json!({ "from": 1_700_000_000_000_i64, "to": 1_800_000_000_000_i64 })
}

#[tokio::test]
async fn viewers_run_the_stored_queries_of_dashboards_they_may_read() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let ds = t.create_sqlite("Umsätze", &file).await;
    let dashboard = t.dashboard(&ds, None).await;
    let viewer = t.session_for_role("viewer", Some("viewer")).await;

    // Viewers hold no data source permission; reading the dashboard is enough for its queries.
    let r =
        t.panel(&viewer, &dashboard, "p1", json!({ "timeRange": range(), "variables": { "land": "Schweiz" } })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["results"]["A"]["result"]["frame"]["fields"][0]["values"], json!(["2"]));
    assert_eq!(r.body["results"]["B"]["error"]["code"], "query_rejected", "stored writes are refused too");
    // Without a value the variable's query answers for its refId only.
    let r = t.panel(&viewer, &dashboard, "p1", json!({ "timeRange": range() })).await;
    assert_eq!(r.body["results"]["A"]["error"]["code"], "query_rejected", "{}", r.text);

    let r = t.options(&viewer, &dashboard, "land", json!({ "timeRange": range() })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["options"][0], json!({ "value": "Österreich", "label": "Österreich!" }));
    assert_eq!(r.body["options"].as_array().unwrap().len(), 3);
    assert_eq!(r.body["truncated"], false);
    let r = t.options(&viewer, &dashboard, "kaputt", json!({ "timeRange": range() })).await;
    assert_eq!((r.status, r.code()), (StatusCode::UNPROCESSABLE_ENTITY, "query_rejected"), "{}", r.text);
    let r = t.options(&viewer, &dashboard, "fest", json!({ "timeRange": range() })).await;
    assert_eq!(r.code(), "validation", "not a query variable");
    // A variable's own value is refused.
    let r = t.options(&viewer, &dashboard, "land", json!({ "timeRange": range(), "variables": { "land": "x" } })).await;
    assert_eq!((r.code(), r.body["error"]["field"].as_str()), ("validation", Some("variables")));

    // Unknown panels and variables do not exist.
    assert_eq!(t.panel(&viewer, &dashboard, "p9", json!({ "timeRange": range() })).await.status, StatusCode::NOT_FOUND);
    let r = t.options(&viewer, &dashboard, "nix", json!({ "timeRange": range() })).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // A trashed data source answers per target.
    t.send(Method::DELETE, &t.path(&format!("/datasources/{ds}")), None, Some(&t.owner)).await;
    let r =
        t.panel(&viewer, &dashboard, "p1", json!({ "timeRange": range(), "variables": { "land": "Schweiz" } })).await;
    assert_eq!(r.body["results"]["A"]["error"]["code"], "not_found", "{}", r.text);
    t.finish().await;
}

/// A dashboard stored before a panel option rule existed keeps working: its queries run, it saves
/// while that panel stays as it is, and older versions restore. Changing the panel means fixing it.
#[tokio::test]
async fn stored_panels_that_predate_the_option_rules_keep_working() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let ds = t.create_sqlite("Umsätze", &file).await;
    let dashboard = t.dashboard(&ds, None).await;
    let mut odd = dashboard_model(&ds);
    odd["panels"][0]["options"] = json!({ "rowColors": true, "pageSize": 1 });
    odd["panels"][0]["fieldConfig"] = json!({ "defaults": { "decimals": 99 } });
    sqlx::query("UPDATE dashboard_versions SET model = $1 WHERE dashboard_id = $2 AND version = 1")
        .bind(odd.to_string())
        .bind(&dashboard)
        .execute(&t.state.db)
        .await
        .unwrap();

    let body = json!({ "timeRange": range(), "variables": { "land": "Schweiz" } });
    let r = t.panel(&t.owner, &dashboard, "p1", body).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = t.options(&t.owner, &dashboard, "land", json!({ "timeRange": range() })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);

    let path = t.path(&format!("/dashboards/{dashboard}"));
    let mut renamed = odd.clone();
    renamed["title"] = json!("Umsatz 2026");
    let r = t.send(Method::PUT, &path, Some(json!({ "model": renamed, "version": 1 })), Some(&t.owner)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = t.post(&format!("/dashboards/{dashboard}/versions/1/restore"), json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);

    let mut changed = odd;
    changed["panels"][0]["options"] = json!({ "pageSize": 2 });
    let r = t.send(Method::PUT, &path, Some(json!({ "model": changed, "version": 3 })), Some(&t.owner)).await;
    assert_eq!((r.status, r.code()), (StatusCode::UNPROCESSABLE_ENTITY, "validation"), "{}", r.text);
    assert!(r.text.contains("model.panels[0].fieldConfig.defaults.decimals"), "{}", r.text);
}

/// Creating a dashboard and restoring a version check the panel options of what they write, and
/// the refusal names the panel.
#[tokio::test]
async fn creating_and_restoring_check_panel_options() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let ds = t.create_sqlite("Umsätze", &file).await;

    let mut odd = dashboard_model(&ds);
    odd["panels"][0]["options"] = json!({ "pageSize": 1 });
    let r = t.post("/dashboards", json!({ "model": odd })).await;
    assert_eq!((r.status, r.code()), (StatusCode::UNPROCESSABLE_ENTITY, "validation"), "{}", r.text);
    assert_eq!(r.body["error"]["reason"], "dashboards.panel_options", "{}", r.text);
    assert_eq!(r.body["error"]["params"]["panel"], "Verkäufe", "{}", r.text);
    assert!(r.text.contains("options.pageSize"), "{}", r.text);

    // Version 1 is stored with options from before a rule; version 2 changed them since.
    let dashboard = t.dashboard(&ds, None).await;
    let path = t.path(&format!("/dashboards/{dashboard}"));
    let mut fixed = dashboard_model(&ds);
    fixed["panels"][0]["options"] = json!({ "pageSize": 50 });
    let r = t.send(Method::PUT, &path, Some(json!({ "model": fixed, "version": 1 })), Some(&t.owner)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    sqlx::query("UPDATE dashboard_versions SET model = $1 WHERE dashboard_id = $2 AND version = 1")
        .bind(odd.to_string())
        .bind(&dashboard)
        .execute(&t.state.db)
        .await
        .unwrap();
    let r = t.post(&format!("/dashboards/{dashboard}/versions/1/restore"), json!({})).await;
    assert_eq!((r.status, r.code()), (StatusCode::UNPROCESSABLE_ENTITY, "validation"), "{}", r.text);
    assert_eq!(r.body["error"]["reason"], "dashboards.panel_options", "{}", r.text);
}

#[tokio::test]
async fn dashboards_the_caller_cannot_read_do_not_exist() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let ds = t.create_sqlite("Umsätze", &file).await;
    let folder = t.post("/folders", json!({ "name": "Geheim", "restricted": true })).await;
    assert_eq!(folder.status, StatusCode::CREATED, "{}", folder.text);
    let hidden = t.dashboard(&ds, Some(folder.body["id"].as_str().unwrap())).await;
    let open = t.dashboard(&ds, None).await;
    let viewer = t.session_for_role("viewer", Some("viewer")).await;
    let stranger = t.session_for_role("fremd", Some("stranger")).await;
    let body = json!({ "timeRange": range(), "variables": { "land": "Schweiz" } });

    // Inside a restricted folder without a grant: not found, for both routes.
    assert_eq!(t.panel(&viewer, &hidden, "p1", body.clone()).await.status, StatusCode::NOT_FOUND);
    let r = t.options(&viewer, &hidden, "land", json!({ "timeRange": range() })).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // The owner manages folder permissions and sees it.
    assert_eq!(t.panel(&t.owner, &hidden, "p1", body.clone()).await.status, StatusCode::OK);
    // Members of other organizations and unknown dashboards: not found.
    assert_eq!(t.panel(&stranger, &open, "p1", body.clone()).await.status, StatusCode::NOT_FOUND);
    let unknown = uuid::Uuid::now_v7().to_string();
    assert_eq!(t.panel(&viewer, &unknown, "p1", body.clone()).await.status, StatusCode::NOT_FOUND);
    // A trashed dashboard runs nothing.
    t.send(Method::DELETE, &t.path(&format!("/dashboards/{open}")), None, Some(&t.owner)).await;
    assert_eq!(t.panel(&viewer, &open, "p1", body).await.status, StatusCode::NOT_FOUND);
    t.finish().await;
}

#[tokio::test]
async fn dashboard_query_requests_are_bounded() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let ds = t.create_sqlite("Umsätze", &file).await;
    let dashboard = t.dashboard(&ds, None).await;
    let viewer = t.session_for_role("viewer", Some("viewer")).await;
    let many: serde_json::Map<String, Value> = (0..101).map(|i| (format!("v{i}"), json!(i))).collect();
    for (body, field) in [
        (json!({ "timeRange": { "from": 0, "to": i64::MAX } }), "timeRange"),
        (json!({ "timeRange": { "from": 2, "to": 1 } }), "timeRange"),
        (json!({ "timeRange": range(), "variables": { "fremd": 1 } }), "variables"),
        (json!({ "timeRange": range(), "variables": many }), "variables"),
        (json!({ "timeRange": range(), "variables": { "land": "x".repeat(70_000) } }), "variables"),
    ] {
        let r = t.panel(&viewer, &dashboard, "p1", body.clone()).await;
        assert_eq!((r.code(), r.body["error"]["field"].as_str()), ("validation", Some(field)), "{body}: {}", r.text);
    }
    let r = t.panel(&viewer, &dashboard, "p1", json!({ "timeRange": range(), "extra": 1 })).await;
    assert_eq!(r.code(), "validation");
    let r = t.options(&viewer, &dashboard, "land", json!({ "timeRange": range(), "cursors": {} })).await;
    assert_eq!(r.code(), "validation", "unknown fields are refused");
    // The row limit applies to stored queries too: C has three rows.
    let all = t.panel(&viewer, &dashboard, "p1", json!({ "timeRange": range(), "variables": { "land": "x" } })).await;
    assert_eq!(all.body["results"]["C"]["result"]["frame"]["fields"][0]["values"].as_array().unwrap().len(), 3);
    let body = json!({ "timeRange": range(), "variables": { "land": "x" }, "limit": 1 });
    let r = t.panel(&viewer, &dashboard, "p1", body).await;
    let frame = &r.body["results"]["C"]["result"]["frame"];
    assert_eq!(frame["fields"][0]["values"].as_array().unwrap().len(), 1, "{}", r.text);
    assert_eq!(frame["meta"]["rowsTruncated"], true);
    let r = t.panel(&viewer, &dashboard, "p1", json!({ "timeRange": range(), "intervalMs": 0 })).await;
    assert_eq!((r.code(), r.body["error"]["field"].as_str()), ("validation", Some("intervalMs")));
    let r = t.panel(&viewer, &dashboard, "p1", json!({ "timeRange": range(), "intervalMs": u64::MAX })).await;
    assert_eq!((r.code(), r.body["error"]["field"].as_str()), ("validation", Some("intervalMs")));
    t.finish().await;
}

/// A grant on a data source gives a member what the role does not, on that source only, and
/// taking it back takes effect at once.
#[tokio::test]
async fn data_source_grants_extend_and_revoke_access() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let shared = t.create_sqlite("Geteilt", &file).await;
    let other = t.create_sqlite("Andere", &file).await;
    let viewer = t.session_for_role("vera", Some("viewer")).await;
    let (vera,): (String,) =
        sqlx::query_as("SELECT id FROM users WHERE email = 'vera@example.de'").fetch_one(&t.state.db).await.unwrap();
    let grant = |level: &str| json!({ "subjectType": "user", "subjectId": vera, "resourceType": "datasource", "resourceId": shared, "level": level });
    let r = t.post("/grants", grant("query")).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let grant_id = r.body["id"].as_str().unwrap().to_string();

    let list = t.send(Method::GET, &t.path("/datasources"), None, Some(&viewer)).await;
    let ids: Vec<&str> = list.body["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [shared.as_str()], "only the granted source: {}", list.text);
    let q = |id: &str| json!([{ "refId": "A", "datasourceId": id, "query": { "sql": "SELECT COUNT(*) AS n FROM verkauf" } }]);
    assert!(t.query(&viewer, q(&shared)).await.body["results"]["A"]["result"].is_object());
    assert_eq!(t.query(&viewer, q(&other)).await.body["results"]["A"]["error"]["code"], "not_found");
    let health =
        t.send(Method::POST, &t.path(&format!("/datasources/{shared}/health")), Some(json!({})), Some(&viewer)).await;
    assert_eq!(health.body["ok"], true, "{}", health.text);
    let schema = t.send(Method::GET, &t.path(&format!("/datasources/{shared}/schema")), None, Some(&viewer)).await;
    assert_eq!(schema.status, StatusCode::OK);
    let rename = json!({ "name": "Umbenannt" });
    let r =
        t.send(Method::PATCH, &t.path(&format!("/datasources/{shared}")), Some(rename.clone()), Some(&viewer)).await;
    assert_eq!(r.code(), "forbidden", "query rights do not edit");

    // An edit grant lets the member change this source.
    t.post("/grants", grant("edit")).await;
    let r = t.send(Method::PATCH, &t.path(&format!("/datasources/{shared}")), Some(rename), Some(&viewer)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);

    // Revoked: free queries, health and schema stop at once.
    let r = t.send(Method::DELETE, &t.path(&format!("/grants/{grant_id}")), None, Some(&t.owner)).await;
    assert!(r.status.is_success(), "{}", r.text);
    assert_eq!(t.query(&viewer, q(&shared)).await.body["results"]["A"]["error"]["code"], "not_found");
    let health =
        t.send(Method::POST, &t.path(&format!("/datasources/{shared}/health")), Some(json!({})), Some(&viewer)).await;
    assert_eq!(health.status, StatusCode::NOT_FOUND);
    let list = t.send(Method::GET, &t.path("/datasources"), None, Some(&viewer)).await;
    assert!(list.body["items"].as_array().unwrap().is_empty());
    t.finish().await;
}

/// Someone allowed to edit a dashboard may rename it although they could not write its queries:
/// unchanged queries are not checked again.
#[tokio::test]
async fn unchanged_queries_need_no_query_rights_when_saving() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let ds = t.create_sqlite("Umsätze", &file).await;
    let dashboard = t.dashboard(&ds, None).await;
    let viewer = t.session_for_role("eddi", Some("viewer")).await;
    let (eddi,): (String,) =
        sqlx::query_as("SELECT id FROM users WHERE email = 'eddi@example.de'").fetch_one(&t.state.db).await.unwrap();
    let grant = json!({ "subjectType": "user", "subjectId": eddi, "resourceType": "dashboard", "resourceId": dashboard, "level": "edit" });
    assert_eq!(t.post("/grants", grant).await.status, StatusCode::CREATED);
    let path = t.path(&format!("/dashboards/{dashboard}"));
    let mut model = dashboard_model(&ds);
    model["title"] = json!("Umsatz 2026");
    let r = t.send(Method::PUT, &path, Some(json!({ "model": model.clone(), "version": 1 })), Some(&viewer)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    // A changed query needs the right on its source, and says which source.
    model["panels"][0]["targets"][0]["query"] = json!({ "sql": "SELECT 1" });
    let r = t.send(Method::PUT, &path, Some(json!({ "model": model.clone(), "version": 2 })), Some(&viewer)).await;
    assert_eq!(r.code(), "forbidden", "{}", r.text);
    assert!(r.body["error"]["message"].as_str().unwrap().contains(&ds));
    // A source that does not exist is a model error.
    model["panels"][0]["targets"][0]["datasourceId"] = json!(uuid::Uuid::now_v7().to_string());
    let r = t.send(Method::PUT, &path, Some(json!({ "model": model, "version": 2 })), Some(&t.owner)).await;
    assert_eq!((r.code(), r.body["error"]["field"].as_str()), ("validation", Some("model")), "{}", r.text);
    t.finish().await;
}

/// Request values cannot replace what the dashboard fixes: constants, and custom variables
/// outside their options; only checked variables may become identifiers.
#[tokio::test]
async fn dashboard_variables_keep_to_the_dashboard() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let ds = t.create_sqlite("Umsätze", &file).await;
    let model = json!({
        "schemaVersion": 1, "title": "V", "timeRange": { "from": "now-6h", "to": "now" },
        "variables": [
            { "name": "fest", "type": "constant", "current": { "value": "Schweiz" } },
            { "name": "wahl", "type": "custom", "options": [ { "value": "land" }, "betrag" ] },
            { "name": "frei", "type": "textbox" },
            { "name": "abfrage", "type": "query", "datasourceId": ds, "query": { "sql": "SELECT land FROM verkauf" } }
        ],
        "panels": [{
            "id": "p", "type": "table", "title": "T", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
            "targets": [
                { "refId": "K", "datasourceId": ds, "query": { "sql": "SELECT id FROM verkauf WHERE land = $fest" } },
                { "refId": "W", "datasourceId": ds, "query": { "sql": "SELECT ${wahl:identifier} FROM verkauf WHERE id = 1" } },
                { "refId": "F", "datasourceId": ds, "query": { "sql": "SELECT ${frei:identifier} FROM verkauf" } },
                { "refId": "Q", "datasourceId": ds, "query": { "sql": "SELECT ${abfrage:identifier} FROM verkauf" } }
            ],
            "transformations": [], "options": {}, "fieldConfig": {}
        }]
    });
    let r = t.post("/dashboards", json!({ "model": model })).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let dashboard = r.body["id"].as_str().unwrap().to_string();
    let viewer = t.session_for_role("viewer", Some("viewer")).await;
    let run = |vars: Value| {
        let body = json!({ "timeRange": range(), "variables": vars });
        let t = &t;
        let viewer = viewer.clone();
        let dashboard = dashboard.clone();
        async move { t.panel(&viewer, &dashboard, "p", body).await }
    };

    let r = run(json!({ "wahl": "land", "frei": "land", "abfrage": "land" })).await;
    let res = &r.body["results"];
    assert_eq!(
        res["K"]["result"]["frame"]["fields"][0]["values"],
        json!(["2"]),
        "the constant's own value: {}",
        r.text
    );
    assert_eq!(res["W"]["result"]["frame"]["fields"][0]["values"], json!(["Österreich"]));
    // Free and query variables never become identifiers.
    assert_eq!(res["F"]["error"]["code"], "query_rejected");
    assert_eq!(res["Q"]["error"]["code"], "query_rejected");

    for vars in [
        json!({ "fest": "Österreich" }),
        json!({ "wahl": "id" }),
        json!({ "wahl": ["land", "sqlite_version()"] }),
        json!({ "wahl": { "value": "land" } }),
    ] {
        let r = run(vars.clone()).await;
        assert_eq!(
            (r.code(), r.body["error"]["field"].as_str()),
            ("validation", Some("variables")),
            "{vars}: {}",
            r.text
        );
    }
    t.finish().await;
}

/// A constant, a custom and a textbox variable in one statement each bind their own value, on
/// the panel route as through `/query`.
#[tokio::test]
async fn constant_and_custom_variables_share_a_statement() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let ds = t.create_sqlite("Umsätze", &file).await;
    let sql = "SELECT id FROM verkauf WHERE land IN ($k, $wahl) OR land = $frei ORDER BY id";
    let model = json!({
        "schemaVersion": 1, "title": "V", "timeRange": { "from": "now-6h", "to": "now" },
        "variables": [
            { "name": "k", "type": "constant", "current": { "value": "Schweiz" } },
            { "name": "wahl", "type": "custom", "options": ["Österreich", "Deutschland"] },
            { "name": "frei", "type": "textbox" }
        ],
        "panels": [{
            "id": "p", "type": "table", "title": "T", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
            "targets": [{ "refId": "A", "datasourceId": ds, "query": { "sql": sql } }],
            "transformations": [], "options": {}, "fieldConfig": {}
        }]
    });
    let r = t.post("/dashboards", json!({ "model": model })).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let dashboard = r.body["id"].as_str().unwrap().to_string();
    let viewer = t.session_for_role("viewer", Some("viewer")).await;
    let body = json!({ "timeRange": range(), "variables": { "wahl": "Österreich", "frei": "-" } });
    let r = t.panel(&viewer, &dashboard, "p", body).await;
    assert_eq!(r.body["results"]["A"]["result"]["frame"]["fields"][0]["values"], json!(["1", "2"]), "{}", r.text);
    let body = json!({ "timeRange": range(), "variables": { "wahl": ["Österreich", "Deutschland"], "frei": "-" } });
    let r = t.panel(&viewer, &dashboard, "p", body).await;
    let frame = r.body["results"]["A"]["result"]["frame"].clone();
    assert_eq!(frame["fields"][0]["values"], json!(["1", "2", "9007199254740993"]), "{}", r.text);
    assert_eq!(
        frame["meta"]["executedQuery"],
        "SELECT id FROM verkauf WHERE land IN (?, ?, ?) OR land = ? ORDER BY id"
    );
    let free = json!({
        "queries": [{ "refId": "A", "datasourceId": ds, "query": { "sql": sql } }],
        "timeRange": range(),
        "variables": { "k": "Schweiz", "wahl": ["Österreich", "Deutschland"], "frei": "-" }
    });
    let r = t.send(Method::POST, &t.path("/query"), Some(free), Some(&t.owner)).await;
    assert_eq!(r.body["results"]["A"]["result"]["frame"], frame, "the same answer through /query: {}", r.text);
    t.finish().await;
}

/// The same rules hold for a Prometheus panel: a custom variable keeps to its options.
#[tokio::test]
async fn prometheus_panels_keep_variables_to_the_dashboard() {
    let t = T::new().await;
    let addr = fake_prometheus().await;
    let r = t
        .post(
            "/datasources",
            json!({ "name": "Prom", "kind": "prometheus", "settings": { "url": format!("http://{addr}") } }),
        )
        .await;
    let ds = r.body["id"].as_str().unwrap().to_string();
    let model = json!({
        "schemaVersion": 1, "title": "P", "timeRange": { "from": "now-6h", "to": "now" },
        "variables": [ { "name": "job", "type": "custom", "options": ["api", "db"] } ],
        "panels": [{
            "id": "p", "type": "timeseries", "title": "T", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
            "targets": [ { "refId": "A", "datasourceId": ds, "query": { "expr": "up{job=\"$job\"}" } } ],
            "transformations": [], "options": {}, "fieldConfig": {}
        }]
    });
    let dashboard = t.post("/dashboards", json!({ "model": model })).await.body["id"].as_str().unwrap().to_string();
    let viewer = t.session_for_role("viewer", Some("viewer")).await;
    let ok = t.panel(&viewer, &dashboard, "p", json!({ "timeRange": range(), "variables": { "job": "api" } })).await;
    assert!(ok.body["results"]["A"]["result"].is_object(), "{}", ok.text);
    let bad = json!({ "timeRange": range(), "variables": { "job": "api\"} or vector(1) or up{job=\"x" } });
    let r = t.panel(&viewer, &dashboard, "p", bad).await;
    assert_eq!((r.code(), r.body["error"]["field"].as_str()), ("validation", Some("variables")), "{}", r.text);
    t.finish().await;
}

/// Any change to a variable definition makes every stored query count as changed, so an editor
/// without data source rights cannot widen what the queries read.
#[tokio::test]
async fn variable_changes_recheck_every_stored_query() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let ds = t.create_sqlite("Umsätze", &file).await;
    let mut model = dashboard_model(&ds);
    model["variables"].as_array_mut().unwrap().push(json!({ "name": "wahl", "type": "custom", "options": ["land"] }));
    let r = t.post("/dashboards", json!({ "model": model.clone() })).await;
    let dashboard = r.body["id"].as_str().unwrap().to_string();
    let viewer = t.session_for_role("edda", Some("viewer")).await;
    let (edda,): (String,) =
        sqlx::query_as("SELECT id FROM users WHERE email = 'edda@example.de'").fetch_one(&t.state.db).await.unwrap();
    let grant = json!({ "subjectType": "user", "subjectId": edda, "resourceType": "dashboard", "resourceId": dashboard, "level": "edit" });
    assert_eq!(t.post("/grants", grant).await.status, StatusCode::CREATED);
    let path = t.path(&format!("/dashboards/{dashboard}"));
    let fest = 2;
    let wahl = 3;
    let mut changes = Vec::new();
    let mut m = model.clone();
    m["variables"][fest]["current"] = json!({ "value": "Schweiz" });
    changes.push(("a constant's value", m));
    let mut m = model.clone();
    m["variables"][wahl]["options"] = json!(["land", "betrag"]);
    changes.push(("a custom option", m));
    let mut m = model.clone();
    m["variables"][fest]["type"] = json!("textbox");
    changes.push(("a constant turned textbox", m));
    for (what, m) in changes {
        let r = t.send(Method::PUT, &path, Some(json!({ "model": m, "version": 1 })), Some(&viewer)).await;
        assert_eq!(r.code(), "forbidden", "{what}: {}", r.text);
    }
    // Labels and the selection of query and textbox variables do not affect the queries.
    let mut m = model.clone();
    m["variables"][0]["label"] = json!("Land");
    m["variables"][0]["current"] = json!({ "value": "Schweiz" });
    let r = t.send(Method::PUT, &path, Some(json!({ "model": m, "version": 1 })), Some(&viewer)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    // Without variable changes the same editor may still rename it.
    let mut m = model;
    m["title"] = json!("Neu");
    let r = t.send(Method::PUT, &path, Some(json!({ "model": m, "version": 2 })), Some(&viewer)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    t.finish().await;
}

/// List and detail answers say what the caller may do, from role and grants, and the routes
/// agree with what they say.
#[tokio::test]
async fn answers_carry_the_callers_access() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let other = t.sqlite_file("anderes.db", SALES).await;
    let ds = t.create_sqlite("Umsätze", &file).await;
    let access = |read: bool, query: bool, write: bool, permissions: bool, change_target: bool| json!({ "read": read, "query": query, "write": write, "permissions": permissions, "changeTarget": change_target });
    let seen = |cookie: String| {
        let t = &t;
        let ds = ds.clone();
        async move {
            let list = t.send(Method::GET, &t.path("/datasources"), None, Some(&cookie)).await;
            let one = t.send(Method::GET, &t.path(&format!("/datasources/{ds}")), None, Some(&cookie)).await;
            let listed = list.body["items"].as_array().unwrap().iter().find(|i| i["id"] == ds.as_str()).cloned();
            assert_eq!(listed.as_ref().map(|i| &i["access"]), Some(&one.body["access"]), "{} {}", list.text, one.text);
            one.body["access"].clone()
        }
    };
    assert_eq!(seen(t.owner.clone()).await, access(true, true, true, true, true));
    let editor = t.session_for_role("edda", Some("editor")).await;
    assert_eq!(seen(editor.clone()).await, access(true, true, false, false, false));

    // A custom role with the org-wide write but without permissions may repoint sources, so
    // `changeTarget` is true where `permissions` is false.
    let role = t
        .post("/roles", json!({ "name": "Quellenpflege", "permissions": ["datasources:read", "datasources:write"] }))
        .await;
    assert_eq!(role.status, StatusCode::CREATED, "{}", role.text);
    let custom = t.session_for_role("quirin", role.body["id"].as_str()).await;
    assert_eq!(seen(custom.clone()).await, access(true, false, true, false, true));
    let moved = json!({ "settings": { "path": other.to_string_lossy() } });
    let r = t.send(Method::PATCH, &t.path(&format!("/datasources/{ds}")), Some(moved), Some(&custom)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let back = json!({ "settings": { "path": file.to_string_lossy() } });
    let r = t.send(Method::PATCH, &t.path(&format!("/datasources/{ds}")), Some(back), Some(&custom)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);

    // A custom role with read and permissions but without write manages grants, but cannot change
    // the source, so neither its target.
    let role = t
        .post("/roles", json!({ "name": "Freigaben", "permissions": ["datasources:read", "datasources:permissions"] }))
        .await;
    assert_eq!(role.status, StatusCode::CREATED, "{}", role.text);
    let granter = t.session_for_role("greta", role.body["id"].as_str()).await;
    assert_eq!(seen(granter.clone()).await, access(true, false, false, true, false));
    let moved = json!({ "settings": { "path": other.to_string_lossy() } });
    let r = t.send(Method::PATCH, &t.path(&format!("/datasources/{ds}")), Some(moved), Some(&granter)).await;
    assert_eq!(r.code(), "forbidden", "{}", r.text);

    let viewer = t.session_for_role("vera", Some("viewer")).await;
    let (vera,): (String,) =
        sqlx::query_as("SELECT id FROM users WHERE email = 'vera@example.de'").fetch_one(&t.state.db).await.unwrap();
    let list = t.send(Method::GET, &t.path("/datasources"), None, Some(&viewer)).await;
    assert_eq!(list.body["items"], json!([]), "{}", list.text);
    let grant = |level: &str| json!({ "subjectType": "user", "subjectId": vera, "resourceType": "datasource", "resourceId": ds, "level": level });
    for (level, expected) in [
        ("query", access(true, true, false, false, false)),
        ("edit", access(true, true, true, false, false)),
        ("admin", access(true, true, true, true, true)),
    ] {
        // A second grant for the same member replaces the first.
        let r = t.post("/grants", grant(level)).await;
        assert!(r.status.is_success(), "{}", r.text);
        assert_eq!(seen(viewer.clone()).await, expected, "{level}");
    }
    // With the admin grant the member may repoint the source (an edit grant alone may not, see
    // an_edit_grant_cannot_repoint_a_data_source).
    let r = t
        .send(
            Method::PATCH,
            &t.path(&format!("/datasources/{ds}")),
            Some(json!({ "settings": { "path": other.to_string_lossy() } })),
            Some(&viewer),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["access"], access(true, true, true, true, true));

    // The trash says the same.
    t.send(Method::DELETE, &t.path(&format!("/datasources/{ds}")), None, Some(&viewer)).await;
    let trash = t.send(Method::GET, &t.path("/datasources?trash=true"), None, Some(&viewer)).await;
    assert_eq!(trash.body["items"][0]["access"], access(true, true, true, true, true), "{}", trash.text);
    t.finish().await;
}

/// `access` against what each route allows, for every combination of data source permissions on
/// a custom role (held directly or as a team role) and a grant (none, or query, edit or admin to
/// the member, their team or their role): 192 principals. Read is `GET`, query is a free query
/// (`/health` and `/schema` check the same permission), write is a rename, permissions is
/// reading the grants, changeTarget is a path change; on the trash, `write` and being listed must
/// match whether restore works. Every flag must be both true and false for some principals, so a
/// broken setup cannot pass by allowing nothing.
#[tokio::test]
async fn access_matches_what_the_routes_allow() {
    let t = T::new().await;
    let file = t.sqlite_file("a.db", SALES).await;
    let other = t.sqlite_file("b.db", SALES).await;
    let ds = t.create_sqlite("A", &file).await;
    let gone = t.create_sqlite("B", &file).await;
    let r = t.send(Method::DELETE, &t.path(&format!("/datasources/{gone}")), None, Some(&t.owner)).await;
    assert!(r.status.is_success(), "{}", r.text);
    let db = t.state.db.clone();
    let perms = ["datasources:read", "datasources:query", "datasources:write", "datasources:permissions"];
    let grants: [(&str, &str); 6] =
        [("none", ""), ("user", "query"), ("user", "edit"), ("user", "admin"), ("team", "edit"), ("role", "admin")];
    let mut bad = Vec::new();
    let mut n = 0;
    let mut allowed = [0_usize; 5];
    let mut restored = 0_usize;
    for mask in 0..16u32 {
        let set: Vec<&str> = perms.iter().enumerate().filter(|(i, _)| mask & (1 << i) != 0).map(|(_, p)| *p).collect();
        let role_id = uuid::Uuid::now_v7().to_string();
        sqlx::query(
            "INSERT INTO roles (id, org_id, name, name_key, description, created_at) VALUES ($1, $2, $3, $4, $5, 0)",
        )
        .bind(&role_id)
        .bind(&t.org)
        .bind(format!("r{mask}"))
        .bind(format!("r{mask}"))
        .bind("x")
        .execute(&db)
        .await
        .unwrap();
        for p in &set {
            sqlx::query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)")
                .bind(&role_id)
                .bind(*p)
                .execute(&db)
                .await
                .unwrap();
        }
        for via_team in [false, true] {
            for (subject, level) in grants {
                n += 1;
                let name = format!("u{n}");
                let org_role = if via_team { "viewer".to_string() } else { role_id.clone() };
                let cookie = t.session_for_role(&name, Some(&org_role)).await;
                let (uid,): (String,) =
                    sqlx::query_as("SELECT id FROM users WHERE name = $1").bind(&name).fetch_one(&db).await.unwrap();
                let team = uuid::Uuid::now_v7().to_string();
                sqlx::query("INSERT INTO teams (id, org_id, name, name_key, created_at) VALUES ($1, $2, $3, $4, 0)")
                    .bind(&team)
                    .bind(&t.org)
                    .bind(format!("t{n}"))
                    .bind(format!("t{n}"))
                    .execute(&db)
                    .await
                    .unwrap();
                sqlx::query("INSERT INTO team_members (team_id, user_id, role, created_at) VALUES ($1, $2, $3, 0)")
                    .bind(&team)
                    .bind(&uid)
                    .bind("member")
                    .execute(&db)
                    .await
                    .unwrap();
                if via_team {
                    sqlx::query("INSERT INTO team_roles (team_id, role) VALUES ($1, $2)")
                        .bind(&team)
                        .bind(&role_id)
                        .execute(&db)
                        .await
                        .unwrap();
                }
                let subject_id = match subject {
                    "user" => uid.clone(),
                    "team" => team.clone(),
                    _ => role_id.clone(),
                };
                let mut grant_ids = Vec::new();
                if subject != "none" {
                    for res in [&ds, &gone] {
                        let gid = uuid::Uuid::now_v7().to_string();
                        sqlx::query("INSERT INTO resource_grants (id, org_id, subject_type, subject_id, resource_type, resource_id, level, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 0)")
                            .bind(&gid).bind(&t.org).bind(subject).bind(&subject_id).bind("datasource").bind(res).bind(level)
                            .execute(&db).await.unwrap();
                        grant_ids.push(gid);
                    }
                }
                let label = format!("perms={set:?} team={via_team} grant={subject}:{level}");
                let flags = |a: &Value| -> [bool; 5] {
                    ["read", "query", "write", "permissions", "changeTarget"].map(|k| a[k].as_bool().unwrap_or(false))
                };
                // Live source.
                let list = t.send(Method::GET, &t.path("/datasources"), None, Some(&cookie)).await;
                let listed = list.body["items"].as_array().unwrap().iter().find(|i| i["id"] == ds.as_str()).cloned();
                let one = t.send(Method::GET, &t.path(&format!("/datasources/{ds}")), None, Some(&cookie)).await;
                if let Some(row) = &listed
                    && one.status == StatusCode::OK
                    && row["access"] != one.body["access"]
                {
                    bad.push(format!("{label}: list {} != detail {}", row["access"], one.body["access"]));
                }
                let claimed = listed
                    .as_ref()
                    .map(|r| flags(&r["access"]))
                    .or_else(|| (one.status == StatusCode::OK).then(|| flags(&one.body["access"])))
                    .unwrap_or_default();
                let q = t.send(Method::POST, &t.path("/query"), Some(json!({ "queries": [{ "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT 1 AS x" } }], "timeRange": { "from": 0, "to": 1 } })), Some(&cookie)).await;
                let free_ok = q.body["results"]["A"].get("result").is_some();
                let write = t
                    .send(
                        Method::PATCH,
                        &t.path(&format!("/datasources/{ds}")),
                        Some(json!({ "name": "A" })),
                        Some(&cookie),
                    )
                    .await;
                let gr = t
                    .send(
                        Method::GET,
                        &t.path(&format!("/grants?resourceType=datasource&resourceId={ds}")),
                        None,
                        Some(&cookie),
                    )
                    .await;
                let moved = t
                    .send(
                        Method::PATCH,
                        &t.path(&format!("/datasources/{ds}")),
                        Some(json!({ "settings": { "path": other.to_string_lossy() } })),
                        Some(&cookie),
                    )
                    .await;
                if moved.status == StatusCode::OK {
                    let back = t
                        .send(
                            Method::PATCH,
                            &t.path(&format!("/datasources/{ds}")),
                            Some(json!({ "settings": { "path": file.to_string_lossy() } })),
                            Some(&t.owner),
                        )
                        .await;
                    assert_eq!(back.status, StatusCode::OK, "{}", back.text);
                }
                let actual = [
                    one.status == StatusCode::OK,
                    free_ok,
                    write.status == StatusCode::OK,
                    gr.status == StatusCode::OK,
                    moved.status == StatusCode::OK,
                ];
                for (count, yes) in allowed.iter_mut().zip(actual) {
                    *count += usize::from(yes);
                }
                if claimed != actual {
                    bad.push(format!(
                        "{label}: live access {claimed:?} vs routes {actual:?} (listed={})",
                        listed.is_some()
                    ));
                }
                let sees = actual[0] || actual[1];
                if listed.is_some() != sees {
                    bad.push(format!("{label}: listed={} but routes see={sees}", listed.is_some()));
                }
                // Trash.
                let trash = t.send(Method::GET, &t.path("/datasources?trash=true"), None, Some(&cookie)).await;
                let row =
                    trash.body["items"].as_array().and_then(|a| a.iter().find(|i| i["id"] == gone.as_str()).cloned());
                let claimed = row.as_ref().map(|r| flags(&r["access"])).unwrap_or_default();
                let restore = t
                    .send(
                        Method::POST,
                        &t.path(&format!("/datasources/{gone}/restore")),
                        Some(json!({})),
                        Some(&cookie),
                    )
                    .await;
                if restore.status == StatusCode::OK {
                    let again =
                        t.send(Method::DELETE, &t.path(&format!("/datasources/{gone}")), None, Some(&t.owner)).await;
                    assert!(again.status.is_success(), "{}", again.text);
                }
                let restore_ok = restore.status == StatusCode::OK;
                restored += usize::from(restore_ok);
                if claimed[2] != restore_ok || row.is_some() != restore_ok {
                    bad.push(format!(
                        "{label}: trash listed={} access={claimed:?} but restore {}",
                        row.is_some(),
                        restore.status
                    ));
                }
                for gid in grant_ids {
                    sqlx::query("DELETE FROM resource_grants WHERE id = $1").bind(gid).execute(&db).await.unwrap();
                }
            }
        }
    }
    assert_eq!(n, 192);
    for (flag, count) in ["read", "query", "write", "permissions", "changeTarget"].iter().zip(allowed) {
        assert!(count > 0 && count < n, "{flag} is allowed for {count} of {n} principals");
    }
    assert!(restored > 0 && restored < n, "restore works for {restored} of {n} principals");
    assert!(bad.is_empty(), "{} of {n} principals disagree:\n{}", bad.len(), bad.join("\n"));
    t.finish().await;
}

/// An edit grant on a data source renames it and changes its limits, but where it connects is
/// for administrators.
#[tokio::test]
async fn an_edit_grant_cannot_repoint_a_data_source() {
    let t = T::new().await;
    let file = t.sqlite_file("umsatz.db", SALES).await;
    let other = t.sqlite_file("anderes.db", SALES).await;
    let ds = t.create_sqlite("Umsätze", &file).await;
    let pg = t
        .post(
            "/datasources",
            json!({ "name": "PG", "kind": "postgres",
            "settings": { "host": "db.intern", "database": "d", "user": "u" }, "secrets": { "password": "geheim" } }),
        )
        .await
        .body["id"]
        .as_str()
        .unwrap()
        .to_string();
    let viewer = t.session_for_role("erik", Some("viewer")).await;
    let (erik,): (String,) =
        sqlx::query_as("SELECT id FROM users WHERE email = 'erik@example.de'").fetch_one(&t.state.db).await.unwrap();
    for id in [&ds, &pg] {
        let grant = json!({ "subjectType": "user", "subjectId": erik, "resourceType": "datasource", "resourceId": id, "level": "edit" });
        assert_eq!(t.post("/grants", grant).await.status, StatusCode::CREATED);
    }
    let patch = |id: &str, body: Value| {
        let path = t.path(&format!("/datasources/{id}"));
        let viewer = viewer.clone();
        let t = &t;
        async move { t.send(Method::PATCH, &path, Some(body), Some(&viewer)).await }
    };
    let r = patch(&ds, json!({ "settings": { "path": other.to_string_lossy() } })).await;
    assert_eq!(r.code(), "forbidden", "{}", r.text);
    let r = patch(&pg, json!({ "settings": { "host": "anderswo.example", "database": "d", "user": "u" }, "secrets": { "password": "geheim" } })).await;
    assert_eq!(r.code(), "forbidden", "{}", r.text);
    // Name, limits and re-entering a secret for the same target are fine.
    assert_eq!(patch(&ds, json!({ "name": "Umsatz alt" })).await.status, StatusCode::OK);
    let limits = json!({ "settings": { "path": file.to_string_lossy(), "maxRows": 10 } });
    assert_eq!(patch(&ds, limits).await.status, StatusCode::OK);
    assert_eq!(patch(&pg, json!({ "secrets": { "password": "neu" } })).await.status, StatusCode::OK);

    // The trash shows what the member may restore.
    t.send(Method::DELETE, &t.path(&format!("/datasources/{ds}")), None, Some(&viewer)).await;
    let trash = t.send(Method::GET, &t.path("/datasources?trash=true"), None, Some(&viewer)).await;
    let ids: Vec<&str> = trash.body["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [ds.as_str()], "{}", trash.text);
    let restored = t.post(&format!("/datasources/{ds}/restore"), json!({})).await;
    assert_eq!(restored.status, StatusCode::OK);
    t.finish().await;
}

#[tokio::test]
async fn file_sources_read_only_from_the_file_directories() {
    let t = T::new().await;
    let files = t.dir.path().join("dateien");
    std::fs::create_dir_all(&files).unwrap();
    std::fs::write(files.join("umsatz.csv"), "land;betrag\nÖsterreich;12,5\n").unwrap();
    // The SQLite directory does not open CSV files.
    std::fs::write(t.allowed_dir().join("umsatz.csv"), "a\n1\n").unwrap();
    let create =
        |path: PathBuf| json!({ "name": "Datei", "kind": "file", "settings": { "path": path.to_string_lossy() } });
    for path in [files.join("umsatz.csv"), t.allowed_dir().join("umsatz.csv")] {
        let r = t.post("/datasources", create(path)).await;
        assert_eq!((r.status, r.code()), (StatusCode::UNPROCESSABLE_ENTITY, "datasource_target_blocked"), "{}", r.text);
        assert_eq!(r.body["error"]["field"], "path");
        assert_eq!(r.body["error"]["reason"], "target.file_path_refused");
    }
    t.set("datasources.file_dirs", json!([files.to_string_lossy()]));
    let r = t.post("/datasources", create(files.join("umsatz.csv"))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let id = r.body["id"].as_str().unwrap().to_string();
    let q = t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": {} }])).await;
    let frame = &q.body["results"]["A"]["result"]["frame"];
    assert_eq!(frame["fields"][1]["type"], "number", "{}", q.text);
    assert_eq!(frame["fields"][1]["values"], json!([12.5]));
    let bad = t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": { "sql": "SELECT 1" } }])).await;
    assert_eq!(bad.body["results"]["A"]["error"]["reason"], "query.invalid_form", "{}", bad.text);
    // Removing the directory later cuts the source off.
    t.set("datasources.file_dirs", json!([]));
    let r = t.query(&t.owner, json!([{ "refId": "A", "datasourceId": id, "query": {} }])).await;
    assert_eq!(r.body["results"]["A"]["error"]["reason"], "target.file_path_refused", "{}", r.text);
}

/// A fake search cluster and JSON API in one server; it records every request it gets.
#[expect(clippy::disallowed_methods, reason = "a fake upstream server, not an API route")]
async fn fake_search_and_json(seen: Arc<std::sync::Mutex<Vec<String>>>) -> SocketAddr {
    use axum::http::{HeaderMap, Uri};
    let app = Router::new()
        .route(
            "/api/items",
            axum::routing::get(|headers: HeaderMap| async move {
                let key = headers.get("x-api-key").map(|v| v.to_str().unwrap().to_string());
                axum::Json(json!({ "data": [{ "id": 1, "key": key }, { "id": 2 }] }))
            }),
        )
        .route("/api/wrong", axum::routing::get(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "Fehler mit geheim-123") }))
        .fallback(move |method: Method, uri: Uri, body: String| {
            let seen = seen.clone();
            async move {
                seen.lock().unwrap().push(format!("{method} {}", uri.path()));
                let answer = match uri.path() {
                    "/" => json!({ "version": { "number": "9.1.0" } }),
                    p if p.ends_with("/_search") && body.contains("\"aggs\"") => {
                        json!({ "hits": { "hits": [] }, "aggregations": { "land": { "buckets": [{ "key": "AT", "doc_count": 3 }] } } })
                    }
                    p if p.ends_with("/_search") => json!({ "hits": { "hits": [{ "_id": "1", "_source": { "land": "AT" } }] } }),
                    p if p.starts_with("/_cat/indices") => json!([{ "index": "logs-1" }]),
                    p if p.ends_with("/_mapping") => {
                        json!({ "logs-1": { "mappings": { "properties": { "land": { "type": "keyword" } } } } })
                    }
                    _ => json!({ "error": "unexpected" }),
                };
                axum::Json(answer)
            }
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

#[tokio::test]
async fn search_sources_through_the_routes() {
    let t = T::new().await;
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let addr = fake_search_and_json(seen.clone()).await;
    let meta = json!({ "name": "M", "kind": "elasticsearch", "settings": { "url": "http://169.254.169.254:9200" } });
    let r = t.post("/datasources", meta).await;
    assert_eq!((r.code(), r.body["error"]["field"].as_str()), ("datasource_target_blocked", Some("url")), "{}", r.text);
    let bad_index = json!({ "name": "B", "kind": "elasticsearch",
                            "settings": { "url": format!("http://{addr}"), "index": "x/_delete_by_query" } });
    let r = t.post("/datasources", bad_index).await;
    assert_eq!((r.code(), r.body["error"]["field"].as_str()), ("validation", Some("index")), "{}", r.text);

    let r = t
        .post(
            "/datasources",
            json!({ "name": "Suche", "kind": "elasticsearch", "settings": { "url": format!("http://{addr}"), "index": "logs-*" },
                    "secrets": { "apiKey": "geheim-123" } }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert!(!r.text.contains("geheim-123"));
    let id = r.body["id"].as_str().unwrap().to_string();
    let h = t.post(&format!("/datasources/{id}/health"), json!({})).await;
    assert_eq!(
        (h.body["reason"].as_str(), h.body["params"]["engine"].as_str()),
        (Some("health.connected"), Some("Elasticsearch")),
        "{}",
        h.text
    );
    let q = t
        .query(
            &t.owner,
            json!([
                { "refId": "H", "datasourceId": id, "query": { "lucene": "land:AT" } },
                { "refId": "A", "datasourceId": id, "query": { "dsl": { "aggs": { "land": { "terms": { "field": "land" } } } } } },
                { "refId": "S", "datasourceId": id, "query": { "dsl": { "script_fields": { "x": { "script": "ctx.op = 'delete'" } } } } },
                { "refId": "I", "datasourceId": id, "query": { "lucene": "*", "index": "logs/_update_by_query" } }
            ]),
        )
        .await;
    let res = &q.body["results"];
    assert_eq!(res["H"]["result"]["shape"], "documents", "{}", q.text);
    assert_eq!(res["H"]["result"]["documents"]["documents"][0]["_source"]["land"], "AT");
    assert_eq!(res["A"]["result"]["shape"], "frame", "{}", q.text);
    assert_eq!(res["A"]["result"]["frame"]["fields"][0]["values"], json!(["AT"]));
    assert_eq!(
        (res["S"]["error"]["code"].as_str(), res["S"]["error"]["reason"].as_str()),
        (Some("query_rejected"), Some("elasticsearch.script_writes"))
    );
    assert_eq!(res["I"]["error"]["reason"], "elasticsearch.index_invalid", "{}", q.text);
    let schema = t.get(&format!("/datasources/{id}/schema")).await;
    assert_eq!(schema.body["kind"], "indices", "{}", schema.text);
    assert_eq!(schema.body["indices"][0]["columns"][0]["name"], "land");
    let requests = seen.lock().unwrap().clone();
    assert!(
        requests.iter().all(|r| ["GET /", "POST /logs-*/_search", "GET /_cat/indices/logs-*", "GET /logs-*/_mapping"]
            .contains(&r.as_str())),
        "only read endpoints: {requests:?}"
    );
}

#[tokio::test]
async fn http_json_sources_through_the_routes() {
    let t = T::new().await;
    let addr = fake_search_and_json(Arc::new(std::sync::Mutex::new(Vec::new()))).await;
    let r = t
        .post(
            "/datasources",
            json!({ "name": "API", "kind": "http_json",
                    "settings": { "url": format!("http://{addr}/api/"), "apiKeyHeader": "X-Api-Key", "documentsPath": "data" },
                    "secrets": { "apiKey": "geheim-123" } }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let id = r.body["id"].as_str().unwrap().to_string();
    let q = t
        .query(
            &t.owner,
            json!([
                { "refId": "A", "datasourceId": id, "query": { "path": "items" } },
                { "refId": "U", "datasourceId": id, "query": { "path": "../secret" } },
                { "refId": "W", "datasourceId": id, "query": { "path": "wrong" } }
            ]),
        )
        .await;
    let res = &q.body["results"];
    assert_eq!(res["A"]["result"]["documents"]["documents"][0]["key"], "geheim-123", "{}", q.text);
    assert_eq!(res["A"]["result"]["documents"]["documents"].as_array().unwrap().len(), 2);
    assert_eq!(
        (res["U"]["error"]["code"].as_str(), res["U"]["error"]["reason"].as_str()),
        (Some("query_rejected"), Some("http_json.path_invalid"))
    );
    assert_eq!(res["W"]["error"]["reason"], "http_json.status", "{}", q.text);
    // The upstream repeats the secret in its error; the answer never does.
    assert!(!res["W"].to_string().contains("geheim-123"), "{}", q.text);

    // A changed URL needs the API key again, so it is never sent to another host.
    let patch = json!({ "settings": { "url": "http://anders.example/api/", "apiKeyHeader": "X-Api-Key" } });
    let r = t.send(Method::PATCH, &t.path(&format!("/datasources/{id}")), Some(patch), Some(&t.owner)).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text);
    assert_eq!(r.body["error"]["reason"], "secrets.resend_on_target_change", "{}", r.text);
}
