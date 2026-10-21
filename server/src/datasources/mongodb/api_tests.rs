//! MongoDB sources through the real router, against the in-process server of `test_server.rs`
//! (always run). Real MongoDB is tested in `server/tests/mongodb.rs`.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use bson::{Binary, Bson, Document, doc, oid::ObjectId, spec::BinarySubtype};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::test_server::{Behaviour, FakeMongo};
use crate::app::{AppState, router};
use crate::clock::ManualClock;
use crate::config::Config;

const SETUP_CODE: &str = "test-setup-code-0123456789";

struct T {
    app: Router,
    state: AppState,
    org: String,
    cookie: String,
    _dir: tempfile::TempDir,
}

impl T {
    async fn new() -> T {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().join("data");
        std::fs::create_dir_all(&config.paths.data_dir).unwrap();
        let pool = crate::db::connect(&config.database_url(), 4).await.unwrap();
        let clock = Arc::new(ManualClock::new(1_800_000_000_000));
        let state = AppState::new(config, pool, clock, Some(SETUP_CODE.into())).await.unwrap();
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let app = router(state.clone()).layer(MockConnectInfo(peer));
        let body = json!({ "token": SETUP_CODE, "orgName": "Test", "name": "Jörg", "email": "joerg@example.de",
                           "password": "Grün und sicher 2026" });
        let req = Request::builder()
            .method(Method::POST)
            .uri("/api/setup")
            .header(header::HOST, "kalzit.test")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let cookie =
            res.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap().split(';').next().unwrap().to_string();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let me: Value = serde_json::from_slice(&bytes).unwrap();
        T { app, state, org: me["orgs"][0]["id"].as_str().unwrap().to_string(), cookie, _dir: dir }
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

    async fn create(&self, name: &str, settings: Value) -> (StatusCode, Value) {
        self.send(Method::POST, "/datasources", Some(json!({ "name": name, "kind": "mongodb", "settings": settings })))
            .await
    }

    async fn create_ok(&self, settings: Value) -> String {
        let (status, body) = self.create("Mongo", settings).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body["id"].as_str().unwrap().to_string()
    }

    async fn query_with(&self, id: &str, query: Value, cursor: Option<&str>) -> Value {
        let mut item = json!({ "refId": "A", "datasourceId": id, "query": query });
        if let Some(c) = cursor {
            item["cursor"] = json!(c);
        }
        let body = json!({
            "queries": [item],
            "timeRange": { "from": 1_700_000_000_000_i64, "to": 1_800_000_000_000_i64 },
            "variables": { "land": "Österreich", "ids": [1, 2] }
        });
        let (status, body) = self.send(Method::POST, "/query", Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["results"]["A"].clone()
    }

    async fn query(&self, id: &str, query: Value) -> Value {
        self.query_with(id, query, None).await
    }
}

fn read_privileges() -> Vec<Document> {
    vec![doc! {
        "resource": { "db": "shop", "collection": "" },
        "actions": ["changeStream", "collStats", "dbHash", "dbStats", "find", "killCursors", "listCollections", "listIndexes", "listSearchIndexes"]
    }]
}

fn orders() -> Vec<Document> {
    (1..=5)
        .map(|i| {
            doc! {
                "_id": ObjectId::parse_str(format!("65f0c1a2b3c4d5e6f7a8b9c{i}")).unwrap(),
                "n": i,
                "gross": 9_007_199_254_740_993_i64,
                "betrag": format!("{i}.50").parse::<bson::Decimal128>().unwrap(),
                "ts": bson::DateTime::from_millis(1_750_000_000_000 + i64::from(i)),
                "bild": Binary { subtype: BinarySubtype::Generic, bytes: vec![0xFF; 4] },
                "items": [{ "sku": "a", "menge": 1 }],
            }
        })
        .collect()
}

async fn fake(behaviour: Behaviour) -> FakeMongo {
    FakeMongo::start(Behaviour { privileges: read_privileges(), documents: orders(), ..behaviour }).await
}

fn settings(fake: &FakeMongo) -> Value {
    json!({ "hosts": format!("127.0.0.1:{}", fake.port), "database": "shop" })
}

const WRITE_COMMANDS: &[&str] = &[
    "insert",
    "update",
    "delete",
    "findAndModify",
    "create",
    "drop",
    "createIndexes",
    "dropDatabase",
    "renameCollection",
    "createUser",
    "eval",
    "mapReduce",
];

#[tokio::test]
async fn the_kind_is_listed_with_its_form() {
    let t = T::new().await;
    let (_, kinds) = t.send(Method::GET, "/datasource-kinds", None).await;
    let mongo = kinds["items"].as_array().unwrap().iter().find(|k| k["kind"] == "mongodb").expect("mongodb");
    assert_eq!(mongo["shapes"], json!(["documents"]));
    assert_eq!(mongo["hintKey"], "datasources.kinds.mongodb.hint");
    let field = |n: &str| mongo["settings"].as_array().unwrap().iter().find(|f| f["name"] == n).unwrap().clone();
    assert_eq!(field("hosts")["target"], true);
    assert_eq!(field("hosts")["required"], true);
    assert_eq!(field("password")["secret"], true);
    assert_eq!(field("port")["default"], 27017);
    assert_eq!(field("maxResponseBytes")["target"], false);
}

#[tokio::test]
async fn saving_refuses_blocked_targets_and_bad_settings() {
    let t = T::new().await;
    let (status, body) = t.create("Meta", json!({ "hosts": "db.intern, 169.254.169.254", "database": "shop" })).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "datasource_target_blocked");
    assert_eq!(body["error"]["field"], "hosts");
    assert_eq!(body["error"]["reason"], "target.metadata_address");
    let (status, body) =
        t.create("Srv", json!({ "hosts": "a.example.com,b.example.com", "srv": true, "database": "shop" })).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"]["reason"], "mongodb.srv_host", "{body}");
}

/// The driver's connections, also to names it resolves itself, pass the target rules: with only
/// 10.0.0.0/8 allowed, `localhost` passes the check without network but its address does not.
#[tokio::test]
async fn every_connection_of_the_driver_passes_the_target_rules() {
    let fake = fake(Behaviour::default()).await;
    let t = T::new().await;
    t.state
        .datasources
        .test_settings
        .lock()
        .unwrap()
        .insert("datasources.allowed_targets".into(), json!(["10.0.0.0/8"]));
    let s = json!({ "hosts": format!("localhost:{}", fake.port), "database": "shop" });
    let (status, body) = t.create("Lokal", s.clone()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "datasource_target_blocked");
    assert_eq!(body["error"]["field"], "hosts");
    assert_eq!(body["error"]["reason"], "target.not_allowed");
    assert!(fake.commands.lock().unwrap().is_empty(), "nothing reached the server");

    // Saved while allowed; once the rule changes, queries are refused the same way.
    t.state.datasources.test_settings.lock().unwrap().remove("datasources.allowed_targets");
    let id = t.create_ok(s).await;
    t.state
        .datasources
        .test_settings
        .lock()
        .unwrap()
        .insert("datasources.allowed_targets".into(), json!(["10.0.0.0/8"]));
    let r = t.query(&id, json!({ "collection": "orders", "pipeline": "[]" })).await;
    assert_eq!(r["error"]["code"], "datasource_target_blocked", "{r}");
    assert_eq!(r["error"]["reason"], "target.not_allowed");
}

#[tokio::test]
async fn a_read_only_login_queries_documents_with_their_types() {
    let fake = fake(Behaviour::default()).await;
    let t = T::new().await;
    let id = t.create_ok(settings(&fake)).await;
    assert!(
        fake.command_names().contains(&"connectionStatus".to_string()),
        "checked on save: {:?}",
        fake.command_names()
    );

    let (_, h) = t.send(Method::POST, &format!("/datasources/{id}/health"), Some(json!({}))).await;
    assert_eq!(h["ok"], true, "{h}");
    assert_eq!(h["reason"], "health.connected");
    assert_eq!(h["params"], json!({ "engine": "MongoDB", "version": "8.0.4" }));

    let r = t.query(&id, json!({ "collection": "orders", "pipeline": r#"[{"$match": {"land": "${land}", "n": {"$in": "${ids}"}, "$__timeFilter": "ts"}}, {"$sort": {"ts": -1, "n": 1}}]"# })).await;
    let set = &r["result"]["documents"];
    assert_eq!(r["result"]["shape"], "documents", "{r}");
    let first = &set["documents"][0];
    assert_eq!(first["_id"], json!({ "$type": "objectId", "value": "65f0c1a2b3c4d5e6f7a8b9c1" }));
    assert_eq!(first["n"], 1);
    assert_eq!(first["gross"], json!({ "$type": "int64", "value": "9007199254740993" }));
    assert_eq!(first["betrag"], json!({ "$type": "decimal", "value": "1.50" }));
    assert_eq!(first["ts"], json!({ "$type": "date", "value": "1750000000001" }));
    assert_eq!(first["bild"], json!({ "$type": "binary", "value": null }));
    assert_eq!(set["notices"][0]["code"], "documents.binary_hidden", "{set}");
    assert_eq!(set["notices"][0]["params"]["path"], "bild");
    let schema = set["schema"].as_array().unwrap();
    let path = |p: &str| schema.iter().find(|f| f["path"] == p).unwrap_or_else(|| panic!("{p}: {set}")).clone();
    assert_eq!(path("n")["coverage"], 1.0);
    assert_eq!(path("n")["types"], json!([{ "name": "int", "share": 1.0 }]));
    assert_eq!(path("items[].sku")["types"][0]["name"], "string");
    assert!(set.get("truncated").is_none());

    // What reached the server: typed values, the time range as dates, the order of $sort, and
    // only reading commands.
    let sent = fake.last("aggregate").unwrap();
    let stages = sent.get_array("pipeline").unwrap();
    let m = stages[0].as_document().unwrap().get_document("$match").unwrap();
    assert_eq!(m.get_str("land").unwrap(), "Österreich");
    assert_eq!(m.get_document("n").unwrap().get_array("$in").unwrap(), &vec![Bson::Int64(1), Bson::Int64(2)]);
    assert_eq!(m.get_document("ts").unwrap().get_datetime("$gte").unwrap().timestamp_millis(), 1_700_000_000_000);
    let sort: Vec<&String> = stages[1].as_document().unwrap().get_document("$sort").unwrap().keys().collect();
    assert_eq!(sort, ["ts", "n"]);
    assert!(sent.get_i64("maxTimeMS").is_ok() || sent.get_i32("maxTimeMS").is_ok(), "a server-side time limit: {sent}");
    assert!(set["executedQuery"].as_str().unwrap().starts_with("orders.aggregate([{\"$match\""), "{set}");
    for name in fake.command_names() {
        assert!(!WRITE_COMMANDS.contains(&name.as_str()), "{name}");
    }

    let (status, schema) = t.send(Method::GET, &format!("/datasources/{id}/schema"), None).await;
    assert_eq!(status, StatusCode::OK, "{schema}");
    assert_eq!(schema["kind"], "collections");
    assert_eq!(schema["database"], "shop");
    assert_eq!(schema["collections"], json!([]), "no collections listed by the fake yet");
}

#[tokio::test]
async fn the_schema_lists_collections_indexes_and_sampled_fields() {
    let fake = fake(Behaviour {
        collections: vec![
            doc! { "name": "orders", "type": "collection", "options": {}, "info": { "readOnly": false } },
            doc! { "name": "system.views", "type": "collection", "options": {}, "info": { "readOnly": false } },
            doc! { "name": "bericht", "type": "view", "options": { "viewOn": "orders", "pipeline": [] }, "info": { "readOnly": true } },
        ],
        ..Behaviour::default()
    })
    .await;
    let t = T::new().await;
    let id = t.create_ok(settings(&fake)).await;
    let (status, schema) = t.send(Method::GET, &format!("/datasources/{id}/schema"), None).await;
    assert_eq!(status, StatusCode::OK, "{schema}");
    let names: Vec<&str> =
        schema["collections"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["bericht", "orders"], "sorted, without system collections");
    let orders = &schema["collections"][1];
    assert_eq!(orders["type"], "collection");
    assert_eq!(orders["sampled"], 5);
    assert_eq!(orders["indexes"][1]["name"], "ts_land");
    assert_eq!(orders["indexes"][1]["unique"], true);
    assert_eq!(orders["indexes"][1]["keys"], json!([{ "field": "ts", "kind": -1 }, { "field": "land", "kind": 1 }]));
    assert!(
        orders["fields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["path"] == "betrag" && f["types"][0]["name"] == "decimal")
    );
    assert_eq!(schema["collections"][0]["type"], "view");
    assert_eq!(schema["collections"][0]["indexes"], json!([]));
}

#[tokio::test]
async fn limits_cut_the_set_and_the_cursor_continues_it() {
    let fake = fake(Behaviour::default()).await;
    let t = T::new().await;
    let mut s = settings(&fake);
    s["maxRows"] = json!(2);
    let id = t.create_ok(s).await;
    let q = json!({ "collection": "orders", "pipeline": "[]" });
    let first = t.query(&id, q.clone()).await;
    let set = &first["result"]["documents"];
    assert_eq!(set["documents"].as_array().unwrap().len(), 2, "{first}");
    assert_eq!(set["truncated"], json!({ "limit": 2 }));
    assert_eq!(set["notices"][0]["code"], "documents.limit");
    assert_eq!(set["notices"][0]["params"]["limit"], "2");
    let cursor = set["nextCursor"].as_str().unwrap().to_string();
    let second = t.query_with(&id, q.clone(), Some(&cursor)).await;
    let set2 = &second["result"]["documents"];
    assert_eq!(set2["documents"][0]["n"], 3, "{second}");
    assert!(set2["executedQuery"].as_str().unwrap().contains(r#"{"$skip": 2}, {"$limit": 3}"#), "{second}");
    let third = t.query_with(&id, q.clone(), set2["nextCursor"].as_str()).await;
    assert_eq!(third["result"]["documents"]["documents"].as_array().unwrap().len(), 1);
    assert!(third["result"]["documents"].get("nextCursor").is_none(), "{third}");
    // A cursor from another query is refused.
    let other =
        t.query_with(&id, json!({ "collection": "orders", "pipeline": "[{\"$match\": {}}]" }), Some(&cursor)).await;
    assert_eq!(other["error"]["reason"], "mongodb.cursor_invalid", "{other}");

    // find: the query's own limit and skip, and the source's limit on top.
    let r = t.query(&id, json!({ "collection": "orders", "filter": "{\"n\": {\"$gte\": 1}}", "sort": "{\"n\": 1}", "skip": 1, "limit": 2 })).await;
    let set = &r["result"]["documents"];
    assert_eq!(set["documents"][0]["n"], 2, "{r}");
    assert!(set.get("truncated").is_none(), "the query's own limit is no cut: {r}");
    let sent = fake.last("find").unwrap();
    assert_eq!(sent.get_document("sort").unwrap(), &doc! { "n": 1 });

    // The response size limit of the source.
    let mut s = settings(&fake);
    s["maxResponseBytes"] = json!(400);
    let (status, body) = t.send(Method::PATCH, &format!("/datasources/{id}"), Some(json!({ "settings": s }))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let r = t.query(&id, q).await;
    let set = &r["result"]["documents"];
    assert!(set["documents"].as_array().unwrap().len() < 5, "{r}");
    assert!(set["notices"].as_array().unwrap().iter().any(|n| n["code"] == "documents.size_limit"), "{r}");
    assert!(set["nextCursor"].is_string());
}

#[tokio::test]
async fn refused_queries_never_reach_the_server() {
    let fake = fake(Behaviour::default()).await;
    let t = T::new().await;
    let id = t.create_ok(settings(&fake)).await;
    let cases = [
        (json!({ "collection": "orders", "pipeline": r#"[{"$out": "kopie"}]"# }), "mongodb.write_stage"),
        (
            json!({ "collection": "orders", "pipeline": r#"[{"$facet": {"a": [{"$merge": {"into": "x"}}]}}]"# }),
            "mongodb.write_stage",
        ),
        (
            json!({ "collection": "orders", "pipeline": r#"[{"$match": {"$where": "sleep(1000)"}}]"# }),
            "mongodb.operator_not_allowed",
        ),
        (
            json!({ "collection": "orders", "filter": r#"{"$expr": {"$function": {"body": "x", "args": [], "lang": "js"}}}"# }),
            "mongodb.operator_not_allowed",
        ),
        (json!({ "collection": "orders", "pipeline": r#"[{"$currentOp": {}}]"# }), "mongodb.stage_not_allowed"),
        (json!({ "collection": "system.users", "pipeline": "[]" }), "mongodb.system_collection"),
        (json!({ "collection": "orders", "pipeline": "[]", "filter": "{}" }), "mongodb.pipeline_and_find"),
        (json!({ "collection": "orders", "pipeline": [{ "$match": {} }] }), "query.invalid_form"),
        (json!({ "collection": "orders", "runCommand": "{\"drop\": \"orders\"}" }), "query.invalid_form"),
        (
            json!({ "collection": "orders", "pipeline": r#"[{"$match": {"a": "${fehlt}"}}]"# }),
            "mongodb.variable_missing",
        ),
    ];
    let before = fake.commands.lock().unwrap().len();
    for (q, reason) in cases {
        let r = t.query(&id, q.clone()).await;
        assert_eq!(r["error"]["code"], "query_rejected", "{q}: {r}");
        assert_eq!(r["error"]["reason"], reason, "{q}: {r}");
    }
    let after: Vec<String> =
        fake.commands.lock().unwrap()[before..].iter().filter_map(|c| c.keys().next().cloned()).collect();
    assert!(!after.iter().any(|c| c == "aggregate" || c == "find"), "{after:?}");
}

#[tokio::test]
async fn logins_that_may_do_more_than_read_are_refused() {
    let mut privileges = read_privileges();
    privileges.push(doc! { "resource": { "db": "andere", "collection": "" }, "actions": ["find", "insert"] });
    let fake = fake(Behaviour::default()).await;
    fake.behaviour.lock().unwrap().privileges = privileges.clone();
    let t = T::new().await;
    let (status, body) = t.create("Schreiber", settings(&fake)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "validation");
    assert_eq!(body["error"]["field"], "user");
    assert_eq!(body["error"]["reason"], "mongodb.login_not_read_only");
    assert_eq!(body["error"]["params"], json!({ "action": "insert", "resource": "andere.*" }));

    // A server without access control is refused too: any login could write there.
    fake.behaviour.lock().unwrap().privileges = read_privileges();
    fake.behaviour.lock().unwrap().access_control_off = true;
    let (status, body) = t.create("Offen", settings(&fake)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["reason"], "mongodb.access_control_off");

    // Saved while the login could only read; when it gains more, queries and the connection test
    // refuse it.
    fake.behaviour.lock().unwrap().access_control_off = false;
    let id = t.create_ok(settings(&fake)).await;
    fake.behaviour.lock().unwrap().privileges = vec![doc! { "resource": { "cluster": true }, "actions": ["shutdown"] }];
    let r = t.query(&id, json!({ "collection": "orders", "pipeline": "[]" })).await;
    assert_eq!(r["error"]["code"], "datasource_error", "{r}");
    assert_eq!(r["error"]["reason"], "mongodb.login_not_read_only");
    assert_eq!(r["error"]["params"]["resource"], "cluster");
    let (_, h) = t.send(Method::POST, &format!("/datasources/{id}/health"), Some(json!({}))).await;
    assert_eq!(h["ok"], false, "{h}");
    assert_eq!(h["reason"], "mongodb.login_not_read_only");
}

#[tokio::test]
async fn an_unreachable_server_does_not_stop_the_save() {
    // A port nobody listens on: the check on save cannot finish, so the save goes ahead.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let t = T::new().await;
    let mut s = json!({ "hosts": format!("127.0.0.1:{closed}"), "database": "shop" });
    s["queryTimeoutSecs"] = json!(30);
    let id = t.create_ok(s).await;
    let (_, h) = t.send(Method::POST, &format!("/datasources/{id}/health"), Some(json!({}))).await;
    assert_eq!(h["ok"], false, "{h}");
    assert_eq!(h["code"], "datasource_error", "{h}");
}
