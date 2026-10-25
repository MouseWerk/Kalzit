//! Data sources against real databases, through the router. Each test needs its
//! `KALZIT_TEST_<SOURCE>_URL`; the CI job `datasources` sets all of them from service containers
//! together with `KALZIT_TEST_REQUIRE_DATABASES=1`, which turns a missing URL into a failure.
//! Elsewhere a missing URL skips the test with a printed notice.
//!
//! - `KALZIT_TEST_POSTGRES_URL`: `postgres://user[:password]@host:port/database`
//! - `KALZIT_TEST_MYSQL_URL`, `KALZIT_TEST_MARIADB_URL`: `mysql://user[:password]@host:port/database`
//! - `KALZIT_TEST_MSSQL_URL`: `mssql://user:password@host:port/database` (self-signed certificate)
//! - `KALZIT_TEST_PROMETHEUS_URL`: `http://host:port`
//! - `KALZIT_TEST_ELASTICSEARCH_URL`, `KALZIT_TEST_OPENSEARCH_URL`: `http://[user:password@]host:port`
//! - `KALZIT_TEST_NEO4J_URL`, `KALZIT_TEST_MEMGRAPH_URL`: `bolt://[user:password@]host:port`
//!
//! SQLite and a fake Prometheus are tested in `src/datasources/api_tests.rs` on every run, and
//! TigerGraph against a fake server in `src/datasources/tigergraph/tests.rs`.

mod common;

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
use serde_json::{Value, json};
use tower::ServiceExt;

const SETUP_CODE: &str = "test-setup-code-0123456789";

struct T {
    app: Router,
    org: String,
    cookie: String,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
}

impl T {
    /// Stops the app and deletes its data directory (`common::Finish`).
    async fn finish(self) {
        let finish = self.finisher();
        drop(self);
        finish.finish().await;
    }

    /// What `finish` does, for a test that hands the app on by value.
    fn finisher(&self) -> common::Finish {
        common::Finish::new(self.state.clone(), self.dir.clone())
    }
}

fn env(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => Some(v),
        _ if std::env::var("KALZIT_TEST_REQUIRE_DATABASES").is_ok_and(|v| v == "1") => {
            panic!("{name} is not set, but KALZIT_TEST_REQUIRE_DATABASES=1 requires every database")
        }
        _ => {
            eprintln!("{name} not set, test not run");
            None
        }
    }
}

/// Host, port, user, password and database of a test URL.
fn parts(url: &str) -> (String, u16, String, Option<String>, String) {
    let u = reqwest::Url::parse(url).expect("a URL like scheme://user:password@host:port/database");
    let decode = |s: &str| {
        // Percent-decoding by hand keeps the dependency list short; test URLs are simple.
        let mut out = Vec::new();
        let b = s.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' && i + 2 < b.len() {
                out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap());
                i += 3;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8(out).unwrap()
    };
    (
        u.host_str().unwrap().trim_matches(['[', ']']).to_string(),
        u.port().expect("the URL names the port"),
        decode(u.username()),
        u.password().map(decode),
        u.path().trim_start_matches('/').to_string(),
    )
}

impl T {
    async fn new(db_url: Option<String>) -> T {
        let dir = common::private_tempdir();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().to_path_buf();
        config.database.url = db_url;
        let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
        let clock = Arc::new(ManualClock::new(1_800_000_000_000));
        let state = AppState::new(config, pool, clock, Some(SETUP_CODE.into())).await.unwrap();
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let mut t = T {
            app: router(state.clone()).layer(MockConnectInfo(peer)),
            org: String::new(),
            cookie: String::new(),
            state,
            dir: Arc::new(dir),
        };
        let body = json!({ "token": SETUP_CODE, "orgName": "Test", "name": "Jörg", "email": "joerg@example.de",
                           "password": "Grün und sicher 2026" });
        let req = Request::builder()
            .method(Method::POST)
            .uri("/api/setup")
            .header(header::HOST, "kalzit.test")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let res = t.app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let cookie =
            res.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap().split(';').next().unwrap().to_string();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let me: Value = serde_json::from_slice(&bytes).unwrap();
        t.org = me["orgs"][0]["id"].as_str().unwrap().to_string();
        t.cookie = cookie;
        t
    }

    async fn send(&self, method: Method, rest: &str, body: Option<Value>) -> (StatusCode, Value) {
        // A data source PATCH names the version it changes, as the edit page does; these tests
        // change the stored one unless they name a version themselves.
        let body = match body {
            Some(Value::Object(mut fields)) if method == Method::PATCH && !fields.contains_key("expectedUpdatedAt") => {
                let id = rest.split_once("/datasources/").map(|(_, id)| id).filter(|id| !id.contains(['/', '?']));
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
        let req = Request::builder()
            .method(method)
            .uri(format!("/api/orgs/{}{rest}", self.org))
            .header(header::HOST, "kalzit.test")
            .header(header::COOKIE, &self.cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn create(&self, kind: &str, settings: Value, secrets: Value) -> String {
        let (status, body) = self
            .send(
                Method::POST,
                "/datasources",
                Some(json!({ "name": kind, "kind": kind, "settings": settings, "secrets": secrets })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body["id"].as_str().unwrap().to_string()
    }

    async fn query(&self, id: &str, query: Value) -> Value {
        let body = json!({
            "queries": [{ "refId": "A", "datasourceId": id, "query": query }],
            "timeRange": { "from": 1_700_000_000_000_i64, "to": 1_800_000_000_000_i64 },
            "variables": { "land": "Österreich" }
        });
        let (status, body) = self.send(Method::POST, "/query", Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["results"]["A"].clone()
    }

    async fn health(&self, id: &str) -> Value {
        self.send(Method::POST, &format!("/datasources/{id}/health"), Some(json!({}))).await.1
    }
}

fn types(result: &Value) -> Vec<String> {
    result["result"]["frame"]["fields"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .map(|f| f["type"].as_str().unwrap().to_string())
        .collect()
}

fn secrets(password: Option<String>) -> Value {
    password.map_or(json!({}), |p| json!({ "password": p }))
}

#[tokio::test]
async fn postgres_reads_in_a_read_only_transaction() {
    let Some(url) = env("KALZIT_TEST_POSTGRES_URL") else { return };
    let (host, port, user, password, database) = parts(&url);
    let t = T::new(None).await;
    let id = t
        .create(
            "postgres",
            json!({ "host": host, "port": port, "database": database, "user": user }),
            secrets(password),
        )
        .await;
    assert_eq!(t.health(&id).await["ok"], true);

    let r = t
        .query(
            &id,
            json!({ "sql": "SELECT 9007199254740993::int8 AS gross, 1.5::numeric AS dezimal, $land::text AS land, \
                    now() AS jetzt, true AS ja, '{\"a\": 1}'::jsonb AS doc, NULL::int4 AS leer, \
                    gen_random_uuid() AS id WHERE now() > $__timeFrom" }),
        )
        .await;
    assert_eq!(types(&r), ["int64", "decimal", "string", "time", "bool", "json", "number", "string"], "{r}");
    let fields = &r["result"]["frame"]["fields"];
    assert_eq!(fields[0]["values"][0], "9007199254740993");
    assert_eq!(fields[1]["values"][0], "1.5");
    assert_eq!(fields[2]["values"][0], "Österreich");
    assert_eq!(fields[5]["values"][0], json!({ "a": 1 }));
    // Decimals keep every digit and their scale, MONEY is a decimal too, and a DATE is a day.
    let exact = t
        .query(
            &id,
            json!({ "sql": "SELECT n, m, d FROM (VALUES \
                    (12345678901234567.8901::numeric(30,4), 1234.56::money, DATE '2026-10-25'), \
                    ((0.1::numeric + 0.2::numeric)::numeric(30,4), (-0.05)::money, DATE '0001-01-01'), \
                    ((-12.5)::numeric(30,4), 0::money, NULL::date), \
                    ('NaN'::numeric(30,4), NULL::money, DATE '9999-12-31')) AS v(n, m, d)" }),
        )
        .await;
    assert_eq!(types(&exact), ["decimal", "decimal", "date"], "{exact}");
    let fields = &exact["result"]["frame"]["fields"];
    assert_eq!(fields[0]["values"], json!(["12345678901234567.8901", "0.3000", "-12.5000", null]), "{exact}");
    assert_eq!(fields[1]["values"], json!(["1234.56", "-0.05", "0.00", null]), "{exact}");
    assert_eq!(
        fields[2]["values"],
        json!([1_792_886_400_000_i64, -62_135_596_800_000_i64, null, 253_402_214_400_000_i64]),
        "{exact}"
    );
    let scs = t.query(&id, json!({ "sql": "SELECT current_setting('standard_conforming_strings') AS s" })).await;
    assert_eq!(scs["result"]["frame"]["fields"][0]["values"][0], "on", "{scs}");
    assert!(fields[6]["values"][0].is_null());

    // The statement check stops writes; a function that writes is stopped by the read-only
    // transaction.
    assert_eq!(t.query(&id, json!({ "sql": "CREATE TABLE x (a int)" })).await["error"]["code"], "query_rejected");
    let seq = t.query(&id, json!({ "sql": "SELECT nextval('kalzit_test_does_not_matter')" })).await;
    assert!(matches!(seq["error"]["code"].as_str(), Some("query_rejected" | "datasource_error")), "{seq}");
    let slow = t.query(&id, json!({ "sql": "SELECT pg_sleep(0.1)" })).await;
    assert!(slow["result"].is_object(), "{slow}");
    let schema = t.send(Method::GET, &format!("/datasources/{id}/schema"), None).await.1;
    assert_eq!(schema["kind"], "tables");
    t.finish().await;
}

/// A PostgreSQL source pointing at Kalzit's own database is refused after connecting, whatever
/// host name it uses.
#[tokio::test]
async fn postgres_refuses_kalzits_own_database() {
    let Some(url) = env("KALZIT_TEST_POSTGRES_URL") else { return };
    let (host, port, user, password, database) = parts(&url);
    // Kalzit's tables go into a throwaway schema of the same database, as in tests/api.rs.
    let schema = format!("kalzit_ds_{}", uuid::Uuid::now_v7().simple());
    sqlx::any::install_default_drivers();
    let admin = sqlx::AnyPool::connect(&url).await.unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}"))).execute(&admin).await.unwrap();
    let sep = if url.contains('?') { '&' } else { '?' };
    let t = T::new(Some(format!("{url}{sep}options=-csearch_path%3D{schema}"))).await;
    for alias in [host.as_str(), "127.0.0.1"] {
        let settings = json!({ "host": alias, "port": port, "database": database, "user": user });
        let (status, body) = t
            .send(Method::POST, "/datasources", Some(json!({ "name": format!("Selbst {alias}"), "kind": "postgres", "settings": settings, "secrets": secrets(password.clone()) })))
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let id = body["id"].as_str().unwrap();
        let r = t.query(id, json!({ "sql": "SELECT 1" })).await;
        assert_eq!(r["error"]["code"], "datasource_target_blocked", "{alias}: {r}");
    }
    t.finish().await;
    sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE"))).execute(&admin).await.unwrap();
}

/// A constant, a custom and a textbox variable in one statement: each binds its own numbered
/// parameter, on the panel route as through `/query`.
#[tokio::test]
async fn postgres_panels_bind_mixed_variables() {
    let Some(url) = env("KALZIT_TEST_POSTGRES_URL") else { return };
    let (host, port, user, password, database) = parts(&url);
    let t = T::new(None).await;
    let id = t
        .create(
            "postgres",
            json!({ "host": host, "port": port, "database": database, "user": user }),
            secrets(password),
        )
        .await;
    let sql = "SELECT v FROM (VALUES ('Schweiz'), ('Österreich'), ('Polen'), ('Italien'), ('Spanien')) AS t(v)                WHERE v IN ($k, $wahl, $frei) ORDER BY v";
    let model = json!({
        "schemaVersion": 1, "title": "V", "timeRange": { "from": "now-6h", "to": "now" },
        "variables": [
            { "name": "k", "type": "constant", "current": "Schweiz" },
            { "name": "wahl", "type": "custom", "options": ["Österreich", "Italien"] },
            { "name": "frei", "type": "textbox" }
        ],
        "panels": [{
            "id": "p", "type": "table", "title": "T", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
            "targets": [{ "refId": "A", "datasourceId": id, "query": { "sql": sql } }],
            "transformations": [], "options": {}, "fieldConfig": {}
        }]
    });
    let (status, dashboard) = t.send(Method::POST, "/dashboards", Some(json!({ "model": model }))).await;
    assert_eq!(status, StatusCode::CREATED, "{dashboard}");
    let dashboard = dashboard["id"].as_str().unwrap();
    let range = json!({ "from": 1_700_000_000_000_i64, "to": 1_800_000_000_000_i64 });
    let body = json!({ "timeRange": range, "variables": { "wahl": ["Österreich", "Italien"], "frei": "Polen" } });
    let (status, r) = t.send(Method::POST, &format!("/dashboards/{dashboard}/panels/p/query"), Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    let frame = &r["results"]["A"]["result"]["frame"];
    assert_eq!(frame["fields"][0]["values"], json!(["Italien", "Österreich", "Polen", "Schweiz"]), "{r}");
    assert!(frame["meta"]["executedQuery"].as_str().unwrap().contains("IN ($1, $2, $3, $4)"), "{r}");

    let free = json!({
        "queries": [{ "refId": "A", "datasourceId": id, "query": { "sql": sql } }],
        "timeRange": range,
        "variables": { "k": "Schweiz", "wahl": ["Österreich", "Italien"], "frei": "Polen" }
    });
    let (_, r) = t.send(Method::POST, "/query", Some(free)).await;
    assert_eq!(r["results"]["A"]["result"]["frame"], *frame, "the same answer through /query: {r}");
    t.finish().await;
}

#[tokio::test]
async fn postgres_errors_never_show_the_password() {
    let Some(url) = env("KALZIT_TEST_POSTGRES_URL") else { return };
    let (host, port, user, password, database) = parts(&url);
    let secret = password.expect("the CI database uses a password, so scrubbing is exercised");
    let t = T::new(None).await;
    let id = t
        .create(
            "postgres",
            json!({ "host": host, "port": port, "database": database, "user": user }),
            json!({ "password": secret }),
        )
        .await;
    // The login works; then the database repeats a literal holding the password, case kept.
    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");
    assert!(h["reason"].as_str().is_some_and(|r| r.starts_with("health.connected")), "{h}");
    assert_eq!(h["params"]["engine"], "PostgreSQL", "{h}");
    let literal = format!("x{secret}x");
    let r = t.query(&id, json!({ "sql": format!("SELECT CAST('{literal}' AS integer)") })).await;
    assert_eq!(r["error"]["code"], "datasource_error", "{r}");
    assert!(r["error"]["message"].as_str().unwrap().contains("integer"), "{r}");
    assert_eq!(r["error"]["reason"], "source.error", "{r}");
    assert!(r["error"]["params"]["detail"].as_str().unwrap().contains("integer"), "{r}");
    assert!(!r.to_string().contains(&secret), "{r}");
    // A wrong password in an authentication error does not come back either.
    let wrong = format!("{secret}-falsch");
    let bad =
        t.send(Method::PATCH, &format!("/datasources/{id}"), Some(json!({ "secrets": { "password": wrong } }))).await.1;
    assert!(!bad.to_string().contains(&wrong));
    let h = t.health(&id).await;
    assert_eq!(h["ok"], false, "{h}");
    assert_eq!(h["reason"], "source.error", "{h}");
    assert!(!h.to_string().contains(&wrong), "{h}");
    t.finish().await;
}

#[tokio::test]
async fn mysql_reads_read_only_and_never_sends_local_files() {
    let Some(url) = env("KALZIT_TEST_MYSQL_URL") else { return };
    mysql_like(&url).await;
}

#[tokio::test]
async fn mariadb_reads_read_only_and_never_sends_local_files() {
    let Some(url) = env("KALZIT_TEST_MARIADB_URL") else { return };
    mysql_like(&url).await;
}

async fn mysql_like(url: &str) {
    let url = url.to_string();
    let (host, port, user, password, database) = parts(&url);
    let t = T::new(None).await;
    let id = t
        .create(
            "mysql",
            json!({ "host": host, "port": port, "database": database, "user": user }),
            secrets(password.clone()),
        )
        .await;
    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");
    let r = t
        .query(
            &id,
            json!({ "sql": "SELECT CAST(9007199254740993 AS SIGNED) AS gross, CAST(1.5 AS DECIMAL(4,2)) AS d, \
                                    ? AS x FROM DUAL WHERE NOW() > $__timeFrom" }),
        )
        .await;
    assert_eq!(r["error"]["code"], "query_rejected", "hand-written placeholders: {r}");
    let r = t
        .query(
            &id,
            json!({ "sql": "SELECT CAST(9007199254740993 AS SIGNED) AS gross, CAST(1.5 AS DECIMAL(4,2)) AS d, \
                                    $land AS land, NOW() AS jetzt FROM DUAL WHERE NOW() > $__timeFrom" }),
        )
        .await;
    assert_eq!(types(&r), ["int64", "decimal", "string", "time"], "{r}");
    assert_eq!(r["result"]["frame"]["fields"][1]["values"][0], "1.50", "{r}");
    assert_eq!(r["result"]["frame"]["fields"][2]["values"][0], "Österreich");
    // Decimals keep every digit and their scale; a DATE is a day.
    let exact = t
        .query(
            &id,
            json!({ "sql": "SELECT CAST('12345678901234567.8901' AS DECIMAL(30,4)) AS n, \
                    CAST(-0.05 AS DECIMAL(5,3)) AS k, CAST('2026-10-25' AS DATE) AS d FROM DUAL" }),
        )
        .await;
    assert_eq!(types(&exact), ["decimal", "decimal", "date"], "{exact}");
    let fields = &exact["result"]["frame"]["fields"];
    assert_eq!(fields[0]["values"][0], "12345678901234567.8901", "{exact}");
    assert_eq!(fields[1]["values"][0], "-0.050", "{exact}");
    assert_eq!(fields[2]["values"][0], 1_792_886_400_000_i64, "{exact}");
    // Every session runs with exactly the sql_mode the statement checker assumes.
    let mode = t.query(&id, json!({ "sql": "SELECT CAST(@@SESSION.sql_mode AS CHAR) AS m" })).await;
    assert_eq!(mode["result"]["frame"]["fields"][0]["values"][0], "NO_ENGINE_SUBSTITUTION", "{mode}");
    let lock = t.query(&id, json!({ "sql": "SELECT GET_LOCK('kalzit', 0)" })).await;
    assert_eq!(lock["error"]["code"], "query_rejected", "{lock}");
    for sql in [
        "SELECT LOAD_FILE('/etc/passwd')",
        "SELECT 1 INTO OUTFILE '/tmp/x'",
        "SELECT 1 /*!50000 INTO OUTFILE '/tmp/y' */",
    ] {
        assert_eq!(t.query(&id, json!({ "sql": sql })).await["error"]["code"], "query_rejected", "{sql}");
    }

    // The same driver, asked directly: the server cannot get a local file from it.
    let pool = sqlx::MySqlPool::connect(&url).await.unwrap();
    sqlx::raw_sql("CREATE TEMPORARY TABLE kalzit_infile (a TEXT)").execute(&pool).await.ok();
    let load = sqlx::raw_sql("LOAD DATA LOCAL INFILE 'Cargo.toml' INTO TABLE kalzit_infile").execute(&pool).await;
    assert!(load.is_err(), "LOCAL INFILE must not work");
    pool.close().await;
    t.finish().await;
}

#[tokio::test]
async fn mssql_reads_and_rolls_back() {
    let Some(url) = env("KALZIT_TEST_MSSQL_URL") else { return };
    let (host, port, user, password, database) = parts(&url);
    let t = T::new(None).await;
    let settings =
        json!({ "host": host, "port": port, "database": database, "user": user, "trustServerCertificate": true });
    let id = t.create("mssql", settings, secrets(password)).await;
    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");
    let r = t
        .query(
            &id,
            json!({ "sql": "SELECT CAST(9007199254740993 AS BIGINT) AS gross, CAST(1.5 AS DECIMAL(4,2)) AS d, \
                                    $land AS land, SYSUTCDATETIME() AS jetzt, CAST(1 AS BIT) AS ja \
                                    WHERE SYSUTCDATETIME() > $__timeFrom" }),
        )
        .await;
    assert_eq!(types(&r), ["int64", "decimal", "string", "time", "bool"], "{r}");
    assert_eq!(r["result"]["frame"]["fields"][1]["values"][0], "1.50", "{r}");
    assert_eq!(r["result"]["frame"]["fields"][2]["values"][0], "Österreich");
    // Decimals keep every digit and their scale; a DATE is a day.
    let exact = t
        .query(
            &id,
            json!({ "sql": "SELECT CAST('12345678901234567.8901' AS DECIMAL(30,4)) AS n, \
                    CAST(-0.05 AS NUMERIC(5,3)) AS k, CAST('2026-10-25' AS DATE) AS d" }),
        )
        .await;
    assert_eq!(types(&exact), ["decimal", "decimal", "date"], "{exact}");
    let fields = &exact["result"]["frame"]["fields"];
    assert_eq!(fields[0]["values"][0], "12345678901234567.8901", "{exact}");
    assert_eq!(fields[1]["values"][0], "-0.050", "{exact}");
    assert_eq!(fields[2]["values"][0], 1_792_886_400_000_i64, "{exact}");
    for sql in [
        "SELECT * INTO neu FROM sys.objects",
        "SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1') AS r",
        "SELECT name FROM sys.objects WITH (TABLOCKX)",
        "SELECT name FROM sys.objects WITH (UPDLOCK, HOLDLOCK)",
        "SELECT o.name FROM sys.objects o JOIN sys.columns c WITH (XLOCK) ON c.object_id = o.object_id",
        "SELECT name FROM sys.objects OPTION (TABLE HINT (sys.objects, TABLOCKX))",
        "SELECT NEXT VALUE FOR dbo.s",
        "SELECT name FROM sys.objects OPTION/**/(TABLE HINT (sys.objects, TABLOCKX))",
        "SELECT o.name FROM sys.objects o (TABLOCKX)",
        "SELECT j.[key] FROM sys.objects o CROSS APPLY OPENJSON('[1]') j OPTION (TABLE HINT (o, TABLOCKX))",
    ] {
        assert_eq!(t.query(&id, json!({ "sql": sql })).await["error"]["code"], "query_rejected", "{sql}");
    }
    for sql in [
        "SELECT TOP 1 name FROM sys.objects WITH (NOLOCK)",
        "SELECT TOP 1 'option (x)' AS a FROM sys.objects WITH (READUNCOMMITTED)",
        "SELECT TOP 1 o.name FROM sys.objects o (NOLOCK)",
        "SELECT TOP 1 [option].name FROM sys.objects AS [option] WITH (NOLOCK)",
    ] {
        let ok = t.query(&id, json!({ "sql": sql })).await;
        assert!(ok["result"].is_object(), "{sql}: {ok}");
    }
    let schema = t.send(Method::GET, &format!("/datasources/{id}/schema"), None).await.1;
    assert_eq!(schema["kind"], "tables");

    // A query past its time limit is cancelled on the server, and the source stays usable.
    let (status, body) = t
        .send(Method::PATCH, &format!("/datasources/{id}"), Some(json!({ "settings": { "host": host, "port": port, "database": database, "user": user, "trustServerCertificate": true, "queryTimeoutSecs": 1 } })))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let slow = t
        .query(
            &id,
            json!({ "sql": "SELECT COUNT_BIG(*) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b \
                       CROSS JOIN sys.all_objects c CROSS JOIN sys.all_objects d \
                       WHERE CHECKSUM(a.name, b.name, c.name, d.name) = 42" }),
        )
        .await;
    assert_eq!(slow["error"]["code"], "query_timeout", "{slow}");
    let after = t.query(&id, json!({ "sql": "SELECT 1 AS eins" })).await;
    assert!(after["result"].is_object(), "{after}");
    t.finish().await;
}

#[tokio::test]
async fn prometheus_range_and_instant_queries() {
    let Some(url) = env("KALZIT_TEST_PROMETHEUS_URL") else { return };
    let t = T::new(None).await;
    let id = t.create("prometheus", json!({ "url": url }), json!({})).await;
    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let body = json!({
        "queries": [
            { "refId": "R", "datasourceId": id, "query": { "expr": "vector(1)" } },
            { "refId": "I", "datasourceId": id, "query": { "expr": "time()", "instant": true } }
        ],
        "timeRange": { "from": now - 600_000, "to": now }
    });
    let (status, body) = t.send(Method::POST, "/query", Some(body)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["results"]["R"]["result"]["frame"]["fields"][0]["type"], "time", "{body}");
    assert_eq!(body["results"]["I"]["result"]["frame"]["fields"][1]["type"], "number", "{body}");
    let schema = t.send(Method::GET, &format!("/datasources/{id}/schema"), None).await.1;
    assert_eq!(schema["kind"], "metrics", "{schema}");
    t.finish().await;
}

/// Runs Cypher on the test database directly (auto-commit), to set up data Kalzit then only reads.
async fn bolt_setup(url: &str, statements: &[&str]) {
    let (host, port, user, password, _) = parts(url);
    let policy = kalzit::datasources::targets::TargetPolicy::new(
        &std::env::temp_dir().join("kalzit-none"),
        "sqlite::memory:",
        &[],
        &[],
    );
    let opts = kalzit::datasources::bolt::ConnectOptions {
        host: &host,
        port,
        user: (!user.is_empty()).then_some(user.as_str()),
        password: password.as_deref(),
        tls: None,
        timeout: std::time::Duration::from_secs(10),
    };
    let mut c = kalzit::datasources::bolt::connect(&policy, opts).await.unwrap();
    for s in statements {
        c.run_auto(s, None).await.unwrap_or_else(|e| panic!("{s}: {e}"));
        c.pull(-1, 1 << 20, |_, _| true).await.unwrap();
    }
}

fn graph_settings(url: &str, extra: Value) -> (Value, Value) {
    let (host, port, user, password, _) = parts(url);
    let mut settings = json!({ "host": host, "port": port });
    if !user.is_empty() {
        settings["user"] = json!(user);
    }
    for (k, v) in extra.as_object().unwrap() {
        settings[k] = v.clone();
    }
    (settings, secrets(password))
}

const GRAPH_SETUP: &[&str] = &[
    "MATCH (n:KalzitTest) DETACH DELETE n",
    "CREATE (a:KalzitTest:Person {name: 'Ana', gross: 9007199254740993, seit: date('2024-01-01')})-[:KENNT {seit: 2020}]->(b:KalzitTest:Person {name: 'Bo'})",
];

/// The checks both Bolt kinds share: graph and frame answers, native types, refusals, schema.
async fn graph_reads(t: &T, id: &str) {
    let r = t.query(id, json!({ "cypher": "MATCH p = (a:KalzitTest {name: 'Ana'})-[:KENNT]->(b) RETURN p" })).await;
    let graph = &r["result"]["graph"];
    assert_eq!(r["result"]["shape"], "graph", "{r}");
    assert_eq!(graph["nodes"].as_array().unwrap().len(), 2, "{r}");
    assert_eq!(graph["edges"][0]["type"], "KENNT", "{r}");
    assert_eq!(graph["edges"][0]["properties"]["seit"], 2020, "{r}");
    assert_eq!(graph["paths"][0]["nodes"].as_array().unwrap().len(), 2, "{r}");
    let ana = graph["nodes"].as_array().unwrap().iter().find(|n| n["properties"]["name"] == "Ana").unwrap();
    assert_eq!(ana["properties"]["gross"], json!({ "$type": "int64", "value": "9007199254740993" }), "{r}");
    assert_eq!(ana["properties"]["seit"], json!({ "$type": "date", "value": "2024-01-01" }), "{r}");

    let r = t
        .query(
            id,
            json!({ "cypher": "MATCH (n:KalzitTest) WHERE n.name = $land OR n.name IS NOT NULL \
                               RETURN n.name AS name, n.gross AS g, $__timeFrom AS ab ORDER BY name" }),
        )
        .await;
    assert_eq!(types(&r), ["string", "int64", "time"], "{r}");
    let fields = &r["result"]["frame"]["fields"];
    assert_eq!(fields[0]["values"], json!(["Ana", "Bo"]), "{r}");
    assert_eq!(fields[2]["values"][0], 1_700_000_000_000_i64, "{r}");

    for q in [
        "MATCH (n) DETACH DELETE n",
        "CREATE (n:KalzitTest)",
        "MATCH (n:KalzitTest) SET n.x = 1",
        "MATCH (n) CALL { WITH n MERGE (m:KalzitTest) } RETURN n",
        "LOAD CSV FROM 'file:///etc/passwd' AS l RETURN l",
    ] {
        assert_eq!(t.query(id, json!({ "cypher": q })).await["error"]["code"], "query_rejected", "{q}");
    }
    let count = t.query(id, json!({ "cypher": "MATCH (n:KalzitTest) RETURN count(n) AS c" })).await;
    assert_eq!(count["result"]["frame"]["fields"][0]["values"][0], "2", "nothing changed: {count}");
    let schema = t.send(Method::GET, &format!("/datasources/{id}/schema"), None).await.1;
    assert_eq!(schema["kind"], "graph", "{schema}");
    assert!(schema["labels"].as_array().unwrap().contains(&json!("KalzitTest")), "{schema}");
    assert!(schema["edgeTypes"].as_array().unwrap().contains(&json!("KENNT")), "{schema}");
}

#[tokio::test]
async fn neo4j_reads_graphs_in_read_transactions() {
    let Some(url) = env("KALZIT_TEST_NEO4J_URL") else { return };
    bolt_setup(&url, GRAPH_SETUP).await;
    let t = T::new(None).await;
    let (settings, secrets) = graph_settings(&url, json!({}));
    let id = t.create("neo4j", settings.clone(), secrets).await;
    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");
    assert_eq!(h["reason"], "health.connected", "{h}");
    assert_eq!(h["params"]["engine"], "Neo4j", "{h}");
    graph_reads(&t, &id).await;

    // The node limit cuts the graph with a reason.
    let mut limited = settings;
    limited["maxNodes"] = json!(1);
    let (status, body) =
        t.send(Method::PATCH, &format!("/datasources/{id}"), Some(json!({ "settings": limited }))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let r = t.query(&id, json!({ "cypher": "MATCH (n:KalzitTest) RETURN n" })).await;
    assert_eq!(r["result"]["graph"]["truncated"]["reason"], "graph.node_limit", "{r}");
}

#[tokio::test]
async fn memgraph_refuses_users_who_may_write_unless_allowed() {
    let Some(url) = env("KALZIT_TEST_MEMGRAPH_URL") else { return };
    bolt_setup(&url, GRAPH_SETUP).await;
    let t = T::new(None).await;
    // The CI container has no users, so anyone may write: refused by default.
    let (settings, secrets) = graph_settings(&url, json!({}));
    let strict = t.create("memgraph", settings, secrets).await;
    let h = t.health(&strict).await;
    assert_eq!(h["ok"], false, "{h}");
    assert_eq!(h["reason"], "memgraph.user_can_write", "{h}");
    let r = t.query(&strict, json!({ "cypher": "MATCH (n) RETURN n LIMIT 1" })).await;
    assert_eq!(r["error"]["reason"], "memgraph.user_can_write", "{r}");

    let (settings, secrets) = graph_settings(&url, json!({ "allowWriteCapableUser": true }));
    let body = json!({ "name": "Memgraph erlaubt", "kind": "memgraph", "settings": settings, "secrets": secrets });
    let (status, created) = t.send(Method::POST, "/datasources", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["id"].as_str().unwrap().to_string();
    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");
    assert_eq!(h["reason"], "health.connected_write_capable", "{h}");
    assert!(h["params"]["privileges"].as_str().unwrap().contains("CREATE"), "{h}");
    graph_reads(&t, &id).await;
}

/// Whether the server accepts `query` (planned with EXPLAIN, so nothing runs).
async fn bolt_explains(url: &str, query: &str) -> bool {
    let (host, port, user, password, _) = parts(url);
    let policy = kalzit::datasources::targets::TargetPolicy::new(
        &std::env::temp_dir().join("kalzit-none"),
        "sqlite::memory:",
        &[],
        &[],
    );
    let opts = kalzit::datasources::bolt::ConnectOptions {
        host: &host,
        port,
        user: (!user.is_empty()).then_some(user.as_str()),
        password: password.as_deref(),
        tls: None,
        timeout: std::time::Duration::from_secs(10),
    };
    let mut c = kalzit::datasources::bolt::connect(&policy, opts).await.unwrap();
    match c.run_auto(&format!("EXPLAIN {query}"), None).await {
        Ok(_) => c.pull(-1, 1 << 20, |_, _| true).await.is_ok(),
        Err(_) => false,
    }
}

/// Kalzit refuses numbers glued to letters. Where Neo4j accepts such a text, it must read it as
/// the number followed by a word, exactly as with a space: then the refusal is what keeps a
/// hidden keyword out.
#[tokio::test]
async fn neo4j_reads_glued_numbers_as_number_and_word() {
    let Some(url) = env("KALZIT_TEST_NEO4J_URL") else { return };
    let t = T::new(None).await;
    let (settings, secrets) = graph_settings(&url, json!({}));
    let id = t.create("neo4j", settings, secrets).await;
    for (glued, spaced) in [
        ("MATCH (n) WITH n, 1DELETE n", "MATCH (n) WITH n, 1 DELETE n"),
        ("MATCH (n) RETURN n LIMIT 1SET n.x = 1", "MATCH (n) RETURN n LIMIT 1 SET n.x = 1"),
        (
            "MATCH (n) WITH n LIMIT 1CALL dbms.killQueries(['x'])",
            "MATCH (n) WITH n LIMIT 1 CALL dbms.killQueries(['x'])",
        ),
        (
            "MATCH (n) WITH n LIMIT 1LOAD CSV FROM 'file:///x.csv' AS l RETURN l",
            "MATCH (n) WITH n LIMIT 1 LOAD CSV FROM 'file:///x.csv' AS l RETURN l",
        ),
        ("MATCH (n) WHERE n.x = $1DELETE n", "MATCH (n) WHERE n.x = $1 DELETE n"),
    ] {
        let r = t.query(&id, json!({ "cypher": glued })).await;
        assert_eq!(r["error"]["reason"], "cypher.number_followed_by_letters", "{glued}: {r}");
        let server_glued = bolt_explains(&url, glued).await;
        let server_spaced = bolt_explains(&url, spaced).await;
        eprintln!("{glued}: server accepts glued {server_glued}, spaced {server_spaced}");
        assert!(!server_glued || server_spaced, "Neo4j reads {glued:?} in a way Kalzit does not know");
    }
}

/// Sends a request straight to a search cluster, to set up and check test data.
async fn cluster(
    http: &kalzit::http::HttpClient,
    auth: &Option<String>,
    method: reqwest::Method,
    url: String,
    body: Option<(&str, String)>,
) -> Value {
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(a) = auth {
        headers.insert(reqwest::header::AUTHORIZATION, a.parse().unwrap());
    }
    let body = body.map(|(content_type, text)| {
        headers.insert(reqwest::header::CONTENT_TYPE, content_type.parse().unwrap());
        text.into_bytes()
    });
    let res = http.send_with_body(method, reqwest::Url::parse(&url).unwrap(), headers, body).await.unwrap();
    let status = res.status();
    let bytes = res.bytes().await.unwrap();
    assert!(status.is_success(), "{status}: {}", String::from_utf8_lossy(&bytes));
    serde_json::from_slice(&bytes).unwrap()
}

/// Elasticsearch or OpenSearch: hits as documents, aggregations as frames, nothing written.
async fn search_cluster(env_name: &str, engine: &str) {
    use base64::Engine as _;
    let Some(url) = env(env_name) else { return };
    let (host, port, user, password, _) = parts(&url);
    let base = format!("http://{host}:{port}");
    let auth = (!user.is_empty()).then(|| {
        let pair = format!("{user}:{}", password.clone().unwrap_or_default());
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(pair))
    });
    let policy = kalzit::datasources::targets::TargetPolicy::new(
        &std::env::temp_dir().join("kalzit-none"),
        "sqlite::memory:",
        &[],
        &[],
    );
    let http = kalzit::http::client(kalzit::http::HttpOptions {
        timeout: std::time::Duration::from_secs(60),
        extra_root_pem: None,
        policy: Arc::new(policy),
    })
    .unwrap();
    let index = format!("kalzit-test-{}", uuid::Uuid::now_v7().simple());
    let json = "application/json";
    let mapping = json!({ "mappings": { "properties": {
        "@timestamp": { "type": "date" }, "land": { "type": "keyword" }, "betrag": { "type": "double" } } } });
    cluster(&http, &auth, reqwest::Method::PUT, format!("{base}/{index}"), Some((json, mapping.to_string()))).await;
    let docs = [
        json!({ "@timestamp": 1_750_000_000_000_i64, "land": "Österreich", "betrag": 12.5 }),
        json!({ "@timestamp": 1_760_000_000_000_i64, "land": "Österreich", "betrag": 7.5 }),
        json!({ "@timestamp": 1_770_000_000_000_i64, "land": "Schweiz", "betrag": 3.0 }),
        // Outside the queried range.
        json!({ "@timestamp": 1_900_000_000_000_i64, "land": "Schweiz", "betrag": 99.0 }),
    ];
    let bulk: String = docs.iter().map(|d| format!("{{\"index\":{{}}}}\n{d}\n")).collect();
    let r = cluster(
        &http,
        &auth,
        reqwest::Method::POST,
        format!("{base}/{index}/_bulk?refresh=true"),
        Some(("application/x-ndjson", bulk)),
    )
    .await;
    assert_eq!(r["errors"], false, "{r}");

    let t = T::new(None).await;
    let mut settings = json!({ "url": base, "index": index });
    if !user.is_empty() {
        settings["basicAuthUser"] = json!(user);
    }
    let secrets = password.map_or(json!({}), |p| json!({ "basicAuthPassword": p }));
    let id = t.create("elasticsearch", settings, secrets).await;
    let h = t.health(&id).await;
    assert_eq!((h["ok"].as_bool(), h["params"]["engine"].as_str()), (Some(true), Some(engine)), "{h}");

    let hits = t.query(&id, json!({ "lucene": "land:$land" })).await;
    let found = &hits["result"]["documents"]["documents"];
    assert_eq!(found.as_array().map(Vec::len), Some(2), "{hits}");
    assert_eq!(found[0]["_index"], index.as_str());
    let all = t.query(&id, json!({})).await;
    assert_eq!(all["result"]["documents"]["documents"].as_array().map(Vec::len), Some(3), "the time filter: {all}");

    let aggs = t
        .query(
            &id,
            json!({ "dsl": { "aggs": { "land": { "terms": { "field": "land" }, "aggs": { "summe": { "sum": { "field": "betrag" } } } } } } }),
        )
        .await;
    let fields = &aggs["result"]["frame"]["fields"];
    assert_eq!(fields[0]["name"], "land", "{aggs}");
    assert_eq!(fields[0]["values"], json!(["Österreich", "Schweiz"]), "{aggs}");
    assert_eq!(fields[1]["name"], "summe", "{aggs}");
    assert_eq!(fields[1]["values"], json!([20.0, 3.0]), "{aggs}");
    let years = t
        .query(&id, json!({ "dsl": { "aggs": { "jahr": { "date_histogram": { "field": "@timestamp", "calendar_interval": "year" } } } } }))
        .await;
    assert_eq!(years["result"]["frame"]["fields"][0]["type"], "time", "{years}");

    let doubled = t
        .query(&id, json!({ "dsl": { "script_fields": { "doppelt": { "script": "doc['betrag'].value * 2" } } } }))
        .await;
    assert!(doubled["result"]["documents"].is_object(), "a read-only script runs: {doubled}");
    for refused in [
        json!({ "dsl": { "script_fields": { "x": { "script": "ctx._source.betrag = 0" } } } }),
        json!({ "lucene": "*", "index": format!("{index}/_delete_by_query") }),
        json!({ "dsl": { "aggs": { "m": { "scripted_metric": { "map_script": "1" } } } } }),
    ] {
        let r = t.query(&id, refused.clone()).await;
        assert_eq!(r["error"]["code"], "query_rejected", "{refused}: {r}");
    }

    let schema = t.send(Method::GET, &format!("/datasources/{id}/schema"), None).await.1;
    assert_eq!(schema["kind"], "indices", "{schema}");
    let ours = schema["indices"].as_array().unwrap().iter().find(|i| i["name"] == index.as_str()).unwrap();
    assert!(
        ours["columns"].as_array().unwrap().iter().any(|c| c["name"] == "land" && c["type"] == "keyword"),
        "{schema}"
    );

    let count = cluster(&http, &auth, reqwest::Method::GET, format!("{base}/{index}/_count"), None).await;
    assert_eq!(count["count"], 4, "nothing was written or deleted");
    cluster(&http, &auth, reqwest::Method::DELETE, format!("{base}/{index}"), None).await;
}

#[tokio::test]
async fn elasticsearch_hits_aggregations_and_refusals() {
    search_cluster("KALZIT_TEST_ELASTICSEARCH_URL", "Elasticsearch").await;
}

#[tokio::test]
async fn opensearch_hits_aggregations_and_refusals() {
    search_cluster("KALZIT_TEST_OPENSEARCH_URL", "OpenSearch").await;
}
