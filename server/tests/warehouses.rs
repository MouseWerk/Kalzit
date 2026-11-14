//! The data warehouse sources (BigQuery, Snowflake, Databricks SQL) through the router.
//!
//! They cannot run in CI containers, so the tests that always run use recorded API answers
//! (`tests/fixtures/warehouses`) served by an HTTP mock (`tests/support/warehouse_mock.rs`): a
//! source is created, tested, browsed and queried as through the UI, and a write is refused
//! before anything reaches the warehouse.
//!
//! The `real_*` tests are ignored unless run with `--ignored`; the nightly workflow
//! `warehouses-nightly.yml` runs them with credentials from the GitHub environment `warehouses`.
//! Each skips with a notice when its credentials are not set:
//!
//! - BigQuery: `KALZIT_TEST_BIGQUERY_PROJECT`, `KALZIT_TEST_BIGQUERY_KEY` (a service account key
//!   file's JSON), optional `KALZIT_TEST_BIGQUERY_LOCATION`
//! - Snowflake: `KALZIT_TEST_SNOWFLAKE_ACCOUNT`, `KALZIT_TEST_SNOWFLAKE_USER`,
//!   `KALZIT_TEST_SNOWFLAKE_PRIVATE_KEY` (unencrypted PEM), optional `KALZIT_TEST_SNOWFLAKE_WAREHOUSE`,
//!   `KALZIT_TEST_SNOWFLAKE_ROLE`, `KALZIT_TEST_SNOWFLAKE_DATABASE`
//! - Databricks: `KALZIT_TEST_DATABRICKS_URL`, `KALZIT_TEST_DATABRICKS_WAREHOUSE_ID`, and
//!   `KALZIT_TEST_DATABRICKS_TOKEN` or `KALZIT_TEST_DATABRICKS_CLIENT_ID` with
//!   `KALZIT_TEST_DATABRICKS_CLIENT_SECRET`

mod common;
#[path = "support/warehouse_mock.rs"]
mod mock;

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
use mock::{Mock, reply};
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

    async fn query(&self, id: &str, sql: &str) -> Value {
        let body = json!({
            "queries": [{ "refId": "A", "datasourceId": id, "query": { "sql": sql } }],
            "timeRange": { "from": 1_793_232_000_000_i64, "to": 1_793_318_400_000_i64 },
            "variables": { "land": "Österreich" }
        });
        let (status, body) = self.send(Method::POST, "/query", Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["results"]["A"].clone()
    }

    async fn health(&self, id: &str) -> Value {
        self.send(Method::POST, &format!("/datasources/{id}/health"), Some(json!({}))).await.1
    }

    async fn schema(&self, id: &str) -> Value {
        self.send(Method::GET, &format!("/datasources/{id}/schema"), None).await.1
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

/// A throwaway RSA key generated for these tests only (tests/fixtures/warehouses).
fn test_key() -> String {
    let b64 = include_str!("fixtures/warehouses/test-key.pk8.b64");
    format!("-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n", b64.trim())
}

/// A write is refused on the server; the mock saw nothing new.
async fn refuses_writes(t: &T, id: &str, m: &Mock) {
    let before = m.seen().len();
    for sql in ["DELETE FROM bestellungen WHERE 1 = 1", "SELECT 1; DROP TABLE bestellungen"] {
        let r = t.query(id, sql).await;
        assert_eq!(r["error"]["code"], "query_rejected", "{sql}: {r}");
    }
    assert_eq!(m.seen().len(), before, "a write reached the warehouse");
}

#[tokio::test]
async fn bigquery_through_the_api() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/token", vec![reply("bigquery", "token", &base, 200)]);
    m.on("POST", "/bigquery/v2/projects/kalzit-test/jobs", vec![reply("bigquery", "dry-run", &base, 200)]);
    m.on(
        "POST",
        "/bigquery/v2/projects/kalzit-test/queries",
        vec![
            reply("bigquery", "select-one", &base, 200),
            reply("bigquery", "columns", &base, 200),
            reply("bigquery", "query-page2", &base, 200),
        ],
    );
    let t = T::new().await;
    let key = json!({ "type": "service_account", "client_email": "leser@kalzit-test.iam.gserviceaccount.com",
                      "private_key": test_key(), "token_uri": format!("{base}/token") })
    .to_string();
    let id = t
        .create(
            "bigquery",
            json!({ "project": "kalzit-test", "location": "EU", "url": base }),
            json!({ "serviceAccountKey": key }),
        )
        .await;
    let (_, one) = t.send(Method::GET, &format!("/datasources/{id}"), None).await;
    assert_eq!(one["secrets"]["serviceAccountKey"]["set"], true, "{one}");
    assert!(!one.to_string().contains("PRIVATE KEY"), "the key is never returned");
    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");
    let schema = t.schema(&id).await;
    assert_eq!(schema["tables"][0]["name"], "bestellungen", "{schema}");
    let r = t.query(&id, "SELECT * FROM verkauf.bestellungen WHERE land = $land AND $__timeFilter(ts)").await;
    assert_eq!(types(&r)[..3], ["time", "string", "int64"], "{r}");
    let notices = r["result"]["frame"]["meta"]["notices"].as_array().cloned().unwrap_or_default();
    assert!(notices.iter().any(|n| n["code"] == "bigquery.bytes_estimate"), "{r}");
    let run = m.seen_at("POST", "/bigquery/v2/projects/kalzit-test/queries");
    assert_eq!(run.last().unwrap().json()["queryParameters"][0]["parameterValue"]["value"], "Österreich");
    refuses_writes(&t, &id, &m).await;
    t.finish().await;
}

#[tokio::test]
async fn snowflake_through_the_api() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on(
        "POST",
        "/api/v2/statements",
        vec![
            reply("snowflake", "version", &base, 200),
            reply("snowflake", "columns", &base, 200),
            reply("snowflake", "result", &base, 200),
        ],
    );
    m.on(
        "GET",
        "/api/v2/statements/*",
        vec![mock::Reply::json(200, &mock::fixture("snowflake", "partition-1", &base))],
    );
    let t = T::new().await;
    let id = t
        .create(
            "snowflake",
            json!({ "account": "myorg-kalzit", "user": "kalzit_reader", "role": "KALZIT_READER", "url": base }),
            json!({ "privateKey": test_key() }),
        )
        .await;
    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");
    assert_eq!(t.schema(&id).await["tables"][1]["name"], "KUNDEN");
    let r = t.query(&id, "SELECT * FROM bestellungen WHERE land = $land").await;
    assert_eq!(r["result"]["frame"]["fields"][0]["values"].as_array().map(Vec::len), Some(3), "{r}");
    refuses_writes(&t, &id, &m).await;
    t.finish().await;
}

#[tokio::test]
async fn databricks_through_the_api() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on(
        "POST",
        "/api/2.0/sql/statements",
        vec![
            reply("databricks", "version", &base, 200),
            reply("databricks", "columns", &base, 200),
            reply("databricks", "succeeded", &base, 200),
        ],
    );
    m.on("GET", "/api/2.0/sql/statements/*", vec![reply("databricks", "chunk-1", &base, 200)]);
    let t = T::new().await;
    let id =
        t.create("databricks", json!({ "url": base, "warehouseId": "abc123" }), json!({ "token": "dapi-test" })).await;
    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");
    assert_eq!(t.schema(&id).await["tables"][0]["schema"], "verkauf");
    let r = t.query(&id, "SELECT * FROM bestellungen WHERE land = $land").await;
    assert_eq!(types(&r)[..3], ["time", "string", "int64"], "{r}");
    assert_eq!(r["result"]["frame"]["fields"][0]["values"].as_array().map(Vec::len), Some(3), "{r}");
    refuses_writes(&t, &id, &m).await;
    t.finish().await;
}

#[tokio::test]
async fn the_kinds_and_their_forms() {
    let t = T::new().await;
    let (_, kinds) = t.send(Method::GET, "/datasource-kinds", None).await;
    let kind = |name: &str| kinds["items"].as_array().unwrap().iter().find(|k| k["kind"] == name).cloned().unwrap();
    let secret = |k: &Value, field: &str| {
        k["settings"].as_array().unwrap().iter().find(|f| f["name"] == field).map(|f| f["secret"].clone())
    };
    assert_eq!(secret(&kind("bigquery"), "serviceAccountKey"), Some(json!(true)));
    assert_eq!(secret(&kind("snowflake"), "privateKey"), Some(json!(true)));
    assert_eq!(secret(&kind("databricks"), "token"), Some(json!(true)));
    assert_eq!(secret(&kind("databricks"), "clientSecret"), Some(json!(true)));
    // A key may not be sent as a setting, where it would be stored and returned in clear text.
    let (status, body) = t
        .send(
            Method::POST,
            "/datasources",
            Some(json!({ "name": "x", "kind": "snowflake",
                         "settings": { "account": "a", "user": "u", "privateKey": "geheim" } })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    t.finish().await;
}

// ---- real warehouses (nightly) ----

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn skip(what: &str) {
    eprintln!("{what} credentials are not set, test not run");
}

/// Health, schema, a query with parameters and the refusal of a write against a real warehouse.
async fn real_checks(t: &T, id: &str, query: &str) {
    let h = t.health(id).await;
    assert_eq!(h["ok"], true, "{h}");
    eprintln!("health: {h}");
    let schema = t.schema(id).await;
    assert_eq!(schema["kind"], "tables", "{schema}");
    let r = t.query(id, query).await;
    assert!(r["error"].is_null(), "{r}");
    let fields = &r["result"]["frame"]["fields"];
    assert_eq!(fields[0]["values"][0], "Österreich", "{r}");
    eprintln!("types: {:?}", types(&r));
    let r = t.query(id, "DELETE FROM kalzit_never WHERE 1 = 1").await;
    assert_eq!(r["error"]["code"], "query_rejected", "{r}");
}

#[tokio::test]
#[ignore = "needs BigQuery credentials (warehouses-nightly.yml)"]
async fn real_bigquery() {
    let (Some(project), Some(key)) = (env("KALZIT_TEST_BIGQUERY_PROJECT"), env("KALZIT_TEST_BIGQUERY_KEY")) else {
        return skip("BigQuery");
    };
    let t = T::new().await;
    let mut settings = json!({ "project": project, "maximumBytesBilled": 104_857_600 });
    if let Some(location) = env("KALZIT_TEST_BIGQUERY_LOCATION") {
        settings["location"] = json!(location);
    }
    let id = t.create("bigquery", settings, json!({ "serviceAccountKey": key })).await;
    real_checks(
        &t,
        &id,
        "SELECT $land AS land, 42 AS n, NUMERIC '12.50' AS betrag, CURRENT_TIMESTAMP() AS jetzt, \
         [1, 2] AS liste, STRUCT('Graz' AS stadt) AS adresse WHERE CURRENT_TIMESTAMP() > $__timeFrom",
    )
    .await;
    t.finish().await;
}

#[tokio::test]
#[ignore = "needs Snowflake credentials (warehouses-nightly.yml)"]
async fn real_snowflake() {
    let (Some(account), Some(user), Some(key)) = (
        env("KALZIT_TEST_SNOWFLAKE_ACCOUNT"),
        env("KALZIT_TEST_SNOWFLAKE_USER"),
        env("KALZIT_TEST_SNOWFLAKE_PRIVATE_KEY"),
    ) else {
        return skip("Snowflake");
    };
    let t = T::new().await;
    let mut settings = json!({ "account": account, "user": user });
    for (field, var) in [
        ("warehouse", "KALZIT_TEST_SNOWFLAKE_WAREHOUSE"),
        ("role", "KALZIT_TEST_SNOWFLAKE_ROLE"),
        ("database", "KALZIT_TEST_SNOWFLAKE_DATABASE"),
    ] {
        if let Some(v) = env(var) {
            settings[field] = json!(v);
        }
    }
    let id = t.create("snowflake", settings, json!({ "privateKey": key })).await;
    real_checks(
        &t,
        &id,
        "SELECT $land AS land, 42 AS n, 12.50::NUMBER(10, 2) AS betrag, CURRENT_TIMESTAMP() AS jetzt, \
         PARSE_JSON('{\"a\": 1}') AS doc WHERE CURRENT_TIMESTAMP() > $__timeFrom",
    )
    .await;
    t.finish().await;
}

#[tokio::test]
#[ignore = "needs Databricks credentials (warehouses-nightly.yml)"]
async fn real_databricks() {
    let (Some(url), Some(warehouse)) = (env("KALZIT_TEST_DATABRICKS_URL"), env("KALZIT_TEST_DATABRICKS_WAREHOUSE_ID"))
    else {
        return skip("Databricks");
    };
    let (settings, secrets) = match (
        env("KALZIT_TEST_DATABRICKS_TOKEN"),
        env("KALZIT_TEST_DATABRICKS_CLIENT_ID"),
        env("KALZIT_TEST_DATABRICKS_CLIENT_SECRET"),
    ) {
        (Some(token), _, _) => (json!({ "url": url, "warehouseId": warehouse }), json!({ "token": token })),
        (None, Some(client), Some(secret)) => (
            json!({ "url": url, "warehouseId": warehouse, "authType": "oauth", "clientId": client }),
            json!({ "clientSecret": secret }),
        ),
        _ => return skip("Databricks"),
    };
    let t = T::new().await;
    let id = t.create("databricks", settings, secrets).await;
    real_checks(
        &t,
        &id,
        "SELECT $land AS land, 42 AS n, CAST(12.50 AS DECIMAL(10, 2)) AS betrag, current_timestamp() AS jetzt, \
         array(1, 2) AS liste, named_struct('stadt', 'Graz') AS adresse WHERE current_timestamp() > $__timeFrom",
    )
    .await;
    t.finish().await;
}
