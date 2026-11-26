//! ArangoDB against a fake HTTP API on every run; `server/tests/arangodb.rs` checks the same
//! against a real server in CI.

use std::sync::Mutex;
use std::time::Duration;

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
    /// The access level of the user on the database and its collections.
    level: &'static str,
    collection_level: &'static str,
    /// The access levels cannot be read (403).
    hide_levels: bool,
    /// Every cursor request's body.
    cursors: Mutex<Vec<Value>>,
    deleted: Mutex<Vec<String>>,
    parsed: Mutex<Vec<String>>,
}

type S = Arc<Fake>;

fn reply(status: u16, v: Value) -> Response {
    (AxStatus::from_u16(status).unwrap(), [("content-type", "application/json")], v.to_string()).into_response()
}

fn authorized(h: &AxHeaders) -> bool {
    h.get("authorization").and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("Basic "))
}

async fn version(h: AxHeaders) -> Response {
    if !authorized(&h) {
        return reply(401, json!({ "error": true, "errorNum": 11, "errorMessage": "not authorized", "code": 401 }));
    }
    reply(200, json!({ "server": "arango", "license": "community", "version": "3.12.4" }))
}

async fn levels(State(s): State<S>, Path((db, user)): Path<(String, String)>) -> Response {
    assert_eq!(user, "leser");
    if s.hide_levels {
        return reply(403, json!({ "error": true, "errorNum": 11, "errorMessage": "forbidden", "code": 403 }));
    }
    reply(
        200,
        json!({ "error": false, "code": 200, "result": {
            db: { "permission": s.level, "collections": { "persons": s.collection_level, "*": "undefined" } },
            "_system": { "permission": "none", "collections": {} }
        } }),
    )
}

async fn collections() -> Response {
    reply(
        200,
        json!({ "error": false, "result": [
            { "name": "persons", "type": 2, "isSystem": false },
            { "name": "knows", "type": 3, "isSystem": false },
            { "name": "_graphs", "type": 2, "isSystem": true }
        ] }),
    )
}

/// The syntax tree as ArangoDB answers it; `-- writes` in a test query stands for a write the
/// tokenizer missed, so the server's check is exercised on its own.
async fn parse(State(s): State<S>, body: String) -> Response {
    let q: Value = serde_json::from_str(&body).unwrap();
    let text = q["query"].as_str().unwrap().to_string();
    s.parsed.lock().unwrap().push(text.clone());
    if text.contains("SYNTAX") {
        return reply(
            400,
            json!({ "error": true, "errorNum": 1501, "errorMessage": "syntax error, unexpected SYNTAX", "code": 400 }),
        );
    }
    let inner = if text.contains("'writes'") {
        json!([{ "type": "for" }, { "type": "insert", "subNodes": [{ "type": "collection", "name": "persons" }] }])
    } else if text.contains("'udf'") {
        json!([{ "type": "return", "subNodes": [{ "type": "user function call", "name": "MY::FN" }] }])
    } else {
        json!([{ "type": "for" }, { "type": "return", "subNodes": [{ "type": "function call", "name": "LENGTH" }] }])
    };
    reply(200, json!({ "error": false, "parsed": true, "ast": [{ "type": "root", "subNodes": inner }] }))
}

fn person(key: &str, name: &str) -> Value {
    json!({ "_key": key, "_id": format!("persons/{key}"), "_rev": "_x", "name": name, "big": 9_007_199_254_740_993_i64 })
}

fn knows(key: &str, from: &str, to: &str) -> Value {
    json!({ "_key": key, "_id": format!("knows/{key}"), "_rev": "_y", "_from": format!("persons/{from}"),
            "_to": format!("persons/{to}"), "since": 2020 })
}

async fn cursor(State(s): State<S>, body: String) -> Response {
    let q: Value = serde_json::from_str(&body).unwrap();
    s.cursors.lock().unwrap().push(q.clone());
    let text = q["query"].as_str().unwrap();
    let result = if text.contains("ATTRIBUTES") {
        json!([["name", "big"], ["since"]])
    } else if text.contains("{v, e}") {
        json!([{ "v": person("b", "Bo"), "e": knows("1", "a", "b"), "score": 3 }])
    } else if text.contains("OUTBOUND") {
        json!([{ "vertices": [person("a", "Ada"), person("b", "Bo")], "edges": [knows("1", "a", "b")] }])
    } else if text.contains("slow") || text.contains("failing") {
        // A first batch whose next one never comes in time (88) or fails (99).
        let id = if text.contains("slow") { "88" } else { "99" };
        return reply(201, json!({ "error": false, "result": [{ "n": 0 }], "hasMore": true, "id": id }));
    } else if text.contains("many") {
        // The first batch of a longer result.
        let items: Vec<Value> = (0..5).map(|i| json!({ "n": i })).collect();
        return reply(201, json!({ "error": false, "result": items, "hasMore": true, "id": "77" }));
    } else {
        json!([person("a", "Ada"), 42, "text"])
    };
    reply(201, json!({ "error": false, "result": result, "hasMore": false }))
}

async fn next_batch(Path(id): Path<String>) -> Response {
    match id.as_str() {
        "88" => tokio::time::sleep(Duration::from_secs(30)).await,
        "99" => {
            return reply(500, json!({ "error": true, "errorNum": 1, "errorMessage": "shard failed", "code": 500 }));
        }
        _ => assert_eq!(id, "77"),
    }
    let items: Vec<Value> = (5..8).map(|i| json!({ "n": i })).collect();
    reply(200, json!({ "error": false, "result": items, "hasMore": false }))
}

async fn delete_cursor(State(s): State<S>, Path(id): Path<String>) -> Response {
    s.deleted.lock().unwrap().push(id);
    reply(202, json!({ "error": false }))
}

async fn redirect() -> Response {
    (AxStatus::TEMPORARY_REDIRECT, [("location", "/_db/kalzit/_api/document/persons")]).into_response()
}

#[expect(clippy::disallowed_methods, reason = "a fake ArangoDB server, not an API route")]
async fn fake(f: Fake) -> (std::net::SocketAddr, S) {
    let state: S = Arc::new(f);
    let app = Router::new()
        .route("/_db/{db}/_api/version", get(version))
        .route("/_db/{db}/_api/user/{user}/database/", get(levels_route))
        .route("/_db/{db}/_api/collection", get(collections))
        .route("/_db/{db}/_api/query", post(parse))
        .route("/_db/{db}/_api/cursor", post(cursor))
        .route("/_db/{db}/_api/cursor/{id}", post(next_batch_route).delete(delete_route))
        .route("/redirect/_db/{db}/_api/version", get(redirect))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, state)
}

async fn levels_route(
    s: State<S>,
    Path((db, user)): Path<(String, String)>,
    Query(q): Query<BTreeMap<String, String>>,
) -> Response {
    assert_eq!(q.get("full").map(String::as_str), Some("true"));
    levels(s, Path((db, user))).await
}

async fn next_batch_route(Path((_db, id)): Path<(String, String)>) -> Response {
    next_batch(Path(id)).await
}

async fn delete_route(s: State<S>, Path((_db, id)): Path<(String, String)>) -> Response {
    delete_cursor(s, Path(id)).await
}

async fn connection(url: String, extra: Value) -> Connection {
    let mut settings = json!({ "url": url, "database": "kalzit", "user": "leser" });
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

fn req(aql: &str, variables: Value, max_rows: usize) -> SourceQuery {
    SourceQuery {
        ref_id: "A".into(),
        query: json!({ "aql": aql }),
        range: TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 },
        interval_ms: 15_000,
        max_data_points: None,
        variables: serde_json::from_value(variables).unwrap(),
        identifier_variables: None,
        limits: Limits {
            timeout: Duration::from_secs(5),
            max_rows,
            budget: crate::datasources::frame::ResponseBudget::new(1 << 20),
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

async fn reader() -> (Connection, S) {
    let (addr, s) = fake(Fake { level: "ro", collection_level: "undefined", ..Fake::default() }).await;
    (connection(format!("http://{addr}"), json!({})).await, s)
}

#[test]
fn settings_are_checked() {
    let k = kind();
    let ok = json!({ "url": "http://db:8529", "database": "shop" });
    assert!(k.validate_settings(&ok).is_ok());
    let bad = |s: Value| k.validate_settings(&s).unwrap_err().field;
    assert_eq!(bad(json!({ "url": "ftp://db" })), "url");
    assert_eq!(bad(json!({ "url": "http://db", "database": "a/b" })), "database");
    assert_eq!(bad(json!({ "url": "http://db", "maxNodes": 0 })), "maxNodes");
    assert_eq!(bad(json!({ "url": "http://db", "caCert": "nope" })), "caCert");
}

#[tokio::test]
async fn a_reader_connects_and_the_schema_lists_collections() {
    let (conn, _) = reader().await;
    let h = ArangoDb.health(&conn).await;
    assert!(h.ok, "{h:?}");
    assert_eq!(h.detail.reason, "health.connected");
    assert_eq!(h.detail.params["version"], "3.12.4");
    match ArangoDb.schema(&conn).await.unwrap() {
        SourceSchema::Graph { labels, edge_types, property_keys, .. } => {
            assert_eq!(labels, ["persons"]);
            assert_eq!(edge_types, ["knows"]);
            assert_eq!(property_keys, ["big", "name", "since"]);
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_user_who_may_write_is_refused_unless_allowed() {
    for (level, collection) in [("rw", "undefined"), ("ro", "rw")] {
        let (addr, _) = fake(Fake { level, collection_level: collection, ..Fake::default() }).await;
        let conn = connection(format!("http://{addr}"), json!({})).await;
        let h = ArangoDb.health(&conn).await;
        assert!(!h.ok);
        assert_eq!(h.detail.reason, "arangodb.user_can_write", "{level} {collection}");
        assert_eq!(
            reason(ArangoDb.query(&conn, req("FOR d IN persons RETURN d", json!({}), 10)).await),
            "arangodb.user_can_write"
        );

        let allowed = connection(format!("http://{addr}"), json!({ "allowWriteCapableUser": true })).await;
        let h = ArangoDb.health(&allowed).await;
        assert!(h.ok);
        assert_eq!(h.detail.reason, "health.connected_write_capable");
    }
    let (addr, _) = fake(Fake { level: "ro", hide_levels: true, ..Fake::default() }).await;
    let conn = connection(format!("http://{addr}"), json!({})).await;
    assert_eq!(ArangoDb.health(&conn).await.detail.reason, "arangodb.privileges_unverifiable");
}

#[tokio::test]
async fn writes_are_refused_by_the_tokenizer_and_by_the_servers_syntax_tree() {
    let (conn, s) = reader().await;
    let r = ArangoDb.query(&conn, req("INSERT { a: 1 } INTO persons", json!({}), 10)).await;
    assert_eq!(reason(r), "arangodb.write_refused");
    // Refused before anything was sent.
    assert!(s.parsed.lock().unwrap().is_empty());
    for (q, why) in [
        ("FOR d IN persons FILTER d.x == 'writes' RETURN d", "arangodb.write_refused"),
        ("RETURN 'udf'", "arangodb.user_function"),
    ] {
        assert_eq!(reason(ArangoDb.query(&conn, req(q, json!({}), 10)).await), why, "{q}");
    }
    assert!(s.cursors.lock().unwrap().is_empty(), "nothing refused reached the cursor API");
    let e = ArangoDb.query(&conn, req("FOR SYNTAX", json!({}), 10)).await.unwrap_err();
    assert_eq!(e.detail().reason, "arangodb.error");
    assert!(e.detail().message.contains("1501"));
}

#[tokio::test]
async fn documents_keep_their_shape_and_values_bind_as_parameters() {
    let (conn, s) = reader().await;
    let r = ArangoDb
        .query(
            &conn,
            req(
                "FOR d IN @@coll FILTER d.name == @land AND d.t >= @__timeFrom RETURN d",
                json!({ "land": "Österreich", "coll": "persons" }),
                10,
            ),
        )
        .await
        .unwrap();
    let QueryResult::Documents { documents } = r else { panic!("{r:?}") };
    let docs: Vec<Value> = documents.documents.iter().map(|d| serde_json::to_value(d).unwrap()).collect();
    assert_eq!(docs[0]["name"], "Ada");
    assert_eq!(docs[0]["big"], json!({ "$type": "int64", "value": "9007199254740993" }));
    assert_eq!(docs[1], json!({ "value": 42 }));
    assert_eq!(docs[2], json!({ "value": "text" }));
    let sent = s.cursors.lock().unwrap().last().unwrap().clone();
    assert_eq!(
        sent["bindVars"],
        json!({ "land": "Österreich", "@coll": "persons", "__timeFrom": 1_800_000_000_000_i64 })
    );
    assert_eq!(sent["options"]["maxRuntime"], 5.0);

    // A collection parameter takes only a variable that may name one.
    let mut r = req("FOR d IN @@coll RETURN d", json!({ "coll": "persons" }), 10);
    r.identifier_variables = Some(BTreeSet::new());
    assert_eq!(reason(ArangoDb.query(&conn, r).await), "arangodb.variable_identifier");
    assert_eq!(reason(ArangoDb.query(&conn, req("RETURN @x", json!({}), 10)).await), "arangodb.variable_missing");
    assert_eq!(reason(ArangoDb.query(&conn, req("RETURN @__nope", json!({}), 10)).await), "arangodb.macro_unknown");
}

#[tokio::test]
async fn traversals_and_edges_become_graphs() {
    let (conn, _) = reader().await;
    let r = ArangoDb
        .query(&conn, req("FOR v, e, p IN 1..2 OUTBOUND 'persons/a' knows RETURN p", json!({}), 10))
        .await
        .unwrap();
    let QueryResult::Graph { graph } = r else { panic!("{r:?}") };
    assert_eq!(graph.nodes.len(), 2);
    assert_eq!(graph.nodes[0].id, "persons/a");
    assert_eq!(graph.nodes[0].labels, ["persons"]);
    assert!(!graph.nodes[0].properties.contains_key("_rev"));
    assert_eq!(graph.edges[0].edge_type, "knows");
    assert_eq!((graph.edges[0].from.as_str(), graph.edges[0].to.as_str()), ("persons/a", "persons/b"));
    assert_eq!(graph.paths.as_ref().unwrap()[0].nodes, ["persons/a", "persons/b"]);

    let r = ArangoDb.query(&conn, req("FOR v, e IN 1 OUTBOUND 'persons/a' knows RETURN {v, e}", json!({}), 10)).await;
    let QueryResult::Graph { graph } = r.unwrap() else { panic!() };
    // The edge's other end is known by id only.
    assert_eq!(graph.nodes.len(), 2);
    let notices = graph.notices.unwrap();
    assert_eq!(notices[0].code, "graph.columns_omitted");
    assert_eq!(notices[0].params.as_ref().unwrap()["columns"], "score");
}

#[tokio::test]
async fn batches_are_read_until_the_row_limit_and_the_cursor_is_closed() {
    let (conn, s) = reader().await;
    let r = ArangoDb.query(&conn, req("FOR i IN many RETURN {n: i}", json!({}), 100)).await.unwrap();
    let QueryResult::Documents { documents } = r else { panic!() };
    assert_eq!(documents.documents.len(), 8);
    assert!(documents.truncated.is_none());
    assert!(s.deleted.lock().unwrap().is_empty());

    let r = ArangoDb.query(&conn, req("FOR i IN many RETURN {n: i}", json!({}), 3)).await.unwrap();
    let QueryResult::Documents { documents } = r else { panic!() };
    assert_eq!(documents.documents.len(), 3);
    assert_eq!(documents.truncated.unwrap().reason.as_deref(), Some("documents.limit"));
    assert_eq!(*s.deleted.lock().unwrap(), ["77"]);
}

#[tokio::test]
async fn a_cursor_left_open_by_a_timeout_or_an_error_is_deleted() {
    let (conn, s) = reader().await;
    let mut slow = req("FOR i IN slow RETURN i", json!({}), 100);
    slow.limits.timeout = Duration::from_secs(1);
    assert_eq!(reason(ArangoDb.query(&conn, slow).await), "query.timeout");
    let e = ArangoDb.query(&conn, req("FOR i IN failing RETURN i", json!({}), 100)).await.unwrap_err();
    assert_eq!(e.detail().reason, "arangodb.error");
    assert_eq!(*s.deleted.lock().unwrap(), ["88", "99"]);
}

#[tokio::test]
async fn redirects_are_refused_and_secrets_stay_out_of_errors() {
    let (addr, _) = fake(Fake { level: "ro", collection_level: "undefined", ..Fake::default() }).await;
    let conn = connection(format!("http://{addr}/redirect"), json!({})).await;
    let h = ArangoDb.health(&conn).await;
    assert!(!h.ok);
    // The levels endpoint does not exist under /redirect: the setup fails before the version.
    assert!(!format!("{h:?}").contains("geheim-pw"));
    let c = Client {
        api: JsonApi::new(&conn, &format!("http://{addr}/redirect"), Some("leser"), None, REASONS).unwrap(),
        database: "kalzit".into(),
        user: Some("leser".into()),
        allow_write: false,
        writes: Vec::new(),
    };
    assert_eq!(reason(c.version().await), "arangodb.redirect_refused");
}

#[test]
fn access_levels_are_read_from_the_full_answer() {
    let body = |p: &str, c: Value| json!({ "result": { "db": { "permission": p, "collections": c } } });
    assert_eq!(writes_from(&body("ro", json!({ "a": "undefined", "*": "ro" })), "db"), Some(vec![]));
    assert_eq!(writes_from(&body("rw", json!({})), "db"), Some(vec!["database".to_string()]));
    assert_eq!(writes_from(&body("ro", json!({ "*": "rw" })), "db"), Some(vec!["every collection".to_string()]));
    assert_eq!(writes_from(&json!({ "result": { "db": "ro" } }), "db"), None);
    assert_eq!(writes_from(&json!({ "result": { "db": "rw" } }), "db"), Some(vec!["database".to_string()]));
    assert_eq!(writes_from(&json!({ "result": {} }), "db"), None);
}
