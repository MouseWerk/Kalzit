//! Quick actions on a graph the browser already holds (board `Graph082.dc.html`, frames 8 to 10):
//! "Pfad zwischen zwei gewählten Knoten", "Wie hängen diese zusammen" and "Wichtigste Knoten".
//! They compute on the Kalzit server with the same code and limits as the graph algorithm steps,
//! on the nodes and edges the canvas has loaded, and ask no data source anything: no query runs,
//! nothing is read or written in a source. So every member of the organization may use them,
//! viewers too (decision 4); the graph comes from the caller and goes back to the caller only.
//!
//! Only the steps the quick actions need are taken: paths, centrality and degree.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::Method;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::table::{RouteDef, route};
use crate::analysis::algo::{self, AlgoLimits};
use crate::analysis::graph::{GraphOut, apply_summarized};
use crate::analysis::steps::Control;
use crate::analysis::{CentralityMeasure, Step, StepKind, check_steps};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx};
use crate::datasources::detail::Detail;
use crate::datasources::error_body;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::shapes::{ErrorBody, GraphPath, GraphSet, Notice, RanIn, StepSummary};

/// Steps one request may run: the pairs of ten chosen nodes ("Wie hängen diese zusammen").
pub const MAX_ACTIONS: usize = 45;
/// A loaded graph is at most this large as JSON; the canvas holds no larger one.
pub const BODY_LIMIT: usize = 32 * 1024 * 1024;
/// The name every step's graph goes by in its frame reference.
const FRAME: &str = "A";

pub fn routes() -> Vec<RouteDef> {
    vec![
        // Computes on the caller's own graph only; the algorithm limits bound the work.
        route(Method::POST, "/orgs/{orgId}/graph/actions", Access::OrgMember, run_actions)
            .body_limit(BODY_LIMIT)
            .long_running(),
    ]
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActionsRequest {
    graph: GraphSet,
    steps: Vec<Value>,
}

/// What one step found, small enough for the canvas: the paths, or a value per node id.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ActionResult {
    id: String,
    ran_in: RanIn,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<StepSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    paths: Vec<GraphPath>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    values: BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    notices: Vec<Notice>,
}

#[derive(Serialize)]
struct ActionsResponse {
    results: Vec<ActionResult>,
}

/// Sets the cancel flag when the request goes away, so a step computing in a thread stops.
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// The property a step writes its value to.
fn value_name(kind: &StepKind) -> Option<String> {
    match kind {
        StepKind::Degree { name, .. } => Some(name.clone().unwrap_or_else(|| "degree".into())),
        StepKind::Centrality { name, measure, .. } => Some(name.clone().unwrap_or_else(|| {
            match measure {
                CentralityMeasure::PageRank => "pagerank",
                CentralityMeasure::Betweenness => "betweenness",
                CentralityMeasure::Closeness => "closeness",
                CentralityMeasure::Eigenvector => "eigenvector",
                CentralityMeasure::Harmonic => "harmonic",
            }
            .into()
        })),
        _ => None,
    }
}

/// The steps of a request: at most `MAX_ACTIONS`, each a path, centrality or degree step on `A`.
fn checked(raw: &[Value]) -> ApiResult<Vec<Step>> {
    if raw.is_empty() || raw.len() > MAX_ACTIONS {
        return Err(ApiError::validation(format!("steps takes 1 to {MAX_ACTIONS} entries")));
    }
    let steps = check_steps(raw, &BTreeSet::from([FRAME]), "steps").map_err(ApiError::validation)?;
    for (i, step) in steps.iter().enumerate() {
        if !matches!(step.kind, StepKind::Paths { .. } | StepKind::Centrality { .. } | StepKind::Degree { .. }) {
            return Err(ApiError::validation(format!(
                "steps[{i}]: quick actions take only paths, centrality and degree steps"
            )));
        }
    }
    Ok(steps)
}

/// Runs one step on `graph` on this server and keeps what the canvas needs of its answer.
fn run_one(step: &Step, graph: &GraphSet, control: &Control) -> ActionResult {
    let mut out = ActionResult {
        id: step.id.clone(),
        ran_in: RanIn::Server,
        summary: None,
        error: None,
        paths: Vec::new(),
        values: BTreeMap::new(),
        notices: Vec::new(),
    };
    // An algorithm step checks its size against the limits itself (`algo::apply`).
    match apply_summarized(&step.kind, graph, control) {
        Ok((GraphOut::Graph(after), summary)) => {
            out.summary = summary;
            out.paths = after.paths.unwrap_or_default();
            out.notices = after.notices.unwrap_or_default();
            if let Some(name) = value_name(&step.kind) {
                for node in after.nodes {
                    if let Some(v) = node.properties.get(&name) {
                        out.values.insert(node.id, v.clone());
                    }
                }
            }
        }
        // None of the steps taken here answers a table.
        Ok((GraphOut::Frame(_), _)) => {
            out.error = Some(error_body("internal", Detail::new("steps.failed", "the step answered no graph")));
        }
        Err(detail) => out.error = Some(error_body("validation", detail)),
    }
    out
}

/// `POST /orgs/{orgId}/graph/actions`: the steps one by one on the posted graph, each within the
/// algorithm limits of the organization and waiting for one of the server's places.
async fn run_actions(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    JsonBody(req): JsonBody<ActionsRequest>,
) -> ApiResult<Json<ActionsResponse>> {
    let steps = checked(&req.steps)?;
    let limits = AlgoLimits::load(&state, Some(&ctx.org_id)).await?;
    let graph = Arc::new(req.graph);
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel = CancelOnDrop(cancelled.clone());
    let mut results = Vec::with_capacity(steps.len());
    for step in steps {
        let until = Instant::now() + Duration::from_secs(limits.timeout_secs);
        let slot = match algo::acquire(limits.max_parallel, until, limits.timeout_secs).await {
            Ok(slot) => slot,
            Err(detail) => {
                results.push(ActionResult {
                    id: step.id.clone(),
                    ran_in: RanIn::Server,
                    summary: None,
                    error: Some(error_body("validation", detail)),
                    paths: Vec::new(),
                    values: BTreeMap::new(),
                    notices: Vec::new(),
                });
                continue;
            }
        };
        let (graph, flag) = (graph.clone(), cancelled.clone());
        let result = tokio::task::spawn_blocking(move || {
            let _slot = slot;
            let control =
                Control::new(flag, limits.timeout_secs.max(1)).with_algorithm_limits(limits).with_algorithm_slot(true);
            run_one(&step, &graph, &control)
        })
        .await
        .map_err(|e| ApiError::internal("graph actions", e))?;
        results.push(result);
    }
    Ok(Json(ActionsResponse { results }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{Edge, Node};
    use serde_json::json;

    fn node(id: &str) -> Node {
        Node { id: id.into(), labels: vec!["Kunde".into()], properties: BTreeMap::new() }
    }

    fn edge(id: &str, from: &str, to: &str, cost: f64) -> Edge {
        Edge {
            id: id.into(),
            edge_type: "KAUFT".into(),
            from: from.into(),
            to: to.into(),
            properties: BTreeMap::from([("cost".to_string(), json!(cost))]),
        }
    }

    /// a - b - c, and a long way a - d - e - c that is cheaper by `cost`.
    fn graph() -> GraphSet {
        let nodes = ["a", "b", "c", "d", "e"].map(node).to_vec();
        let edges = vec![
            edge("1", "a", "b", 5.0),
            edge("2", "b", "c", 5.0),
            edge("3", "a", "d", 1.0),
            edge("4", "d", "e", 1.0),
            edge("5", "e", "c", 1.0),
        ];
        let schema = crate::analysis::graph::schema_of(&nodes, &edges);
        GraphSet { nodes, edges, schema, ..Default::default() }
    }

    fn control() -> Control {
        Control::new(Arc::new(AtomicBool::new(false)), 30)
            .with_algorithm_limits(AlgoLimits::default())
            .with_algorithm_slot(true)
    }

    fn step(value: Value) -> Step {
        checked(&[value]).expect("a quick action").remove(0)
    }

    #[test]
    fn only_paths_centrality_and_degree_are_taken() {
        for kind in [
            json!({ "id": "s", "type": "paths", "frame": "A", "mode": "shortest", "from": "a", "to": "c" }),
            json!({ "id": "s", "type": "centrality", "frame": "A", "measure": "pageRank" }),
            json!({ "id": "s", "type": "degree", "frame": "A" }),
        ] {
            assert!(checked(&[kind]).is_ok());
        }
        for kind in [
            json!({ "id": "s", "type": "communities", "frame": "A", "algorithm": "louvain" }),
            json!({ "id": "s", "type": "countLabels", "frame": "A" }),
            json!({ "id": "s", "type": "filterGraph", "frame": "A" }),
        ] {
            assert!(checked(&[kind]).is_err());
        }
        assert!(checked(&[]).is_err());
        let many: Vec<Value> =
            (0..=MAX_ACTIONS).map(|i| json!({ "id": format!("s{i}"), "type": "degree", "frame": "A" })).collect();
        assert!(checked(&many).is_err());
        // The steps keep the checks of the steps themselves.
        assert!(
            checked(&[json!({ "id": "s", "type": "paths", "frame": "A", "mode": "shortest", "from": "a", "to": "a" })])
                .is_err()
        );
        assert!(
            checked(&[json!({ "id": "s", "type": "paths", "frame": "B", "mode": "shortest", "from": "a", "to": "c" })])
                .is_err()
        );
    }

    #[test]
    fn a_path_comes_back_as_its_nodes_and_edges() {
        let shortest = run_one(
            &step(json!({ "id": "p", "type": "paths", "frame": "A", "mode": "shortest", "from": "a", "to": "c" })),
            &graph(),
            &control(),
        );
        assert_eq!(shortest.error, None);
        assert_eq!(shortest.paths.len(), 1);
        assert_eq!(shortest.paths[0].nodes, vec!["a", "b", "c"]);
        assert_eq!(shortest.summary.as_ref().map(|s| s.key.as_str()), Some("analysis.summary.paths"));
        let weighted = run_one(
            &step(
                json!({ "id": "w", "type": "paths", "frame": "A", "mode": "weighted", "weight": "cost", "from": "a", "to": "c" }),
            ),
            &graph(),
            &control(),
        );
        assert_eq!(weighted.paths[0].nodes, vec!["a", "d", "e", "c"]);
        let all = run_one(
            &step(json!({ "id": "x", "type": "paths", "frame": "A", "mode": "allShortest", "from": "a", "to": "c" })),
            &graph(),
            &control(),
        );
        assert_eq!(all.paths.len(), 1);
    }

    #[test]
    fn scores_come_back_by_node_id() {
        let ranked = run_one(
            &step(json!({ "id": "r", "type": "centrality", "frame": "A", "measure": "pageRank" })),
            &graph(),
            &control(),
        );
        assert_eq!(ranked.error, None);
        assert_eq!(ranked.values.len(), 5);
        let sum: f64 = ranked.values.values().filter_map(Value::as_f64).sum();
        assert!((sum - 1.0).abs() < 1e-6, "{sum}");
        let degree = run_one(&step(json!({ "id": "d", "type": "degree", "frame": "A" })), &graph(), &control());
        assert_eq!(degree.values.get("a"), Some(&json!(2)));
        assert_eq!(degree.values.get("c"), Some(&json!(2)));
    }

    #[test]
    fn a_failing_step_says_why_in_plain_words() {
        let missing = run_one(
            &step(json!({ "id": "p", "type": "paths", "frame": "A", "mode": "shortest", "from": "a", "to": "zz" })),
            &graph(),
            &control(),
        );
        assert_eq!(missing.error.and_then(|e| e.reason).as_deref(), Some("steps.node_missing"));
        let small = Control::new(Arc::new(AtomicBool::new(false)), 30)
            .with_algorithm_limits(AlgoLimits { max_nodes: 2, ..AlgoLimits::default() })
            .with_algorithm_slot(true);
        let too_large = run_one(
            &step(json!({ "id": "r", "type": "centrality", "frame": "A", "measure": "pageRank" })),
            &graph(),
            &small,
        );
        assert_eq!(too_large.error.and_then(|e| e.reason).as_deref(), Some("steps.algorithm_too_large"));
    }
}
