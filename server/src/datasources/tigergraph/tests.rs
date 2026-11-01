//! TigerGraph against a fake GSQL server and REST++ (4.x paths; one 3.x case), on every run. The
//! real image is too large for the PR check; `.github/workflows/tigergraph-nightly.yml` runs it.

use std::collections::BTreeMap;
use std::sync::Mutex;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap as AxHeaders, StatusCode as AxStatus};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine as _;
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
    /// The token endpoint redirects (to a same-origin twin that would issue a token).
    redirect_tokens: bool,
    /// REST++ without authentication (a fresh Community Edition): it answers without a token.
    restpp_open: bool,
    /// How often `GET /gsql/v1/queries/info?query=...` was asked.
    info_calls: Mutex<u32>,
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
        // As 4.2.5 answers a queryreader about itself (the nightly job checks it).
        "leser" => json_reply(
            200,
            json!({ "error": false, "message": "", "results": { "name": "leser", "isSuperUser": false, "disabled": false,
                "roles": { "social": ["queryreader"] }, "creators": { "social": "tigergraph" }, "secrets": [],
                "privileges": { "social": { "privileges": ["READ_SCHEMA", "READ_LOADINGJOB", "EXECUTE_LOADINGJOB",
                    "READ_DATA", "APP_ACCESS_DATA", "READ_POLICY"] } } } }),
        ),
        "schreiber" => json_reply(
            200,
            json!({ "error": false, "results": [{ "name": "schreiber", "isSuperUser": false,
                "roles": { "social": ["querywriter"] },
                "privileges": { "social": { "privileges": ["READ_DATA", "CREATE_DATA", "DELETE_DATA"] } } }] }),
        ),
        "chef" => json_reply(
            200,
            json!({ "error": false, "results": { "name": "chef", "isSuperUser": true,
                "roles": { "1": ["superuser"], "social": ["superuser"] },
                "privileges": { "1": { "privileges": ["READ_DATA", "DELETE_DATA", "DROP_ALL"] },
                    "social": { "privileges": [], "childPermissions": { "nachbarn": { "privileges": ["OWNER"] } } } } } }),
        ),
        // Not allowed to read its own record (4.2.5 lets a queryreader read it; older or other
        // setups may not): Kalzit asks with SHOW USER.
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
    if s.redirect_tokens {
        return (AxStatus::TEMPORARY_REDIRECT, [("location", "/gsql/v1/tokens2")]).into_response();
    }
    tokens2(State(s), h, body).await
}

async fn tokens2(State(s): State<S>, h: AxHeaders, body: String) -> Response {
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
        "nachbarn" => {
            json_reply(200, json!({ "error": false, "results": { "name": "nachbarn", "queryContent": NACHBARN } }))
        }
        "loescht" => json_reply(
            200,
            json!({ "error": false, "results": { "queryContent": "CREATE QUERY loescht() FOR GRAPH social { DELETE s FROM Person:s; }" } }),
        ),
        // As 4.2.5 answers a queryreader.
        _ => json_reply(
            403,
            json!({ "error": true, "message": format!("User 'leser' does not have the permission to run the command\nRequired Query Privileges: \n  - Graph 'social' Privileges:\n    - Query '{name}' Privileges:\n      READ_QUERY [MISSING]\n\nPlease ask for the [MISSING] privileges.") }),
        ),
    }
}

/// `GET /gsql/v1/queries/info`, which 4.2.5 answers a queryreader (shortened): every query, or
/// the one named in `query`.
async fn query_info(State(s): State<S>, Query(q): Query<BTreeMap<String, String>>) -> Response {
    assert_eq!(q.get("graph").map(String::as_str), Some("social"));
    if q.contains_key("query") {
        *s.info_calls.lock().unwrap() += 1;
    }
    // The parameters as 4.2.5 describes `geheim(INT k, STRING name, LIST<INT> liste, VERTEX v,
    // VERTEX<Person> p)`: an untyped vertex has a `v.type` companion, a list `max_count`.
    let geheim = json!({
        "k": { "index": 0, "type": "INT64", "min_count": 0 },
        "name": { "index": 1, "type": "STRING", "min_count": 0 },
        "liste": { "max_count": 2_147_483_647_u64, "index": 2, "type": "INT64", "min_count": 0 },
        "v": { "index": 3, "id_type": "$v.type", "type": "STRING", "is_id": "true", "min_count": 0 },
        "v.type": { "index": 4, "type": "STRING", "min_count": 0 },
        "p": { "index": 5, "id_type": "Person", "type": "STRING", "is_id": "true", "min_count": 0 },
        "query": { "default": "geheim", "type": "STRING" }
    });
    let all = [
        ("nachbarn", false, json!({ "query": { "default": "nachbarn", "type": "STRING" } })),
        ("loescht", true, json!({ "query": { "default": "loescht", "type": "STRING" } })),
        ("geheim", false, geheim),
        ("schreibt_geheim", true, json!({ "query": { "default": "schreibt_geheim", "type": "STRING" } })),
        ("verboten", false, json!({ "query": { "default": "verboten", "type": "STRING" } })),
    ];
    let mut results: Vec<Value> = all
        .iter()
        .filter(|(n, _, _)| q.get("query").is_none_or(|w| w == n))
        .map(|(n, update, params)| {
            json!({ "name": n, "installed": true, "graphUpdate": update, "status": "VALID", "syntax": "GSQL v2",
                    "endpoint": { "query": { "social": { *n: { "GET/POST": {
                        "graphUpdate": update, "action": "query", "parameters": params } } } } } })
        })
        .collect();
    // An info without `graphUpdate` (an older or changed server).
    if q.get("query").is_none_or(|w| w == "ohne_flag") {
        results
            .push(json!({ "name": "ohne_flag", "installed": true, "endpoint": { "query": { "social": { "ohne_flag": {
            "GET/POST": { "parameters": { "query": { "default": "ohne_flag", "type": "STRING" } } } } } } } }));
    }
    json_reply(200, json!({ "error": false, "message": "", "results": results }))
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
    let bearer =
        h.get("authorization").and_then(|v| v.to_str().ok()).map(|v| v.trim_start_matches("Bearer ").to_string());
    // As 4.2.5 answers a missing or unknown token, with REST++ authentication on.
    if valid.is_none() || bearer != valid {
        return json_reply(
            403,
            json!({ "version": { "edition": "community", "api": "v2", "schema": 0 }, "error": true,
                    "message": "Access Denied because the input token = 'tok-****' is not in correct format", "code": "REST-10016" }),
        );
    }
    assert!(h.get("gsql-timeout").is_some());
    *s.last_query.lock().unwrap() = raw.0.unwrap_or_default();
    // As 4.2.5 answers a valid token that lacks a privilege the query needs: final, not a token issue.
    if name == "verboten" {
        return json_reply(
            403,
            json!({ "version": { "edition": "community", "api": "v2", "schema": 0 }, "error": true,
                    "message": "Access Denied because the input token = 'tok-****' does not have permission to run the request",
                    "code": "REST-10018" }),
        );
    }
    json_reply(
        200,
        json!({ "error": false, "message": "", "version": { "edition": "enterprise" }, "results": results_for(&name) }),
    )
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

async fn version(State(s): State<S>, h: AxHeaders) -> Response {
    let bearer =
        h.get("authorization").and_then(|v| v.to_str().ok()).map(|v| v.trim_start_matches("Bearer ").to_string());
    if !s.restpp_open && (bearer.is_none() || bearer != *s.valid_token.lock().unwrap()) {
        return json_reply(
            403,
            json!({ "error": true, "message": "Access Denied because the input token = '' is empty or too short", "code": "REST-10016" }),
        );
    }
    json_reply(
        200,
        json!({ "error": false, "message": "\nTigerGraph RESTPP:\n --- Version --- \nTigerGraph version: 4.1.2\nEdition: enterprise\n" }),
    )
}

/// 4.2.5 answers a queryreader with an empty list here, even when the graph has queries.
async fn queries() -> Response {
    json_reply(200, json!({ "error": false, "message": "", "results": [] }))
}

async fn fake(v3: bool) -> (std::net::SocketAddr, S) {
    fake_with(Fake { v3, ..Fake::default() }).await
}

#[expect(clippy::disallowed_methods, reason = "a fake TigerGraph server, not an API route")]
async fn fake_with(fake: Fake) -> (std::net::SocketAddr, S) {
    let state: S = Arc::new(fake);
    let app = Router::new()
        .route("/gsql/v1/schema/graphs/{g}", get(schema_v4))
        .route("/gsqlserver/gsql/schema", get(schema_v3))
        .route("/gsql/v1/users/{name}", get(user))
        .route("/gsql/v1/statements", post(statements))
        .route("/gsqlserver/gsql/file", post(statements))
        .route("/gsql/v1/tokens", post(tokens))
        .route("/gsql/v1/tokens2", post(tokens2))
        .route("/gsql/v1/queries/{name}", get(query_text))
        .route("/gsql/v1/queries", get(queries))
        .route("/gsql/v1/queries/info", get(query_info))
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
    let secrets: BTreeMap<String, Zeroizing<String>> =
        [("password".to_string(), Zeroizing::new("geheim".to_string()))].into();
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
        cursor: None,
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
    assert_eq!(sent, "p=1&tiefe=2&tags=a%20b&tags=c%26d", "typed, from params and variables");
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
    assert_eq!(*fake.tokens_issued.lock().unwrap(), 2, "a new token was fetched after REST++ refused the old one");
    assert!(TigerGraph.query(&conn, req(again, json!({}))).await.is_ok());
    assert_eq!(*fake.tokens_issued.lock().unwrap(), 2, "and kept");
}

#[tokio::test]
async fn installed_queries_need_a_text_that_passes_or_an_approval() {
    let (addr, fake) = fake(false).await;
    let conn = connection(addr, "leser", json!({})).await;
    let r = TigerGraph.query(&conn, req(json!({ "installed": "loescht" }), json!({}))).await;
    assert_eq!(reason(r), "gsql.write");
    let r = TigerGraph.query(&conn, req(json!({ "installed": "geheim" }), json!({}))).await;
    assert_eq!(reason(r), "tigergraph.query_text_unreadable");
    let r = TigerGraph.query(&conn, req(json!({ "installed": "x/../../gsql/v1/users" }), json!({}))).await;
    assert_eq!(reason(r), "tigergraph.query_name");

    let approved =
        connection(addr, "leser", json!({ "approvedQueries": "geheim, andere, schreibt_geheim, ohne_flag, verboten" }))
            .await;
    // TigerGraph marks a query that changes data (graphUpdate in its info): refused even when approved.
    let r = TigerGraph.query(&approved, req(json!({ "installed": "schreibt_geheim" }), json!({}))).await;
    assert_eq!(reason(r), "tigergraph.query_writes");
    // 4.x fails closed: without an info, or without graphUpdate in it, an approved query does
    // not run (it would run untyped and unchecked).
    for name in ["andere", "ohne_flag"] {
        let r = TigerGraph.query(&approved, req(json!({ "installed": name, "params": { "s": "x" } }), json!({}))).await;
        assert_eq!(reason(r), "tigergraph.query_info_unreadable", "{name}");
    }
    // A token REST++ accepts but that lacks a privilege (REST-10018) is final: no new token.
    let before = *fake.tokens_issued.lock().unwrap();
    let r = TigerGraph.query(&approved, req(json!({ "installed": "verboten" }), json!({}))).await;
    assert_eq!(reason(r), "tigergraph.error");
    assert_eq!(*fake.tokens_issued.lock().unwrap(), before + 1, "one token for the call, none after the refusal");
    // With info: typed parameters in their declared order, filled from dashboard variables too.
    let params = json!({ "k": 3, "name": "x+y z", "liste": [1, 2], "v": { "type": "Ort", "id": "7" } });
    let r = TigerGraph
        .query(&approved, req(json!({ "installed": "geheim", "params": params }), json!({ "p": "1", "fremd": 1 })))
        .await;
    assert_eq!(fake.last_query.lock().unwrap().as_str(), "k=3&name=x%2By%20z&liste=1&liste=2&v=7&v.type=Ort&p=1");
    for (bad, why) in [
        (json!({ "k": "drei" }), "tigergraph.param_type"),
        (json!({ "v": "7" }), "tigergraph.param_type"),
        (json!({ "s": 1 }), "tigergraph.param_unknown"),
    ] {
        let q = json!({ "installed": "geheim", "params": bad });
        assert_eq!(reason(TigerGraph.query(&approved, req(q, json!({}))).await), why, "{bad}");
    }
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
        .query(
            &conn,
            req(json!({ "gsql": text, "params": { "ab": 1_800_000_000_000_i64 } }), json!({ "name": "Ana Ö" })),
        )
        .await
        .unwrap();
    assert!(matches!(r, QueryResult::Frame { .. }));
    assert_eq!(fake.last_query.lock().unwrap().as_str(), "graph=social&name=Ana%20%C3%96&ab=2027-01-15%2008%3A00%3A00");
    assert_eq!(fake.last_body.lock().unwrap().as_str(), text);

    for (gsql, why) in [
        ("INTERPRET QUERY () FOR GRAPH social { DELETE s FROM Person:s; }", "gsql.write"),
        ("INTERPRET QUERY () FOR GRAPH andere { PRINT 1; }", "gsql.other_graph"),
        ("INTERPRET QUERY () FOR GRAPH social { PRINT 1; } DROP ALL", "gsql.not_one_query"),
        ("INTERPRET QUERY () { PRINT 1; }", "gsql.graph_missing"),
        // A tuple named like an installed query of the graph.
        (
            "INTERPRET QUERY () FOR GRAPH social { TYPEDEF TUPLE <INT a> Nachbarn; PRINT nachbarn(1); }",
            "gsql.typedef_name",
        ),
    ] {
        assert_eq!(reason(TigerGraph.query(&conn, req(json!({ "gsql": gsql }), json!({}))).await), why, "{gsql}");
    }
    assert_eq!(
        reason(TigerGraph.query(&conn, req(json!({ "gsql": "x", "installed": "y" }), json!({}))).await),
        "query.invalid_form"
    );
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
async fn token_requests_do_not_follow_redirects() {
    let (addr, fake) = fake_with(Fake { redirect_tokens: true, ..Fake::default() }).await;
    let conn = connection(addr, "leser", json!({})).await;
    let r = TigerGraph.query(&conn, req(json!({ "installed": "nachbarn", "params": { "p": "1" } }), json!({}))).await;
    assert_eq!(reason(r), "tigergraph.redirect_refused");
    assert_eq!(*fake.tokens_issued.lock().unwrap(), 0, "the redirect was not followed");
}

#[test]
fn no_redirect_is_followed() {
    let restpp = Url::parse("http://tg.intern:14240/restpp/").unwrap();
    let first = restpp.join("query/g/genehmigt?x=1").unwrap();
    // The first request goes out (the target checks still apply to it).
    assert!(check_hop(0, &first).is_ok());
    // Every redirect is refused: other installed queries, user management, look-alike paths,
    // encoded or resolved dots, other origins, credentials, and the same URL again.
    for loc in [
        "andere",
        "/restpp/query/g/schreibt",
        "/gsql/v1/users/",
        "/restppx/query",
        "https://tg.intern:14240/restpp/query/g/genehmigt",
        "http://tg.intern:9000/query/g/x",
        "http://fremd@tg.intern:14240/restpp/query/g/genehmigt",
        "http://xn--tg-intern-9ya.example/restpp/",
        "/restpp/%252e%252e/x",
        "/restpp/%2e%2e/gsql",
        "//evil.example/restpp/",
        "/restpp/query/g/genehmigt;/../../gsql",
        "/restpp/query/g/genehmigt?x=1",
    ] {
        let url = first.join(loc).unwrap();
        let e = check_hop(1, &url).expect_err(loc);
        assert_eq!(e.reason, "tigergraph.redirect_refused");
        assert_eq!(e.params["path"], url.path());
    }
}

#[tokio::test]
async fn health_and_schema() {
    let (addr, _) = fake(false).await;
    let conn = connection(addr, "leser", json!({ "approvedQueries": "extra" })).await;
    let h = TigerGraph.health(&conn).await;
    assert!(h.ok, "{h:?}");
    assert_eq!(h.detail.params["version"], "4.1.2");
    assert_eq!(h.detail.params["edition"], "enterprise");
    let SourceSchema::Graph { labels, edge_types, property_keys, queries, query_params } =
        TigerGraph.schema(&conn).await.unwrap()
    else {
        panic!("a graph schema")
    };
    assert_eq!(labels, ["Person"]);
    assert_eq!(edge_types, ["Friend"]);
    assert_eq!(property_keys, ["age", "name", "since"]);
    // From the query info, which a queryreader may read; the plain query list is empty for it.
    assert_eq!(queries, ["extra", "geheim", "loescht", "nachbarn", "ohne_flag", "schreibt_geheim", "verboten"]);
    let types: Vec<String> = query_params["geheim"].iter().map(|p| format!("{} {}", p.ty, p.name)).collect();
    assert_eq!(types, ["INT k", "STRING name", "SET<INT> liste", "VERTEX v", "VERTEX<Person> p"]);
    assert_eq!(query_params["nachbarn"], []);
    assert!(h.warnings.is_empty(), "REST++ refuses requests without a token: {h:?}");
}

#[tokio::test]
async fn approved_query_info_is_read_again_while_rest_is_open() {
    let params = json!({ "installed": "geheim", "params": { "k": 1 } });
    // REST++ checks tokens: the clean info is kept for a minute, like a checked text.
    let (addr, fake) = fake(false).await;
    let conn = connection(addr, "leser", json!({ "approvedQueries": "geheim" })).await;
    for _ in 0..2 {
        TigerGraph.query(&conn, req(params.clone(), json!({}))).await.unwrap();
    }
    assert_eq!(*fake.info_calls.lock().unwrap(), 1);
    // REST++ without authentication: the info is the only guard, so every run reads it again.
    let (addr, fake) = fake_with(Fake { restpp_open: true, ..Fake::default() }).await;
    let conn = connection(addr, "leser", json!({ "approvedQueries": "geheim" })).await;
    for _ in 0..2 {
        TigerGraph.query(&conn, req(params.clone(), json!({}))).await.unwrap();
    }
    assert_eq!(*fake.info_calls.lock().unwrap(), 2);
}

#[test]
fn query_strings_keep_plus_space_and_ampersand_apart() {
    let mut url = Url::parse("http://tg/restpp/query/social/q").unwrap();
    set_query(&mut url, &[("a", "x+y z&w=1"), ("b c", "ö")]);
    assert_eq!(url.query(), Some("a=x%2By%20z%26w%3D1&b%20c=%C3%B6"));
    set_query::<&str, &str>(&mut url, &[]);
    assert_eq!(url.query(), None);
}

#[tokio::test]
async fn rest_without_authentication_is_a_warning() {
    let (addr, _) = fake_with(Fake { restpp_open: true, ..Fake::default() }).await;
    let conn = connection(addr, "leser", json!({})).await;
    let h = TigerGraph.health(&conn).await;
    assert!(h.ok, "a warning, not a failure: {h:?}");
    assert_eq!(h.warnings.len(), 1);
    assert_eq!(h.warnings[0].reason, "tigergraph.auth_disabled");
    assert!(h.warnings[0].message.contains("RESTPP.Factory.EnableAuth"));
}

#[tokio::test]
async fn version_3_uses_the_gsqlserver_paths() {
    let (addr, fake) = fake(true).await;
    let conn = connection(addr, "versteckt", json!({})).await;
    let text = "INTERPRET QUERY () FOR GRAPH social { PRINT 1; }";
    TigerGraph.query(&conn, req(json!({ "gsql": text }), json!({}))).await.unwrap();
    assert_eq!(fake.last_body.lock().unwrap().as_str(), text);
    assert_eq!(fake.last_query.lock().unwrap().as_str(), "", "3.x takes the graph from the query text");
    // 3.x cannot list the graph's queries, so no tuple name can be checked: TYPEDEF is refused.
    let typedef = "INTERPRET QUERY () FOR GRAPH social { TYPEDEF TUPLE <INT a> otherQuery; otherQuery(1); }";
    assert_eq!(reason(TigerGraph.query(&conn, req(json!({ "gsql": typedef }), json!({}))).await), "gsql.typedef_name");
    // 3.x has no endpoint for a query's text: only approved installed queries run.
    let r = TigerGraph.query(&conn, req(json!({ "installed": "nachbarn" }), json!({}))).await;
    assert_eq!(reason(r), "tigergraph.query_text_unreadable");
}

#[test]
fn rights_and_parameters() {
    let show = "- Name: x\n- Global Roles: \n- Graph 'social' Roles: queryreader, designer\n";
    assert_eq!(rights_from_show_user(show, "social").unwrap().excess(), ["designer"]);
    assert!(rights_from_show_user("nothing here", "social").is_none());
    // Only global roles and roles on the source's graph count.
    let other = "- Graph 'other' Roles: designer\n- Roles: designer\n- Graph 'social' Roles: queryreader\n";
    assert_eq!(rights_from_show_user(other, "social").unwrap().excess(), Vec::<String>::new());
    let anywhere = "- Graph 'other' Roles: superuser\n- Graph 'social' Roles: queryreader\n";
    assert_eq!(rights_from_show_user(anywhere, "social").unwrap().excess(), ["superuser"]);
    let mut out = Vec::new();
    typed_pairs(
        "v",
        "v",
        &ParamType::Many(Box::new(ParamType::Vertex(None))),
        &json!([{ "type": "Person", "id": 7 }]),
        &mut out,
    )
    .unwrap();
    assert_eq!(out, [("v[0]".to_string(), "7".to_string()), ("v[0].type".to_string(), "Person".to_string())]);
    assert!(typed_pairs("u", "u", &ParamType::Uint, &json!(-1), &mut Vec::new()).is_err());
    // INT is i64: a larger number is refused, not wrapped; UINT takes the whole u64 range.
    for big in [json!(9_223_372_036_854_775_808_u64), json!("9223372036854775808")] {
        assert!(typed_pairs("i", "i", &ParamType::Int, &big, &mut Vec::new()).is_err(), "{big}");
    }
    let mut out = Vec::new();
    typed_pairs("i", "i", &ParamType::Int, &json!(i64::MIN), &mut out).unwrap();
    typed_pairs("u", "u", &ParamType::Uint, &json!(u64::MAX), &mut out).unwrap();
    typed_pairs("u", "u", &ParamType::Uint, &json!("18446744073709551615"), &mut out).unwrap();
    assert_eq!(
        out.iter().map(|(_, v)| v.as_str()).collect::<Vec<_>>(),
        ["-9223372036854775808", "18446744073709551615", "18446744073709551615"]
    );
    assert!(typed_pairs("u", "u", &ParamType::Uint, &json!("18446744073709551616"), &mut Vec::new()).is_err());
    assert!(typed_pairs("b", "b", &ParamType::Bool, &json!("ja"), &mut Vec::new()).is_err());
    assert_eq!(version_from("product release_3.10.1_02-01-2024"), Some("3.10.1".into()));
    assert!(kind().validate_settings(&json!({ "url": "http://tg", "graph": "a/b", "user": "u" })).is_err());
    assert!(kind().validate_settings(&json!({ "url": "http://tg", "graph": "g", "user": "u/../x" })).is_err());
    assert!(
        kind()
            .validate_settings(&json!({ "url": "http://tg", "graph": "g", "user": "u", "approvedQueries": "a;b" }))
            .is_err()
    );
}

/// Dashboard variables reach GSQL only as typed REST++ parameters: text meant to break out of a
/// string stays one URL-encoded value, the query text is sent as written, a multi-value variable
/// fills a `SET` parameter, and a list for a single value is refused before anything is sent.
#[tokio::test]
async fn variables_stay_typed_parameters() {
    let (addr, fake) = fake(false).await;
    let conn = connection(addr, "leser", json!({})).await;
    let text = "INTERPRET QUERY (STRING name, SET<STRING> tags) FOR GRAPH social { SumAccum<INT> @@total; \
                S = {Person.*}; R = SELECT s FROM S:s WHERE s.name == name ACCUM @@total += 1; PRINT @@total; }";
    let attack = "Ana\"; DELETE s FROM Person:s; PRINT \"";
    let r = TigerGraph
        .query(&conn, req(json!({ "gsql": text }), json!({ "name": attack, "tags": ["a&b", "c=d"], "fremd": "x" })))
        .await;
    assert!(r.is_ok(), "{:?}", r.err().map(|e| e.detail().reason));
    assert_eq!(
        fake.last_query.lock().unwrap().as_str(),
        "graph=social&name=Ana%22%3B%20DELETE%20s%20FROM%20Person%3As%3B%20PRINT%20%22&tags=a%26b&tags=c%3Dd",
        "a variable the query does not declare is not sent"
    );
    assert_eq!(fake.last_body.lock().unwrap().as_str(), text);

    *fake.last_query.lock().unwrap() = String::new();
    let r = TigerGraph.query(&conn, req(json!({ "gsql": text }), json!({ "name": ["Ana", "Bo"] }))).await;
    assert_eq!(reason(r), "tigergraph.param_type");
    assert_eq!(fake.last_query.lock().unwrap().as_str(), "", "nothing was sent");

    // Installed queries take them the same way: the variable p fills the vertex parameter.
    let r = TigerGraph
        .query(&conn, req(json!({ "installed": "nachbarn" }), json!({ "p": "1&tiefe=99", "tiefe": 2 })))
        .await;
    assert!(r.is_ok());
    assert_eq!(fake.last_query.lock().unwrap().as_str(), "p=1%26tiefe%3D99&tiefe=2");
}
