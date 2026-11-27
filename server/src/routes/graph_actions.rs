//! Quick actions on a graph the browser already holds (board `Graph082.dc.html`, frames 8 to 10):
//! "Pfad zwischen zwei gewählten Knoten", "Wie hängen diese zusammen" and "Wichtigste Knoten".
//! They compute on the Kalzit server with the same code and limits as the graph algorithm steps,
//! on the nodes and edges the canvas has loaded, and ask no data source anything: no query runs,
//! nothing is read or written in a source. So every member of the organization may use them,
//! viewers too (decision 4); the graph comes from the caller and goes back to the caller only.
//!
//! Only the steps the quick actions need are taken: shortest, all shortest, weighted and k
//! shortest paths, PageRank and betweenness, and degree.
//!
//! Resources: one request per user at a time, at most `MAX_REQUESTS` on the server (more answer
//! `503 busy`), in places of their own, so the stored steps of panels, Explore and alert rules
//! never wait for a quick action (they take `algo::acquire`'s places). One deadline, the
//! organization's `algorithm_timeout_secs`, covers the whole request; steps past it answer
//! `steps.timeout`. The graph is at most `MAX_NODES` nodes and `MAX_EDGES` edges, within
//! `BODY_LIMIT` bytes.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use axum::extract::State;
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::table::{RouteDef, route};
use crate::analysis::algo::AlgoLimits;
use crate::analysis::graph::{GraphOut, apply_summarized};
use crate::analysis::steps::Control;
use crate::analysis::{CentralityMeasure, PathMode, Step, StepKind, check_steps};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx};
use crate::datasources::detail::Detail;
use crate::datasources::error_body;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::locks::MutexExt;
use crate::shapes::{ErrorBody, GraphPath, GraphSet, Notice, RanIn, StepSummary};

/// Chosen nodes of "Wie hängen diese zusammen" at most (board Graph082, frame 8).
pub const MAX_CONNECT_NODES: usize = 20;
/// Steps one request may run: the pairs of the chosen nodes of "Wie hängen diese zusammen".
pub const MAX_ACTIONS: usize = MAX_CONNECT_NODES * (MAX_CONNECT_NODES - 1) / 2;
/// Nodes the canvas draws at most (`MAX_NODE_LIMIT` of the graph panels) and so sends.
pub const MAX_NODES: usize = crate::dashboards::panel_options::MAX_NODE_LIMIT as usize;
/// Edges between them a request may carry.
pub const MAX_EDGES: usize = 5 * MAX_NODES;
/// The graph of `MAX_NODES` nodes and `MAX_EDGES` edges with their properties, as JSON.
pub const BODY_LIMIT: usize = 16 * 1024 * 1024;
/// Quick-action requests computing at once on a server.
pub const MAX_REQUESTS: usize = 2;
/// The name every step's graph goes by in its frame reference.
const FRAME: &str = "A";

/// The places of the quick actions: their own, apart from the algorithm steps' places.
static PLACES: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(MAX_REQUESTS)));
/// The users with a quick action running.
static USERS: LazyLock<Arc<Mutex<HashSet<String>>>> = LazyLock::new(Arc::default);

pub fn routes() -> Vec<RouteDef> {
    vec![
        // Computes on the caller's own graph only, bounded by its own places and one deadline.
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

impl ActionResult {
    fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            ran_in: RanIn::Server,
            summary: None,
            error: None,
            paths: Vec::new(),
            values: BTreeMap::new(),
            notices: Vec::new(),
        }
    }
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

/// A user's quick action, given back when it is done.
struct UserPlace(String);

impl Drop for UserPlace {
    fn drop(&mut self) {
        USERS.lock_or_recover().remove(&self.0);
    }
}

/// What a running quick action holds: its user's place and one of the server's.
struct Places {
    _user: UserPlace,
    _server: tokio::sync::OwnedSemaphorePermit,
}

/// The places for `user_id`: one request per user, at most `MAX_REQUESTS` on the server.
fn places(user_id: &str) -> ApiResult<Places> {
    if !USERS.lock_or_recover().insert(user_id.to_string()) {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "busy",
            "you have a quick action running; wait until it is done",
        )
        .because("graph_actions.user_busy"));
    }
    let user = UserPlace(user_id.to_string());
    let server = PLACES.clone().try_acquire_owned().map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "busy",
            "too many quick actions run at the moment; try again shortly",
        )
        .because("graph_actions.busy")
    })?;
    Ok(Places { _user: user, _server: server })
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

/// Which quick action a request is, for the counter (`Metrics::graph_action`).
fn action_of(steps: &[Step]) -> &'static str {
    match steps.first().map(|s| &s.kind) {
        Some(StepKind::Paths { .. }) if steps.len() > 1 => "connect",
        Some(StepKind::Paths { .. }) => "path",
        _ => "top",
    }
}

/// The steps of a request: at most `MAX_ACTIONS`, each one the canvas offers, on `A`.
fn checked(raw: &[Value]) -> ApiResult<Vec<Step>> {
    if raw.is_empty() || raw.len() > MAX_ACTIONS {
        return Err(ApiError::validation(format!("steps takes 1 to {MAX_ACTIONS} entries")));
    }
    let steps = check_steps(raw, &BTreeSet::from([FRAME]), "steps").map_err(ApiError::validation)?;
    for (i, step) in steps.iter().enumerate() {
        let offered = matches!(
            step.kind,
            StepKind::Paths {
                mode: PathMode::Shortest | PathMode::AllShortest | PathMode::Weighted | PathMode::KShortest,
                ..
            } | StepKind::Centrality { measure: CentralityMeasure::PageRank | CentralityMeasure::Betweenness, .. }
                | StepKind::Degree { .. }
        );
        if !offered {
            return Err(ApiError::validation(format!(
                "steps[{i}]: quick actions take only paths, PageRank, betweenness and degree steps"
            )));
        }
    }
    Ok(steps)
}

/// The graph within the canvas's bounds.
fn check_graph(graph: &GraphSet) -> ApiResult<()> {
    if graph.nodes.len() > MAX_NODES || graph.edges.len() > MAX_EDGES {
        return Err(ApiError::validation(format!("the graph takes at most {MAX_NODES} nodes and {MAX_EDGES} edges"))
            .because("graph_actions.too_large")
            .param("maxNodes", MAX_NODES)
            .param("maxEdges", MAX_EDGES));
    }
    Ok(())
}

/// Runs one step on `graph` on this server and keeps what the canvas needs of its answer.
fn run_one(step: &Step, graph: &GraphSet, control: &Control) -> ActionResult {
    let mut out = ActionResult::new(&step.id);
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

/// The steps one after the other within one deadline (`control`): once it has passed, every step
/// left answers that, without computing.
fn run_all(steps: &[Step], graph: &GraphSet, control: &Control) -> Vec<ActionResult> {
    let mut results = Vec::with_capacity(steps.len());
    for step in steps {
        if let Err(detail) = control.check() {
            let mut out = ActionResult::new(&step.id);
            out.error = Some(error_body("validation", detail));
            results.push(out);
            continue;
        }
        results.push(run_one(step, graph, control));
    }
    results
}

/// `POST /orgs/{orgId}/graph/actions`: the steps on the posted graph, in the quick actions' own
/// places, within the organization's algorithm limits and one deadline for all of them.
async fn run_actions(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    JsonBody(req): JsonBody<ActionsRequest>,
) -> ApiResult<Json<ActionsResponse>> {
    let steps = checked(&req.steps)?;
    check_graph(&req.graph)?;
    let action = action_of(&steps);
    let held = match places(&ctx.user.id) {
        Ok(held) => held,
        Err(e) => {
            state.metrics.graph_action(action, false);
            return Err(e);
        }
    };
    let limits = AlgoLimits::load(&state, Some(&ctx.org_id)).await?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel = CancelOnDrop(cancelled.clone());
    let graph = req.graph;
    let results = tokio::task::spawn_blocking(move || {
        let _held = held;
        // The places are the quick actions' own: they take none of the algorithm steps'.
        let control =
            Control::new(cancelled, limits.timeout_secs.max(1)).with_algorithm_limits(limits).with_algorithm_slot(true);
        run_all(&steps, &graph, &control)
    })
    .await
    .map_err(|e| ApiError::internal("graph actions", e))?;
    state.metrics.graph_action(action, true);
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
            json!({ "id": "s", "type": "centrality", "frame": "A", "measure": "closeness" }),
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
    fn k_shortest_paths_are_a_quick_action_too() {
        assert!(
            checked(&[
                json!({ "id": "k", "type": "paths", "frame": "A", "mode": "kShortest", "k": 3, "from": "a", "to": "c" })
            ])
            .is_ok()
        );
    }

    #[test]
    fn one_quick_action_per_user_and_a_few_on_the_server() {
        let first = places("user-busy-a").expect("a first place");
        let again = places("user-busy-a").err().expect("the same user waits");
        assert_eq!(again.reason.as_ref().map(|r| r.code.as_str()), Some("graph_actions.user_busy"));
        let mut held = vec![first];
        for i in 1..MAX_REQUESTS {
            held.push(places(&format!("user-busy-{i}")).expect("a place of the server"));
        }
        let full = places("user-busy-late").err().expect("the server is full");
        assert_eq!(full.reason.as_ref().map(|r| r.code.as_str()), Some("graph_actions.busy"));
        // A refused request holds no user place: once a place is free, the user gets it.
        drop(held.pop());
        assert!(places("user-busy-late").is_ok());
        drop(held);
        assert!(places("user-busy-a").is_ok());
    }

    #[test]
    fn one_deadline_covers_every_step_of_a_request() {
        let expired = Control::new(Arc::new(AtomicBool::new(false)), 0)
            .with_algorithm_limits(AlgoLimits::default())
            .with_algorithm_slot(true);
        let steps: Vec<Step> = (0..3)
            .map(|i| step(json!({ "id": format!("p{i}"), "type": "paths", "frame": "A", "mode": "shortest", "from": "a", "to": "c" })))
            .collect();
        let results = run_all(&steps, &graph(), &expired);
        assert_eq!(results.len(), 3);
        for r in results {
            assert_eq!(r.error.and_then(|e| e.reason).as_deref(), Some("steps.timeout"));
        }
    }

    #[test]
    fn a_graph_beyond_the_canvas_is_refused() {
        let mut big = graph();
        big.nodes = (0..=MAX_NODES).map(|i| node(&format!("n{i}"))).collect();
        assert_eq!(
            check_graph(&big).err().and_then(|e| e.reason.map(|r| r.code)).as_deref(),
            Some("graph_actions.too_large")
        );
        assert!(check_graph(&graph()).is_ok());
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
