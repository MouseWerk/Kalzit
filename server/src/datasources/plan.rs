//! Query plans (docs/api/datasources.md, "Query plans"): `EXPLAIN` and `PROFILE` of a Cypher
//! query as one readable tree of operators, whatever engine answered. Neo4j sends the plan in the
//! metadata at the end of the result (`plan`, `profile`); Memgraph answers with rows, one per
//! operator, drawn as a tree with `*` and `|`. Two readers turn both into `PlanOperator`.
//!
//! `PROFILE` runs the query: the source runs it with the same read-only check, read transaction,
//! timeout and limits as any query, and throws the records away. GSQL has no plan that TigerGraph
//! gives for any query, so a TigerGraph source answers `available: false` with
//! `plan.not_available_gsql`; other kinds without plans answer `plan.unsupported`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum PlanMode {
    /// The plan without running the query.
    Explain,
    /// Runs the query and counts rows and work per operator.
    Profile,
}

impl PlanMode {
    pub fn keyword(self) -> &'static str {
        match self {
            PlanMode::Explain => "EXPLAIN",
            PlanMode::Profile => "PROFILE",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct QueryPlan {
    pub mode: PlanMode,
    pub available: bool,
    /// Why there is no plan (`plan.not_available_gsql`, `plan.unsupported`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub message: Option<String>,
    /// The query text the plan is of (a pattern's compiled Cypher, for instance).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub root: Option<PlanOperator>,
    /// `PROFILE`: the database hits of all operators together, where the engine counts them.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub total_db_hits: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PlanOperator {
    /// The operator's name (`NodeByLabelScan`, `ScanAllByLabel`, `Expand`).
    pub operator: String,
    /// What it works on, as the engine writes it (`n:Person`, `(n :Person)`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<String>>", optional))]
    pub identifiers: Vec<String>,
    /// Neo4j's estimate.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub estimated_rows: Option<f64>,
    /// `PROFILE`: rows the operator produced (Memgraph: its hits).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub rows: Option<u64>,
    /// `PROFILE`: database hits (Neo4j).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub db_hits: Option<u64>,
    /// `PROFILE`: time spent in the operator, in milliseconds, where the engine measures it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub time_ms: Option<f64>,
    /// `PROFILE` (Memgraph): the operator's share of the whole time, in percent.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub time_share: Option<f64>,
    pub children: Vec<PlanOperator>,
}

/// The answer of a source without plans.
pub fn unavailable(kind: &str, mode: PlanMode) -> QueryPlan {
    let (reason, message) = if kind == "tigergraph" {
        ("plan.not_available_gsql", "TigerGraph gives no plan for GSQL queries in general, so there is none to show")
    } else {
        ("plan.unsupported", "this kind of data source has no query plans")
    };
    QueryPlan {
        mode,
        available: false,
        reason: Some(reason.into()),
        message: Some(message.into()),
        query: None,
        root: None,
        total_db_hits: None,
    }
}

impl QueryPlan {
    pub fn of(mode: PlanMode, query: String, root: Option<PlanOperator>) -> Self {
        let total_db_hits = root.as_ref().and_then(|r| {
            let mut total = None;
            r.visit(&mut |op| {
                if let Some(h) = op.db_hits {
                    total = Some(total.unwrap_or(0u64).saturating_add(h));
                }
            });
            total
        });
        QueryPlan {
            mode,
            available: root.is_some(),
            reason: root.is_none().then(|| "plan.empty".to_string()),
            message: root.is_none().then(|| "the database sent no plan for this query".to_string()),
            query: Some(query),
            root,
            total_db_hits,
        }
    }
}

impl PlanOperator {
    fn visit(&self, f: &mut impl FnMut(&PlanOperator)) {
        f(self);
        for c in &self.children {
            c.visit(f);
        }
    }
}

fn number(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|f| f.is_finite())
}

fn count(v: Option<&Value>) -> Option<u64> {
    v.and_then(|v| v.as_u64().or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)))
}

/// The most operators a plan may have; deeper or larger plans are cut there.
const MAX_OPERATORS: usize = 10_000;
const MAX_DEPTH: usize = 200;

/// Neo4j's `plan` or `profile` from the summary of a result: `operatorType` (with `@neo4j`),
/// `args` (`Details`, `EstimatedRows`), `identifiers`, `children`, and for a profile `rows`,
/// `dbHits` and `time` (nanoseconds).
pub fn from_neo4j(plan: &Value) -> Option<PlanOperator> {
    let mut budget = MAX_OPERATORS;
    neo4j_operator(plan, 0, &mut budget)
}

fn neo4j_operator(v: &Value, depth: usize, budget: &mut usize) -> Option<PlanOperator> {
    let name = v.get("operatorType").and_then(Value::as_str)?;
    if depth > MAX_DEPTH || *budget == 0 {
        return None;
    }
    *budget -= 1;
    let args = v.get("args");
    let arg = |k: &str| args.and_then(|a| a.get(k));
    let details = arg("Details").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
    let identifiers = v
        .get("identifiers")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let time_ns = number(v.get("time")).or_else(|| number(arg("Time")));
    let children = v
        .get("children")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| neo4j_operator(c, depth + 1, budget))
        .collect();
    Some(PlanOperator {
        operator: name.split('@').next().unwrap_or(name).to_string(),
        details,
        identifiers,
        estimated_rows: number(arg("EstimatedRows")),
        rows: count(v.get("rows")).or_else(|| count(arg("Rows"))),
        db_hits: count(v.get("dbHits")).or_else(|| count(arg("DbHits"))),
        time_ms: time_ns.map(|ns| ns / 1_000_000.0),
        time_share: None,
        children,
    })
}

/// One row of Memgraph's plan: the operator text with its tree drawing, and for `PROFILE` the
/// hits, the relative time (`"12.5 %"`) and the absolute time (`"0.012 ms"`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MemgraphRow {
    pub operator: String,
    pub hits: Option<u64>,
    pub relative: Option<String>,
    pub absolute: Option<String>,
}

fn leading_number(s: &str) -> Option<f64> {
    let s = s.trim();
    let end = s.find(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | '-' | 'e' | 'E' | '+'))).unwrap_or(s.len());
    s[..end].parse::<f64>().ok().filter(|f| f.is_finite())
}

fn milliseconds(s: &str) -> Option<f64> {
    let n = leading_number(s)?;
    let unit =
        s.trim().trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, '.' | '-' | 'e' | 'E' | '+')).trim();
    Some(match unit {
        "s" => n * 1000.0,
        "us" | "µs" => n / 1000.0,
        "ns" => n / 1_000_000.0,
        _ => n,
    })
}

/// Memgraph's rows as a tree. Each operator line is `* Name details`; the `|` before the `*`
/// give its depth, a line `|\` opens a branch below the last operator one level up. An operator
/// is the input (child) of the operator before it on the same level, the first one of a branch
/// the child of the operator the branch hangs from.
pub fn from_memgraph(rows: &[MemgraphRow]) -> Option<PlanOperator> {
    let mut arena: Vec<(PlanOperator, Vec<usize>)> = Vec::new();
    let mut last: Vec<usize> = Vec::new();
    let mut root = None;
    for row in rows.iter().take(MAX_OPERATORS) {
        let line = row.operator.as_str();
        let Some(star) = line.find('*') else {
            if line.contains('\\') {
                let depth = line.matches('|').count();
                last.truncate(depth);
            }
            continue;
        };
        let depth = line[..star].matches('|').count().min(MAX_DEPTH);
        let rest = line[star + 1..].trim();
        let (name, details) = match rest.split_once(char::is_whitespace) {
            Some((n, d)) if !d.trim().is_empty() => (n, Some(d.trim().to_string())),
            Some((n, _)) => (n, None),
            None => (rest, None),
        };
        let op = PlanOperator {
            operator: name.to_string(),
            details,
            rows: row.hits,
            time_ms: row.absolute.as_deref().and_then(milliseconds),
            time_share: row.relative.as_deref().and_then(leading_number),
            ..Default::default()
        };
        let idx = arena.len();
        arena.push((op, Vec::new()));
        let parent = if depth < last.len() { Some(last[depth]) } else { last.last().copied() };
        match (root, parent) {
            (None, _) => root = Some(idx),
            (Some(_), Some(p)) => arena[p].1.push(idx),
            (Some(_), None) => {}
        }
        last.truncate(depth);
        while last.len() < depth {
            // A level skipped in the drawing hangs from the last operator above it.
            last.push(*last.last().unwrap_or(&idx));
        }
        last.push(idx);
    }
    fn build(arena: &mut Vec<(PlanOperator, Vec<usize>)>, i: usize, depth: usize) -> PlanOperator {
        let children = std::mem::take(&mut arena[i].1);
        let mut op = std::mem::take(&mut arena[i].0);
        if depth < MAX_DEPTH {
            op.children = children.into_iter().map(|c| build(arena, c, depth + 1)).collect();
        }
        op
    }
    root.map(|r| build(&mut arena, r, 0))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The `profile` metadata of Neo4j 2026.10 for
    /// `PROFILE MATCH (a:Person)-[:KENNT]->(b) WHERE a.name = $n RETURN b`, shortened.
    fn neo4j_profile() -> Value {
        json!({
            "operatorType": "ProduceResults@neo4j",
            "args": { "Details": "b", "EstimatedRows": 1.0, "planner": "COST", "runtime": "SLOTTED" },
            "identifiers": ["a", "anon_0", "b"],
            "dbHits": 0, "rows": 1, "pageCacheHits": 0, "pageCacheMisses": 0, "time": 25_000,
            "children": [{
                "operatorType": "Expand(All)@neo4j",
                "args": { "Details": "(a)-[anon_0:KENNT]->(b)", "EstimatedRows": 1.0 },
                "identifiers": ["a", "anon_0", "b"], "dbHits": 4, "rows": 1, "time": 12_000,
                "children": [{
                    "operatorType": "Filter@neo4j",
                    "args": { "Details": "a.name = $n", "EstimatedRows": 1.5 },
                    "identifiers": ["a"], "dbHits": 4, "rows": 1,
                    "children": [{
                        "operatorType": "NodeByLabelScan@neo4j",
                        "args": { "Details": "a:Person", "EstimatedRows": 3.0 },
                        "identifiers": ["a"], "dbHits": 3, "rows": 2, "children": []
                    }]
                }]
            }]
        })
    }

    #[test]
    fn neo4j_plans_read_into_a_tree() {
        let root = from_neo4j(&neo4j_profile()).unwrap();
        assert_eq!(root.operator, "ProduceResults");
        assert_eq!(root.details.as_deref(), Some("b"));
        assert_eq!(root.time_ms, Some(0.025));
        let expand = &root.children[0];
        assert_eq!((expand.operator.as_str(), expand.db_hits, expand.rows), ("Expand(All)", Some(4), Some(1)));
        let scan = &expand.children[0].children[0];
        assert_eq!((scan.operator.as_str(), scan.estimated_rows), ("NodeByLabelScan", Some(3.0)));
        let plan = QueryPlan::of(PlanMode::Profile, "PROFILE ...".into(), Some(root));
        assert_eq!(plan.total_db_hits, Some(11));
        assert!(plan.available);
        // EXPLAIN has no counts.
        let plan = QueryPlan::of(
            PlanMode::Explain,
            String::new(),
            from_neo4j(&json!({ "operatorType": "ProduceResults@neo4j" })),
        );
        assert_eq!(plan.total_db_hits, None);
        assert!(plan.root.unwrap().children.is_empty());
        assert!(!QueryPlan::of(PlanMode::Explain, String::new(), from_neo4j(&json!({}))).available);
    }

    fn rows(lines: &[&str]) -> Vec<MemgraphRow> {
        lines.iter().map(|l| MemgraphRow { operator: (*l).to_string(), ..Default::default() }).collect()
    }

    #[test]
    fn memgraph_plans_read_into_a_tree() {
        // `EXPLAIN MATCH (a:Person), (b) RETURN a, b` on Memgraph 3.x.
        let root = from_memgraph(&rows(&[
            " * Produce {a, b}",
            " * Cartesian {a : b}",
            " |\\ ",
            " | * ScanAll (b)",
            " | * Once",
            " * ScanAllByLabel (a :Person)",
            " * Once",
        ]))
        .unwrap();
        assert_eq!((root.operator.as_str(), root.details.as_deref()), ("Produce", Some("{a, b}")));
        let cartesian = &root.children[0];
        assert_eq!(cartesian.operator, "Cartesian");
        let names: Vec<_> = cartesian.children.iter().map(|c| c.operator.as_str()).collect();
        assert_eq!(names, ["ScanAll", "ScanAllByLabel"]);
        assert_eq!(cartesian.children[0].children[0].operator, "Once");
        assert_eq!(cartesian.children[1].children[0].operator, "Once");
        assert_eq!(cartesian.children[1].details.as_deref(), Some("(a :Person)"));

        // PROFILE rows carry hits and times.
        let profiled = from_memgraph(&[
            MemgraphRow {
                operator: "* Produce".into(),
                hits: Some(3),
                relative: Some("40.12 %".into()),
                absolute: Some("0.012345 ms".into()),
            },
            MemgraphRow {
                operator: "* ScanAll".into(),
                hits: Some(3),
                relative: Some("59.88 %".into()),
                absolute: Some("18 us".into()),
            },
            MemgraphRow { operator: "* Once".into(), hits: Some(2), relative: None, absolute: None },
        ])
        .unwrap();
        assert_eq!((profiled.rows, profiled.time_share, profiled.time_ms), (Some(3), Some(40.12), Some(0.012345)));
        assert_eq!(profiled.children[0].time_ms, Some(0.018));
        assert_eq!(profiled.children[0].children[0].operator, "Once");
        assert!(from_memgraph(&[]).is_none());
    }

    #[test]
    fn sources_without_plans_say_why() {
        let p = unavailable("tigergraph", PlanMode::Explain);
        assert_eq!((p.available, p.reason.as_deref()), (false, Some("plan.not_available_gsql")));
        assert_eq!(unavailable("postgres", PlanMode::Profile).reason.as_deref(), Some("plan.unsupported"));
    }
}
