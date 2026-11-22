//! The checks of the "algorithms" cases of `conformance.json`, for the server's unit tests and
//! for the integration tests that run the same cases in Neo4j and Memgraph (`server/tests`).
//!
//! A case names its graph, the step and what the answer must hold (`expect`). Nodes and edges
//! are named by their property `kz` when they have one (the test databases), else by their id.
//! Deterministic algorithms are checked exactly (`tolerance` 0); iterative and randomised ones by
//! invariants within the stated `tolerance`: values, a ranking, the partition into communities
//! and their number, never the ids a library gives its communities. `library` changes what is
//! checked when a library answered: another `tolerance`, values compared after dividing by the
//! largest (`relative`, where libraries count differently), or checks left out (`skip`, such as
//! the one path among several of the same length that a library picks).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::shapes::{GraphSet, StepSummary};

fn key_of(id: &str, properties: &BTreeMap<String, Value>) -> String {
    properties.get("kz").and_then(Value::as_str).unwrap_or(id).to_string()
}

fn close(a: &Value, b: &Value, tolerance: f64) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) if a.is_number() && b.is_number() => (x - y).abs() <= tolerance.max(0.0) || x == y,
        _ => a == b,
    }
}

/// Checks `graph` and `summary`, the answer of the case's step; `library` when a library
/// answered. The error says what differs.
pub fn check_case(case: &Value, graph: &GraphSet, summary: Option<&StepSummary>, library: bool) -> Result<(), String> {
    let name = case["name"].as_str().unwrap_or("?");
    let expect = &case["expect"];
    let overrides = if library { case.get("library").cloned().unwrap_or(Value::Null) } else { Value::Null };
    let skip: BTreeSet<&str> =
        overrides.get("skip").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    let tolerance =
        overrides.get("tolerance").or_else(|| expect.get("tolerance")).and_then(Value::as_f64).unwrap_or(0.0);
    let relative = overrides.get("relative").and_then(Value::as_bool).unwrap_or(false);
    let property = expect.get("property").and_then(Value::as_str).unwrap_or("");
    let node_values: BTreeMap<String, Value> = graph
        .nodes
        .iter()
        .filter_map(|n| n.properties.get(property).map(|v| (key_of(&n.id, &n.properties), v.clone())))
        .collect();
    let fail = |what: &str, detail: String| Err(format!("{name}: {what}: {detail}"));
    let wanted = |k: &str| expect.get(k).filter(|_| !skip.contains(k));

    if let Some(want) = wanted("nodes").and_then(Value::as_object) {
        let scale = |values: Vec<(String, f64)>| -> BTreeMap<String, f64> {
            let max = values.iter().map(|(_, v)| v.abs()).fold(0.0, f64::max);
            values.into_iter().map(|(k, v)| (k, if max > 0.0 { v / max } else { v })).collect()
        };
        if relative {
            let got = scale(node_values.iter().filter_map(|(k, v)| v.as_f64().map(|x| (k.clone(), x))).collect());
            let exp = scale(want.iter().filter_map(|(k, v)| v.as_f64().map(|x| (k.clone(), x))).collect());
            for (k, w) in &exp {
                let g = got.get(k).copied().unwrap_or(f64::NAN);
                if (g - w).abs() > tolerance.max(1e-9) {
                    return fail("relative value", format!("{k}: got {g}, want {w}"));
                }
            }
        } else {
            for (k, w) in want {
                match node_values.get(k) {
                    Some(g) if close(g, w, tolerance) => {}
                    other => return fail("node value", format!("{k}: got {other:?}, want {w}")),
                }
            }
        }
    }
    if let Some(want) = wanted("edges").and_then(Value::as_object) {
        let got: BTreeMap<String, Value> = graph
            .edges
            .iter()
            .filter_map(|e| e.properties.get(property).map(|v| (key_of(&e.id, &e.properties), v.clone())))
            .collect();
        for (k, w) in want {
            match got.get(k) {
                Some(g) if close(g, w, tolerance) => {}
                other => return fail("edge value", format!("{k}: got {other:?}, want {w}")),
            }
        }
    }
    if let Some(want) = wanted("partition").and_then(Value::as_array) {
        let mut groups: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for (k, v) in &node_values {
            groups.entry(v.to_string()).or_default().insert(k.clone());
        }
        let got: BTreeSet<BTreeSet<String>> = groups.into_values().collect();
        let exp: BTreeSet<BTreeSet<String>> = want
            .iter()
            .map(|g| g.as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect())
            .collect();
        if got != exp {
            return fail("partition", format!("got {got:?}, want {exp:?}"));
        }
    }
    if let Some(want) = wanted("count").and_then(Value::as_u64) {
        let got = node_values.values().map(Value::to_string).collect::<BTreeSet<_>>().len() as u64;
        if got != want {
            return fail("count", format!("got {got}, want {want}"));
        }
    }
    if let Some(want) = wanted("ranking").and_then(Value::as_array) {
        let mut got: Vec<(f64, String)> =
            node_values.iter().filter_map(|(k, v)| v.as_f64().map(|x| (x, k.clone()))).collect();
        got.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        let got: Vec<&str> = got.iter().take(want.len()).map(|(_, k)| k.as_str()).collect();
        let exp: Vec<&str> = want.iter().filter_map(Value::as_str).collect();
        if got != exp {
            return fail("ranking", format!("got {got:?}, want {exp:?}"));
        }
    }
    if let Some(want) = wanted("keep").and_then(Value::as_array) {
        let got: BTreeSet<String> = graph.nodes.iter().map(|n| key_of(&n.id, &n.properties)).collect();
        let exp: BTreeSet<String> = want.iter().filter_map(Value::as_str).map(String::from).collect();
        if got != exp {
            return fail("nodes kept", format!("got {got:?}, want {exp:?}"));
        }
    }
    if let Some(want) = wanted("keepEdges").and_then(Value::as_array) {
        let got: BTreeSet<String> = graph.edges.iter().map(|e| key_of(&e.id, &e.properties)).collect();
        let exp: BTreeSet<String> = want.iter().filter_map(Value::as_str).map(String::from).collect();
        if got != exp {
            return fail("edges kept", format!("got {got:?}, want {exp:?}"));
        }
    }
    let node_key: BTreeMap<&str, String> =
        graph.nodes.iter().map(|n| (n.id.as_str(), key_of(&n.id, &n.properties))).collect();
    if let Some(want) = wanted("paths").and_then(Value::as_array) {
        let got: Vec<Vec<String>> = graph
            .paths
            .iter()
            .flatten()
            .map(|p| {
                p.nodes.iter().map(|id| node_key.get(id.as_str()).cloned().unwrap_or_else(|| id.clone())).collect()
            })
            .collect();
        let exp: Vec<Vec<String>> = want
            .iter()
            .map(|p| p.as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect())
            .collect();
        if got != exp {
            return fail("paths", format!("got {got:?}, want {exp:?}"));
        }
    }
    if let Some(want) = wanted("pathLengths").and_then(Value::as_array) {
        let got: Vec<u64> = graph.paths.iter().flatten().map(|p| p.edges.len() as u64).collect();
        let exp: Vec<u64> = want.iter().filter_map(Value::as_u64).collect();
        if got != exp {
            return fail("path lengths", format!("got {got:?}, want {exp:?}"));
        }
    }
    for (what, edges) in
        [("suggested", graph.suggested.as_deref().unwrap_or_default()), ("similar", graph.edges.as_slice())]
    {
        let Some(want) = wanted(what).and_then(Value::as_array) else { continue };
        let mut got: BTreeMap<(String, String), f64> = BTreeMap::new();
        for e in edges.iter().filter(|e| e.properties.contains_key("score")) {
            let (a, b) = (
                node_key.get(e.from.as_str()).cloned().unwrap_or_default(),
                node_key.get(e.to.as_str()).cloned().unwrap_or_default(),
            );
            let score = e.properties.get("score").and_then(Value::as_f64).unwrap_or(f64::NAN);
            got.insert((a.clone().min(b.clone()), a.max(b)), score);
        }
        let mut exp: BTreeMap<(String, String), f64> = BTreeMap::new();
        for p in want {
            let (a, b) = (p[0].as_str().unwrap_or("").to_string(), p[1].as_str().unwrap_or("").to_string());
            exp.insert((a.clone().min(b.clone()), a.max(b)), p[2].as_f64().unwrap_or(f64::NAN));
        }
        let same = got.len() == exp.len()
            && got.iter().zip(&exp).all(|((gk, gv), (ek, ev))| gk == ek && (gv - ev).abs() <= tolerance.max(1e-12));
        if !same {
            return fail(what, format!("got {got:?}, want {exp:?}"));
        }
    }
    if let Some(want) = wanted("summary") {
        let Some(got) = summary else { return fail("summary", "none".into()) };
        if want["key"].as_str() != Some(got.key.as_str()) {
            return fail("summary key", format!("got {}, want {}", got.key, want["key"]));
        }
        for (k, w) in want["values"].as_object().into_iter().flatten() {
            match got.values.get(k) {
                Some(g) if close(g, w, tolerance.max(1e-9)) => {}
                other => return fail("summary value", format!("{k}: got {other:?}, want {w}")),
            }
        }
    }
    Ok(())
}
