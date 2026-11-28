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
use crate::shapes::{GraphSet, TimeRange};

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
    /// The graph the algorithm variants compute on (`kalzit_*`, `algorithms.gsql`), as a
    /// TigerGraph result names it.
    algo_graph: Mutex<Option<GraphSet>>,
    /// Kalzit's variants on the graph, by name, with their texts (listed in the query info).
    installed: Mutex<BTreeMap<String, String>>,
    /// The database holds one edge more between the vertices than any result shows.
    extra_edge: bool,
    /// The JSON bodies of the variants' REST++ calls.
    algorithm_calls: Mutex<Vec<(String, Value)>>,
    /// The database holds the same number of edges between the vertices, but one ends elsewhere.
    other_edge: bool,
    /// The GSQL scripts the install access ran.
    scripts: Mutex<Vec<String>>,
}

/// The install access of the tests: `installer` may only read and install queries,
/// `installer_viel` may also write data.
fn install_auth(h: &AxHeaders) -> Option<&'static str> {
    let given = h.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("");
    ["installer", "installer_viel"].into_iter().find(|u| given == base64_basic(u, "einbau"))
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
            "VertexTypes": [
                { "Name": "Person", "PrimaryId": { "AttributeName": "id", "AttributeType": { "Name": "STRING" } },
                  "Attributes": [{ "AttributeName": "name", "AttributeType": { "Name": "STRING" } },
                                 { "AttributeName": "age", "AttributeType": { "Name": "INT" } }] },
                { "Name": "Ort", "PrimaryId": { "AttributeName": "id", "AttributeType": { "Name": "INT" } },
                  "Attributes": [{ "AttributeName": "name", "AttributeType": { "Name": "STRING" } }] }
            ],
            "EdgeTypes": [
                { "Name": "Friend", "IsDirected": false, "FromVertexTypeName": "Person", "ToVertexTypeName": "Person",
                  "Config": {}, "Attributes": [{ "AttributeName": "since", "AttributeType": { "Name": "INT" } }] },
                { "Name": "Lebt", "IsDirected": true, "FromVertexTypeName": "Person", "ToVertexTypeName": "Ort",
                  "Config": { "REVERSE_EDGE": "reverse_Lebt" }, "Attributes": [] }
            ]
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
        // The install access, with a role of only query privileges, and one that may write data.
        "installer" => json_reply(
            200,
            json!({ "error": false, "results": { "name": "installer", "isSuperUser": false,
                "roles": { "social": ["kalzit_installer"] },
                "privileges": { "social": { "privileges": ["READ_SCHEMA", "READ_QUERY", "CREATE_QUERY", "DROP_QUERY",
                    "INSTALL_QUERY"] } } } }),
        ),
        "installer_viel" => json_reply(
            200,
            json!({ "error": false, "results": { "name": "installer_viel", "isSuperUser": false,
                "roles": { "social": ["kalzit_viel"] },
                "privileges": { "social": { "privileges": ["READ_SCHEMA", "CREATE_QUERY", "INSTALL_QUERY",
                    "CREATE_DATA", "WRITE_SCHEMA"] } } } }),
        ),
        // Not allowed to read its own record (4.2.5 lets a queryreader read it; older or other
        // setups may not): Kalzit asks with SHOW USER.
        _ => json_reply(403, json!({ "error": true, "message": "Permission denied: READ_USER" })),
    }
}

async fn statements(State(s): State<S>, h: AxHeaders, body: String) -> Response {
    if body.starts_with("USE GRAPH social\n") {
        // Only the install access runs scripts, and only Kalzit's own.
        assert!(install_auth(&h).is_some(), "scripts run with the install access only");
        s.scripts.lock().unwrap().push(body.clone());
        let mut installed = s.installed.lock().unwrap();
        for line in body.lines() {
            if let Some(names) = line.strip_prefix("DROP QUERY ") {
                for n in names.split(", ") {
                    assert!(n.starts_with("kalzit_"), "never another query: {n}");
                    installed.remove(n);
                }
            }
        }
        for part in body.split("CREATE QUERY ").skip(1) {
            let text = format!("CREATE QUERY {}", &part[..=part.rfind('}').unwrap()]);
            let name = text["CREATE QUERY ".len()..].split('(').next().unwrap().to_string();
            assert!(!installed.contains_key(&name), "{name} was dropped before");
            installed.insert(name, text);
        }
        return (AxStatus::OK, "Successfully created queries.\nQuery installation finished.").into_response();
    }
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

async fn query_text(
    State(s): State<S>,
    h: AxHeaders,
    Path(name): Path<String>,
    Query(q): Query<BTreeMap<String, String>>,
) -> Response {
    assert_eq!(q.get("graph").map(String::as_str), Some("social"));
    // The install access may read query texts (READ_QUERY), the reader may not.
    if install_auth(&h).is_some() {
        return match s.installed.lock().unwrap().get(&name) {
            Some(text) => json_reply(200, json!({ "error": false, "results": { "name": name, "queryContent": text } })),
            None => json_reply(404, json!({ "error": true, "message": format!("Query {name} not found") })),
        };
    }
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
    // Kalzit's variants as 4.2.5 describes untyped vertex sets, text sets and numbers.
    let vertices = |i: u64, n: &str| {
        [
            (
                n.to_string(),
                json!({ "index": i, "id_type": format!("${n}.type"), "type": "STRING", "is_id": "true",
                                     "max_count": 2_147_483_647_u64, "min_count": 0 }),
            ),
            (format!("{n}.type"), json!({ "index": i + 1, "type": "STRING", "min_count": 0 })),
        ]
    };
    let mut all: Vec<(String, bool, Value)> = all.iter().map(|(n, u, p)| (n.to_string(), *u, p.clone())).collect();
    let installed: Vec<String> = s.installed.lock().unwrap().keys().cloned().collect();
    for name in &installed {
        let mut params: Map<String, Value> = vertices(0, "nodes").into_iter().collect();
        params.insert("edge_types".into(), json!({ "index": 2, "type": "STRING", "max_count": 2_147_483_647_u64 }));
        let mut i = 3;
        let signature = algorithms::signature(name).unwrap();
        for (p, ty) in &signature[2..] {
            match ty {
                ParamType::Many(_) => {
                    params.extend(vertices(i, p));
                    i += 2;
                    continue;
                }
                ParamType::Float => params.insert((*p).into(), json!({ "index": i, "type": "DOUBLE" })),
                ParamType::Int => params.insert((*p).into(), json!({ "index": i, "type": "INT64" })),
                _ => params.insert((*p).into(), json!({ "index": i, "type": "STRING" })),
            };
            i += 1;
        }
        all.push((name.clone(), false, Value::Object(params)));
    }
    let mut results: Vec<Value> = all
        .iter()
        .filter(|(n, _, _)| q.get("query").is_none_or(|w| w == n))
        .map(|(n, update, params)| {
            json!({ "name": n, "installed": true, "graphUpdate": update, "status": "VALID", "syntax": "GSQL v2",
                    "endpoint": { "query": { "social": { n.as_str(): { "GET/POST": {
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
    let results = if body.contains("kalzit_near") {
        explored()
    } else if body.contains("@@kalzit_types") {
        json!([{ "@@kalzit_types": { "Person": 3, "Ort": 1 } }])
    } else if body.contains("PRINT R") {
        results_for("nachbarn")
    } else {
        results_for("zahlen")
    };
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
        .route("/restpp/query/{graph}/{name}", get(restpp_query).post(restpp_algorithm))
        .route("/restpp/version", get(version))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, state)
}

async fn connection(addr: std::net::SocketAddr, user: &str, extra: Value) -> Connection {
    connection_as("ds", addr, user, extra).await
}

/// `connection` for the data source `id` (the per-source lock of the algorithm queries is keyed by it).
async fn connection_as(id: &str, addr: std::net::SocketAddr, user: &str, extra: Value) -> Connection {
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
    Connection::new(id, settings, secrets, policy, own)
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
        filters: Vec::new(),
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
    let SourceSchema::Graph { labels, edge_types, property_keys, queries, query_params, gsql } =
        TigerGraph.schema(&conn).await.unwrap()
    else {
        panic!("a graph schema")
    };
    assert_eq!(labels, ["Person", "Ort"]);
    assert_eq!(edge_types, ["Friend", "Lebt"]);
    assert_eq!(property_keys, ["age", "name", "since"]);
    // From the query info, which a queryreader may read; the plain query list is empty for it.
    assert_eq!(queries, ["extra", "geheim", "loescht", "nachbarn", "ohne_flag", "schreibt_geheim", "verboten"]);
    let types: Vec<String> = query_params["geheim"].iter().map(|p| format!("{} {}", p.ty, p.name)).collect();
    assert_eq!(types, ["INT k", "STRING name", "SET<INT> liste", "VERTEX v", "VERTEX<Person> p"]);
    assert_eq!(query_params["nachbarn"], []);
    // GSQL completion: the types with their attributes and directions, and the accumulators.
    let gsql = gsql.unwrap();
    assert_eq!(gsql.vertex_types[0].name, "Person");
    assert_eq!(gsql.vertex_types[0].attributes.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["name", "age"]);
    assert_eq!(gsql.edge_types[0].directions, [crate::shapes::GsqlDirection::Undirected]);
    assert!(gsql.accumulators.iter().any(|a| a.name == "SumAccum"));
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

// ---- 0.8.3: explorer, step in the database, algorithm queries ----

/// As 4.2.5 answers the explorer's neighbours of Ana (shortened): her, one neighbour reached
/// through a reverse edge type, the edges, the generated query's own accumulators.
fn explored() -> Value {
    json!([
        { "kalzit_start": [{ "v_id": "1", "v_type": "Person", "attributes": { "name": "Ana", "@kalzit_pick": false } }] },
        { "kalzit_near": [{ "v_id": "7", "v_type": "Ort", "attributes": { "name": "Bonn", "@kalzit_pick": false } },
                          { "v_id": "2", "v_type": "Person", "attributes": { "name": "Bo", "@kalzit_pick": false } }] },
        { "@@kalzit_edges": [
            { "e_type": "Lebt", "from_type": "Person", "from_id": "1", "to_type": "Ort", "to_id": "7", "directed": true, "attributes": {} },
            { "e_type": "Friend", "from_type": "Person", "from_id": "1", "to_type": "Person", "to_id": "2", "directed": false, "attributes": {} }
        ] }
    ])
}

#[tokio::test]
async fn explorer_neighbours_run_as_gsql_made_from_the_schema() {
    let (addr, fake) = fake(false).await;
    let conn = connection(addr, "leser", json!({})).await;
    let q = json!({ "explore": { "op": "neighbours", "node": "Person:1", "limit": 10 } });
    let r = TigerGraph.query(&conn, req(q, json!({ "kalzit_node": "99" }))).await.unwrap();
    let body = fake.last_body.lock().unwrap().clone();
    assert!(body.starts_with("INTERPRET QUERY (VERTEX<Person> kalzit_node) FOR GRAPH social"), "{body}");
    assert!(body.contains("-(Friend|Lebt>:e)- :t"), "{body}");
    assert_eq!(fake.last_query.lock().unwrap().as_str(), "graph=social&kalzit_node=1", "the id, not a variable");
    let QueryResult::Graph { graph } = r else { panic!("a graph") };
    let ids: Vec<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids, ["Person:1", "Ort:7", "Person:2"]);
    assert_eq!(graph.nodes[0].properties.keys().collect::<Vec<_>>(), ["name"], "no accumulators of Kalzit's own");
    assert_eq!(graph.edges.len(), 2);
    // Against the direction: the reverse type, the answer as the edge itself.
    let q = json!({ "explore": { "op": "neighbours", "node": "Ort:7", "direction": "in" } });
    assert!(TigerGraph.query(&conn, req(q, json!({}))).await.is_ok());
    assert!(fake.last_body.lock().unwrap().contains("-(reverse_Lebt>:e)- :t"));
    // Unknown names never reach the server; neither do params next to an explorer form.
    let q = json!({ "explore": { "op": "neighbours", "node": "Person:1", "edgeTypes": ["Kennt"] } });
    assert_eq!(reason(TigerGraph.query(&conn, req(q, json!({}))).await), "tigergraph.explore_type_unknown");
    let q = json!({ "explore": { "op": "count", "node": "Person:1" }, "params": { "x": 1 } });
    assert_eq!(reason(TigerGraph.query(&conn, req(q, json!({}))).await), "query.invalid_form");
}

#[tokio::test]
async fn vertex_types_are_counted_in_the_database() {
    let (addr, fake) = fake(false).await;
    let conn = connection(addr, "leser", json!({})).await;
    let original = json!({ "gsql": "INTERPRET QUERY () FOR GRAPH social { S = {Person.*}; PRINT S; }" });
    let step = crate::analysis::parse_step(&json!({ "id": "s", "frame": "A", "type": "countLabels" })).unwrap().kind;
    let pushed = TigerGraph.pushdown(&original, &step, 1000).unwrap();
    let r = TigerGraph.query(&conn, req(pushed, json!({}))).await.unwrap();
    assert!(fake.last_body.lock().unwrap().contains("PRINT @@kalzit_types;"));
    let r = crate::analysis::pushdown::normalize(&step, r, 1000).unwrap();
    let QueryResult::Frame { frame } = r else { panic!("a table") };
    assert_eq!(frame.fields()[0].values, [json!("Person"), json!("Ort")]);
    assert_eq!(frame.fields()[1].values, [json!(3.0), json!(1.0)]);
}

/// A conformance graph as a TigerGraph result: vertices `V:<id>` (their labels kept for the steps
/// that filter by label) with their name in `kz`, edges
/// with TigerGraph's ids (`Type:a->b`).
fn tigergraph_graph(cases: &Value, name: &str) -> GraphSet {
    let g = &cases["algorithmGraphs"][name];
    let mut out: GraphSet = serde_json::from_value(g.clone()).unwrap();
    for n in &mut out.nodes {
        n.properties.insert("kz".into(), json!(n.id));
        n.id = format!("V:{}", n.id);
    }
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for e in &mut out.edges {
        e.properties.insert("kz".into(), json!(e.id));
        e.from = format!("V:{}", e.from);
        e.to = format!("V:{}", e.to);
        let base = format!("{}:{}->{}", e.edge_type, e.from, e.to);
        let n = seen.entry(base.clone()).or_default();
        *n += 1;
        e.id = if *n == 1 { base } else { format!("{base}#{n}") };
    }
    out
}

/// REST++ running one of Kalzit's variants, as the real query computes it: on the given
/// vertices and the edges of the given types between them, here with Kalzit's own server
/// algorithms, so the fake checks the way there and back (parameters, answer, edge count).
async fn restpp_algorithm(
    State(s): State<S>,
    Path((graph, name)): Path<(String, String)>,
    h: AxHeaders,
    body: String,
) -> Response {
    assert_eq!(graph, "social");
    let bearer =
        h.get("authorization").and_then(|v| v.to_str().ok()).map(|v| v.trim_start_matches("Bearer ").to_string());
    if bearer.is_none() || bearer != *s.valid_token.lock().unwrap() {
        return json_reply(403, json!({ "error": true, "message": "Access Denied", "code": "REST-10016" }));
    }
    assert_eq!(h.get("content-type").and_then(|v| v.to_str().ok()), Some("application/json"));
    let p: Value = serde_json::from_str(&body).unwrap();
    s.algorithm_calls.lock().unwrap().push((name.clone(), p.clone()));
    let full = s.algo_graph.lock().unwrap().clone().unwrap();
    let ids = |v: &Value| -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| format!("{}:{}", x["type"].as_str().unwrap(), x["id"].as_str().unwrap()))
            .collect()
    };
    let nodes = ids(&p["nodes"]);
    let types: Vec<String> = serde_json::from_value(p["edge_types"].clone()).unwrap();
    let sub = GraphSet {
        nodes: full.nodes.iter().filter(|n| nodes.contains(&n.id)).cloned().collect(),
        edges: full
            .edges
            .iter()
            .filter(|e| types.contains(&e.edge_type) && nodes.contains(&e.from) && nodes.contains(&e.to))
            .cloned()
            .collect(),
        ..Default::default()
    };
    let edges = sub.edges.len() + usize::from(s.extra_edge);
    let (step, outputs) = match name.as_str() {
        "kalzit_pagerank" => (
            json!({ "type": "centrality", "measure": "pageRank", "direction": p["direction"], "damping": p["damping"],
                    "maxIterations": p["max_iterations"], "tolerance": p["tolerance"] }),
            vec![("kalzit_value", "pagerank")],
        ),
        "kalzit_wcc" => {
            (json!({ "type": "communities", "algorithm": "weaklyConnected" }), vec![("kalzit_value", "component")])
        }
        "kalzit_kcore" => (json!({ "type": "kCore" }), vec![("kalzit_value", "core")]),
        "kalzit_triangles" => {
            (json!({ "type": "triangles" }), vec![("kalzit_value", "triangles"), ("kalzit_clustering", "clustering")])
        }
        "kalzit_reachable" => (
            json!({ "type": "reachable", "from": ids(&p["starts"]), "maxHops": p["max_hops"], "direction": p["direction"] }),
            vec![("kalzit_value", "distance")],
        ),
        other => panic!("{other}"),
    };
    let mut step = step;
    step["id"] = json!("s");
    step["frame"] = json!("A");
    let kind = crate::analysis::parse_step(&step).unwrap().kind;
    let control = crate::analysis::steps::Control::new(Arc::new(std::sync::atomic::AtomicBool::new(false)), 10)
        .with_algorithm_limits(Default::default())
        .with_algorithm_slot(true);
    let (crate::analysis::graph::GraphOut::Graph(out), _) =
        crate::analysis::graph::apply_summarized(&kind, &sub, &control).unwrap()
    else {
        panic!("a graph")
    };
    let vertices: Vec<Value> = out
        .nodes
        .iter()
        .map(|n| {
            let (ty, id) = n.id.split_once(':').unwrap();
            let attrs: Map<String, Value> = outputs
                .iter()
                .map(|(acc, prop)| (format!("kalzit_all.@{acc}"), n.properties.get(*prop).cloned().unwrap_or(json!(0))))
                .collect();
            json!({ "v_id": id, "v_type": ty, "attributes": attrs })
        })
        .collect();
    let mut seen = sub.edges.clone();
    if s.other_edge
        && let (Some(first), Some(last)) = (seen.first().cloned(), sub.nodes.last())
    {
        seen[0].to = if first.to == last.id { first.from.clone() } else { last.id.clone() };
    }
    let ends = crate::analysis::algo::library::edge_ends(seen.iter());
    let ends: Vec<Value> = sub
        .nodes
        .iter()
        .map(|n| {
            let (ty, id) = n.id.split_once(':').unwrap();
            let counts = ends.get(&n.id).cloned().unwrap_or_default();
            json!({ "v_id": id, "v_type": ty, "attributes": { "kalzit_all.@kalzit_ends": counts } })
        })
        .collect();
    json_reply(
        200,
        json!({ "error": false, "results": [{ "edges": edges }, { "kalzit_ends": ends }, { "kalzit_all": vertices }] }),
    )
}

/// Runs one step after a TigerGraph result as a query does, with the source's library.
async fn step_after(conn: &Connection, graph: &GraphSet, step: Value) -> (QueryResult, crate::shapes::StepPlace) {
    let mut step = step;
    step["id"] = json!("s");
    step["frame"] = json!("A");
    let parsed = crate::analysis::parse_step(&step).unwrap();
    let after = crate::datasources::AfterQuery {
        name: "A".into(),
        in_source: false,
        timeout_secs: 10,
        algorithms: Default::default(),
    };
    let result = QueryResult::Graph { graph: graph.clone() };
    let (result, mut places) =
        crate::datasources::graph_steps_after(&TigerGraph, conn, vec![parsed], result, after).await.unwrap();
    (result, places.remove(0))
}

/// The conformance cases the variants take, against the fake: each runs in the database (as far
/// as the route sends it there) and passes the case's checks for a library.
#[tokio::test]
async fn algorithm_steps_run_in_the_installed_variants() {
    use crate::analysis::algo::library;
    let cases: Value = serde_json::from_str(include_str!("../../analysis/conformance.json")).unwrap();
    let installed: BTreeMap<String, String> =
        algorithms::shipped("social").into_iter().map(|(n, t)| (n.to_string(), t)).collect();
    let mut in_database = 0;
    for case in cases["algorithms"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        if case.get("error").is_some() || case["step"]["type"] == "mergeNodes" {
            continue;
        }
        let graph = tigergraph_graph(&cases, case["graph"].as_str().unwrap());
        let (addr, fake) = fake_with(Fake { installed: Mutex::new(installed.clone()), ..Fake::default() }).await;
        *fake.algo_graph.lock().unwrap() = Some(graph.clone());
        // Approved by name: the reader cannot read their texts; TigerGraph says they only read.
        let approved = algorithms::shipped("social").iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", ");
        let conn = connection(addr, "leser", json!({ "approvedQueries": approved })).await;
        let mut step = case["step"].clone();
        for key in ["from", "to"] {
            match step.get(key).cloned() {
                Some(Value::String(s)) => step[key] = json!(format!("V:{s}")),
                Some(Value::Array(l)) => {
                    step[key] = Value::Array(l.iter().map(|v| json!(format!("V:{}", v.as_str().unwrap()))).collect())
                }
                _ => {}
            }
        }
        let (result, place) = step_after(&conn, &graph, step.clone()).await;
        assert!(place.error.is_none(), "{name}: {place:?}");
        let kind = {
            let mut s = step.clone();
            s["id"] = json!("s");
            s["frame"] = json!("A");
            crate::analysis::parse_step(&s).unwrap().kind
        };
        let routed = library::route(Some(library::Library::TigerGraph), &kind, &graph, &Default::default());
        let in_library = place.ran_in == crate::shapes::RanIn::Database;
        assert_eq!(in_library, matches!(routed, Ok(Ok(_))), "{name}: {place:?}");
        if in_library {
            in_database += 1;
        } else {
            assert!(place.reason.is_some(), "{name}: a step on the server says why");
        }
        let out = match result {
            QueryResult::Graph { graph } => graph,
            _ => GraphSet::default(),
        };
        crate::analysis::algo::conformance::check_case(case, &out, place.summary.as_ref(), in_library)
            .unwrap_or_else(|e| panic!("{e}"));
    }
    assert!(in_database >= 8, "{in_database} cases ran in the variants");
}

#[tokio::test]
async fn a_variant_on_other_edges_or_not_installed_leaves_the_step_to_the_server() {
    use crate::analysis::algo::library::reason;
    let cases: Value = serde_json::from_str(include_str!("../../analysis/conformance.json")).unwrap();
    let graph = tigergraph_graph(&cases, "triangles");
    let installed: BTreeMap<String, String> =
        algorithms::shipped("social").into_iter().map(|(n, t)| (n.to_string(), t)).collect();
    let approved =
        json!({ "approvedQueries": "kalzit_pagerank, kalzit_wcc, kalzit_kcore, kalzit_triangles, kalzit_reachable" });
    // The database has an edge between the vertices that the result does not show.
    let (addr, extra) = fake_with(Fake { installed: Mutex::new(installed), extra_edge: true, ..Fake::default() }).await;
    *extra.algo_graph.lock().unwrap() = Some(graph.clone());
    let conn = connection(addr, "leser", approved.clone()).await;
    let (_, place) = step_after(&conn, &graph, json!({ "type": "kCore" })).await;
    assert_eq!(place.ran_in, crate::shapes::RanIn::Server);
    assert_eq!(place.reason.as_deref(), Some(reason::SUBGRAPH_DIFFERS));
    // As many edges, but one with other ends.
    let installed: BTreeMap<String, String> =
        algorithms::shipped("social").into_iter().map(|(n, t)| (n.to_string(), t)).collect();
    let (addr, other) = fake_with(Fake { installed: Mutex::new(installed), other_edge: true, ..Fake::default() }).await;
    *other.algo_graph.lock().unwrap() = Some(graph.clone());
    let conn = connection(addr, "leser", approved.clone()).await;
    let (_, place) = step_after(&conn, &graph, json!({ "type": "kCore" })).await;
    assert_eq!(place.reason.as_deref(), Some(reason::SUBGRAPH_DIFFERS), "{place:?}");
    // Not installed: said, and not asked again for a while.
    let (addr, fake) = fake(false).await;
    let conn = connection(addr, "leser", approved).await;
    let (_, place) = step_after(&conn, &graph, json!({ "type": "kCore" })).await;
    assert_eq!(place.reason.as_deref(), Some(reason::NOT_INSTALLED));
    let (_, place) = step_after(&conn, &graph, json!({ "type": "kCore" })).await;
    assert_eq!(place.reason.as_deref(), Some(reason::NOT_INSTALLED));
    assert!(fake.algorithm_calls.lock().unwrap().is_empty());
    // Installed but neither readable nor approved: not shown to only read.
    let installed: BTreeMap<String, String> =
        algorithms::shipped("social").into_iter().map(|(n, t)| (n.to_string(), t)).collect();
    let (addr, _) = fake_with(Fake { installed: Mutex::new(installed), ..Fake::default() }).await;
    let conn = connection(addr, "leser", json!({})).await;
    let (_, place) = step_after(&conn, &graph, json!({ "type": "kCore" })).await;
    assert_eq!(place.reason.as_deref(), Some(reason::NOT_VERIFIED));
}

/// The install access: off without the switch, refused when it may do too much, installs only
/// what was confirmed, records what it installed, and Kalzit runs a query only while its text
/// has the stored checksum.
#[tokio::test]
async fn the_install_access_installs_kalzits_queries_only_when_confirmed() {
    const ADMIN: AlgorithmsView = AlgorithmsView { installer: true, replace_changed: false };
    use crate::analysis::algo::library::reason;
    use crate::shapes::TigerGraphAlgorithmState as St;
    let cases: Value = serde_json::from_str(include_str!("../../analysis/conformance.json")).unwrap();
    let graph = tigergraph_graph(&cases, "triangles");
    let (addr, fake) = fake(false).await;
    *fake.algo_graph.lock().unwrap() = Some(graph.clone());
    let with = |user: &str, on: bool| json!({ "installAlgorithms": on, "installUser": user });
    let install_conn = |settings: Value| async move {
        let mut c = connection(addr, "leser", settings).await;
        c.secrets.insert("installPassword".into(), Zeroizing::new("einbau".into()));
        c
    };
    // The switch off: no install access, as before.
    let off = install_conn(with("installer", false)).await;
    let s = algorithms_status(&off, &[], ADMIN).await.unwrap();
    assert!(!s.install_credential && s.install.is_none());
    assert!(s.queries.iter().all(|q| q.state == St::Missing));
    // An install access that may write data is refused.
    let much = install_conn(with("installer_viel", true)).await;
    let e = algorithms_status(&much, &[], ADMIN).await.unwrap_err();
    assert_eq!(e.detail().reason, "tigergraph.install_user_too_much");
    assert!(e.detail().params["privileges"].contains("CREATE_DATA"));
    // The install needs the checksum of exactly the shown GSQL.
    let conn = install_conn(with("installer", true)).await;
    let s = algorithms_status(&conn, &[], ADMIN).await.unwrap();
    let script = s.install.clone().unwrap();
    assert!(!script.contains("DROP"), "nothing to replace: {script}");
    let e = install_algorithms(&conn, &[], "0000", false).await.unwrap_err();
    assert_eq!(e.detail().reason, "tigergraph.install_script_changed");
    assert!(fake.scripts.lock().unwrap().is_empty(), "nothing ran");
    let (after, installed) =
        install_algorithms(&conn, &[], s.install_checksum.as_deref().unwrap(), false).await.unwrap();
    assert_eq!(fake.scripts.lock().unwrap().as_slice(), [script]);
    assert!(after.queries.iter().all(|q| q.state == St::Current));
    assert_eq!(installed.len(), algorithms::shipped("social").len());
    assert!(after.install.is_none(), "all current: nothing to install");
    // What Kalzit installed is recorded, as the route does.
    let db = conn.own_database().pool();
    sqlx::query("PRAGMA foreign_keys = OFF").execute(db).await.unwrap();
    for (name, sum) in &installed {
        sqlx::query(
            "INSERT INTO tigergraph_installed_queries (datasource_id, name, version, checksum, installed_at) \
             VALUES ('ds', $1, 1, $2, 0)",
        )
        .bind(name)
        .bind(sum)
        .execute(db)
        .await
        .unwrap();
    }
    // Runs in the database with the query access, the text checked with the install access.
    let (_, place) = step_after(&conn, &graph, json!({ "type": "kCore" })).await;
    assert_eq!(place.ran_in, crate::shapes::RanIn::Database, "{place:?}");
    // Changed in the database: not run, said so.
    fake.installed.lock().unwrap().get_mut("kalzit_kcore").unwrap().push_str("\n// geändert");
    // The verified checksum is trusted for two minutes; an install through Kalzit forgets it.
    client(&conn).await.unwrap().verified.lock().unwrap().clear();
    let (_, place) = step_after(&conn, &graph, json!({ "type": "kCore" })).await;
    assert_eq!(place.reason.as_deref(), Some(reason::CHANGED_IN_DATABASE), "{place:?}");
    let recorded: Vec<String> = installed.iter().map(|(n, _)| n.clone()).collect();
    let s = algorithms_status(&conn, &recorded, ADMIN).await.unwrap();
    assert_eq!(s.queries.iter().find(|q| q.name == "kalzit_kcore").unwrap().state, St::Changed);
    assert!(s.install.is_none(), "a changed query blocks the install unless replacing it is asked for");
    let e = install_algorithms(&conn, &recorded, "x", false).await.unwrap_err();
    assert_eq!(e.detail().reason, "tigergraph.install_changed_query");
    let view = AlgorithmsView { installer: true, replace_changed: true };
    let s = algorithms_status(&conn, &recorded, view).await.unwrap();
    let script = s.install.as_deref().unwrap();
    assert!(s.replace_changed);
    assert!(
        script.starts_with("// Replaces queries changed in the database since Kalzit installed them: kalzit_kcore\n")
    );
    assert!(script.contains("DROP QUERY kalzit_kcore\n"), "{script}");
    // A reader sees the states Kalzit can tell without the install access, and no scripts.
    let s = algorithms_status(&conn, &recorded, AlgorithmsView::default()).await.unwrap();
    assert!(s.queries.iter().all(|q| q.state == St::Present) && s.install.is_none() && s.remove.is_none());
    // Someone else's query of the same name: shown, no install, and never run.
    let other = install_conn(with("installer", true)).await;
    let (_, place) = step_after(&other, &graph, json!({ "type": "kCore" })).await;
    assert_eq!(place.reason.as_deref(), Some(reason::NOT_VERIFIED), "{place:?}");
    let s = algorithms_status(&conn, &[], ADMIN).await.unwrap();
    assert_eq!(s.queries.iter().find(|q| q.name == "kalzit_kcore").unwrap().state, St::Foreign);
    assert!(s.install.is_none() && s.remove.is_none(), "never touches another's query: {s:?}");
    let e = install_algorithms(&conn, &[], "x", false).await.unwrap_err();
    assert_eq!(e.detail().reason, "tigergraph.install_name_taken");
    // Removal: only what Kalzit installed, with the confirmed checksum.
    let s = algorithms_status(&conn, &recorded, ADMIN).await.unwrap();
    let (after, removed) = remove_algorithms(&conn, &recorded, s.remove_checksum.as_deref().unwrap()).await.unwrap();
    assert_eq!(removed.len(), recorded.len());
    assert!(after.queries.iter().all(|q| q.state == St::Missing));
    assert!(fake.installed.lock().unwrap().is_empty());
}

#[test]
fn the_install_access_fails_closed() {
    let user = |privileges: Value, roles: Value, superuser: Value| {
        json!({ "error": false, "results": { "name": "i", "isSuperUser": superuser, "roles": { "social": roles },
                "privileges": { "social": { "privileges": privileges } } } })
    };
    let ok = json!(["READ_SCHEMA", "READ_QUERY", "CREATE_QUERY", "DROP_QUERY", "INSTALL_QUERY"]);
    assert_eq!(install_problem(&user(ok.clone(), json!(["kalzit_installer"]), json!(false)), "i"), None);
    let reason = |body: Value| install_problem(&body, "i");
    assert_eq!(reason(user(json!([]), json!(["r"]), json!(false))).unwrap().0, "tigergraph.install_user_unverifiable");
    assert_eq!(
        reason(user(json!(["READ_SCHEMA", "CREATE_QUERY"]), json!(["r"]), json!(false))).unwrap().0,
        "tigergraph.install_user_unverifiable",
        "without INSTALL_QUERY it cannot install"
    );
    let much = reason(user(
        json!(["CREATE_QUERY", "INSTALL_QUERY", "EXECUTE_QUERY", "READ_DATA"]),
        json!(["r"]),
        json!(false),
    ));
    assert_eq!(much, Some(("tigergraph.install_user_too_much", "EXECUTE_QUERY, READ_DATA".to_string())));
    for role in ["designer", "globaldesigner", "admin", "architect", "superuser"] {
        let r = reason(user(ok.clone(), json!([role]), json!(false))).unwrap();
        assert_eq!(r, ("tigergraph.install_user_too_much", role.to_string()));
    }
    assert_eq!(reason(user(ok.clone(), json!(["r"]), json!(true))).unwrap().1, "superuser");
    assert_eq!(reason(user(ok.clone(), json!(["r"]), Value::Null)).unwrap().1, "superuser", "unknown is not no");
    // Privileges anywhere under privileges count, also below a query.
    let nested = json!({ "results": { "name": "i", "isSuperUser": false, "roles": { "social": ["r"] },
        "privileges": { "social": { "privileges": ok, "childPermissions": { "q": { "privileges": ["DELETE_DATA"] } } } } } });
    assert_eq!(reason(nested).unwrap().1, "DELETE_DATA");
    assert_eq!(reason(json!({ "results": { "name": "other" } })).unwrap().0, "tigergraph.install_user_unverifiable");
}

#[test]
fn the_install_user_is_another_user() {
    let s = json!({ "url": "http://tg:14240", "graph": "social", "user": "leser", "installUser": "leser" });
    assert_eq!(kind().validate_settings(&s).unwrap_err().detail.reason, "settings.install_user_same");
    let s = json!({ "url": "http://tg:14240", "graph": "social", "user": "leser", "installUser": "a b" });
    assert_eq!(kind().validate_settings(&s).unwrap_err().detail.reason, "settings.name_invalid");
}

/// While Kalzit installs or removes the queries of a source, its algorithm steps run on the
/// server with `algorithm.busy`, which is not remembered: the next run uses the database again.
/// A second install or removal meanwhile is answered at once.
#[tokio::test]
async fn an_install_in_progress_keeps_steps_out_only_meanwhile() {
    use crate::analysis::algo::library::reason;
    let cases: Value = serde_json::from_str(include_str!("../../analysis/conformance.json")).unwrap();
    let graph = tigergraph_graph(&cases, "triangles");
    let installed: BTreeMap<String, String> =
        algorithms::shipped("social").into_iter().map(|(n, t)| (n.to_string(), t)).collect();
    let (addr, fake) = fake_with(Fake { installed: Mutex::new(installed), ..Fake::default() }).await;
    *fake.algo_graph.lock().unwrap() = Some(graph.clone());
    let approved = json!({ "approvedQueries": "kalzit_kcore" });
    // An id of its own: the lock is per source and process-wide.
    let conn = connection_as("ds-busy", addr, "leser", approved).await;
    let lock = crate::datasources::tigergraph_lock("ds-busy");
    {
        let _install = crate::datasources::install_guard(&lock).unwrap();
        let second = crate::datasources::install_guard(&lock).unwrap_err();
        assert_eq!(second.reason.unwrap().code, "tigergraph.install_busy");
        let (_, place) = step_after(&conn, &graph, json!({ "type": "kCore" })).await;
        assert_eq!(place.ran_in, crate::shapes::RanIn::Server);
        assert_eq!(place.reason.as_deref(), Some(reason::BUSY), "{place:?}");
    }
    let (_, place) = step_after(&conn, &graph, json!({ "type": "kCore" })).await;
    assert_eq!(place.ran_in, crate::shapes::RanIn::Database, "not remembered: {place:?}");
    // A reader looking at the status takes no lock, so steps keep running in the database.
    assert!(crate::datasources::install_guard(&lock).is_ok());
}
