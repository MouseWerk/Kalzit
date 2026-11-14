//! BigQuery against recorded API answers (tests/fixtures/warehouses/bigquery.json) served by the
//! warehouse mock: sign-in, the dry run, parameters, paging, types, the schema and refusals.

use serde_json::{Value, json};

use super::*;
use crate::datasources::warehouse::mock::{Mock, reply};
use crate::datasources::warehouse::test_support::{connection, connection_with_files, pkcs8_pem, req};

const KIND: &str = "bigquery";

fn key_file(base: &str) -> String {
    json!({
        "type": "service_account",
        "project_id": "kalzit-test",
        "private_key_id": "0123abcd",
        "private_key": pkcs8_pem(),
        "client_email": "kalzit-reader@kalzit-test.iam.gserviceaccount.com",
        "token_uri": format!("{base}/token"),
    })
    .to_string()
}

/// A mock with sign-in, the dry run and a query that runs once more before it is complete.
async fn mock() -> (Mock, String) {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/token", vec![reply(KIND, "token", &base, 200)]);
    m.on("POST", "/bigquery/v2/projects/kalzit-test/jobs", vec![reply(KIND, "dry-run", &base, 200)]);
    m.on("POST", "/bigquery/v2/projects/kalzit-test/queries", vec![reply(KIND, "query-running", &base, 200)]);
    m.on(
        "GET",
        "/bigquery/v2/projects/kalzit-test/queries/job_Kalzit_0001",
        vec![reply(KIND, "query-page1", &base, 200), reply(KIND, "query-page2", &base, 200)],
    );
    m.on("POST", "/bigquery/v2/projects/kalzit-test/jobs/*", vec![reply(KIND, "cancel", &base, 200)]);
    (m, base)
}

async fn conn(base: &str, extra: Value) -> Connection {
    let mut settings = json!({ "project": "kalzit-test", "location": "EU", "dataset": "verkauf", "url": base });
    for (k, v) in extra.as_object().into_iter().flatten() {
        settings[k] = v.clone();
    }
    connection(settings, &[("serviceAccountKey", &key_file(base))]).await
}

#[tokio::test]
async fn queries_run_after_a_dry_run_with_parameters_and_pages() {
    let (m, base) = mock().await;
    let c = conn(&base, json!({})).await;
    let r = BigQuery
        .query(&c, req("SELECT * FROM bestellungen WHERE $__timeFilter(ts) AND land = $land AND n IN ($ids)", 10))
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
            FieldType::Time,
            FieldType::Json,
            FieldType::Json,
            FieldType::Json
        ]
    );
    assert_eq!(f[0].values, [json!(1_793_275_200_250_i64), Value::Null, json!(1_793_278_800_000_i64)]);
    assert_eq!(f[1].values[0], "Österreich");
    assert_eq!(f[2].values[0], "9007199254740993");
    assert_eq!(f[3].values, [json!("12.5"), Value::Null, json!("0.10")]);
    assert_eq!(f[4].values[1], Value::Null, "NaN has no JSON number");
    assert_eq!(f[6].values[0], json!(1_793_232_000_000_i64));
    assert_eq!(f[7].values[2], json!(1_793_348_100_500_i64));
    assert_eq!(f[8].values, [json!(["a", "b"]), json!([]), json!(["c"])]);
    assert_eq!(f[9].values[0], json!({ "stadt": "Graz", "plz": "8010" }));
    assert_eq!(f[10].values, [json!({ "a": 1 }), Value::Null, json!([1, 2])]);
    assert_eq!(
        frame.meta().unwrap().executed_query.as_deref(),
        Some(
            "SELECT * FROM bestellungen WHERE (ts BETWEEN TIMESTAMP_MILLIS(?) AND TIMESTAMP_MILLIS(?)) AND land = ? AND n IN (?, ?)"
        )
    );
    let notices = &frame.meta().unwrap().notices;
    assert!(notices.iter().any(|n| n.code == "bigquery.bytes_estimate"), "{notices:?}");

    // Signed in with a JWT for the read-only scope, sent as the bearer token.
    let token = &m.seen_at("POST", "/token")[0];
    assert!(token.text().contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer"));
    let dry = &m.seen_at("POST", "/bigquery/v2/projects/kalzit-test/jobs")[0];
    assert_eq!(dry.header("authorization").as_deref(), Some("Bearer ya29.kalzit-test-token"));
    let dry = dry.json();
    assert_eq!(dry["configuration"]["dryRun"], true);
    assert_eq!(dry["jobReference"]["location"], "EU");
    let run = m.seen_at("POST", "/bigquery/v2/projects/kalzit-test/queries")[0].json();
    assert_eq!(run["useLegacySql"], false);
    assert_eq!(run["parameterMode"], "POSITIONAL");
    assert_eq!(run["defaultDataset"], json!({ "projectId": "kalzit-test", "datasetId": "verkauf" }));
    assert_eq!(run["jobTimeoutMs"], "20000");
    let params = run["queryParameters"].as_array().unwrap();
    assert_eq!(params.len(), 5);
    assert_eq!(
        params[0],
        json!({ "parameterType": { "type": "INT64" }, "parameterValue": { "value": "1793232000000" } })
    );
    assert_eq!(
        params[2],
        json!({ "parameterType": { "type": "STRING" }, "parameterValue": { "value": "Öster'reich" } })
    );
    assert_eq!(params[3]["parameterType"]["type"], "INT64");
    // The job was waited for, then its second page read with the page token; nothing cancelled.
    let pages = m.seen_at("GET", "/bigquery/v2/projects/kalzit-test/queries/job_Kalzit_0001");
    assert_eq!(pages.len(), 2);
    assert!(pages[1].path.contains("pageToken=SEITE-2"), "{}", pages[1].path);
    assert!(pages[1].path.contains("location=EU"));
    assert!(m.seen_at("POST", "/bigquery/v2/projects/kalzit-test/jobs/").is_empty());
}

#[tokio::test]
async fn the_row_limit_stops_paging() {
    let (m, base) = mock().await;
    let c = conn(&base, json!({})).await;
    let r = BigQuery.query(&c, req("SELECT * FROM bestellungen", 1)).await.unwrap();
    let QueryResult::Frame { frame } = r else { panic!("a frame") };
    assert_eq!(frame.fields()[0].values.len(), 1);
    assert!(frame.meta().unwrap().rows_truncated);
    let run = m.seen_at("POST", "/bigquery/v2/projects/kalzit-test/queries")[0].json();
    assert_eq!(run["maxResults"], 2);
    assert_eq!(m.seen_at("GET", "/bigquery/v2/projects/kalzit-test/queries/").len(), 1, "no second page");
}

#[tokio::test]
async fn writes_are_refused_before_anything_is_sent() {
    let (m, base) = mock().await;
    let c = conn(&base, json!({})).await;
    for statement in [
        "INSERT INTO t VALUES (1)",
        "DELETE FROM t WHERE true",
        "SELECT 1; DROP TABLE t",
        "CREATE TABLE x AS SELECT 1",
        "EXPORT DATA OPTIONS (uri = 'gs://b/*') AS SELECT 1",
        "SELECT * FROM EXTERNAL_QUERY('c', 'DELETE FROM t')",
        "SELECT ML.GENERATE_TEXT(MODEL m, (SELECT 'x' AS prompt))",
        "SELECT * FROM t WHERE a = @name",
        "SELECT * FROM t WHERE a = ?",
    ] {
        let e = BigQuery.query(&c, req(statement, 10)).await.unwrap_err();
        assert_eq!(e.code(), "query_rejected", "{statement}: {:?}", e.detail());
    }
    assert!(m.seen().is_empty(), "nothing reached BigQuery");
}

#[tokio::test]
async fn the_dry_run_refuses_what_bigquery_does_not_call_a_select() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/token", vec![reply(KIND, "token", &base, 200)]);
    m.on("POST", "/bigquery/v2/projects/kalzit-test/jobs", vec![reply(KIND, "dry-run-script", &base, 200)]);
    let c = conn(&base, json!({})).await;
    let e = BigQuery.query(&c, req("SELECT 1", 10)).await.unwrap_err();
    assert_eq!(e.detail().reason, "bigquery.not_select");
    assert_eq!(e.detail().params["type"], "SCRIPT");
    assert!(m.seen_at("POST", "/bigquery/v2/projects/kalzit-test/queries").is_empty(), "the query never ran");
}

#[tokio::test]
async fn maximum_bytes_billed_refuses_before_the_run_and_is_sent_along() {
    let (m, base) = mock().await;
    let c = conn(&base, json!({ "maximumBytesBilled": 1000 })).await;
    let e = BigQuery.query(&c, req("SELECT 1", 10)).await.unwrap_err();
    assert_eq!(e.detail().reason, "bigquery.bytes_limit");
    assert_eq!(e.detail().params["bytes"], "1048576");
    assert!(m.seen_at("POST", "/bigquery/v2/projects/kalzit-test/queries").is_empty());

    let c = conn(&base, json!({ "maximumBytesBilled": 2_000_000 })).await;
    BigQuery.query(&c, req("SELECT 1", 10)).await.unwrap();
    let run = m.seen_at("POST", "/bigquery/v2/projects/kalzit-test/queries")[0].json();
    assert_eq!(run["maximumBytesBilled"], "2000000");
}

#[tokio::test]
async fn errors_keep_their_reason() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/token", vec![reply(KIND, "token", &base, 200)]);
    m.on("POST", "/bigquery/v2/projects/kalzit-test/jobs", vec![reply(KIND, "error-not-found", &base, 404)]);
    let c = conn(&base, json!({})).await;
    let e = BigQuery.query(&c, req("SELECT * FROM fehlt", 10)).await.unwrap_err();
    assert_eq!(e.detail().reason, "bigquery.error");
    assert_eq!(e.detail().params["code"], "notFound");

    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/token", vec![reply(KIND, "token", &base, 200)]);
    m.on("POST", "/bigquery/v2/projects/kalzit-test/jobs", vec![reply(KIND, "dry-run", &base, 200)]);
    m.on("POST", "/bigquery/v2/projects/kalzit-test/queries", vec![reply(KIND, "error-bytes-limit", &base, 400)]);
    let c = conn(&base, json!({})).await;
    let e = BigQuery.query(&c, req("SELECT 1", 10)).await.unwrap_err();
    assert_eq!(e.detail().reason, "bigquery.bytes_limit");

    // A refused key is a refused login, and a refused token is asked for again once.
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/token", vec![reply(KIND, "token-refused", &base, 400)]);
    let c = conn(&base, json!({})).await;
    let h = BigQuery.health(&c).await;
    assert!(!h.ok);
    assert_eq!(h.detail.reason, "source.auth_failed");

    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/token", vec![reply(KIND, "token", &base, 200)]);
    m.on("POST", "/bigquery/v2/projects/kalzit-test/queries", vec![reply(KIND, "error-unauthenticated", &base, 401)]);
    let c = conn(&base, json!({})).await;
    let h = BigQuery.health(&c).await;
    assert_eq!(h.detail.reason, "source.auth_failed");
    assert_eq!(m.seen_at("POST", "/token").len(), 2, "the token was fetched again once");
}

#[tokio::test]
async fn health_and_schema() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/token", vec![reply(KIND, "token", &base, 200)]);
    m.on(
        "POST",
        "/bigquery/v2/projects/kalzit-test/queries",
        vec![reply(KIND, "select-one", &base, 200), reply(KIND, "columns", &base, 200)],
    );
    let c = conn(&base, json!({})).await;
    let h = BigQuery.health(&c).await;
    assert!(h.ok, "{:?}", h.detail);
    assert_eq!(h.detail.params["engine"], "BigQuery");
    let SourceSchema::Tables { tables } = BigQuery.schema(&c).await.unwrap() else { panic!("tables") };
    assert_eq!(tables.len(), 2);
    assert_eq!(tables[0].schema.as_deref(), Some("verkauf"));
    assert_eq!(tables[0].name, "bestellungen");
    assert_eq!(tables[0].columns.len(), 2);
    let sql_text = m.seen_at("POST", "/bigquery/v2/projects/kalzit-test/queries")[1].json()["query"].clone();
    assert!(sql_text.as_str().unwrap().contains("`kalzit-test`.`verkauf`.INFORMATION_SCHEMA.COLUMNS"), "{sql_text}");
}

#[tokio::test]
async fn a_dropped_query_cancels_its_job() {
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/token", vec![reply(KIND, "token", &base, 200)]);
    m.on("POST", "/bigquery/v2/projects/kalzit-test/jobs", vec![reply(KIND, "dry-run", &base, 200)]);
    m.on("POST", "/bigquery/v2/projects/kalzit-test/queries", vec![reply(KIND, "query-running", &base, 200)]);
    // The job never completes.
    m.on(
        "GET",
        "/bigquery/v2/projects/kalzit-test/queries/job_Kalzit_0001",
        vec![reply(KIND, "query-running", &base, 200)],
    );
    m.on("POST", "/bigquery/v2/projects/kalzit-test/jobs/*", vec![reply(KIND, "cancel", &base, 200)]);
    let c = conn(&base, json!({})).await;
    let run = BigQuery.query(&c, req("SELECT 1", 10));
    assert!(tokio::time::timeout(std::time::Duration::from_millis(500), run).await.is_err());
    for _ in 0..50 {
        if !m.seen_at("POST", "/bigquery/v2/projects/kalzit-test/jobs/job_Kalzit_0001/cancel").is_empty() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("the job was not cancelled: {:?}", m.seen().iter().map(|s| &s.path).collect::<Vec<_>>());
}

#[tokio::test]
async fn workload_identity_exchanges_a_token_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("token.txt");
    std::fs::write(&file, "eyJ-subject-token\n").unwrap();
    let m = Mock::default();
    let addr = m.serve().await;
    let base = format!("http://{addr}");
    m.on("POST", "/sts", vec![reply(KIND, "sts-token", &base, 200)]);
    m.on("POST", "/impersonate", vec![reply(KIND, "impersonated-token", &base, 200)]);
    m.on("POST", "/bigquery/v2/projects/kalzit-test/queries", vec![reply(KIND, "select-one", &base, 200)]);
    let config = json!({
        "type": "external_account",
        "audience": "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/k",
        "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
        "token_url": format!("{base}/sts"),
        "service_account_impersonation_url": format!("{base}/impersonate"),
        "credential_source": { "file": file.to_string_lossy() },
    })
    .to_string();
    let settings =
        json!({ "project": "kalzit-test", "url": base, "authType": "workloadIdentity", "credentialConfig": config });
    BigQuery.check_settings(&settings).unwrap();
    let dirs = [dir.path().to_string_lossy().to_string()];
    let c = connection_with_files(settings.clone(), &[], &dirs).await;
    let h = BigQuery.health(&c).await;
    assert!(h.ok, "{:?}", h.detail);
    assert!(m.seen_at("POST", "/sts")[0].text().contains("subject_token=eyJ-subject-token"));
    assert_eq!(
        m.seen_at("POST", "/impersonate")[0].header("authorization").as_deref(),
        Some("Bearer federated-kalzit-test")
    );
    assert_eq!(
        m.seen_at("POST", "/bigquery/v2/projects/kalzit-test/queries")[0].header("authorization").as_deref(),
        Some("Bearer ya29.impersonated-kalzit-test")
    );
    // A token file outside the allowed directories is refused as a target.
    let c = connection(settings, &[]).await;
    let h = BigQuery.health(&c).await;
    assert_eq!(h.code, Some("datasource_target_blocked"), "{:?}", h.detail);
}

#[test]
fn settings_are_checked() {
    let ok = json!({ "project": "kalzit-test", "location": "europe-west3", "dataset": "verkauf_2026" });
    BigQuery.check_settings(&ok).unwrap();
    let field = |s: Value| BigQuery.check_settings(&s).unwrap_err().field;
    assert_eq!(field(json!({ "project": "Kalzit Test" })), "project");
    assert_eq!(field(json!({ "project": "p", "location": "eu/1" })), "location");
    assert_eq!(field(json!({ "project": "p", "dataset": "a.b" })), "dataset");
    assert_eq!(field(json!({ "project": "p", "authType": "workloadIdentity" })), "credentialConfig");
    let url_source = json!({ "type": "external_account", "audience": "a", "subject_token_type": "t", "token_url": "https://sts.googleapis.com/v1/token",
                             "credential_source": { "url": "http://169.254.169.254/token" } })
    .to_string();
    let e = BigQuery
        .check_settings(&json!({ "project": "p", "authType": "workloadIdentity", "credentialConfig": url_source }))
        .unwrap_err();
    assert_eq!(e.detail.reason, "bigquery.credential_source_unsupported");
}

#[test]
fn parameters_carry_their_types() {
    assert_eq!(parameter(&Bind::Null), json!({ "parameterType": { "type": "STRING" }, "parameterValue": {} }));
    assert_eq!(parameter(&Bind::Bool(true))["parameterValue"]["value"], "true");
    assert_eq!(parameter(&Bind::Float(f64::INFINITY))["parameterValue"]["value"], "Infinity");
    assert_eq!(parameter(&Bind::Interval(30_000))["parameterValue"]["value"], "30000");
}
