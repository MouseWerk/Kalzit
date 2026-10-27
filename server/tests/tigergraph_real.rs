//! TigerGraph against a real instance, through the router. The tests are ignored by default: the
//! nightly job (.github/workflows/tigergraph-nightly.yml) starts the Community Edition image, sets
//! it up with .github/tigergraph/setup.sh and runs
//! `cargo test --test tigergraph_real -- --ignored` with `KALZIT_TEST_TIGERGRAPH_URL` set to the
//! server (`http://127.0.0.1:14240`). Run with --ignored but without the URL, they fail.
//!
//! The users, graphs, data and queries are the ones setup.sh creates. The same rules run on every
//! PR against a fake server in `src/datasources/tigergraph/tests.rs`.

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
const READER: (&str, &str) = ("kalzit_leser", "leser-Passwort1");
const WRITER: (&str, &str) = ("kalzit_schreiber", "schreiber-Passwort1");
const SUPERUSER: (&str, &str) = ("tigergraph", "tigergraph");

fn url() -> String {
    std::env::var("KALZIT_TEST_TIGERGRAPH_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .expect("KALZIT_TEST_TIGERGRAPH_URL names the TigerGraph server, e.g. http://127.0.0.1:14240")
}

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

    /// A TigerGraph source for the graph `social` as `user`, with extra settings.
    async fn source(&self, (user, password): (&str, &str), extra: Value) -> String {
        let mut settings = json!({ "url": url(), "graph": "social", "user": user });
        for (k, v) in extra.as_object().unwrap() {
            settings[k] = v.clone();
        }
        let body = json!({ "name": format!("TigerGraph {user} {}", uuid::Uuid::now_v7().simple()), "kind": "tigergraph", "settings": settings,
                           "secrets": { "password": password } });
        let (status, body) = self.send(Method::POST, "/datasources", Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body["id"].as_str().unwrap().to_string()
    }

    async fn query(&self, id: &str, query: Value) -> Value {
        let body = json!({
            "queries": [{ "refId": "A", "datasourceId": id, "query": query }],
            "timeRange": { "from": 1_700_000_000_000_i64, "to": 1_800_000_000_000_i64 },
            "variables": { "name": "Ana" }
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

fn ids(list: &Value) -> Vec<String> {
    let mut out: Vec<String> = list.as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap().to_string()).collect();
    out.sort();
    out
}

fn field<'a>(r: &'a Value, name: &str) -> &'a Value {
    r["result"]["frame"]["fields"]
        .as_array()
        .unwrap_or_else(|| panic!("a frame: {r}"))
        .iter()
        .find(|f| f["name"] == name)
        .unwrap_or_else(|| panic!("a field {name}: {r}"))
}

const PRINT_EDGES: &str = "INTERPRET QUERY (STRING name) FOR GRAPH social { SetAccum<EDGE> @@kanten; \
    SumAccum<INT> @@anzahl; S = {Person.*}; \
    R = SELECT t FROM S:s -(Friend:e)- Person:t WHERE s.name == name ACCUM @@kanten += e, @@anzahl += 1; \
    W = SELECT o FROM S:s -(Lebt>:e)- Ort:o WHERE s.name == name ACCUM @@kanten += e; \
    PRINT R; PRINT W; PRINT @@kanten; PRINT @@anzahl; }";

/// The reader user: health, schema with the query picker, interpreted and installed queries,
/// vertex and edge sets as a graph, other values as a frame.
#[tokio::test]
#[ignore = "needs a real TigerGraph (KALZIT_TEST_TIGERGRAPH_URL), see the nightly job"]
async fn reader_reads_graphs_and_frames() {
    let t = T::new().await;
    let id = t.source(READER, json!({})).await;
    let h = t.health(&id).await;
    eprintln!("health: {h}");
    assert_eq!(h["ok"], true, "{h}");
    assert_eq!(h["params"]["engine"], "TigerGraph", "{h}");
    assert!(h["params"]["version"].as_str().unwrap().starts_with('4'), "{h}");

    let schema = t.schema(&id).await;
    eprintln!("schema: {schema}");
    assert_eq!(schema["kind"], "graph", "{schema}");
    assert_eq!(schema["labels"], json!(["Person", "Ort"]), "{schema}");
    assert_eq!(schema["edgeTypes"], json!(["Friend", "Lebt"]), "{schema}");
    for key in ["name", "age", "gross", "since"] {
        assert!(schema["propertyKeys"].as_array().unwrap().contains(&json!(key)), "{key}: {schema}");
    }

    // Interpreted: printed vertex and edge sets become one graph; edges only when printed.
    let r = t.query(&id, json!({ "gsql": PRINT_EDGES })).await;
    eprintln!("interpreted: {r}");
    let graph = &r["result"]["graph"];
    assert_eq!(r["result"]["shape"], "graph", "{r}");
    assert_eq!(ids(&graph["nodes"]), ["Ort:7", "Person:1", "Person:2", "Person:3"], "{r}");
    assert_eq!(
        ids(&graph["edges"]),
        ["Friend:Person:1--Person:2", "Friend:Person:1--Person:3", "Lebt:Person:1->Ort:7"],
        "{r}"
    );
    let ana = graph["nodes"].as_array().unwrap().iter().find(|n| n["id"] == "Person:1").unwrap();
    assert_eq!(ana["properties"], json!({}), "Ana is not printed, only an edge end: {r}");
    assert!(r.to_string().contains("graph.columns_omitted"), "@@anzahl is not part of the graph: {r}");

    let nodes_only =
        t.query(&id, json!({ "gsql": "INTERPRET QUERY () FOR GRAPH social { S = {Person.*}; PRINT S; }" })).await;
    assert_eq!(nodes_only["result"]["shape"], "graph", "{nodes_only}");
    assert_eq!(nodes_only["result"]["graph"]["edges"], json!([]), "no edges unless printed: {nodes_only}");
    let ana =
        nodes_only["result"]["graph"]["nodes"].as_array().unwrap().iter().find(|n| n["id"] == "Person:1").cloned();
    let ana = ana.unwrap_or_else(|| panic!("{nodes_only}"));
    assert_eq!(ana["labels"], json!(["Person"]), "{nodes_only}");
    assert_eq!(ana["properties"]["gross"], json!({ "$type": "int64", "value": "9007199254740993" }), "{nodes_only}");

    let frame = t
        .query(
            &id,
            json!({ "gsql": "INTERPRET QUERY (STRING name, INT k) FOR GRAPH social { SumAccum<INT> @@treffer; \
                     S = {Person.*}; R = SELECT s FROM S:s WHERE s.name == name ACCUM @@treffer += 1; \
                     PRINT @@treffer, k; PRINT 1.5 AS durchschnitt; }", "params": { "k": 7 } }),
        )
        .await;
    eprintln!("frame: {frame}");
    assert_eq!(frame["result"]["shape"], "frame", "{frame}");
    assert_eq!(field(&frame, "@@treffer")["values"], json!(["1"]), "the variable name: {frame}");
    assert_eq!(field(&frame, "k")["values"], json!(["7"]), "{frame}");
    assert_eq!(field(&frame, "durchschnitt")["values"], json!([1.5]), "{frame}");

    // A value is a parameter, never GSQL text.
    let sly = t
        .query(
            &id,
            json!({ "gsql": "INTERPRET QUERY (STRING name) FOR GRAPH social { SumAccum<INT> @@treffer; \
                     S = {Person.*}; R = SELECT s FROM S:s WHERE s.name == name ACCUM @@treffer += 1; PRINT @@treffer; }",
                    "params": { "name": "Ana\" OR true OR \"" } }),
        )
        .await;
    assert_eq!(field(&sly, "@@treffer")["values"], json!(["0"]), "{sly}");
    t.finish().await;
}

/// Installed queries: the picker lists them, a reader without READ_QUERY cannot read their text,
/// so they run only when approved by name; parameters of every kind arrive typed.
#[tokio::test]
#[ignore = "needs a real TigerGraph (KALZIT_TEST_TIGERGRAPH_URL), see the nightly job"]
async fn installed_queries_with_parameters() {
    let t = T::new().await;
    let plain = t.source(READER, json!({})).await;
    let r = t.query(&plain, json!({ "installed": "nachbarn", "params": { "p": "1" } })).await;
    eprintln!("installed, not approved: {r}");
    assert_eq!(r["error"]["code"], "query_rejected", "{r}");
    assert_eq!(r["error"]["reason"], "tigergraph.query_text_unreadable", "{r}");

    // The picker lists the installed queries for a plain queryreader too.
    let schema = t.schema(&plain).await;
    eprintln!("schema: {schema}");
    assert_eq!(schema["queries"], json!(["loescht", "nachbarn", "nur_knoten", "zahlen"]), "{schema}");

    let id = t.source(READER, json!({ "approvedQueries": "nachbarn, zahlen, nur_knoten" })).await;
    let r = t.query(&id, json!({ "installed": "nur_knoten" })).await;
    assert_eq!(r["result"]["shape"], "graph", "{r}");
    assert_eq!(ids(&r["result"]["graph"]["nodes"]), ["Person:1", "Person:2", "Person:3", "Person:9"], "{r}");
    assert_eq!(r["result"]["graph"]["edges"], json!([]), "no edges unless printed: {r}");

    let r = t
        .query(
            &id,
            json!({ "installed": "nachbarn", "params": { "p": "1", "tiefe": 2, "stichworte": ["a b", "c&d"] } }),
        )
        .await;
    eprintln!("nachbarn: {r}");
    let graph = &r["result"]["graph"];
    assert_eq!(r["result"]["shape"], "graph", "{r}");
    assert_eq!(ids(&graph["nodes"]), ["Person:1", "Person:2", "Person:3"], "{r}");
    assert_eq!(ids(&graph["edges"]), ["Friend:Person:1--Person:2", "Friend:Person:1--Person:3"], "{r}");
    let since = graph["edges"].as_array().unwrap().iter().find(|e| e["id"] == "Friend:Person:1--Person:2").unwrap();
    assert_eq!(since["properties"]["since"], 2020, "{r}");
    assert!(r.to_string().contains("graph.columns_omitted"), "{r}");

    let r = t
        .query(
            &id,
            json!({ "installed": "zahlen", "params": { "k": 3, "name": "Ana", "ab": "2024-01-01 00:00:00", "liste": [1, 2],
                    "v": { "type": "Person", "id": "2" } } }),
        )
        .await;
    eprintln!("zahlen: {r}");
    assert_eq!(r["result"]["shape"], "frame", "{r}");
    assert_eq!(field(&r, "@@treffer")["values"], json!(["1"]), "{r}");
    assert_eq!(field(&r, "name")["values"], json!(["Ana"]), "{r}");
    assert_eq!(field(&r, "liste")["values"], json!([[1, 2]]), "{r}");
    assert_eq!(field(&r, "v")["values"], json!(["2"]), "{r}");

    // Spaces, plus signs and ampersands arrive as written, in installed and interpreted queries.
    let odd = "a b+c&d=e Ö";
    // An approved query's parameters are unknown to Kalzit, so dashboard variables do not fill
    // them: every value is given.
    let params =
        json!({ "k": 1, "name": odd, "ab": "2024-01-01 00:00:00", "liste": [5], "v": { "type": "Ort", "id": "7" } });
    let r = t.query(&id, json!({ "installed": "zahlen", "params": params })).await;
    assert_eq!(field(&r, "name")["values"], json!([odd]), "{r}");
    let r = t
        .query(
            &id,
            json!({ "gsql": "INTERPRET QUERY (STRING s) FOR GRAPH social { PRINT s; }", "params": { "s": odd } }),
        )
        .await;
    assert_eq!(field(&r, "s")["values"], json!([odd]), "{r}");
    t.finish().await;
}

/// Writes are refused: by the GSQL check for interpreted queries and readable texts, by the
/// server for an approved installed query that writes; nothing changes.
#[tokio::test]
#[ignore = "needs a real TigerGraph (KALZIT_TEST_TIGERGRAPH_URL), see the nightly job"]
async fn writes_are_refused() {
    let t = T::new().await;
    let id = t.source(READER, json!({ "approvedQueries": "loescht" })).await;
    for gsql in [
        "INTERPRET QUERY () FOR GRAPH social { S = {Person.*}; DELETE s FROM S:s WHERE s.name == \"Opfer\"; }",
        "INTERPRET QUERY () FOR GRAPH social { INSERT INTO Person VALUES (\"99\", \"Neu\", 1, 1, _); }",
        "INTERPRET QUERY () FOR GRAPH social { S = {Person.*}; R = SELECT s FROM S:s POST-ACCUM s.age = 0; }",
        "INTERPRET QUERY () FOR GRAPH andere { S = {Person.*}; PRINT S; }",
    ] {
        let r = t.query(&id, json!({ "gsql": gsql })).await;
        assert_eq!(r["error"]["code"], "query_rejected", "{gsql}: {r}");
    }
    // The approved query writes: TigerGraph marks it (graphUpdate), so Kalzit refuses it.
    let r = t.query(&id, json!({ "installed": "loescht" })).await;
    eprintln!("approved write query as reader: {r}");
    assert_eq!(r["error"]["code"], "query_rejected", "{r}");
    assert_eq!(r["error"]["reason"], "tigergraph.query_writes", "{r}");

    // Behind that, the reader user itself may not write, through REST++ (with authentication on)
    // and through the GSQL server.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let http = reqwest::Client::new();
    let token: Value = http
        .post(format!("{}/gsql/v1/tokens", url()))
        .basic_auth(READER.0, Some(READER.1))
        .json(&json!({ "graph": "social", "lifetime": "600" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = token["token"].as_str().unwrap_or_else(|| panic!("{token}"));
    let res = http.get(format!("{}/restpp/query/social/loescht", url())).bearer_auth(token).send().await.unwrap();
    let status = res.status();
    let text = res.text().await.unwrap();
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN, "{text}");
    assert!(text.contains("DELETE [MISSING]"), "{text}");
    let res = http.get(format!("{}/restpp/query/social/nur_knoten", url())).send().await.unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::FORBIDDEN, "REST++ checks tokens");
    let res = http
        .post(format!("{}/gsql/v1/queries/interpret?graph=social", url()))
        .basic_auth(READER.0, Some(READER.1))
        .header("content-type", "text/plain")
        .body("INTERPRET QUERY () FOR GRAPH social { S = {Person.*}; DELETE s FROM S:s WHERE s.name == \"Opfer\"; PRINT 1; }")
        .send()
        .await
        .unwrap();
    let status = res.status();
    let text = res.text().await.unwrap();
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN, "{text}");
    assert!(text.contains("DELETE_DATA [MISSING]"), "{text}");
    let check = t
        .query(
            &id,
            json!({ "gsql": "INTERPRET QUERY () FOR GRAPH social { SumAccum<INT> @@n; S = {Person.*}; \
                     R = SELECT s FROM S:s WHERE s.name == \"Opfer\" ACCUM @@n += 1; PRINT @@n; }" }),
        )
        .await;
    assert_eq!(field(&check, "@@n")["values"], json!(["1"]), "nothing was deleted: {check}");
    t.finish().await;
}

/// Users who may do more than read are refused at Test connection and at every query.
#[tokio::test]
#[ignore = "needs a real TigerGraph (KALZIT_TEST_TIGERGRAPH_URL), see the nightly job"]
async fn users_who_may_write_are_refused() {
    let t = T::new().await;
    for user in [WRITER, SUPERUSER] {
        let id = t.source(user, json!({})).await;
        let h = t.health(&id).await;
        eprintln!("{}: {h}", user.0);
        assert_eq!(h["ok"], false, "{h}");
        assert_eq!(h["reason"], "tigergraph.user_can_write", "{h}");
        let r = t.query(&id, json!({ "gsql": "INTERPRET QUERY () FOR GRAPH social { PRINT 1; }" })).await;
        assert_eq!(r["error"]["reason"], "tigergraph.user_can_write", "{r}");
    }
    let wrong = t.source((READER.0, "falsch"), json!({})).await;
    let h = t.health(&wrong).await;
    eprintln!("wrong password: {h}");
    assert_eq!(h["ok"], false, "{h}");
    assert!(!h.to_string().contains("falsch"), "{h}");
    t.finish().await;
}

/// HTTPS with a certificate from a private CA: refused without `caCert`, read with it. The
/// nightly job switches the server to HTTPS after the other tests and sets
/// `KALZIT_TEST_TIGERGRAPH_CA` to the CA certificate's file.
#[tokio::test]
#[ignore = "needs a real TigerGraph with HTTPS (KALZIT_TEST_TIGERGRAPH_URL, KALZIT_TEST_TIGERGRAPH_CA)"]
async fn tls_with_a_private_ca() {
    let ca = std::env::var("KALZIT_TEST_TIGERGRAPH_CA").expect("KALZIT_TEST_TIGERGRAPH_CA names the CA file");
    let ca = std::fs::read_to_string(ca).unwrap();
    assert!(url().starts_with("https://"), "{}", url());
    let t = T::new().await;
    let unknown = t.source(READER, json!({})).await;
    let h = t.health(&unknown).await;
    eprintln!("without caCert: {h}");
    assert_eq!(h["ok"], false, "the certificate is not trusted without caCert: {h}");

    let id = t.source(READER, json!({ "caCert": ca })).await;
    let h = t.health(&id).await;
    eprintln!("with caCert: {h}");
    assert_eq!(h["ok"], true, "{h}");
    let r = t.query(&id, json!({ "gsql": "INTERPRET QUERY () FOR GRAPH social { S = {Person.*}; PRINT S; }" })).await;
    assert_eq!(r["result"]["shape"], "graph", "{r}");
    let id = t.source(READER, json!({ "caCert": ca, "approvedQueries": "nur_knoten" })).await;
    let r = t.query(&id, json!({ "installed": "nur_knoten" })).await;
    assert_eq!(r["result"]["shape"], "graph", "REST++ through HTTPS with a token: {r}");
    t.finish().await;
}
