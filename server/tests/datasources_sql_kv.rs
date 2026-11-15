//! Graphite, Redis, Oracle and ClickHouse's native protocol against real servers, through the
//! router. Each test needs its `KALZIT_TEST_<SOURCE>_URL`; the CI job `datasources-sql-kv` sets all
//! of them from service containers together with `KALZIT_TEST_REQUIRE_DATABASES=1`, which turns a
//! missing URL into a failure. Elsewhere (Windows, a laptop) a missing URL skips the test with a
//! printed notice.
//!
//! - `KALZIT_TEST_GRAPHITE_URL`: `http://host:port` of graphite-web, and
//!   `KALZIT_TEST_GRAPHITE_CARBON`: `host:port` of carbon's plaintext listener, to write test data
//! - `KALZIT_TEST_REDIS_URL`: `redis://host:port` with a user that may create ACL users (the test
//!   makes a read-only one for Kalzit); `KALZIT_TEST_REDIS_MODULES=1` requires JSON, search and
//!   time series (Redis 8 or Redis Stack)
//! - `KALZIT_TEST_ORACLE_URL`: `oracle://user:password@host:port/service` of a user that may
//!   create tables in its schema
//! - `KALZIT_TEST_CLICKHOUSE_NATIVE_URL`: `clickhouse://user:password@host:port/database` (the
//!   native protocol, port 9000)
//!
//! Units of each kind run on every build in the kind's own module.

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::ManualClock;
use kalzit::config::Config;
use serde_json::{Value, json};
use tokio::io::{AsyncWriteExt, BufStream};
use tower::ServiceExt;

const SETUP_CODE: &str = "test-setup-code-0123456789";

struct T {
    app: Router,
    org: String,
    cookie: String,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
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

/// Host, port, user, password and path of a test URL.
fn parts(url: &str) -> (String, u16, String, Option<String>, String) {
    let u = reqwest::Url::parse(url).expect("a URL like scheme://user:password@host:port/path");
    (
        u.host_str().unwrap().trim_matches(['[', ']']).to_string(),
        u.port().expect("the URL names the port"),
        u.username().to_string(),
        u.password().map(String::from),
        u.path().trim_start_matches('/').to_string(),
    )
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

impl T {
    async fn new() -> T {
        let dir = common::private_tempdir();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().to_path_buf();
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

    async fn finish(self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone());
        drop(self);
        finish.finish().await;
    }

    async fn send(&self, method: Method, rest: &str, body: Option<Value>) -> (StatusCode, Value) {
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

    async fn health(&self, id: &str) -> Value {
        self.send(Method::POST, &format!("/datasources/{id}/health"), Some(json!({}))).await.1
    }

    async fn schema(&self, id: &str) -> Value {
        self.send(Method::GET, &format!("/datasources/{id}/schema"), None).await.1
    }

    /// Runs one query over the last ten minutes.
    async fn query(&self, id: &str, query: Value, variables: Value) -> Value {
        let now = now_ms();
        let body = json!({
            "queries": [{ "refId": "A", "datasourceId": id, "query": query }],
            "timeRange": { "from": now - 600_000, "to": now + 60_000 },
            "variables": variables
        });
        let (status, body) = self.send(Method::POST, "/query", Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["results"]["A"].clone()
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

fn field<'a>(result: &'a Value, name: &str) -> &'a Value {
    result["result"]["frame"]["fields"]
        .as_array()
        .and_then(|f| f.iter().find(|f| f["name"] == name))
        .map_or(&Value::Null, |f| &f["values"])
}

// ---- Graphite ----

/// Graphite: targets with functions and variables, tags, the schema, refused variable values.
#[tokio::test]
async fn graphite_renders_targets_and_lists_metrics() {
    let Some(url) = env("KALZIT_TEST_GRAPHITE_URL") else { return };
    let Some(carbon) = env("KALZIT_TEST_GRAPHITE_CARBON") else { return };
    // Points a minute apart over the last five minutes, in carbon's plaintext protocol.
    let now = now_ms() / 1000;
    let mut lines = String::new();
    for (i, back) in [300, 240, 180, 120, 60].iter().enumerate() {
        lines.push_str(&format!("kalzit.test.requests {} {}\n", 10 + i, now - back));
        lines.push_str(&format!("kalzit.test.errors {} {}\n", i, now - back));
    }
    let mut socket = tokio::net::TcpStream::connect(&carbon).await.unwrap();
    socket.write_all(lines.as_bytes()).await.unwrap();
    socket.shutdown().await.unwrap();

    let t = T::new().await;
    let id = t.create("graphite", json!({ "url": url }), json!({})).await;
    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");

    // Carbon writes the series to disk shortly after it receives them.
    let mut r = Value::Null;
    for _ in 0..60 {
        r = t.query(&id, json!({ "target": "sumSeries(kalzit.test.*)" }), json!({})).await;
        if field(&r, "sumSeries(kalzit.test.*)").as_array().is_some_and(|v| v.iter().any(|x| x.is_number())) {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert_eq!(types(&r).first().map(String::as_str), Some("time"), "{r}");
    assert!(field(&r, "sumSeries(kalzit.test.*)").as_array().unwrap().iter().any(|v| v.is_number()), "{r}");

    let r = t.query(&id, json!({ "target": "aliasByNode(kalzit.test.$m, 2)" }), json!({ "m": "requests" })).await;
    assert!(field(&r, "requests").is_array(), "{r}");
    assert_eq!(r["result"]["frame"]["meta"]["executedQuery"], "aliasByNode(kalzit.test.requests, 2)", "{r}");
    let r = t.query(&id, json!({ "target": "kalzit.test.$m" }), json!({ "m": "requests),sumSeries(kalzit.*" })).await;
    assert_eq!(r["error"]["code"], "query_rejected", "{r}");
    assert_eq!(r["error"]["reason"], "graphite.variable_characters", "{r}");
    let r = t.query(&id, json!({ "target": "notAFunction(kalzit.test.requests)" }), json!({})).await;
    assert_eq!(r["error"]["code"], "datasource_error", "{r}");

    let schema = t.schema(&id).await;
    assert_eq!(schema["kind"], "metrics", "{schema}");
    t.finish().await;
}

// ---- Redis ----

/// One RESP connection for setting up test data (writes Kalzit never sends).
struct RedisAdmin(BufStream<tokio::net::TcpStream>);

impl RedisAdmin {
    async fn connect(host: &str, port: u16, auth: Option<(&str, &str)>) -> RedisAdmin {
        let socket = tokio::net::TcpStream::connect((host, port)).await.unwrap();
        let mut admin = RedisAdmin(BufStream::new(socket));
        if let Some((user, password)) = auth {
            let r = admin.call(&["AUTH", user, password]).await;
            assert_eq!(r, kalzit::datasources::redis::resp::Reply::Status("OK".into()));
        }
        admin
    }

    async fn call(&mut self, args: &[&str]) -> kalzit::datasources::redis::resp::Reply {
        use kalzit::datasources::redis::resp;
        let args: Vec<Vec<u8>> = args.iter().map(|a| a.as_bytes().to_vec()).collect();
        self.0.write_all(&resp::encode(&args)).await.unwrap();
        self.0.flush().await.unwrap();
        let mut budget = 1 << 20;
        resp::read(&mut self.0, &mut budget).await.unwrap()
    }

    /// A command that must succeed.
    async fn ok(&mut self, args: &[&str]) {
        let r = self.call(args).await;
        assert!(!matches!(r, kalzit::datasources::redis::resp::Reply::Error(_)), "{args:?}: {r:?}");
    }
}

/// Redis: every result form, the key schema, refused writes, and an argument that cannot become a
/// second command.
#[tokio::test]
async fn redis_reads_by_type_and_refuses_writes() {
    use kalzit::datasources::redis::resp::Reply;
    let Some(url) = env("KALZIT_TEST_REDIS_URL") else { return };
    let modules_required = std::env::var("KALZIT_TEST_REDIS_MODULES").is_ok_and(|v| v == "1");
    let (host, port, user, password, _) = parts(&url);
    let auth = password.as_deref().map(|p| (if user.is_empty() { "default" } else { user.as_str() }, p));
    let mut admin = RedisAdmin::connect(&host, port, auth).await;
    admin
        .ok(&[
            "DEL",
            "kalzit:user:1",
            "kalzit:counter",
            "kalzit:list",
            "kalzit:scores",
            "kalzit:events",
            "kalzit:doc:1",
            "kalzit:temp",
        ])
        .await;
    admin.ok(&["HSET", "kalzit:user:1", "name", "Jörg", "alter", "41"]).await;
    admin.ok(&["SET", "kalzit:counter", "42"]).await;
    admin.ok(&["RPUSH", "kalzit:list", "a", "b", "c"]).await;
    admin.ok(&["ZADD", "kalzit:scores", "1.5", "graz", "3", "wien"]).await;
    admin.ok(&["XADD", "kalzit:events", "*", "temp", "21.5", "ort", "Linz"]).await;
    // Kalzit's own login: read commands only.
    admin
        .ok(&[
            "ACL",
            "SETUSER",
            "kalzit-ro",
            "reset",
            "on",
            ">kalzit-ci-redis-ro",
            "~*",
            "+@read",
            "+@connection",
            "+info",
        ])
        .await;
    let modules =
        matches!(admin.call(&["JSON.SET", "kalzit:doc:1", "$", r#"{"ort":"Graz","n":[1,2]}"#]).await, Reply::Status(_));
    assert!(modules || !modules_required, "JSON, search and time series are required, but JSON.SET failed");
    let now = now_ms();
    if modules {
        admin.ok(&["TS.CREATE", "kalzit:temp", "LABELS", "area", "nord"]).await;
        admin.ok(&["TS.ADD", "kalzit:temp", &(now - 120_000).to_string(), "1.5"]).await;
        admin.ok(&["TS.ADD", "kalzit:temp", &(now - 60_000).to_string(), "2.5"]).await;
        let _ = admin.call(&["FT.DROPINDEX", "kalzit-idx"]).await;
        admin
            .ok(&[
                "FT.CREATE",
                "kalzit-idx",
                "ON",
                "JSON",
                "PREFIX",
                "1",
                "kalzit:doc:",
                "SCHEMA",
                "$.ort",
                "AS",
                "ort",
                "TAG",
            ])
            .await;
    }

    let t = T::new().await;
    let id = t
        .create(
            "redis",
            json!({ "host": host, "port": port, "user": "kalzit-ro" }),
            json!({ "password": "kalzit-ci-redis-ro" }),
        )
        .await;
    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");
    assert!(h["message"].as_str().unwrap().contains("Redis") || h["message"].as_str().unwrap().contains("Valkey"));

    let r = t.query(&id, json!({ "command": "GET kalzit:counter" }), json!({})).await;
    assert_eq!(field(&r, "value"), &json!([42.0]), "{r}");
    let r = t.query(&id, json!({ "command": "HGETALL kalzit:user:$id" }), json!({ "id": "1" })).await;
    assert_eq!(field(&r, "field"), &json!(["name", "alter"]), "{r}");
    assert_eq!(field(&r, "value"), &json!(["Jörg", "41"]), "{r}");
    let r = t.query(&id, json!({ "command": "ZREVRANGE kalzit:scores 0 -1 WITHSCORES" }), json!({})).await;
    assert_eq!(field(&r, "member"), &json!(["wien", "graz"]), "{r}");
    assert_eq!(field(&r, "score"), &json!([3.0, 1.5]), "{r}");
    let r = t.query(&id, json!({ "command": "LRANGE kalzit:list 0 -1" }), json!({})).await;
    assert_eq!(field(&r, "value"), &json!(["a", "b", "c"]), "{r}");
    let r =
        t.query(&id, json!({ "command": "MGET $keys" }), json!({ "keys": ["kalzit:counter", "kalzit:none"] })).await;
    assert_eq!(field(&r, "key"), &json!(["kalzit:counter", "kalzit:none"]), "{r}");
    assert_eq!(field(&r, "value"), &json!([42.0, null]), "{r}");
    let r = t.query(&id, json!({ "command": "XRANGE kalzit:events - +" }), json!({})).await;
    let doc = &r["result"]["documents"]["documents"][0];
    assert_eq!(doc["ort"], "Linz", "{r}");
    assert!(doc["_time"].is_i64(), "{r}");
    let r = t.query(&id, json!({ "command": "SCAN 0 MATCH kalzit:* COUNT 1000" }), json!({})).await;
    assert!(field(&r, "key").as_array().is_some_and(|k| k.contains(&json!("kalzit:counter"))), "{r}");

    if modules {
        let r = t.query(&id, json!({ "command": "JSON.GET kalzit:doc:1 $" }), json!({})).await;
        assert_eq!(r["result"]["documents"]["documents"], json!([{ "ort": "Graz", "n": [1, 2] }]), "{r}");
        let r = t.query(&id, json!({ "command": "TS.RANGE kalzit:temp $__timeFrom $__timeTo" }), json!({})).await;
        assert_eq!(field(&r, "kalzit:temp"), &json!([1.5, 2.5]), "{r}");
        assert_eq!(field(&r, "time"), &json!([now - 120_000, now - 60_000]), "{r}");
        let r = t
            .query(&id, json!({ "command": "TS.MRANGE $__timeFrom $__timeTo WITHLABELS FILTER area=nord" }), json!({}))
            .await;
        assert_eq!(r["result"]["frame"]["fields"][1]["labels"]["area"], "nord", "{r}");
        // The index fills in the background.
        let mut r = Value::Null;
        for _ in 0..20 {
            r = t.query(&id, json!({ "command": "FT.SEARCH kalzit-idx '@ort:{Graz}'" }), json!({})).await;
            if r["result"]["documents"]["documents"].as_array().is_some_and(|d| !d.is_empty()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        assert_eq!(r["result"]["documents"]["documents"][0]["ort"], "Graz", "{r}");
    }

    for refused in ["SET kalzit:counter 0", "FLUSHALL", "DEL kalzit:counter", "EVAL \"return 1\" 0", "CONFIG GET *"] {
        let r = t.query(&id, json!({ "command": refused }), json!({})).await;
        assert_eq!(r["error"]["code"], "query_rejected", "{refused}: {r}");
        assert_eq!(r["error"]["reason"], "redis.command_not_allowed", "{refused}: {r}");
    }
    let r = t.query(&id, json!({ "command": "KEYS *" }), json!({})).await;
    assert_eq!(r["error"]["reason"], "redis.keys_refused", "{r}");
    // A value with a line break and a second command stays one argument: no such key, no flush.
    let r = t
        .query(&id, json!({ "command": "GET $k" }), json!({ "k": "kalzit:counter\r\n*1\r\n$8\r\nFLUSHALL\r\n" }))
        .await;
    assert_eq!(field(&r, "value"), &json!([null]), "{r}");
    assert_eq!(admin.call(&["GET", "kalzit:counter"]).await, Reply::Bulk(b"42".to_vec()));
    // The login itself may not write either: the boundary on Redis' side.
    let mut ro = RedisAdmin::connect(&host, port, Some(("kalzit-ro", "kalzit-ci-redis-ro"))).await;
    assert!(matches!(ro.call(&["SET", "kalzit:counter", "0"]).await, Reply::Error(e) if e.starts_with("NOPERM")));

    let schema = t.schema(&id).await;
    assert_eq!(schema["kind"], "keys", "{schema}");
    let user = schema["keys"].as_array().unwrap().iter().find(|k| k["name"] == "kalzit:user:1").cloned();
    assert_eq!(user, Some(json!({ "name": "kalzit:user:1", "type": "hash" })), "{schema}");
    t.finish().await;
}

// ---- Oracle ----

/// Oracle: macros and variables as binds, exact numbers, the schema, refused writes and calls.
#[tokio::test]
async fn oracle_reads_in_read_only_transactions() {
    let Some(url) = env("KALZIT_TEST_ORACLE_URL") else { return };
    let (host, port, user, password, service) = parts(&url);
    let password = password.unwrap_or_default();
    let admin = oracle_rs::Connection::connect(&format!("{host}:{port}/{service}"), &user, &password).await.unwrap();
    let _ = admin.execute("DROP TABLE kalzit_events", &[]).await;
    admin
        .execute(
            "CREATE TABLE kalzit_events (t TIMESTAMP, land VARCHAR2(40), n NUMBER(5), preis NUMBER(10, 2), \
             big NUMBER(20))",
            &[],
        )
        .await
        .unwrap();
    let now = now_ms();
    let stamp =
        |ms: i64| chrono::DateTime::from_timestamp_millis(ms).unwrap().format("%Y-%m-%d %H:%M:%S%.3f").to_string();
    for (at, land, n, preis, big) in
        [(now - 120_000, "Österreich", 3, "12.50", "9007199254740993"), (now - 60_000, "Schweiz", 4, "7.25", "1")]
    {
        admin
            .execute(
                &format!(
                    "INSERT INTO kalzit_events VALUES (TO_TIMESTAMP('{}', 'YYYY-MM-DD HH24:MI:SS.FF3'), '{land}', {n}, \
                     {preis}, {big})",
                    stamp(at)
                ),
                &[],
            )
            .await
            .unwrap();
    }
    admin.commit().await.unwrap();

    let t = T::new().await;
    let id = t
        .create(
            "oracle",
            json!({ "host": host, "port": port, "serviceName": service, "user": user }),
            json!({ "password": password }),
        )
        .await;
    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");

    let r = t
        .query(
            &id,
            json!({ "sql": "SELECT t, land, n, preis, big FROM kalzit_events WHERE $__timeFilter(t) AND land = $land \
                            ORDER BY t FETCH FIRST 10 ROWS ONLY" }),
            json!({ "land": "Österreich" }),
        )
        .await;
    assert_eq!(types(&r), ["time", "string", "number", "decimal", "decimal"], "{r}");
    assert_eq!(field(&r, "T"), &json!([now - 120_000]), "{r}");
    assert_eq!(field(&r, "PREIS"), &json!(["12.5"]), "{r}");
    assert_eq!(field(&r, "N"), &json!([3]), "{r}");
    assert!(field(&r, "BIG").to_string().contains("9007199254740993"), "{r}");
    assert!(r["result"]["frame"]["meta"]["executedQuery"].as_str().unwrap().contains(":3"), "{r}");
    let r = t.query(&id, json!({ "sql": "SELECT COUNT(*) AS n FROM kalzit_events" }), json!({})).await;
    assert!(field(&r, "N").to_string().contains('2'), "{r}");

    for refused in [
        "INSERT INTO kalzit_events (n) VALUES (1)",
        "DELETE FROM kalzit_events",
        "SELECT * FROM kalzit_events FOR UPDATE",
        "SELECT UTL_HTTP.REQUEST('http://127.0.0.1:1/') FROM dual",
        "SELECT * FROM kalzit_events@elsewhere",
    ] {
        let r = t.query(&id, json!({ "sql": refused }), json!({})).await;
        assert_eq!(r["error"]["code"], "query_rejected", "{refused}: {r}");
    }
    let r = t.query(&id, json!({ "sql": "SELECT * FROM kalzit_nothing" }), json!({})).await;
    assert_eq!(r["error"]["reason"], "oracle.error", "{r}");
    // The data is untouched, and the pooled connection still answers after the refusals.
    let r = t.query(&id, json!({ "sql": "SELECT COUNT(*) AS n FROM kalzit_events" }), json!({})).await;
    assert!(field(&r, "N").to_string().contains('2'), "{r}");

    let schema = t.schema(&id).await;
    assert_eq!(schema["kind"], "tables", "{schema}");
    assert!(schema["tables"].as_array().unwrap().iter().any(|t| t["name"] == "KALZIT_EVENTS"), "{schema}");
    let _ = admin.execute("DROP TABLE kalzit_events", &[]).await;
    t.finish().await;
}

// ---- ClickHouse, native protocol ----

/// ClickHouse over the native protocol: parameters, types, the schema, refused writes.
#[tokio::test]
async fn clickhouse_native_reads_with_parameters_and_refuses_writes() {
    let Some(url) = env("KALZIT_TEST_CLICKHOUSE_NATIVE_URL") else { return };
    let (host, port, user, password, database) = parts(&url);
    let password = password.unwrap_or_default();
    let options = nativeclick::ClientOptions {
        username: user.clone(),
        password: password.clone(),
        default_database: database.clone(),
        ..nativeclick::ClientOptions::default()
    };
    let admin = nativeclick::Client::connect((host.as_str(), port), options).await.unwrap();
    let now = now_ms();
    for statement in [
        "DROP TABLE IF EXISTS kalzit_native".to_string(),
        "CREATE TABLE kalzit_native (t DateTime64(3, 'UTC'), land LowCardinality(String), n UInt32, big Int64, \
         preis Decimal(10, 2), tags Array(String)) ENGINE = MergeTree ORDER BY t"
            .to_string(),
        format!(
            "INSERT INTO kalzit_native VALUES (fromUnixTimestamp64Milli({}), 'Österreich', 3, 9007199254740993, 12.50, \
             ['a']), (fromUnixTimestamp64Milli({}), 'Schweiz', 4, 1, 7.25, [])",
            now - 120_000,
            now - 60_000
        ),
    ] {
        admin.execute(statement.as_str()).await.unwrap();
    }

    let t = T::new().await;
    let id = t
        .create(
            "clickhouse_native",
            json!({ "host": host, "port": port, "database": database, "user": user }),
            json!({ "password": password }),
        )
        .await;
    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");

    let r = t
        .query(
            &id,
            json!({ "sql": "SELECT t, land, n, big, preis, tags FROM kalzit_native WHERE $__timeFilter(t) AND land = $land ORDER BY t" }),
            json!({ "land": "Österreich" }),
        )
        .await;
    assert_eq!(types(&r), ["time", "string", "number", "int64", "decimal", "json"], "{r}");
    assert_eq!(field(&r, "t"), &json!([now - 120_000]), "{r}");
    assert_eq!(field(&r, "big"), &json!(["9007199254740993"]), "{r}");
    assert_eq!(field(&r, "preis"), &json!(["12.50"]), "{r}");
    assert_eq!(field(&r, "tags"), &json!([["a"]]), "{r}");
    assert!(r["result"]["frame"]["meta"]["executedQuery"].as_str().unwrap().contains("{p3:String}"), "{r}");

    let r = t.query(&id, json!({ "sql": "SELECT number FROM numbers(1000000)" }), json!({})).await;
    assert_eq!(r["result"]["frame"]["meta"]["notices"][0]["code"], "frame.row_limit", "{r}");
    for refused in [
        "INSERT INTO kalzit_native (n) VALUES (1)",
        "SELECT * FROM kalzit_native SETTINGS readonly = 0",
        "SELECT * FROM url('http://127.0.0.1:1/', CSV, 'a String')",
    ] {
        let r = t.query(&id, json!({ "sql": refused }), json!({})).await;
        assert_eq!(r["error"]["code"], "query_rejected", "{refused}: {r}");
    }
    // After a query cut off at the row limit, the next one gets a clean connection.
    let r = t.query(&id, json!({ "sql": "SELECT count() AS c FROM kalzit_native" }), json!({})).await;
    assert_eq!(field(&r, "c"), &json!(["2"]), "{r}");

    let schema = t.schema(&id).await;
    assert_eq!(schema["kind"], "tables", "{schema}");
    assert!(schema["tables"].as_array().unwrap().iter().any(|t| t["name"] == "kalzit_native"), "{schema}");
    admin.execute("DROP TABLE IF EXISTS kalzit_native").await.unwrap();
    t.finish().await;
}
