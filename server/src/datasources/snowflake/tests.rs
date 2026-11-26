//! Snowflake against recorded SQL API answers (tests/fixtures/warehouses/snowflake.json) served
//! by the warehouse mock: key-pair JWTs, bindings, waiting, compressed partitions, types, the
//! schema and refusals.

use std::io::Write as _;

use base64::Engine as _;
use serde_json::{Value, json};

use super::*;
use crate::datasources::warehouse::mock::{Mock, Reply, fixture, reply};
use crate::datasources::warehouse::test_support::{FINGERPRINT, connection, pkcs8_pem, req};

const KIND: &str = "snowflake";
const HANDLE: &str = "/api/v2/statements/01b8a1c2-0000-4a5b-0000-00012345abcd";

fn gzip(text: &str) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(text.as_bytes()).unwrap();
    e.finish().unwrap()
}

async fn conn(base: &str) -> Connection {
    let settings = json!({ "account": "myorg-kalzit_test", "user": "kalzit_reader", "warehouse": "LESEN_XS",
                           "role": "KALZIT_READER", "database": "VERKAUF", "schema": "PUBLIC", "url": base });
    connection(settings, &[("privateKey", &pkcs8_pem())]).await
}

#[tokio::test]
async fn queries_wait_and_read_every_partition() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/api/v2/statements", vec![reply(KIND, "running", &base, 202)]);
    m.on(
        "GET",
        HANDLE,
        vec![reply(KIND, "result", &base, 200), Reply::gzip_json(200, gzip(&fixture(KIND, "partition-1", &base)))],
    );
    let c = conn(&base).await;
    let r = Snowflake
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
            FieldType::Time,
            FieldType::String,
            FieldType::Int64,
            FieldType::Decimal,
            FieldType::Number,
            FieldType::Bool,
            FieldType::Date,
            FieldType::String,
            FieldType::Json
        ]
    );
    assert_eq!(f[0].values, [json!(1_793_275_200_250_i64), Value::Null, json!(1_793_278_800_000_i64)]);
    assert_eq!(f[1].values[0], json!(1_793_275_200_000_i64), "the offset does not move the instant");
    assert_eq!(f[3].values[0], "9007199254740993");
    assert_eq!(f[4].values, [json!("12.50"), Value::Null, json!("0.10")]);
    assert_eq!(f[5].values[1], Value::Null);
    assert_eq!(f[6].values, [json!(true), json!(false), json!(true)]);
    assert_eq!(f[7].values[0], json!(1_793_232_000_000_i64));
    assert_eq!(f[8].values[0], "12:30:00.250");
    assert_eq!(f[9].values, [json!({ "a": 1 }), Value::Null, json!([1, 2])]);
    assert_eq!(
        frame.meta().unwrap().executed_query.as_deref(),
        Some(
            "SELECT * FROM bestellungen WHERE (am BETWEEN TO_TIMESTAMP_TZ(?, 3) AND TO_TIMESTAMP_TZ(?, 3)) AND land = ? AND n IN (?, ?)"
        )
    );

    let sent = &m.seen_at("POST", "/api/v2/statements")[0];
    assert_eq!(sent.header("x-snowflake-authorization-token-type").as_deref(), Some("KEYPAIR_JWT"));
    let jwt = sent.header("authorization").unwrap();
    let claims = jwt.trim_start_matches("Bearer ").split('.').nth(1).unwrap();
    let claims: Value =
        serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(claims).unwrap()).unwrap();
    assert_eq!(claims["sub"], "MYORG-KALZIT_TEST.KALZIT_READER");
    assert_eq!(claims["iss"], format!("MYORG-KALZIT_TEST.KALZIT_READER.{FINGERPRINT}"));
    let body = sent.json();
    assert_eq!(body["warehouse"], "LESEN_XS");
    assert_eq!(body["role"], "KALZIT_READER");
    assert_eq!(body["timeout"], 20);
    assert_eq!(body["parameters"]["timezone"], "UTC");
    assert_eq!(body["parameters"]["multi_statement_count"], "1");
    assert_eq!(body["parameters"]["rows_per_resultset"], "11");
    assert_eq!(body["bindings"]["1"], json!({ "type": "FIXED", "value": "1793232000000" }));
    assert_eq!(body["bindings"]["3"], json!({ "type": "TEXT", "value": "Öster'reich" }));
    assert_eq!(body["bindings"]["4"], json!({ "type": "FIXED", "value": "1" }));
    let gets = m.seen_at("GET", HANDLE);
    assert_eq!(gets.len(), 2);
    assert!(gets[1].path.ends_with("?partition=1"), "{}", gets[1].path);
    assert!(m.seen_at("POST", &format!("{HANDLE}/cancel")).is_empty());
}

#[tokio::test]
async fn the_row_limit_skips_further_partitions() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/api/v2/statements", vec![reply(KIND, "result", &base, 200)]);
    let c = conn(&base).await;
    let r = Snowflake.query(&c, req("SELECT * FROM bestellungen", 1)).await.unwrap();
    let QueryResult::Frame { frame } = r else { panic!("a frame") };
    assert_eq!(frame.rows(), 1);
    assert!(frame.meta().unwrap().rows_truncated);
    assert!(m.seen_at("GET", "/api/v2/statements/").is_empty());
}

#[tokio::test]
async fn writes_stages_and_system_functions_are_refused_before_anything_is_sent() {
    let m = Mock::default();
    let addr = m.serve().await;
    let c = conn(&format!("http://{addr}")).await;
    for statement in [
        "INSERT INTO t VALUES (1)",
        "UPDATE t SET a = 1",
        "SELECT 1; DROP TABLE t",
        "CALL p()",
        "EXECUTE IMMEDIATE 'DROP TABLE t'",
        "SELECT * FROM @meine_stage",
        "SELECT $1 FROM t",
        "SELECT SYSTEM$CANCEL_ALL_QUERIES(1)",
        "SELECT $$x$$",
        "SELECT GET_PRESIGNED_URL(@s, 'a.csv')",
        "SELECT 1 # Kommentar",
        "SELECT * FROM t WHERE a = ?",
        "COPY INTO t FROM @s",
    ] {
        let e = Snowflake.query(&c, req(statement, 10)).await.unwrap_err();
        assert_eq!(e.code(), "query_rejected", "{statement}: {:?}", e.detail());
    }
    assert!(m.seen().is_empty());
    // Snowflake's own syntax for reads passes.
    for statement in [
        "SELECT v:adresse.stadt::string AS stadt FROM t // Kommentar\nLIMIT 10",
        "SELECT * FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) = 1",
        "SELECT 'a\\'b' AS x, \"Gemischt Groß\" FROM t",
    ] {
        let vars = std::collections::BTreeMap::new();
        let ctx = sql::Context {
            range: crate::shapes::TimeRange { from: 0, to: 1 },
            interval_ms: 1000,
            variables: &vars,
            identifiers: None,
            identifier_variables: None,
            filters: &[],
            column_types: None,
        };
        sql::prepare(statement, Engine::Snowflake, &ctx).unwrap_or_else(|e| panic!("{statement}: {e}"));
    }
}

#[tokio::test]
async fn errors_and_refused_keys() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/api/v2/statements", vec![reply(KIND, "error-compilation", &base, 422)]);
    let c = conn(&base).await;
    let e = Snowflake.query(&c, req("SELECT * FROM fehlt", 10)).await.unwrap_err();
    assert_eq!(e.detail().reason, "snowflake.error");
    assert_eq!(e.detail().params["code"], "002003");

    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/api/v2/statements", vec![reply(KIND, "error-jwt", &base, 401)]);
    let h = Snowflake.health(&conn(&base).await).await;
    assert_eq!(h.detail.reason, "source.auth_failed");

    let settings = json!({ "account": "a", "user": "u", "url": base });
    let c = connection(
        settings.clone(),
        &[("privateKey", "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAA\n-----END ENCRYPTED PRIVATE KEY-----")],
    )
    .await;
    let h = Snowflake.health(&c).await;
    assert_eq!(h.detail.reason, "snowflake.private_key_invalid");
    let h = Snowflake.health(&connection(settings, &[]).await).await;
    assert_eq!(h.detail.reason, "snowflake.private_key_missing");
}

#[tokio::test]
async fn health_and_schema() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/api/v2/statements", vec![reply(KIND, "version", &base, 200), reply(KIND, "columns", &base, 200)]);
    let c = conn(&base).await;
    let h = Snowflake.health(&c).await;
    assert!(h.ok, "{:?}", h.detail);
    assert_eq!(h.detail.params["version"], "9.38.2");
    let SourceSchema::Tables { tables } = Snowflake.schema(&c).await.unwrap() else { panic!("tables") };
    assert_eq!(tables.len(), 2);
    assert_eq!((tables[0].schema.as_deref(), tables[0].name.as_str()), (Some("PUBLIC"), "BESTELLUNGEN"));
    // One JWT for both requests.
    let auth: Vec<_> = m.seen().iter().map(|s| s.header("authorization")).collect();
    assert_eq!(auth[0], auth[1]);
}

#[tokio::test]
async fn a_dropped_query_cancels_its_statement() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/api/v2/statements", vec![reply(KIND, "running", &base, 202)]);
    m.on("GET", HANDLE, vec![reply(KIND, "running", &base, 202)]);
    m.on("POST", &format!("{HANDLE}/cancel"), vec![reply(KIND, "cancel", &base, 200)]);
    let c = conn(&base).await;
    assert!(tokio::time::timeout(Duration::from_millis(500), Snowflake.query(&c, req("SELECT 1", 10))).await.is_err());
    for _ in 0..50 {
        if !m.seen_at("POST", &format!("{HANDLE}/cancel")).is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the statement was not cancelled");
}

#[test]
fn accounts_and_bindings() {
    assert_eq!(jwt_account("xy12345.eu-central-1.aws"), "XY12345");
    assert_eq!(jwt_account("myorg-my_account"), "MYORG-MY_ACCOUNT");
    assert_eq!(default_url("myorg-my_account"), "https://myorg-my-account.snowflakecomputing.com");
    assert_eq!(default_url("xy12345.eu-central-1"), "https://xy12345.eu-central-1.snowflakecomputing.com");
    assert!(Snowflake.check_settings(&json!({ "account": "a/b", "user": "u" })).is_err());
    Snowflake.check_settings(&json!({ "account": "myorg-acct", "user": "u", "role": "R" })).unwrap();
    assert_eq!(binding(&Bind::Null), json!({ "type": "TEXT", "value": null }));
    assert_eq!(binding(&Bind::Interval(300_000)), json!({ "type": "TEXT", "value": "5 minutes" }));
    assert_eq!(binding(&Bind::Bool(false)), json!({ "type": "BOOLEAN", "value": "false" }));
}
