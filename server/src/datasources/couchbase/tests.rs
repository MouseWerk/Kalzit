//! Couchbase against a fake query service on every run; `server/tests/couchbase.rs` checks the
//! same against a real server in CI.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::http::StatusCode as AxStatus;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use zeroize::Zeroizing;

use super::*;
use crate::datasources::targets::TargetPolicy;
use crate::datasources::{Limits, OwnDatabase};
use crate::shapes::TimeRange;

#[derive(Default)]
struct Fake {
    roles: Vec<&'static str>,
    /// `system:my_user_info` cannot be read.
    hide_roles: bool,
    bodies: Mutex<Vec<Value>>,
}

type S = Arc<Fake>;

fn reply(status: u16, v: Value) -> Response {
    (AxStatus::from_u16(status).unwrap(), [("content-type", "application/json")], v.to_string()).into_response()
}

fn ok(results: Value) -> Response {
    reply(200, json!({ "requestID": "r", "results": results, "status": "success" }))
}

async fn service(State(s): State<S>, body: String) -> Response {
    let b: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(b["readonly"], true, "every statement is read-only");
    s.bodies.lock().unwrap().push(b.clone());
    let st = b["statement"].as_str().unwrap();
    if st.contains("my_user_info") {
        if s.hide_roles {
            return reply(
                401,
                json!({ "status": "errors", "errors": [{ "code": 13014, "msg": "User does not have credentials to run SELECT queries on system:my_user_info" }] }),
            );
        }
        let roles: Vec<Value> =
            s.roles.iter().map(|r| json!({ "role": r, "bucket_name": "*", "origin": "user" })).collect();
        return ok(json!([roles]));
    }
    if st.contains("ds_version") {
        return ok(json!(["7.6.2-3721-community"]));
    }
    if st.contains("system:keyspaces") {
        return ok(json!([
            { "b": "travel-sample", "s": "inventory", "c": "airline" },
            { "b": "travel-sample", "s": "_default", "c": "_default" },
            // A bucket's own row, as 7.6 lists it: its default collection, once.
            { "c": "travel-sample" },
            { "c": "kalzit" }
        ]));
    }
    if st.contains("system:indexes") {
        return ok(json!([
            { "name": "#primary", "is_primary": true, "bucket_id": "travel-sample", "scope_id": "inventory", "keyspace_id": "airline" },
            { "name": "def_country", "index_key": ["`country`"], "bucket_id": "travel-sample", "scope_id": "inventory", "keyspace_id": "airline" }
        ]));
    }
    if st.contains("SELECT RAW d FROM `travel-sample`.`inventory`.`airline`") {
        return ok(json!([{ "name": "Lufthansa", "country": "Germany" }]));
    }
    if st.contains("SELECT RAW d") {
        return reply(
            500,
            json!({ "status": "errors", "errors": [{ "code": 4000, "msg": "No index available on keyspace" }] }),
        );
    }
    if st.contains("readonly_slip") {
        // As the query service answers a write in a read-only request.
        return reply(
            200,
            json!({ "status": "errors", "errors": [{ "code": 1000, "msg": "The server or request is read-only and cannot accept this write statement." }] }),
        );
    }
    if st.contains("broken") {
        return reply(
            400,
            json!({ "status": "fatal", "errors": [{ "code": 3000, "msg": "syntax error - at broken" }] }),
        );
    }
    ok(json!([{ "airline": { "name": "Lufthansa", "id": 9_007_199_254_740_993_i64 } }, 7]))
}

#[expect(clippy::disallowed_methods, reason = "a fake Couchbase query service, not an API route")]
async fn fake(f: Fake) -> (std::net::SocketAddr, S) {
    let state: S = Arc::new(f);
    let app = Router::new().route("/query/service", post(service)).with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, state)
}

async fn connection(addr: std::net::SocketAddr, extra: Value) -> Connection {
    let mut settings = json!({ "url": format!("http://{addr}"), "user": "leser" });
    for (k, v) in extra.as_object().unwrap() {
        settings[k] = v.clone();
    }
    kind().validate_settings(&settings).unwrap();
    let policy = Arc::new(TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &[]));
    let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
    let own = Arc::new(OwnDatabase::new(db, "sqlite::memory:"));
    let secrets: BTreeMap<String, Zeroizing<String>> =
        [("password".to_string(), Zeroizing::new("geheim-pw".to_string()))].into();
    Connection::new("ds", settings, secrets, policy, own)
}

fn req(sqlpp: &str, variables: Value) -> SourceQuery {
    SourceQuery {
        ref_id: "A".into(),
        query: json!({ "sqlpp": sqlpp }),
        range: TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 },
        interval_ms: 15_000,
        max_data_points: None,
        variables: serde_json::from_value(variables).unwrap(),
        identifier_variables: None,
        limits: Limits {
            timeout: Duration::from_secs(5),
            max_rows: 1000,
            budget: crate::datasources::frame::ResponseBudget::new(1 << 20),
        },
        cursor: None,
    }
}

fn reason<T>(r: Result<T, SourceError>) -> &'static str {
    match r {
        Ok(_) => "ok",
        Err(e) => e.detail().reason,
    }
}

async fn reader() -> (Connection, S) {
    let (addr, s) = fake(Fake { roles: vec!["query_select", "data_reader"], ..Fake::default() }).await;
    (connection(addr, json!({})).await, s)
}

#[test]
fn settings_are_checked() {
    let k = kind();
    assert!(k.validate_settings(&json!({ "url": "http://cb:8093", "bucket": "travel-sample" })).is_ok());
    let bad = |s: Value| k.validate_settings(&s).unwrap_err().field;
    assert_eq!(bad(json!({ "url": "cb:8093" })), "url");
    assert_eq!(bad(json!({ "url": "http://cb:8093", "bucket": "a b" })), "bucket");
    assert_eq!(bad(json!({ "url": "http://cb:8093", "caCert": "x" })), "caCert");
}

#[tokio::test]
async fn a_reader_connects_and_the_schema_lists_collections() {
    let (conn, _) = reader().await;
    let h = Couchbase.health(&conn).await;
    assert!(h.ok, "{h:?}");
    assert_eq!(h.detail.reason, "health.connected");
    assert_eq!(h.detail.params["version"], "7.6.2");
    assert_eq!(h.detail.params["edition"], "community");
    let SourceSchema::Collections { collections, .. } = Couchbase.schema(&conn).await.unwrap() else { panic!() };
    assert_eq!(collections.len(), 3);
    assert_eq!(collections[0].name, "travel-sample.inventory.airline");
    assert_eq!(collections[0].sampled, 1);
    assert_eq!(collections[0].fields.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["country", "name"]);
    assert_eq!(collections[0].indexes.len(), 2);
    assert_eq!(collections[0].indexes[1].keys[0].field, "country");
    // Without an index the collection has no sample, but it is listed.
    assert_eq!(collections[1].name, "travel-sample._default._default");
    assert_eq!(collections[1].sampled, 0);
    assert_eq!(collections[2].name, "kalzit._default._default");
}

#[tokio::test]
async fn a_user_with_more_than_reading_roles_is_refused_unless_allowed() {
    let (addr, _) = fake(Fake { roles: vec!["query_select", "query_insert", "data_reader"], ..Fake::default() }).await;
    let conn = connection(addr, json!({})).await;
    let h = Couchbase.health(&conn).await;
    assert!(!h.ok);
    assert_eq!(h.detail.reason, "couchbase.user_can_write");
    assert_eq!(h.detail.params["privileges"], "query_insert");
    let allowed = connection(addr, json!({ "allowWriteCapableUser": true })).await;
    let h = Couchbase.health(&allowed).await;
    assert!(h.ok);
    assert_eq!(h.detail.reason, "health.connected_write_capable");

    let (addr, _) = fake(Fake { hide_roles: true, ..Fake::default() }).await;
    let conn = connection(addr, json!({})).await;
    assert_eq!(Couchbase.health(&conn).await.detail.reason, "couchbase.privileges_unverifiable");
    assert!(Couchbase.health(&connection(addr, json!({ "allowWriteCapableUser": true })).await).await.ok);
}

#[tokio::test]
async fn writes_are_refused_by_the_check_and_by_the_read_only_request() {
    let (conn, s) = reader().await;
    let before = s.bodies.lock().unwrap().len();
    for q in ["DELETE FROM b", "UPSERT INTO b VALUES ('k', {})", "SELECT 1; DROP INDEX i ON b"] {
        assert_ne!(reason(Couchbase.query(&conn, req(q, json!({}))).await), "ok", "{q}");
    }
    assert_eq!(s.bodies.lock().unwrap().len(), before, "nothing refused was sent");
    // What the check would let through, the query service refuses in a read-only request.
    let r = Couchbase.query(&conn, req("SELECT readonly_slip FROM b", json!({}))).await;
    assert_eq!(reason(r), "couchbase.readonly_violation");
    let e = Couchbase.query(&conn, req("SELECT broken", json!({}))).await.unwrap_err();
    assert_eq!(e.detail().reason, "couchbase.error");
    assert!(e.detail().message.contains("3000"));
}

#[tokio::test]
async fn rows_are_documents_and_variables_are_named_parameters() {
    let (conn, s) = reader().await;
    let r = Couchbase
        .query(
            &conn,
            req(
                "SELECT a FROM `travel-sample`.inventory.airline AS a WHERE a.country = $land AND a.t < $__timeTo",
                json!({ "land": "Österreich", "unused": 1 }),
            ),
        )
        .await
        .unwrap();
    let QueryResult::Documents { documents } = r else { panic!("{r:?}") };
    let docs: Vec<Value> = documents.documents.iter().map(|d| serde_json::to_value(d).unwrap()).collect();
    assert_eq!(docs[0]["airline"]["id"], json!({ "$type": "int64", "value": "9007199254740993" }));
    assert_eq!(docs[1], json!({ "value": 7 }));
    let sent = s.bodies.lock().unwrap().last().unwrap().clone();
    assert_eq!(sent["$land"], "Österreich");
    assert_eq!(sent["$__timeTo"], 1_800_003_600_000_i64);
    assert!(sent.get("$unused").is_none());
    assert_eq!(sent["timeout"], "5000ms");
    assert_eq!(reason(Couchbase.query(&conn, req("SELECT $nope", json!({}))).await), "couchbase.variable_missing");
    assert_eq!(reason(Couchbase.query(&conn, req("SELECT $__nope", json!({}))).await), "couchbase.macro_unknown");
}

#[test]
fn roles_are_read_from_my_user_info() {
    let r = json!([[{ "role": "query_select", "bucket_name": "*" }, { "role": "data_reader" }, { "role": "query_select" }]]);
    assert_eq!(roles_from(r.as_array().unwrap()), ["data_reader", "query_select"]);
    assert!(roles_from(&[]).is_empty());
}
