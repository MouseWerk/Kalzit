//! The queries the UI's source guides put into the editor (ui/src/help/sources/guides.ts): every
//! starter, schema action and cheat sheet entry, built for a sample schema and kept in
//! `tests/fixtures/guide_queries.json` by the UI's test. Each must pass its kind's checks here,
//! the same ones a run goes through, so a guide never offers a query the server refuses.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{Value, json};

use super::frame::ResponseBudget;
use super::mongodb::pipeline::{Binder, check_collection};
use super::sql::{Context, Engine};
use super::{Limits, SourceQuery, cypher, elasticsearch, gsql, influxdb, prometheus, sql};
use crate::shapes::TimeRange;

const RANGE: TimeRange = TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 };

fn request(query: &Value) -> SourceQuery {
    SourceQuery {
        ref_id: "A".into(),
        query: query.clone(),
        range: RANGE,
        interval_ms: 30_000,
        max_data_points: None,
        variables: BTreeMap::new(),
        identifier_variables: None,
        limits: Limits { timeout: Duration::from_secs(5), max_rows: 1000, budget: ResponseBudget::new(1 << 20) },
        cursor: None,
    }
}

fn text<'a>(query: &'a Value, key: &str) -> &'a str {
    query.get(key).and_then(Value::as_str).unwrap_or_else(|| panic!("no {key} in {query}"))
}

/// The check of one query, by its kind; `Err` names why it would be refused.
fn check(kind: &str, query: &Value) -> Result<(), String> {
    let engine = match kind {
        "postgres" => Some(Engine::Postgres),
        "mysql" => Some(Engine::MySql),
        "sqlite" => Some(Engine::Sqlite),
        "mssql" => Some(Engine::MsSql),
        "clickhouse" => Some(Engine::ClickHouse),
        _ => None,
    };
    if let Some(engine) = engine {
        let vars = BTreeMap::new();
        let ctx = Context {
            range: RANGE,
            interval_ms: 30_000,
            variables: &vars,
            identifiers: None,
            identifier_variables: None,
        };
        return sql::prepare(text(query, "sql"), engine, &ctx).map(|_| ()).map_err(|e| e.message);
    }
    let req = request(query);
    match kind {
        "prometheus" => prometheus::expand(text(query, "expr"), &req).map(|_| ()).map_err(|e| e.to_string()),
        "loki" => prometheus::expand(text(query, "logql"), &req).map(|_| ()).map_err(|e| e.to_string()),
        "influxdb" => influxdb::check_text(query, &req).map_err(|e| e.to_string()),
        "elasticsearch" => {
            if let Some(index) = query.get("index").and_then(Value::as_str) {
                elasticsearch::check_index(index).map_err(|e| e.to_string())?;
            }
            match query.get("dsl") {
                Some(dsl) => elasticsearch::check_dsl(dsl).map_err(|e| e.to_string()),
                None => Ok(()),
            }
        }
        "mongodb" => {
            check_collection(text(query, "collection")).map_err(|e| e.to_string())?;
            let binder = Binder { range: RANGE, interval_ms: 30_000, variables: &req.variables, max_documents: 1000 };
            binder.pipeline(text(query, "pipeline")).map(|_| ()).map_err(|e| e.to_string())
        }
        "neo4j" | "memgraph" => cypher::check(text(query, "cypher")).map(|_| ()).map_err(|e| e.message),
        "tigergraph" => match query.get("gsql") {
            Some(_) => gsql::check(text(query, "gsql"), gsql::Form::Interpret).map(|_| ()).map_err(|e| e.message),
            // An installed query is the source's own; its name is checked against the schema when it runs.
            None => Ok(()),
        },
        // Files and HTTP JSON take `{}`: there is no language to check.
        "file" | "http_json" => {
            if query == &json!({}) {
                Ok(())
            } else {
                Err(format!("expected {{}}, got {query}"))
            }
        }
        other => Err(format!("no check for the kind {other}")),
    }
}

#[test]
fn every_guide_query_passes_the_checks_of_its_kind() {
    let fixture: Vec<Value> =
        serde_json::from_str(include_str!("../../tests/fixtures/guide_queries.json")).expect("the fixture is JSON");
    assert!(fixture.len() > 100, "the fixture holds the queries of every guide");
    let mut kinds = std::collections::BTreeSet::new();
    let refused: Vec<String> = fixture
        .iter()
        .filter_map(|entry| {
            let kind = entry["kind"].as_str().expect("kind");
            kinds.insert(kind.to_string());
            check(kind, &entry["query"]).err().map(|why| format!("{kind} {}: {why}\n{}", entry["id"], entry["query"]))
        })
        .collect();
    assert!(refused.is_empty(), "refused:\n{}", refused.join("\n\n"));
    let registry = super::registry::KindRegistry::built_in();
    for kind in registry.all() {
        assert!(kinds.contains(kind.kind()), "the guide of {} is missing from the fixture", kind.kind());
    }
}
