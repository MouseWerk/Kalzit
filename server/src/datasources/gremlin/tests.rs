//! Gremlin against a fake Gremlin Server (WebSocket, GraphSON 3.0) on every run;
//! `server/tests/gremlin.rs` checks the same against `tinkerpop/gremlin-server` in CI.

use std::sync::Mutex;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::any;
use zeroize::Zeroizing;

use super::*;
use crate::datasources::targets::TargetPolicy;
use crate::datasources::{Limits, OwnDatabase};
use crate::shapes::TimeRange;

#[derive(Default)]
struct Fake {
    /// Asks for SASL PLAIN and accepts `leser` / `geheim-pw`.
    auth: bool,
    requests: Mutex<Vec<Value>>,
}

type S = Arc<Fake>;

fn int(i: i64) -> Value {
    json!({ "@type": "g:Int32", "@value": i })
}

fn vertex(id: i64, name: &str) -> Value {
    json!({ "@type": "g:Vertex", "@value": { "id": int(id), "label": "person", "properties": {
        "name": [{ "@type": "g:VertexProperty", "@value": { "id": int(id * 10), "value": name, "label": "name" } }] } } })
}

fn edge() -> Value {
    json!({ "@type": "g:Edge", "@value": { "id": int(7), "label": "knows", "inVLabel": "person", "outVLabel": "person",
        "inV": int(2), "outV": int(1), "properties": {} } })
}

fn traverser(v: Value, bulk: i64) -> Value {
    json!({ "@type": "g:Traverser", "@value": { "bulk": { "@type": "g:Int64", "@value": bulk }, "value": v } })
}

fn answer(id: &str, code: i64, message: &str, data: Vec<Value>) -> WsMessage {
    let v = json!({ "requestId": id, "status": { "code": code, "message": message, "attributes": {} },
                    "result": { "data": { "@type": "g:List", "@value": data }, "meta": {} } });
    WsMessage::Text(v.to_string().into())
}

fn steps_of(req: &Value) -> Vec<String> {
    req.pointer("/args/gremlin/@value/step")
        .and_then(Value::as_array)
        .map(|s| s.iter().filter_map(|x| x[0].as_str().map(String::from)).collect())
        .unwrap_or_default()
}

async fn session(mut socket: WebSocket, s: S) {
    while let Some(Ok(msg)) = socket.recv().await {
        let WsMessage::Binary(frame) = msg else { continue };
        let len = frame[0] as usize;
        assert_eq!(&frame[1..=len], b"application/vnd.gremlin-v3.0+json");
        let req: Value = serde_json::from_slice(&frame[len + 1..]).unwrap();
        s.requests.lock().unwrap().push(req.clone());
        let id = req["requestId"].as_str().unwrap().to_string();
        if s.auth && req["op"] == "bytecode" {
            socket.send(answer(&id, 407, "", vec![])).await.unwrap();
            continue;
        }
        if req["op"] == "authentication" {
            let sasl = req["args"]["sasl"].as_str().unwrap();
            let plain = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, sasl).unwrap();
            if plain != b"\0leser\0geheim-pw" {
                socket.send(answer(&id, 401, "Username and/or password are incorrect", vec![])).await.unwrap();
                continue;
            }
        }
        let request = s.requests.lock().unwrap().iter().rev().find(|r| r["op"] == "bytecode").cloned().unwrap();
        assert_eq!(
            request.pointer("/args/gremlin/@value/source/0/1/@type").and_then(Value::as_str),
            Some("g:ReadOnlyStrategy"),
            "every traversal runs under ReadOnlyStrategy"
        );
        let steps = steps_of(&request);
        let text = request.to_string();
        let reply = if text.contains("\"writes\"") {
            answer(
                &id,
                500,
                "The provided traversal has a mutating step and thus is not read only: AddVertexStep",
                vec![],
            )
        } else if steps.len() == 2
            && steps[1] == "elementMap"
            && matches!(steps[0].as_str(), "V" | "E")
            && request.pointer("/args/gremlin/@value/step/0/1").is_some()
        {
            // Kalzit asks for the properties of elements that came without (by their ids).
            let first = request.pointer("/args/gremlin/@value/step/0").and_then(Value::as_array).unwrap().clone();
            let maps: Vec<Value> = first[1..]
                .iter()
                .map(|id| {
                    let n = id["@value"].as_i64().unwrap();
                    let t = |v: &str| json!({ "@type": "g:T", "@value": v });
                    let pairs = if steps[0] == "V" {
                        vec![t("id"), id.clone(), t("label"), json!("person"), json!("name"), json!(format!("v{n}"))]
                    } else {
                        let d = |v: &str| json!({ "@type": "g:Direction", "@value": v });
                        vec![
                            t("id"),
                            id.clone(),
                            t("label"),
                            json!("knows"),
                            d("IN"),
                            json!({}),
                            d("OUT"),
                            json!({}),
                            json!("weight"),
                            json!({ "@type": "g:Double", "@value": 0.5 }),
                        ]
                    };
                    traverser(json!({ "@type": "g:Map", "@value": pairs }), 1)
                })
                .collect();
            answer(&id, 200, "", maps)
        } else if text.contains("\"bare\"") {
            // Elements as references only (id and label), as with ReferenceElementStrategy.
            let bare = |id: i64| json!({ "@type": "g:Vertex", "@value": { "id": int(id), "label": "person" } });
            let e = json!({ "@type": "g:Edge", "@value": { "id": int(7), "label": "knows", "inVLabel": "person",
                "outVLabel": "person", "inV": int(2), "outV": int(1) } });
            answer(&id, 200, "", vec![traverser(bare(1), 1), traverser(e, 1), traverser(bare(2), 1)])
        } else if text.contains("\"huge\"") {
            // A hostile bulk: a traverser that claims to stand for 10^18 results.
            answer(&id, 200, "", vec![traverser(json!("x"), 1_000_000_000_000_000_000)])
        } else if text.contains("\"big\"") {
            // One message of about 2 MB, larger than the response budget.
            let items: Vec<Value> = (0..2000).map(|_| traverser(json!("y".repeat(1000)), 1)).collect();
            answer(&id, 200, "", items)
        } else if steps.contains(&"elementMap".to_string()) {
            let m =
                json!({ "@type": "g:Map", "@value": [{ "@type": "g:T", "@value": "id" }, int(1), "name", "marko"] });
            answer(&id, 200, "", vec![traverser(m, 1), traverser(json!("x"), 2)])
        } else if steps.contains(&"path".to_string()) {
            let p = json!({ "@type": "g:Path", "@value": { "labels": { "@type": "g:List", "@value": [] },
                "objects": { "@type": "g:List", "@value": [vertex(1, "marko"), edge(), vertex(2, "vadas")] } } });
            answer(&id, 200, "", vec![traverser(p, 1)])
        } else if steps.contains(&"label".to_string()) {
            answer(&id, 200, "", vec![traverser(json!("person"), 1)])
        } else if steps.contains(&"key".to_string()) {
            // A huge bulk here too: the schema still reads only a bounded number of results.
            answer(&id, 200, "", vec![traverser(json!("name"), 1_000_000_000_000_000_000), traverser(json!("age"), 1)])
        } else if steps.first().is_some_and(|s| s == "inject") {
            answer(&id, 200, "", vec![traverser(int(1), 1)])
        } else {
            // Two parts: 206, then the last one.
            socket.send(answer(&id, 206, "", vec![traverser(vertex(1, "marko"), 1)])).await.unwrap();
            answer(&id, 200, "", vec![traverser(vertex(2, "vadas"), 1), traverser(edge(), 1)])
        };
        socket.send(reply).await.unwrap();
    }
}

async fn upgrade(State(s): State<S>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| session(socket, s))
}

#[expect(clippy::disallowed_methods, reason = "a fake Gremlin Server, not an API route")]
async fn fake(f: Fake) -> (std::net::SocketAddr, S) {
    let state: S = Arc::new(f);
    let app = Router::new().route("/gremlin", any(upgrade)).with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, state)
}

async fn connection(addr: std::net::SocketAddr, extra: Value) -> Connection {
    let mut settings = json!({ "url": format!("ws://{addr}/gremlin") });
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

fn req(gremlin: &str, variables: Value, max_rows: usize) -> SourceQuery {
    SourceQuery {
        ref_id: "A".into(),
        query: json!({ "gremlin": gremlin }),
        range: TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 },
        interval_ms: 15_000,
        max_data_points: None,
        variables: serde_json::from_value(variables).unwrap(),
        identifier_variables: None,
        limits: Limits {
            timeout: Duration::from_secs(5),
            max_rows,
            budget: crate::datasources::frame::ResponseBudget::new(1 << 20),
            pattern: Default::default(),
        },
        cursor: None,
        filters: Vec::new(),
    }
}

fn reason<T>(r: Result<T, SourceError>) -> &'static str {
    match r {
        Ok(_) => "ok",
        Err(e) => e.detail().reason,
    }
}

#[test]
fn settings_are_checked() {
    let k = kind();
    assert!(k.validate_settings(&json!({ "url": "wss://graph:8182/gremlin", "traversalSource": "g2" })).is_ok());
    let bad = |s: Value| k.validate_settings(&s).unwrap_err();
    assert_eq!(bad(json!({ "url": "http://graph:8182" })).detail.reason, "gremlin.url_scheme");
    assert_eq!(bad(json!({ "url": "ws://graph", "traversalSource": "g.V()" })).field, "traversalSource");
    assert_eq!(bad(json!({ "url": "ws://graph", "maxEdges": 0 })).field, "maxEdges");
}

#[tokio::test]
async fn health_schema_and_a_graph_in_parts() {
    let (addr, s) = fake(Fake::default()).await;
    let conn = connection(addr, json!({ "traversalSource": "social" })).await;
    let h = Gremlin.health(&conn).await;
    assert!(h.ok, "{h:?}");
    assert_eq!(s.requests.lock().unwrap()[0]["args"]["aliases"], json!({ "g": "social" }));
    let SourceSchema::Graph { labels, property_keys, .. } = Gremlin.schema(&conn).await.unwrap() else { panic!() };
    assert_eq!(labels, ["person"]);
    assert_eq!(property_keys, ["age", "name"]);

    let r = Gremlin.query(&conn, req("g.V().hasLabel('person').limit(10)", json!({}), 100)).await.unwrap();
    let QueryResult::Graph { graph } = r else { panic!("{r:?}") };
    assert_eq!(graph.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), ["1", "2"]);
    assert_eq!(graph.nodes[0].properties["name"], "marko");
    assert_eq!((graph.edges[0].from.as_str(), graph.edges[0].to.as_str()), ("1", "2"));
}

#[tokio::test]
async fn paths_stay_paths_and_values_are_documents() {
    let (addr, _) = fake(Fake::default()).await;
    let conn = connection(addr, json!({})).await;
    let r = Gremlin.query(&conn, req("g.V(1).outE().inV().path()", json!({}), 100)).await.unwrap();
    let QueryResult::Graph { graph } = r else { panic!() };
    assert_eq!(graph.paths.unwrap()[0].nodes, ["1", "2"]);
    let r = Gremlin.query(&conn, req("g.V().elementMap()", json!({}), 100)).await.unwrap();
    let QueryResult::Documents { documents } = r else { panic!() };
    let docs: Vec<Value> = documents.documents.iter().map(|d| serde_json::to_value(d).unwrap()).collect();
    // The bulk of 2 gives the value twice.
    assert_eq!(docs, [json!({ "id": 1, "name": "marko" }), json!({ "value": "x" }), json!({ "value": "x" })]);
    let r = Gremlin.query(&conn, req("g.V().elementMap()", json!({}), 2)).await.unwrap();
    let QueryResult::Documents { documents } = r else { panic!() };
    assert_eq!(documents.documents.len(), 2);
    assert_eq!(documents.truncated.unwrap().reason.as_deref(), Some("documents.limit"));
}

#[tokio::test]
async fn writes_are_refused_by_the_check_and_by_the_read_only_strategy() {
    let (addr, s) = fake(Fake::default()).await;
    let conn = connection(addr, json!({})).await;
    for q in ["g.addV('person')", "g.V().drop()", "g.V().property('a', 1)", "g.V().sideEffect(addE('x'))"] {
        assert_eq!(reason(Gremlin.query(&conn, req(q, json!({}), 10)).await), "gremlin.write_refused", "{q}");
    }
    assert!(s.requests.lock().unwrap().is_empty(), "nothing refused was sent");
    // What the check would let through, the server refuses under ReadOnlyStrategy.
    let r = Gremlin.query(&conn, req("g.V().has('x', 'writes')", json!({}), 10)).await;
    assert_eq!(reason(r), "gremlin.readonly_violation");
}

#[tokio::test]
async fn variables_go_into_the_bytecode_as_values() {
    let (addr, s) = fake(Fake::default()).await;
    let conn = connection(addr, json!({})).await;
    Gremlin
        .query(&conn, req("g.V().has('land', land).has('t', gte(__timeFrom))", json!({ "land": "Österreich" }), 10))
        .await
        .unwrap();
    // The traversal itself; Kalzit's own property reads may follow it.
    let sent = s.requests.lock().unwrap()[0].clone();
    let steps = sent.pointer("/args/gremlin/@value/step").unwrap();
    assert_eq!(steps[1], json!(["has", "land", "Österreich"]));
    assert_eq!(steps[2][2]["@value"]["value"], json!({ "@type": "g:Int64", "@value": 1_800_000_000_000_i64 }));
    assert_eq!(
        reason(Gremlin.query(&conn, req("g.V().has('a', nope)", json!({}), 10)).await),
        "gremlin.variable_missing"
    );
    assert_eq!(
        reason(Gremlin.query(&conn, req("g.V().has('a', x)", json!({ "x": { "a": 1 } }), 10)).await),
        "gremlin.variable_type"
    );
}

#[tokio::test]
async fn sasl_plain_answers_the_challenge() {
    let (addr, s) = fake(Fake { auth: true, ..Fake::default() }).await;
    let conn = connection(addr, json!({ "user": "leser" })).await;
    assert!(Gremlin.health(&conn).await.ok);
    assert_eq!(s.requests.lock().unwrap()[1]["op"], "authentication");
    let without = connection(addr, json!({})).await;
    assert_eq!(Gremlin.health(&without).await.detail.reason, "source.auth_failed");
    let wrong = connection(addr, json!({ "user": "jemand" })).await;
    let h = Gremlin.health(&wrong).await;
    assert_eq!(h.detail.reason, "source.auth_failed");
    assert!(!format!("{h:?}").contains("geheim-pw"));
}

#[tokio::test]
async fn a_huge_bulk_is_capped_and_ends_at_the_row_limit() {
    assert_eq!(bulk_of(&traverser(json!("x"), 1_000_000_000_000_000_000)), MAX_BULK);
    assert_eq!(bulk_of(&traverser(json!("x"), 0)), 1);
    assert_eq!(bulk_of(&json!("x")), 1);
    let (addr, _) = fake(Fake::default()).await;
    let conn = connection(addr, json!({})).await;
    let started = std::time::Instant::now();
    let r = Gremlin.query(&conn, req("g.V().has('k', 'huge').values('k')", json!({}), 50)).await.unwrap();
    let QueryResult::Documents { documents } = r else { panic!() };
    assert_eq!(documents.documents.len(), 50);
    assert_eq!(documents.truncated.unwrap().reason.as_deref(), Some("documents.limit"));
    // The schema reads a bounded number of results, so a huge bulk ends too.
    let SourceSchema::Graph { property_keys, .. } = Gremlin.schema(&conn).await.unwrap() else { panic!() };
    assert_eq!(property_keys, ["age", "name"]);
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
}

#[tokio::test]
async fn a_message_larger_than_the_budget_is_not_read() {
    let (addr, _) = fake(Fake::default()).await;
    let conn = connection(addr, json!({})).await;
    // About 2 MB in one message against a budget of 1 MiB: refused before it is parsed.
    let r = Gremlin.query(&conn, req("g.V().has('k', 'big').values('k')", json!({}), 10_000)).await.unwrap();
    let QueryResult::Documents { documents } = r else { panic!() };
    assert!(documents.documents.is_empty());
    assert_eq!(documents.truncated.unwrap().reason.as_deref(), Some("documents.size_limit"));

    // Within the message limit, the raw length still counts against the budget first.
    let mut fits = req("g.V().has('k', 'big').values('k')", json!({}), 10_000);
    fits.limits.budget = crate::datasources::frame::ResponseBudget::new(8 << 20);
    let r = Gremlin.query(&conn, fits).await.unwrap();
    let QueryResult::Documents { documents } = r else { panic!() };
    assert_eq!(documents.documents.len(), 2000);
    assert!(documents.truncated.is_none());
}

#[tokio::test]
async fn properties_of_reference_elements_are_fetched() {
    let (addr, s) = fake(Fake::default()).await;
    let conn = connection(addr, json!({})).await;
    let r = Gremlin.query(&conn, req("g.V().has('k', 'bare').outE().inV().path()", json!({}), 100)).await.unwrap();
    let QueryResult::Graph { graph } = r else { panic!("{r:?}") };
    let names: Vec<&Value> = graph.nodes.iter().map(|n| &n.properties["name"]).collect();
    assert_eq!(names, [&json!("v1"), &json!("v2")]);
    assert_eq!(graph.edges[0].properties, [("weight".to_string(), json!(0.5))].into());
    // One traversal per kind, with the ids as the server sent them, under ReadOnlyStrategy too.
    let requests = s.requests.lock().unwrap();
    let fetched: Vec<Value> =
        requests.iter().filter_map(|r| r.pointer("/args/gremlin/@value/step/0").cloned()).collect();
    assert!(fetched.contains(&json!(["V", int(1), int(2)])), "{fetched:?}");
    assert!(fetched.contains(&json!(["E", int(7)])), "{fetched:?}");
}
