//! Couchbase sources against a real server, through the router. Needs
//! `KALZIT_TEST_COUCHBASE_URL`, the query service URL of an administrator
//! (`http://Administrator:password@host:8093`), on a cluster with the bucket `kalzit` (documents
//! and a primary index) as `.github/couchbase/setup.sh` prepares it. `KALZIT_TEST_COUCHBASE_READER`
//! (`user:password`) names a user with only `query_select` and `data_reader`, where the edition
//! has those roles. The CI job `datasources-more` sets both, with
//! `KALZIT_TEST_REQUIRE_DATABASES=1`. Elsewhere a missing URL skips the test with a notice.
//!
//! The fake query service in `src/datasources/couchbase/tests.rs` covers the rest on every run.

mod common;
mod source_harness;

use serde_json::{Value, json};
use source_harness::{T, admin_http, env};

struct Admin {
    base: reqwest::Url,
    user: String,
    password: String,
}

impl Admin {
    fn new(raw: &str) -> Admin {
        let mut base = reqwest::Url::parse(raw).unwrap();
        let user = base.username().to_string();
        let password = base.password().unwrap_or("").to_string();
        base.set_username("").unwrap();
        base.set_password(None).unwrap();
        Admin { base, user, password }
    }

    fn settings(&self, user: &str, extra: Value) -> Value {
        let mut s = json!({ "url": self.base.as_str(), "user": user, "bucket": "kalzit" });
        for (k, v) in extra.as_object().unwrap() {
            s[k] = v.clone();
        }
        s
    }

    /// A statement sent straight to the query service as the administrator.
    async fn statement(&self, statement: &str, readonly: bool) -> Value {
        let url = self.base.join("query/service").unwrap();
        admin_http()
            .post(url)
            .basic_auth(&self.user, Some(&self.password))
            // request_plus: the primary index must include every write made before this statement,
            // otherwise a count right after the setup script can miss its documents.
            .json(&json!({ "statement": statement, "readonly": readonly, "scan_consistency": "request_plus" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    async fn count(&self) -> i64 {
        self.statement("SELECT RAW COUNT(*) FROM kalzit", true).await["results"][0].as_i64().unwrap()
    }
}

#[tokio::test]
async fn couchbase_reads_documents_and_refuses_writes() {
    let Some(url) = env("KALZIT_TEST_COUCHBASE_URL") else { return };
    let admin = Admin::new(&url);
    let before = admin.count().await;
    assert!(before >= 3, "the setup script stores documents in the bucket kalzit");
    let t = T::new().await;
    let secrets = json!({ "password": admin.password });

    // The administrator may write: refused unless allowed.
    let strict =
        t.create("Couchbase admin", "couchbase", admin.settings(&admin.user, json!({})), secrets.clone()).await;
    let h = t.health(&strict).await;
    assert_eq!(h["ok"], false, "{h}");
    assert_eq!(h["reason"], "couchbase.user_can_write", "{h}");
    assert!(!h.to_string().contains(&admin.password));

    let id = t
        .create(
            "Couchbase erlaubt",
            "couchbase",
            admin.settings(&admin.user, json!({ "allowWriteCapableUser": true })),
            secrets,
        )
        .await;
    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");
    assert_eq!(h["reason"], "health.connected_write_capable", "{h}");
    assert_eq!(h["params"]["engine"], "Couchbase");

    let schema = t.schema(&id).await;
    let colls = schema["collections"].as_array().unwrap_or_else(|| panic!("{schema}"));
    let default = colls.iter().find(|c| c["name"] == "kalzit._default._default").unwrap_or_else(|| panic!("{schema}"));
    assert!(default["sampled"].as_u64().unwrap() > 0, "{schema}");

    // Documents, with a variable as a named parameter.
    let r = t
        .query(&id, json!({ "sqlpp": "SELECT d.name, d.land FROM kalzit AS d WHERE d.land = $land ORDER BY d.name" }))
        .await;
    let docs = r["result"]["documents"]["documents"].as_array().unwrap_or_else(|| panic!("{r}"));
    assert_eq!(
        docs,
        &[json!({ "name": "Ada", "land": "Österreich" }), json!({ "name": "Cy", "land": "Österreich" })],
        "{r}"
    );
    let r = t.query(&id, json!({ "sqlpp": "SELECT RAW COUNT(*) FROM kalzit" })).await;
    assert_eq!(r["result"]["documents"]["documents"][0]["value"], before, "{r}");

    // Kalzit's check refuses writes before they are sent.
    for q in [
        "INSERT INTO kalzit (KEY, VALUE) VALUES ('x', {'name': 'X'})",
        "DELETE FROM kalzit",
        "UPDATE kalzit SET name = 'X'",
        "SELECT 1; DELETE FROM kalzit",
    ] {
        let r = t.query(&id, json!({ "sqlpp": q })).await;
        assert_eq!(r["error"]["code"], "query_rejected", "{q}: {r}");
    }
    // The query service's own guard, which every request of Kalzit carries: a write in a
    // read-only request is refused (error 1000).
    let refused = admin.statement("DELETE FROM kalzit", true).await;
    assert_eq!(refused["errors"][0]["code"], 1000, "{refused}");
    assert_eq!(admin.count().await, before);

    // A reader, where the edition has the reading roles.
    if let Some(reader) = std::env::var("KALZIT_TEST_COUCHBASE_READER").ok().filter(|r| !r.is_empty()) {
        let (user, password) = reader.split_once(':').unwrap();
        let rid = t
            .create("Couchbase Leser", "couchbase", admin.settings(user, json!({})), json!({ "password": password }))
            .await;
        let h = t.health(&rid).await;
        assert_eq!(h["ok"], true, "{h}");
        assert_eq!(h["reason"], "health.connected", "{h}");
        let r = t.query(&rid, json!({ "sqlpp": "SELECT RAW d.name FROM kalzit AS d ORDER BY d.name LIMIT 1" })).await;
        assert_eq!(r["result"]["documents"]["documents"][0]["value"], "Ada", "{r}");
    }
    t.finish().await;
}
