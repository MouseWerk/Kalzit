//! MongoDB sources against a real server, through the router. Needs `KALZIT_TEST_MONGODB_URL`, a
//! connection string of a login that may create databases and users
//! (`mongodb://user:password@host:port/?authSource=admin`); the CI job `datasources` sets it from a
//! service container together with `KALZIT_TEST_REQUIRE_DATABASES=1`, which turns a missing URL
//! into a failure. Elsewhere a missing URL skips the test with a printed notice.
//!
//! Each test works in its own database with its own logins and removes them afterwards. The
//! in-process server in `src/datasources/mongodb/test_server.rs` covers the rest on every run.

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use futures_util::TryStreamExt;
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::ManualClock;
use kalzit::config::Config;
use mongodb::bson::{Binary, Bson, Document, doc, oid::ObjectId, spec::BinarySubtype};
use serde_json::{Value, json};
use tower::ServiceExt;

const SETUP_CODE: &str = "test-setup-code-0123456789";

fn env(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => Some(v),
        _ if std::env::var("KALZIT_TEST_REQUIRE_DATABASES").is_ok_and(|v| v == "1") => {
            panic!("{name} is not set, but KALZIT_TEST_REQUIRE_DATABASES=1 requires every database")
        }
        _ => {
            eprintln!("{name} not set, test not run");
            None
        }
    }
}

struct T {
    app: Router,
    org: String,
    cookie: String,
    _dir: tempfile::TempDir,
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
        let app = router(state).layer(MockConnectInfo(peer));
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
        T { app, org: me["orgs"][0]["id"].as_str().unwrap().to_string(), cookie, _dir: dir }
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

    async fn query(&self, id: &str, query: Value) -> Value {
        let body = json!({
            "queries": [{ "refId": "A", "datasourceId": id, "query": query }],
            "timeRange": { "from": 1_700_000_000_000_i64, "to": 1_800_000_000_000_i64 },
            "variables": { "land": "Österreich" }
        });
        let (status, body) = self.send(Method::POST, "/query", Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["results"]["A"].clone()
    }
}

/// A number from a command document, whichever BSON number type the driver chose.
fn number(value: Option<&Bson>) -> Option<i64> {
    match value? {
        Bson::Int32(n) => Some(i64::from(*n)),
        Bson::Int64(n) => Some(*n),
        Bson::Double(n) if n.fract() == 0.0 => Some(*n as i64),
        _ => None,
    }
}

/// Whether an aggregate command carries the slow pipeline: four `$project` stages with `$range`,
/// each followed by an `$unwind`.
fn is_slow_pipeline(command: &Document) -> bool {
    let Ok(stages) = command.get_array("pipeline") else { return false };
    let stages: Vec<&Document> = stages.iter().filter_map(Bson::as_document).collect();
    let ranges = stages
        .windows(2)
        .filter(|w| {
            let range = w[0]
                .get_document("$project")
                .is_ok_and(|p| p.values().any(|v| v.as_document().is_some_and(|d| d.contains_key("$range"))));
            range && w[1].contains_key("$unwind")
        })
        .count();
    ranges == 4
}

/// A database with data and two logins (read and readWrite), removed again by `cleanup`.
struct Fixture {
    admin: mongodb::Client,
    db: String,
    host: String,
    port: u16,
}

impl Fixture {
    async fn new(url: &str) -> Fixture {
        let admin = mongodb::Client::with_uri_str(url).await.unwrap();
        let db = format!("kalzit_{}", uuid::Uuid::now_v7().simple());
        let parsed = reqwest::Url::parse(url).unwrap();
        let host = parsed.host_str().unwrap().trim_matches(['[', ']']).to_string();
        let port = parsed.port().unwrap_or(27017);
        let d = admin.database(&db);
        let orders = d.collection::<mongodb::bson::Document>("orders");
        let docs = (1..=5).map(|i: i32| {
            doc! {
                "_id": ObjectId::new(),
                "n": i,
                "gross": 9_007_199_254_740_993_i64,
                "betrag": format!("{i}.50").parse::<mongodb::bson::Decimal128>().unwrap(),
                "ts": mongodb::bson::DateTime::from_millis(1_750_000_000_000 + i64::from(i)),
                "land": if i % 2 == 0 { "Österreich" } else { "Schweiz" },
                "bild": Binary { subtype: BinarySubtype::Generic, bytes: vec![1, 2, 3] },
                "items": [{ "sku": "a", "menge": i }],
                "kunde": i % 2,
            }
        });
        orders.insert_many(docs).await.unwrap();
        d.collection::<mongodb::bson::Document>("kunden")
            .insert_many([doc! { "_id": 0, "name": "Gerade" }, doc! { "_id": 1, "name": "Ungerade" }])
            .await
            .unwrap();
        d.run_command(
            doc! { "create": "bericht", "viewOn": "orders", "pipeline": [{ "$match": { "land": "Schweiz" } }] },
        )
        .await
        .unwrap();
        d.run_command(doc! { "createUser": "leser", "pwd": "leser-pw-ci", "roles": [{ "role": "read", "db": &db }] })
            .await
            .unwrap();
        d.run_command(
            doc! { "createUser": "schreiber", "pwd": "schreiber-pw-ci", "roles": [{ "role": "readWrite", "db": &db }] },
        )
        .await
        .unwrap();
        Fixture { admin, db, host, port }
    }

    fn settings(&self, user: &str) -> Value {
        json!({ "hosts": format!("{}:{}", self.host, self.port), "database": self.db, "user": user })
    }

    /// The command documents of the slow aggregations on `orders` (four `$range` arrays, each
    /// unwound) that run on the server right now.
    async fn running(&self) -> Vec<Document> {
        let ns = format!("{}.orders", self.db);
        let ops: Vec<Document> = self
            .admin
            .database("admin")
            .aggregate([
                doc! { "$currentOp": { "allUsers": true } },
                doc! { "$match": { "ns": ns, "command.aggregate": "orders" } },
            ])
            .await
            .expect("$currentOp needs an admin login (KALZIT_TEST_MONGODB_URL)")
            .try_collect()
            .await
            .expect("$currentOp needs an admin login (KALZIT_TEST_MONGODB_URL)");
        ops.into_iter().filter_map(|op| op.get_document("command").ok().cloned()).filter(is_slow_pipeline).collect()
    }

    async fn cleanup(self) {
        let d = self.admin.database(&self.db);
        let _ = d.run_command(doc! { "dropAllUsersFromDatabase": 1 }).await;
        let _ = d.drop().await;
    }
}

#[tokio::test]
async fn mongodb_reads_with_a_read_only_login_and_refuses_more() {
    let Some(url) = env("KALZIT_TEST_MONGODB_URL") else { return };
    let f = Fixture::new(&url).await;
    let t = T::new().await;

    // Logins that may write are refused when saving, whether readWrite or the admin.
    let (status, body) = t
        .send(
            Method::POST,
            "/datasources",
            Some(json!({ "name": "Schreiber", "kind": "mongodb",
            "settings": f.settings("schreiber"), "secrets": { "password": "schreiber-pw-ci" } })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["reason"], "mongodb.login_not_read_only", "{body}");
    assert_eq!(body["error"]["field"], "user");

    let (status, body) = t
        .send(
            Method::POST,
            "/datasources",
            Some(json!({ "name": "Leser", "kind": "mongodb",
            "settings": f.settings("leser"), "secrets": { "password": "leser-pw-ci" } })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let id = body["id"].as_str().unwrap().to_string();

    let (_, h) = t.send(Method::POST, &format!("/datasources/{id}/health"), Some(json!({}))).await;
    assert_eq!(h["ok"], true, "{h}");
    assert_eq!(h["params"]["engine"], "MongoDB");
    assert!(!h.to_string().contains("leser-pw-ci"));

    let r = t
        .query(
            &id,
            json!({ "collection": "orders", "pipeline": r#"[
                {"$match": {"land": "${land}", "$__timeFilter": "ts"}},
                {"$lookup": {"from": "kunden", "localField": "kunde", "foreignField": "_id", "as": "k"}},
                {"$sort": {"n": -1}}
            ]"# }),
        )
        .await;
    let set = &r["result"]["documents"];
    let docs = set["documents"].as_array().unwrap_or_else(|| panic!("{r}"));
    assert_eq!(docs.len(), 2, "{r}");
    assert_eq!(docs[0]["n"], 4);
    assert_eq!(docs[0]["gross"], json!({ "$type": "int64", "value": "9007199254740993" }));
    assert_eq!(docs[0]["betrag"], json!({ "$type": "decimal", "value": "4.50" }));
    assert_eq!(docs[0]["ts"], json!({ "$type": "date", "value": "1750000000004" }));
    assert_eq!(docs[0]["_id"]["$type"], "objectId");
    assert_eq!(docs[0]["bild"], json!({ "$type": "binary", "value": null }));
    assert_eq!(docs[0]["k"][0]["name"], "Gerade");
    assert!(set["schema"].as_array().unwrap().iter().any(|f| f["path"] == "k[].name"), "{set}");

    let r = t
        .query(
            &id,
            json!({ "collection": "bericht", "filter": "{\"n\": {\"$gte\": 2}}", "sort": "{\"n\": 1}", "limit": 5 }),
        )
        .await;
    let docs = r["result"]["documents"]["documents"].as_array().unwrap_or_else(|| panic!("{r}")).clone();
    assert_eq!(docs.iter().map(|d| d["n"].clone()).collect::<Vec<_>>(), [json!(3), json!(5)], "{r}");

    // Writing stages and JavaScript are refused by the check; nothing was written.
    for q in [
        json!({ "collection": "orders", "pipeline": r#"[{"$out": "kopie"}]"# }),
        json!({ "collection": "orders", "pipeline": r#"[{"$merge": {"into": "kopie"}}]"# }),
        json!({ "collection": "orders", "filter": r#"{"$where": "true"}"# }),
    ] {
        assert_eq!(t.query(&id, q.clone()).await["error"]["code"], "query_rejected", "{q}");
    }
    let names = f.admin.database(&f.db).list_collection_names().await.unwrap();
    assert!(!names.contains(&"kopie".to_string()), "{names:?}");

    let (status, schema) = t.send(Method::GET, &format!("/datasources/{id}/schema"), None).await;
    assert_eq!(status, StatusCode::OK, "{schema}");
    let colls = schema["collections"].as_array().unwrap();
    let orders = colls.iter().find(|c| c["name"] == "orders").unwrap_or_else(|| panic!("{schema}"));
    assert_eq!(orders["indexes"][0]["name"], "_id_");
    assert!(orders["sampled"].as_u64().unwrap() > 0);
    assert_eq!(colls.iter().find(|c| c["name"] == "bericht").unwrap()["type"], "view");

    // maxTimeMS stops a slow pipeline on the server. The pipeline counts 10^16 rows, which no
    // hardware finishes within the limit, so the outcome does not depend on the server's speed:
    // MongoDB shows it running with Kalzit's maxTimeMS, and it is gone from the server afterwards.
    let mut s = f.settings("leser");
    s["queryTimeoutSecs"] = json!(1);
    let (status, body) = t.send(Method::PATCH, &format!("/datasources/{id}"), Some(json!({ "settings": s }))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // The change rebuilds the connection; a first query does that outside the slow query's limit.
    let warm = t.query(&id, json!({ "collection": "orders", "pipeline": "[{\"$count\": \"n\"}]" })).await;
    assert_eq!(warm["result"]["documents"]["documents"][0]["n"], 5, "{warm}");
    let slow = t.query(
        &id,
        json!({ "collection": "orders", "pipeline": r#"[{"$limit": 1},
            {"$project": {"a": {"$range": [0, 10000]}}}, {"$unwind": "$a"},
            {"$project": {"b": {"$range": [0, 10000]}}}, {"$unwind": "$b"},
            {"$project": {"c": {"$range": [0, 10000]}}}, {"$unwind": "$c"},
            {"$project": {"d": {"$range": [0, 10000]}}}, {"$unwind": "$d"},
            {"$group": {"_id": null, "n": {"$sum": 1}}}]"# }),
    );
    let seen = async {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(command) = f.running().await.into_iter().next() {
                return command;
            }
            assert!(Instant::now() < deadline, "the slow pipeline never ran on the server");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    let (slow, seen) = tokio::join!(slow, seen);
    assert_eq!(slow["error"]["code"], "query_timeout", "{slow}");
    assert_eq!(number(seen.get("maxTimeMS")), Some(1_000), "{seen}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f.running().await.is_empty() {
        assert!(Instant::now() < deadline, "the slow pipeline still runs on the server after the timeout");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let after = t.query(&id, json!({ "collection": "orders", "pipeline": "[{\"$count\": \"n\"}]" })).await;
    assert_eq!(after["result"]["documents"]["documents"][0]["n"], 5, "{after}");

    // A wrong password is a source error without the password in it.
    let (status, _) = t
        .send(Method::PATCH, &format!("/datasources/{id}"), Some(json!({ "secrets": { "password": "falsch-pw-ci" } })))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, h) = t.send(Method::POST, &format!("/datasources/{id}/health"), Some(json!({}))).await;
    assert_eq!(h["ok"], false, "{h}");
    assert!(!h.to_string().contains("falsch-pw-ci"), "{h}");

    f.cleanup().await;
}
