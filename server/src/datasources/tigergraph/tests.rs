//! TigerGraph against a fake GSQL server and REST++ (4.x paths; one 3.x case), on every run. The
//! real image is too large for the PR check; `.github/workflows/tigergraph-nightly.yml` runs it.

use std::collections::BTreeMap;
use std::sync::Mutex;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap as AxHeaders, StatusCode as AxStatus};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use zeroize::Zeroizing;

use super::*;
use crate::datasources::targets::TargetPolicy;
use crate::datasources::{Limits, OwnDatabase};
use crate::shapes::TimeRange;

#[derive(Default)]
struct Fake {
    /// The token REST++ accepts now; `None` until one was issued.
    valid_token: Mutex<Option<String>>,
    tokens_issued: Mutex<u32>,
    /// The query string of the last REST++ or interpret call.
    last_query: Mutex<String>,
    last_body: Mutex<String>,
    /// The user that `GET /gsql/v1/users/{name}` and `SHOW USER` describe.
    v3: bool,
}

type S = Arc<Fake>;

fn json_reply(status: u16, v: Value) -> Response {
    (AxStatus::from_u16(status).unwrap(), [("content-type", "application/json")], v.to_string()).into_response()
}

fn authorized(h: &AxHeaders) -> bool {
    h.get("authorization").and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("Basic "))
}

async fn schema_v4(State(s): State<S>, Path(g): Path<String>, h: AxHeaders) -> Response {
    if s.v3 {
        return (AxStatus::NOT_FOUND, "404 page not found").into_response();
    }
    if !authorized(&h) {
        return json_reply(401, json!({ "error": true, "message": "authentication failed" }));
    }
    json_reply(
        200,
        json!({ "error": false, "results": {
            "GraphName": g,
            "VertexTypes": [{ "Name": "Person", "Attributes": [{ "AttributeName": "name" }, { "AttributeName": "age" }] }],
            "EdgeTypes": [{ "Name": "Friend", "Attributes": [{ "AttributeName": "since" }] }]
        } }),
    )
}

async fn schema_v3(Query(q): Query<BTreeMap<String, String>>) -> Response {
    json_reply(
        200,
        json!({ "error": false, "results": { "GraphName": q.get("graph"), "VertexTypes": [{ "Name": "Person", "Attributes": [] }], "EdgeTypes": [] } }),
    )
}

async fn user(Path(name): Path<String>) -> Response {
    match name.as_str() {
        "leser" => json_reply(
            200,
            json!({ "error": false, "results": [{ "name": "leser", "isSuperUser": false,
                "roles": { "social": ["queryreader"] },
                "privileges": { "social": { "privileges": ["READ_SCHEMA", "READ_DATA", "EXECUTE_LOADINGJOB", "READ_LOADINGJOB"] } } }] }),
        ),
        "schreiber" => json_reply(
            200,
            json!({ "error": false, "results": [{ "name": "schreiber", "isSuperUser": false,
                "roles": { "social": ["querywriter"] },
                "privileges": { "social": { "privileges": ["READ_DATA", "CREATE_DATA", "DELETE_DATA"] } } }] }),
        ),
        "chef" => json_reply(200, json!({ "error": false, "results": [{ "name": "chef", "isSuperUser": true, "roles": { "1": ["superuser"] } }] })),
        // Not allowed to read its own record: Kalzit asks with SHOW USER.
        _ => json_reply(403, json!({ "error": true, "message": "Permission denied: READ_USER" })),
    }
}

async fn statements(h: AxHeaders, body: String) -> Response {
    assert_eq!(body, "SHOW USER", "Kalzit only ever sends this fixed command");
    let who = h.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let text = if who == base64_basic("versteckt", "geheim") {
        "  - Name: versteckt\n  - Graph 'social' Roles: queryreader\n  - Graph 'other' Roles: designer\n"
    } else {
        "  - Name: jemand\n  - Global Roles: globaldesigner\n"
    };
    (AxStatus::OK, text).into_response()
}

fn base64_basic(user: &str, password: &str) -> String {
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}")))
}

async fn tokens(State(s): State<S>, h: AxHeaders, body: String) -> Response {
    if !authorized(&h) {
        return json_reply(401, json!({ "error": true, "message": "no credentials" }));
    }
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["graph"], "social");
    let mut n = s.tokens_issued.lock().unwrap();
    *n += 1;
    let token = format!("tok-{n}");
    *s.valid_token.lock().unwrap() = Some(token.clone());
    json_reply(200, json!({ "error": false, "token": token, "expiration": 1_900_000_000 }))
}

const NACHBARN: &str = "CREATE QUERY nachbarn(VERTEX<Person> p, INT tiefe, SET<STRING> tags) FOR GRAPH social { \
    Start = {p}; R = SELECT t FROM Start:s -(Friend:e)- Person:t ACCUM @@edges += e; \
    SetAccum<EDGE> @@edges; PRINT R; PRINT @@edges; }";

async fn query_text(Path(name): Path<String>, Query(q): Query<BTreeMap<String, String>>) -> Response {
    assert_eq!(q.get("graph").map(String::as_str), Some("social"));
    match name.as_str() {
        "nachbarn" => json_reply(200, json!({ "error": false, "results": { "name": "nachbarn", "queryContent": NACHBARN } })),
        "loescht" => json_reply(
            200,
            json!({ "error": false, "results": { "queryContent": "CREATE QUERY loescht() FOR GRAPH social { DELETE s FROM Person:s; }" } }),
        ),
        _ => json_reply(403, json!({ "error": true, "message": "Permission denied: READ_QUERY" })),
    }
}

fn vertex(id: &str, name: &str) -> Value {
    json!({ "v_id": id, "v_type": "Person", "attributes": { "name": name, "groß": 9_007_199_254_740_993_u64 } })
}

fn results_for(name: &str) -> Value {
    match name {
        "nachbarn" => json!([
            { "R": [vertex("1", "Ana"), vertex("2", "Bo")] },
            { "@@edges": [
                { "e_type": "Friend", "from_type": "Person", "from_id": "1", "to_type": "Person", "to_id": "3", "directed": false, "attributes": { "since": 2020 } },
                { "e_type": "Friend", "from_type": "Person", "from_id": "3", "to_type": "Person", "to_id": "1", "directed": false, "attributes": { "since": 2020 } },
                { "e_type": "Friend", "from_type": "Person", "from_id": "1", "to_type": "Person", "to_id": "3", "directed": false, "attributes": { "since": 2021 } }
            ] },
            { "@@total": 3 }
        ]),
        _ => json!([{ "@@total": 42, "durchschnitt": 1.5 }, { "name": "Ana" }]),
    }
}

async fn restpp_query(
    State(s): State<S>,
    Path((graph, name)): Path<(String, String)>,
    h: AxHeaders,
    raw: axum::extract::RawQuery,
) -> Response {
    assert_eq!(graph, "social");
    let valid = s.valid_token.lock().unwrap().clone();
    let bearer = h.get("authorization").and_then(|v| v.to_str().ok()).map(|v| v.trim_start_matches("Bearer ").to_string());
    if valid.is_none() || bearer != valid {
        return json_reply(401, json!({ "error": true, "message": "token expired" }));
    }
    assert!(h.get("gsql-timeout").is_some());
    *s.last_query.lock().unwrap() = raw.0.unwrap_or_default();
    json_reply(200, json!({ "error": false, "message": "", "version": { "edition": "enterprise" }, "results": results_for(&name) }))
}

async fn interpret(State(s): State<S>, h: AxHeaders, raw: axum::extract::RawQuery, body: String) -> Response {
    if !authorized(&h) {
        return json_reply(401, json!({ "error": true, "message": "authentication failed" }));
    }
    *s.last_query.lock().unwrap() = raw.0.unwrap_or_default();
    *s.last_body.lock().unwrap() = body.clone();
    let results = if body.contains("PRINT R") { results_for("nachbarn") } else { results_for("zahlen") };
    json_reply(200, json!({ "error": false, "results": results }))
}

async fn version() -> Response {
    json_reply(200, json!({ "error": false, "message": "\nTigerGraph RESTPP:\n --- Version --- \nTigerGraph version: 4.1.2\nEdition: enterprise\n" }))
}

async fn queries() -> Response {
    json_reply(200, json!({ "error": false, "results": ["nachbarn", "loescht"] }))
}

#[expect(clippy::disallowed_methods, reason = "a fake TigerGraph server, not an API route")]
async fn fake(v3: bool) -> (std::net::SocketAddr, S) {
    let state: S = Arc::new(Fake { v3, ..Fake::default() });
    let app = Router::new()
        .route("/gsql/v1/schema/graphs/{g}", get(schema_v4))
        .route("/gsqlserver/gsql/schema", get(schema_v3))
        .route("/gsql/v1/users/{name}", get(user))
        .route("/gsql/v1/statements", post(statements))
        .route("/gsqlserver/gsql/file", post(statements))
        .route("/gsql/v1/tokens", post(tokens))
        .route("/gsql/v1/queries/{name}", get(query_text))
        .route("/gsql/v1/queries", get(queries))
        .route("/gsql/v1/queries/interpret", post(interpret))
        .route("/gsqlserver/interpreted_query", post(interpret))
        .route("/restpp/query/{graph}/{name}", get(restpp_query))
        .route("/restpp/version", get(version))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, state)
}

async fn connection(addr: std::net::SocketAddr, user: &str, extra: Value) -> Connection {
    let mut settings = json!({ "url": format!("http://{addr}"), "graph": "social", "user": user });
    for (k, v) in extra.as_object().unwrap() {
        settings[k] = v.clone();
    }
    kind().validate_settings(&settings).unwrap();
    let policy = Arc::new(TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &[]));
    let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
    let own = Arc::new(OwnDatabase::new(db, "sqlite::memory:"));
    let secrets: BTreeMap<String, Zeroizing<String>> = [("password".to_string(), Zeroizing::new("geheim".to_string()))].into();
    Connection::new("ds", settings, secrets, policy, own)
}

fn req(query: Value, variables: Value) -> SourceQuery {
    SourceQuery {
        ref_id: "A".into(),
        query,
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
    }
}

fn reason(r: Result<QueryResult, SourceError>) -> &'static str {
    match r {
        Ok(_) => panic!("the query ran"),
        Err(e) => e.detail().reason,
    }
}

#[tokio::test]
async fn installed_queries_run_with_typed_parameters_and_become_a_graph() {
    let (addr, fake) = fake(false).await;
    let conn = connection(addr, "leser", json!({})).await;
    let q = json!({ "installed": "nachbarn", "params": { "p": "1", "tags": ["a b", "c&d"] } });
    let r = TigerGraph.query(&conn, req(q, json!({ "tiefe": 2 }))).await.unwrap();
    let sent = fake.last_query.lock().unwrap().clone();
    assert_eq!(sent, "p=1&tiefe=2&tags=a+b&tags=c%26d", "typed, from params and variables");
    let QueryResult::Graph { graph } = r else { panic!("a graph") };
    let ids: Vec<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids, ["Person:1", "Person:2", "Person:3"], "Person:3 is an edge's end");
    assert_eq!(graph.nodes[0].properties["groß"], json!({ "$type": "int64", "value": "9007199254740993" }));
    assert!(graph.nodes[2].properties.is_empty());
    assert_eq!(graph.nodes[2].labels, ["Person"]);
    // The undirected edge printed from both ends is one edge; another one (a discriminator) a second.
    let edges: Vec<&str> = graph.edges.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(edges, ["Friend:Person:1--Person:3", "Friend:Person:1--Person:3#2"]);
    let notices = graph.notices.unwrap();
    assert_eq!(notices[0].code, "graph.columns_omitted");
    assert_eq!(notices[0].params.as_ref().unwrap()["columns"], "@@total");
    assert_eq!(*fake.tokens_issued.lock().unwrap(), 1);

    // A wrong type never reaches the server.
    let bad = json!({ "installed": "nachbarn", "params": { "p": "1", "tiefe": "zwei" } });
    assert_eq!(reason(TigerGraph.query(&conn, req(bad, json!({}))).await), "tigergraph.param_type");
    let unknown = json!({ "installed": "nachbarn", "params": { "fremd": 1 } });
    assert_eq!(reason(TigerGraph.query(&conn, req(unknown, json!({}))).await), "tigergraph.param_unknown");

    // An expired token is replaced once.
    *fake.valid_token.lock().unwrap() = Some("tok-neu".into());
    let again = json!({ "installed": "nachbarn", "params": { "p": "1" } });
    assert!(TigerGraph.query(&conn, req(again.clone(), json!({}))).await.is_ok(), "{:?}", fake.valid_token);
    assert_eq!(*fake.tokens_issued.lock().unwrap(), 2, "a new token was fetched after the 401");
    assert!(TigerGraph.query(&conn, req(again, json!({}))).await.is_ok());
    assert_eq!(*fake.tokens_issued.lock().unwrap(), 2, "and kept");
}

#[tokio::test]
async fn installed_queries_need_a_text_that_passes_or_an_approval() {
    let (addr, _) = fake(false).await;
    let conn = connection(addr, "leser", json!({})).await;
    let r = TigerGraph.query(&conn, req(json!({ "installed": "loescht" }), json!({}))).await;
    assert_eq!(reason(r), "gsql.write");
    let r = TigerGraph.query(&conn, req(json!({ "installed": "geheim" }), json!({}))).await;
    assert_eq!(reason(r), "tigergraph.query_text_unreadable");
    let r = TigerGraph.query(&conn, req(json!({ "installed": "x/../../gsql/v1/users" }), json!({}))).await;
    assert_eq!(reason(r), "tigergraph.query_name");

    let approved = connection(addr, "leser", json!({ "approvedQueries": "geheim, andere" })).await;
    let r = TigerGraph.query(&approved, req(json!({ "installed": "geheim", "params": { "k": 3 } }), json!({}))).await;
    let QueryResult::Frame { frame } = r.unwrap() else { panic!("scalars are a frame") };
    let names: Vec<&str> = frame.fields().iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["@@total", "durchschnitt", "name"]);
    assert_eq!(frame.fields()[0].field_type, FieldType::Int64);
    assert_eq!(frame.fields()[0].values, [json!("42")]);
    assert_eq!(frame.fields()[1].field_type, FieldType::Number);
    // An approved query whose text is readable is still checked.
    let both = connection(addr, "leser", json!({ "approvedQueries": "loescht" })).await;
    assert_eq!(reason(TigerGraph.query(&both, req(json!({ "installed": "loescht" }), json!({}))).await), "gsql.write");
}

#[tokio::test]
async fn interpreted_queries_are_checked_and_sent_with_basic_auth() {
    let (addr, fake) = fake(false).await;
    let conn = connection(addr, "leser", json!({})).await;
    let text = "INTERPRET QUERY (STRING name, DATETIME ab) FOR GRAPH social { SumAccum<INT> @@total; \
                S = {Person.*}; R = SELECT s FROM S:s WHERE s.name == name ACCUM @@total += 1; PRINT @@total; }";
    let r = TigerGraph
        .query(&conn, req(json!({ "gsql": text, "params": { "ab": 1_800_000_000_000_i64 } }), json!({ "name": "Ana Ö" })))
        .await
        .unwrap();
    assert!(matches!(r, QueryResult::Frame { .. }));
    assert_eq!(fake.last_query.lock().unwrap().as_str(), "graph=social&name=Ana+%C3%96&ab=2027-01-15+08%3A00%3A00");
    assert_eq!(fake.last_body.lock().unwrap().as_str(), text);

    for (gsql, why) in [
        ("INTERPRET QUERY () FOR GRAPH social { DELETE s FROM Person:s; }", "gsql.write"),
        ("INTERPRET QUERY () FOR GRAPH andere { PRINT 1; }", "gsql.other_graph"),
        ("INTERPRET QUERY () FOR GRAPH social { PRINT 1; } DROP ALL", "gsql.not_one_query"),
    ] {
        assert_eq!(reason(TigerGraph.query(&conn, req(json!({ "gsql": gsql }), json!({}))).await), why, "{gsql}");
    }
    assert_eq!(reason(TigerGraph.query(&conn, req(json!({ "gsql": "x", "installed": "y" }), json!({}))).await), "query.invalid_form");
}

#[tokio::test]
async fn users_who_may_write_are_refused() {
    let (addr, _) = fake(false).await;
    for (user, why) in [("schreiber", "tigergraph.user_can_write"), ("chef", "tigergraph.user_can_write")] {
        let conn = connection(addr, user, json!({})).await;
        let r = TigerGraph.query(&conn, req(json!({ "installed": "nachbarn" }), json!({}))).await;
        assert_eq!(reason(r), why, "{user}");
        let h = TigerGraph.health(&conn).await;
        assert!(!h.ok);
        assert_eq!(h.detail.reason, why);
    }
    // SHOW USER when the user may not read its own record: a reader on this graph passes, even
    // with more rights on another graph (they do not reach this one); a global designer does not.
    let hidden = connection(addr, "versteckt", json!({})).await;
    let h = TigerGraph.health(&hidden).await;
    assert!(h.ok, "{h:?}");
    let global = connection(addr, "jemand", json!({})).await;
    assert_eq!(TigerGraph.health(&global).await.detail.reason, "tigergraph.user_can_write");
}

#[tokio::test]
async fn health_and_schema() {
    let (addr, _) = fake(false).await;
    let conn = connection(addr, "leser", json!({ "approvedQueries": "extra" })).await;
    let h = TigerGraph.health(&conn).await;
    assert!(h.ok, "{h:?}");
    assert_eq!(h.detail.params["version"], "4.1.2");
    assert_eq!(h.detail.params["edition"], "enterprise");
    let SourceSchema::Graph { labels, edge_types, property_keys, queries } = TigerGraph.schema(&conn).await.unwrap() else {
        panic!("a graph schema")
    };
    assert_eq!(labels, ["Person"]);
    assert_eq!(edge_types, ["Friend"]);
    assert_eq!(property_keys, ["age", "name", "since"]);
    assert_eq!(queries, ["extra", "loescht", "nachbarn"]);
}

#[tokio::test]
async fn version_3_uses_the_gsqlserver_paths() {
    let (addr, fake) = fake(true).await;
    let conn = connection(addr, "versteckt", json!({})).await;
    let text = "INTERPRET QUERY () FOR GRAPH social { PRINT 1; }";
    TigerGraph.query(&conn, req(json!({ "gsql": text }), json!({}))).await.unwrap();
    assert_eq!(fake.last_body.lock().unwrap().as_str(), text);
    assert_eq!(fake.last_query.lock().unwrap().as_str(), "", "3.x takes the graph from the query text");
    // 3.x has no endpoint for a query's text: only approved installed queries run.
    let r = TigerGraph.query(&conn, req(json!({ "installed": "nachbarn" }), json!({}))).await;
    assert_eq!(reason(r), "tigergraph.query_text_unreadable");
}

#[test]
fn rights_and_parameters() {
    let show = "- Name: x\n- Global Roles: \n- Graph 'social' Roles: queryreader, designer\n";
    assert_eq!(rights_from_show_user(show, "social").unwrap().excess(), ["designer"]);
    assert!(rights_from_show_user("nothing here", "social").is_none());
    let mut out = Vec::new();
    typed_pairs("v", "v", &ParamType::Many(Box::new(ParamType::Vertex(None))), &json!([{ "type": "Person", "id": 7 }]), &mut out)
        .unwrap();
    assert_eq!(out, [("v[0]".to_string(), "7".to_string()), ("v[0].type".to_string(), "Person".to_string())]);
    assert!(typed_pairs("u", "u", &ParamType::Uint, &json!(-1), &mut Vec::new()).is_err());
    assert!(typed_pairs("b", "b", &ParamType::Bool, &json!("ja"), &mut Vec::new()).is_err());
    assert_eq!(version_from("product release_3.10.1_02-01-2024"), Some("3.10.1".into()));
    assert!(kind().validate_settings(&json!({ "url": "http://tg", "graph": "a/b", "user": "u" })).is_err());
    assert!(kind().validate_settings(&json!({ "url": "http://tg", "graph": "g", "user": "u/../x" })).is_err());
    assert!(kind().validate_settings(&json!({ "url": "http://tg", "graph": "g", "user": "u", "approvedQueries": "a;b" })).is_err());
}
