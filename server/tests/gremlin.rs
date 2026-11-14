//! Gremlin sources against a real Gremlin Server, through the router. Needs
//! `KALZIT_TEST_GREMLIN_URL` (`ws://host:8182/gremlin`) of a server that serves TinkerPop's
//! "modern" toy graph as `g` (`tinkerpop/gremlin-server` started with
//! `conf/gremlin-server-modern.yaml`); the CI job `datasources-more` starts one, together with
//! `KALZIT_TEST_REQUIRE_DATABASES=1`. Elsewhere a missing URL skips the test with a notice.
//!
//! The fake server in `src/datasources/gremlin/tests.rs` covers the rest on every run.

mod common;
mod source_harness;

use std::time::Duration;

use kalzit::datasources::gremlin::{traversal, wire};
use kalzit::datasources::targets::TargetPolicy;
use serde_json::json;
use source_harness::{T, env};

/// Vertices and edges of the modern graph.
const VERTICES: usize = 6;

#[tokio::test]
async fn gremlin_reads_graphs_and_values_and_refuses_writes() {
    let Some(url) = env("KALZIT_TEST_GREMLIN_URL") else { return };
    let t = T::new().await;
    let id = t.create("Gremlin", "gremlin", json!({ "url": url }), json!({})).await;

    let h = t.health(&id).await;
    assert_eq!(h["ok"], true, "{h}");

    let schema = t.schema(&id).await;
    assert_eq!(schema["labels"], json!(["person", "software"]), "{schema}");
    assert_eq!(schema["edgeTypes"], json!(["created", "knows"]), "{schema}");
    assert!(schema["propertyKeys"].as_array().unwrap().contains(&json!("name")), "{schema}");

    // Vertices and edges are a graph.
    let r = t
        .query(&id, json!({ "gremlin": "g.V().hasLabel('person').has('name', 'marko').outE('knows').inV().path()" }))
        .await;
    let graph = &r["result"]["graph"];
    assert_eq!(graph["nodes"].as_array().map(Vec::len), Some(3), "{r}");
    assert_eq!(graph["edges"].as_array().map(Vec::len), Some(2), "{r}");
    assert_eq!(graph["paths"].as_array().map(Vec::len), Some(2), "{r}");
    let marko = graph["nodes"].as_array().unwrap().iter().find(|n| n["properties"]["name"] == "marko");
    assert!(marko.is_some(), "properties are part of the nodes: {r}");

    // Values are documents; a variable goes in as a value.
    let r = t
        .query(&id, json!({ "gremlin": "g.V().has('age', gt(30)).order().by('age').project('name', 'age').by('name').by('age')" }))
        .await;
    let docs = r["result"]["documents"]["documents"].as_array().unwrap_or_else(|| panic!("{r}"));
    assert_eq!(docs, &[json!({ "name": "josh", "age": 32 }), json!({ "name": "peter", "age": 35 })], "{r}");
    let r = t.query(&id, json!({ "gremlin": "g.V().count()" })).await;
    assert_eq!(r["result"]["documents"]["documents"], json!([{ "value": VERTICES }]), "{r}");

    // Kalzit's check refuses writes before they are sent.
    for q in [
        "g.addV('person').property('name', 'x')",
        "g.V().drop()",
        "g.V().property('age', 1)",
        "g.V().sideEffect(drop())",
    ] {
        let r = t.query(&id, json!({ "gremlin": q })).await;
        assert_eq!(r["error"]["code"], "query_rejected", "{q}: {r}");
        assert_eq!(r["error"]["reason"], "gremlin.write_refused", "{q}: {r}");
    }
    let r = t.query(&id, json!({ "gremlin": "g.V().map{ it.get() }" })).await;
    assert_eq!(r["error"]["reason"], "gremlin.lambda", "{r}");

    // The server's own guard: a mutating traversal sent past Kalzit's check is refused under
    // ReadOnlyStrategy, which Kalzit adds to every traversal.
    let policy = TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &[]);
    let parsed = reqwest::Url::parse(&url).unwrap();
    let steps = vec![traversal::Step { name: "addV".into(), args: vec![traversal::Arg::Str("kalzit".into())] }];
    let target = wire::Target { url: &parsed, ca_pem: None, timeout: Duration::from_secs(10), max_message: 1 << 20 };
    let mut w = wire::Wire::connect(&policy, target).await.unwrap();
    let args = json!({ "gremlin": traversal::bytecode(&steps), "aliases": { "g": "g" } });
    let e = w
        .request("traversal", "bytecode", args, None, &|s: &str| s.to_string(), &mut |_| true, |_| true)
        .await
        .unwrap_err();
    assert_eq!(e.detail().reason, "gremlin.readonly_violation", "{e:?}");
    w.close().await;
    let r = t.query(&id, json!({ "gremlin": "g.V().count()" })).await;
    assert_eq!(r["result"]["documents"]["documents"], json!([{ "value": VERTICES }]), "nothing was added: {r}");
    t.finish().await;
}
