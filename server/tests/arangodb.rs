//! ArangoDB sources against a real server, through the router. Needs `KALZIT_TEST_ARANGODB_URL`,
//! the URL of a login that may create databases and users (`http://root:password@host:8529`); the
//! CI job `datasources-more` sets it from a service container together with
//! `KALZIT_TEST_REQUIRE_DATABASES=1`. Elsewhere a missing URL skips the test with a notice.
//!
//! Each test works in its own database with its own users and removes them afterwards. The fake
//! server in `src/datasources/arangodb/tests.rs` covers the rest on every run.

mod common;
mod source_harness;

use reqwest::Method as HttpMethod;
use serde_json::{Value, json};
use source_harness::{T, env, unique};

/// The admin's view of the server: a database with documents, edges, a reader and a writer.
struct Fixture {
    http: reqwest::Client,
    base: reqwest::Url,
    user: String,
    password: String,
    db: String,
    reader: String,
    writer: String,
}

impl Fixture {
    async fn call(&self, method: HttpMethod, path: &str, body: Value) -> Value {
        let url = self.base.join(path).unwrap();
        let r = self
            .http
            .request(method, url)
            .basic_auth(&self.user, Some(&self.password))
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = r.status();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        assert!(status.is_success() || status.as_u16() == 404, "{path}: {status} {v}");
        v
    }

    async fn new(raw: &str) -> Fixture {
        let mut base = reqwest::Url::parse(raw).unwrap();
        let user = base.username().to_string();
        let password = base.password().unwrap_or("").to_string();
        base.set_username("").unwrap();
        base.set_password(None).unwrap();
        let id = unique();
        let f = Fixture {
            http: reqwest::Client::new(),
            base,
            user,
            password,
            db: format!("kalzit_{id}"),
            reader: format!("leser_{id}"),
            writer: format!("schreiber_{id}"),
        };
        f.call(HttpMethod::POST, "/_api/database", json!({ "name": f.db })).await;
        let db = format!("/_db/{}", f.db);
        f.call(HttpMethod::POST, &format!("{db}/_api/collection"), json!({ "name": "persons" })).await;
        f.call(HttpMethod::POST, &format!("{db}/_api/collection"), json!({ "name": "knows", "type": 3 })).await;
        f.call(
            HttpMethod::POST,
            &format!("{db}/_api/document/persons"),
            json!([
                { "_key": "ada", "name": "Ada", "land": "Österreich", "big": 9_007_199_254_740_993_i64 },
                { "_key": "bo", "name": "Bo", "land": "Schweiz" },
                { "_key": "cy", "name": "Cy", "land": "Österreich" }
            ]),
        )
        .await;
        f.call(
            HttpMethod::POST,
            &format!("{db}/_api/document/knows"),
            json!([
                { "_from": "persons/ada", "_to": "persons/bo", "since": 2020 },
                { "_from": "persons/bo", "_to": "persons/cy", "since": 2021 }
            ]),
        )
        .await;
        for (user, grant) in [(&f.reader, "ro"), (&f.writer, "rw")] {
            f.call(HttpMethod::POST, "/_api/user", json!({ "user": user, "passwd": "kalzit-ci-user" })).await;
            f.call(HttpMethod::PUT, &format!("/_api/user/{user}/database/{}", f.db), json!({ "grant": grant })).await;
        }
        f
    }

    fn settings(&self, user: &str, extra: Value) -> Value {
        let mut s = json!({ "url": self.base.as_str(), "database": self.db, "user": user });
        for (k, v) in extra.as_object().unwrap() {
            s[k] = v.clone();
        }
        s
    }

    async fn count(&self) -> i64 {
        let r = self
            .call(
                HttpMethod::POST,
                &format!("/_db/{}/_api/cursor", self.db),
                json!({ "query": "RETURN LENGTH(persons)" }),
            )
            .await;
        r["result"][0].as_i64().unwrap()
    }

    async fn cleanup(self) {
        for user in [&self.reader, &self.writer] {
            self.call(HttpMethod::DELETE, &format!("/_api/user/{user}"), json!({})).await;
        }
        self.call(HttpMethod::DELETE, &format!("/_api/database/{}", self.db), json!({})).await;
    }
}

#[tokio::test]
async fn arangodb_reads_documents_and_graphs_with_a_read_only_user() {
    let Some(url) = env("KALZIT_TEST_ARANGODB_URL") else { return };
    let f = Fixture::new(&url).await;
    let t = T::new().await;
    let secrets = json!({ "password": "kalzit-ci-user" });
    let id = t.create("Arango", "arangodb", f.settings(&f.reader, json!({})), secrets.clone()).await;

    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");
    assert_eq!(h["reason"], "health.connected", "{h}");
    assert_eq!(h["params"]["engine"], "ArangoDB");
    assert!(!h.to_string().contains("kalzit-ci-user"));

    let schema = t.schema(&id).await;
    assert_eq!(schema["labels"], json!(["persons"]), "{schema}");
    assert_eq!(schema["edgeTypes"], json!(["knows"]), "{schema}");
    assert!(schema["propertyKeys"].as_array().unwrap().contains(&json!("name")), "{schema}");

    // Documents, with a variable as a bind parameter.
    let r = t.query(&id, json!({ "aql": "FOR p IN persons FILTER p.land == @land SORT p.name RETURN p" })).await;
    let docs = r["result"]["documents"]["documents"].as_array().unwrap_or_else(|| panic!("{r}"));
    assert_eq!(docs.len(), 2, "{r}");
    assert_eq!(docs[0]["name"], "Ada");
    assert_eq!(docs[0]["big"], json!({ "$type": "int64", "value": "9007199254740993" }));

    // A traversal is a graph with its paths.
    let r = t.query(&id, json!({ "aql": "FOR v, e, p IN 1..2 OUTBOUND 'persons/ada' knows RETURN p" })).await;
    let graph = &r["result"]["graph"];
    assert_eq!(graph["nodes"].as_array().map(Vec::len), Some(3), "{r}");
    assert_eq!(graph["edges"].as_array().map(Vec::len), Some(2), "{r}");
    assert_eq!(graph["paths"].as_array().map(Vec::len), Some(2), "{r}");
    assert!(graph["nodes"].as_array().unwrap().iter().any(|n| n["id"] == "persons/cy"), "{r}");

    // Writes are refused before they reach the server; nothing changed.
    for q in [
        "INSERT { name: 'X' } INTO persons",
        "FOR p IN persons REMOVE p IN persons",
        "FOR p IN persons UPDATE p WITH { x: 1 } IN persons",
        "UPSERT { name: 'X' } INSERT { name: 'X' } UPDATE {} IN persons",
    ] {
        let r = t.query(&id, json!({ "aql": q })).await;
        assert_eq!(r["error"]["code"], "query_rejected", "{q}: {r}");
        assert_eq!(r["error"]["reason"], "arangodb.write_refused", "{q}: {r}");
    }
    assert_eq!(f.count().await, 3);

    // A syntax error is ArangoDB's own, from its parser.
    let r = t.query(&id, json!({ "aql": "FOR p IN persons RETURN" })).await;
    assert_eq!(r["error"]["reason"], "arangodb.error", "{r}");

    t.finish().await;
    f.cleanup().await;
}

#[tokio::test]
async fn arangodb_refuses_users_who_may_write_unless_allowed() {
    let Some(url) = env("KALZIT_TEST_ARANGODB_URL") else { return };
    let f = Fixture::new(&url).await;
    let t = T::new().await;
    let secrets = json!({ "password": "kalzit-ci-user" });
    let strict = t.create("Arango rw", "arangodb", f.settings(&f.writer, json!({})), secrets.clone()).await;
    let h = t.health(&strict).await;
    assert_eq!(h["ok"], false, "{h}");
    assert_eq!(h["reason"], "arangodb.user_can_write", "{h}");
    let r = t.query(&strict, json!({ "aql": "RETURN 1" })).await;
    assert_eq!(r["error"]["reason"], "arangodb.user_can_write", "{r}");

    let allowed = t
        .create(
            "Arango rw erlaubt",
            "arangodb",
            f.settings(&f.writer, json!({ "allowWriteCapableUser": true })),
            secrets,
        )
        .await;
    let h = t.health(&allowed).await;
    assert_eq!(h["ok"], true, "{h}");
    assert_eq!(h["reason"], "health.connected_write_capable", "{h}");
    // The checks still refuse every write.
    let r = t.query(&allowed, json!({ "aql": "INSERT { name: 'X' } INTO persons" })).await;
    assert_eq!(r["error"]["reason"], "arangodb.write_refused", "{r}");
    assert_eq!(f.count().await, 3);

    t.finish().await;
    f.cleanup().await;
}
