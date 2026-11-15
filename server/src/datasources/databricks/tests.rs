//! Databricks SQL against recorded Statement Execution API answers
//! (tests/fixtures/warehouses/databricks.json) served by the warehouse mock: tokens and OAuth,
//! named parameters, waiting, chunks, types, the schema and refusals.

use serde_json::{Value, json};

use super::*;
use crate::datasources::warehouse::mock::{Mock, reply};
use crate::datasources::warehouse::test_support::{connection, req};

const KIND: &str = "databricks";
const STATEMENT: &str = "/api/2.0/sql/statements/01ef9a2b-0000-1c3d-0000-0000kalzit01";

async fn conn(base: &str, oauth: bool) -> Connection {
    let mut settings = json!({ "url": base, "warehouseId": "abc123def456", "catalog": "main", "schema": "verkauf" });
    if oauth {
        settings["authType"] = json!("oauth");
        settings["clientId"] = json!("kalzit-reader-sp");
        connection(settings, &[("clientSecret", "dose-geheim")]).await
    } else {
        connection(settings, &[("token", "dapi-kalzit-test")]).await
    }
}

#[tokio::test]
async fn queries_wait_and_read_every_chunk() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/api/2.0/sql/statements", vec![reply(KIND, "pending", &base, 200)]);
    m.on("GET", STATEMENT, vec![reply(KIND, "succeeded", &base, 200)]);
    m.on("GET", &format!("{STATEMENT}/result/chunks/1"), vec![reply(KIND, "chunk-1", &base, 200)]);
    let c = conn(&base, false).await;
    let r = Databricks
        .query(&c, req("SELECT * FROM bestellungen WHERE $__timeFilter(am) AND land = $land AND n IN ($ids)", 10))
        .await
        .unwrap();
    let QueryResult::Frame { frame } = r else { panic!("a frame") };
    let f = frame.fields();
    let types: Vec<FieldType> = f.iter().map(|f| f.field_type).collect();
    assert_eq!(
        types,
        [
            FieldType::Time,
            FieldType::String,
            FieldType::Int64,
            FieldType::Decimal,
            FieldType::Number,
            FieldType::Bool,
            FieldType::Date,
            FieldType::Json,
            FieldType::Json
        ]
    );
    assert_eq!(f[0].values, [json!(1_793_275_200_250_i64), Value::Null, json!(1_793_278_800_000_i64)]);
    assert_eq!(f[2].values[0], "9007199254740993");
    assert_eq!(f[3].values, [json!("12.50"), Value::Null, json!("0.10")]);
    assert_eq!(f[6].values[1], Value::Null);
    assert_eq!(f[7].values, [json!(["a", "b"]), json!([]), json!(["c"])]);
    assert_eq!(f[8].values[0], json!({ "stadt": "Graz", "plz": 8010 }));
    assert_eq!(
        frame.meta().unwrap().executed_query.as_deref(),
        Some(
            "SELECT * FROM bestellungen WHERE (am BETWEEN timestamp_millis(:p1) AND timestamp_millis(:p2)) AND land = :p3 AND n IN (:p4, :p5)"
        )
    );
    let sent = &m.seen_at("POST", "/api/2.0/sql/statements")[0];
    assert_eq!(sent.header("authorization").as_deref(), Some("Bearer dapi-kalzit-test"));
    let body = sent.json();
    assert_eq!(body["warehouse_id"], "abc123def456");
    assert_eq!(body["catalog"], "main");
    assert_eq!(body["schema"], "verkauf");
    assert_eq!(body["row_limit"], 11);
    assert_eq!(body["disposition"], "INLINE");
    assert_eq!(body["format"], "JSON_ARRAY");
    assert_eq!(body["parameters"][0], json!({ "name": "p1", "type": "BIGINT", "value": "1793232000000" }));
    assert_eq!(body["parameters"][2], json!({ "name": "p3", "type": "STRING", "value": "Öster'reich" }));
    assert!(m.seen_at("POST", &format!("{STATEMENT}/cancel")).is_empty());
}

#[tokio::test]
async fn oauth_machine_to_machine_gets_a_token_once() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/oidc/v1/token", vec![reply(KIND, "oauth-token", &base, 200)]);
    m.on(
        "POST",
        "/api/2.0/sql/statements",
        vec![reply(KIND, "version", &base, 200), reply(KIND, "columns", &base, 200)],
    );
    let c = conn(&base, true).await;
    let h = Databricks.health(&c).await;
    assert!(h.ok, "{:?}", h.detail);
    assert_eq!(h.detail.params["version"], "3.5.2");
    let SourceSchema::Tables { tables } = Databricks.schema(&c).await.unwrap() else { panic!("tables") };
    assert_eq!(tables.len(), 2);
    let token = m.seen_at("POST", "/oidc/v1/token");
    assert_eq!(token.len(), 1, "the token is kept");
    assert!(token[0].text().contains("grant_type=client_credentials"));
    let basic = token[0].header("authorization").unwrap();
    assert!(basic.starts_with("Basic "), "{basic}");
    for s in m.seen_at("POST", "/api/2.0/sql/statements") {
        assert_eq!(s.header("authorization").as_deref(), Some("Bearer eyJ-kalzit-m2m-token"));
    }

    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/oidc/v1/token", vec![reply(KIND, "oauth-refused", &base, 401)]);
    let h = Databricks.health(&conn(&base, true).await).await;
    assert_eq!(h.detail.reason, "source.auth_failed");
    assert!(!h.detail.message.contains("dose-geheim"));
}

#[tokio::test]
async fn writes_files_and_secrets_are_refused_before_anything_is_sent() {
    let m = Mock::default();
    let addr = m.serve().await;
    let c = conn(&format!("http://{addr}"), false).await;
    for statement in [
        "INSERT INTO t VALUES (1)",
        "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE",
        "SELECT 1; DROP TABLE t",
        "SELECT * FROM parquet.`/Volumes/main/x/daten`",
        "SELECT * FROM delta.`s3://bucket/tabelle`",
        "SELECT * FROM read_files('s3://bucket/x.csv')",
        "SELECT secret('scope', 'key')",
        "SELECT http_request(conn => 'c', method => 'GET', path => '/')",
        "SELECT ai_query('endpoint', 'Hallo')",
        "SELECT * FROM t WHERE a = ?",
        "SELECT r'a\\' FROM t",
        "SELECT `a\\b` FROM t",
    ] {
        let e = Databricks.query(&c, req(statement, 10)).await.unwrap_err();
        assert_eq!(e.code(), "query_rejected", "{statement}: {:?}", e.detail());
    }
    assert!(m.seen().is_empty());
}

#[tokio::test]
async fn failures_and_refused_tokens() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/api/2.0/sql/statements", vec![reply(KIND, "failed", &base, 200)]);
    let e = Databricks.query(&conn(&base, false).await, req("SELECT * FROM fehlt", 10)).await.unwrap_err();
    assert_eq!(e.detail().reason, "databricks.error");
    assert_eq!(e.detail().params["code"], "BAD_REQUEST");

    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/api/2.0/sql/statements", vec![reply(KIND, "invalid-token", &base, 403)]);
    let h = Databricks.health(&conn(&base, false).await).await;
    assert_eq!(h.detail.reason, "source.auth_failed");

    let h = Databricks.health(&connection(json!({ "url": base, "warehouseId": "a1" }), &[]).await).await;
    assert_eq!(h.detail.reason, "databricks.credentials_missing");
}

#[tokio::test]
async fn a_dropped_query_cancels_its_statement() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/api/2.0/sql/statements", vec![reply(KIND, "pending", &base, 200)]);
    m.on("GET", STATEMENT, vec![reply(KIND, "pending", &base, 200)]);
    m.on("POST", &format!("{STATEMENT}/cancel"), vec![reply(KIND, "cancel", &base, 200)]);
    let c = conn(&base, false).await;
    assert!(tokio::time::timeout(Duration::from_millis(500), Databricks.query(&c, req("SELECT 1", 10))).await.is_err());
    for _ in 0..50 {
        if !m.seen_at("POST", &format!("{STATEMENT}/cancel")).is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the statement was not cancelled");
}

#[test]
fn settings_and_parameters() {
    let field = |s: Value| Databricks.check_settings(&s).unwrap_err().field;
    assert_eq!(field(json!({ "url": "ftp://x", "warehouseId": "a" })), "url");
    assert_eq!(field(json!({ "url": "https://x.cloud.databricks.com", "warehouseId": "a/b" })), "warehouseId");
    assert_eq!(
        field(json!({ "url": "https://x.cloud.databricks.com", "warehouseId": "a", "authType": "oauth" })),
        "clientId"
    );
    Databricks
        .check_settings(&json!({ "url": "https://adb-1.2.azuredatabricks.net", "warehouseId": "abc123" }))
        .unwrap();
    assert_eq!(parameter(1, &Bind::Null), json!({ "name": "p1", "type": "STRING" }));
    assert_eq!(parameter(2, &Bind::Interval(1_000)), json!({ "name": "p2", "type": "STRING", "value": "1 second" }));
}
