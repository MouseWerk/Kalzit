//! Graph algorithms as steps (docs/PLAN.md, section 15, 0.8.2; board
//! docs/design/blueprint/Graph082.dc.html; docs/api/settings-dashboards.md, "Graph algorithm
//! steps"): centrality, communities, similarity, link prediction, paths, structures and the two
//! steps that reshape a graph (`transform`). Every step keeps the graph and adds what it found:
//! node or edge properties (`pagerank`, `community`, `distance`, ...), the graph's paths, or
//! suggested edges, which stay apart (`GraphSet::suggested`). Similarity may answer a table of
//! pairs instead. Nothing is written back to the source.
//!
//! Where a step runs: in the source's own library where it has one that can be limited to the
//! result (Neo4j GDS on a projection of exactly the result's nodes and edges, Memgraph MAGE through
//! `*_subgraph` procedures or `project()`; `library.rs`), else here on the Kalzit server. Both
//! ways read the same input, the nodes of the result and the edges between them, and build their
//! answer with the same code (`finish`), so they differ only where an iterative or randomised
//! method may (the cases in `conformance.json`, "algorithms", say how much).
//!
//! Limits (server settings `datasources.algorithm_*`, which an organization may only lower;
//! `AlgoLimits`): nodes per step (a fifth for the costly steps), memory per step (estimated
//! before it starts), time per step, how many steps compute on the server at once (`gate`), and
//! how many paths or cycles a step lists and how long they may be. Every algorithm looks at the
//! cancel flag and its deadline while it runs, so a request that goes away or takes too long stops
//! it.

pub mod centrality;
pub mod community;
pub mod conformance;
pub mod library;
pub mod paths;
pub mod similarity;
pub mod structure;
pub mod transform;

use std::cell::Cell;
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::graph::{GraphOut, schema_of, text_order};
use super::steps::Control;
use super::{
    CentralityMeasure, CommunityAlgorithm, Direction, PathMode, SimilarityMeasure, SimilarityOutput, StepKind,
};
use crate::datasources::detail::Detail;
use crate::shapes::{
    Edge, Field, FieldType, Frame, FrameMeta, GraphPath, GraphSet, Notice, NoticeSeverity, StepSummary,
};

/// The bounds of one algorithm step; the server settings `datasources.algorithm_*` set them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AlgoLimits {
    /// The longest one step may compute, within the time left of its query.
    pub timeout_secs: u64,
    /// Nodes one step reads; the costly steps (`costly`) a fifth of it.
    pub max_nodes: usize,
    /// The memory one step may take, estimated from the graph before it starts.
    pub max_memory_bytes: usize,
    /// Steps computing on this server at once; further ones wait within their time.
    pub max_parallel: usize,
    /// Paths or cycles one step lists at most.
    pub max_results: u32,
    /// Edges of a listed cycle or of one of the k shortest paths at most.
    pub max_length: u32,
    /// Similar nodes per node (`topK` of similarity) at most.
    pub max_top_k: u32,
    /// Suggested edges of one link prediction step at most.
    pub max_suggestions: u32,
}

impl Default for AlgoLimits {
    fn default() -> Self {
        Self {
            timeout_secs: 30,
            max_nodes: 100_000,
            max_memory_bytes: 512 * 1024 * 1024,
            max_parallel: 2,
            max_results: 200,
            max_length: 8,
            max_top_k: 100,
            max_suggestions: 50,
        }
    }
}

/// The settings that hold `AlgoLimits` (`settings::REGISTRY`); all but the parallel steps of a
/// server have an organization setting that may only lower the server's.
pub const SETTING_TIMEOUT: &str = "datasources.algorithm_timeout_secs";
pub const SETTING_MAX_NODES: &str = "datasources.algorithm_max_nodes";
pub const SETTING_MAX_MEMORY: &str = "datasources.algorithm_max_memory_bytes";
pub const SETTING_MAX_PARALLEL: &str = "datasources.algorithm_max_parallel";
pub const SETTING_MAX_RESULTS: &str = "datasources.algorithm_max_results";
pub const SETTING_MAX_LENGTH: &str = "datasources.algorithm_max_length";
pub const SETTING_MAX_TOP_K: &str = "datasources.algorithm_max_top_k";
pub const SETTING_MAX_SUGGESTIONS: &str = "datasources.algorithm_max_suggestions";

impl AlgoLimits {
    /// The limits from the server settings, lowered where the organization `org_id` set lower.
    pub async fn load(state: &crate::app::AppState, org_id: Option<&str>) -> crate::error::ApiResult<Self> {
        let get = |key: &'static str, org: bool| async move {
            let server = crate::settings::get(state, key).await?.as_u64().unwrap_or(1).max(1);
            let own = match org_id.filter(|_| org) {
                Some(org) => crate::settings::get_org(state, org, key).await?.as_u64(),
                None => None,
            };
            Ok::<u64, crate::error::ApiError>(own.map_or(server, |own| own.clamp(1, server)))
        };
        Ok(Self {
            timeout_secs: get(SETTING_TIMEOUT, true).await?,
            max_nodes: get(SETTING_MAX_NODES, true).await? as usize,
            max_memory_bytes: get(SETTING_MAX_MEMORY, true).await? as usize,
            max_parallel: get(SETTING_MAX_PARALLEL, false).await? as usize,
            max_results: u32::try_from(get(SETTING_MAX_RESULTS, true).await?).unwrap_or(u32::MAX),
            max_length: u32::try_from(get(SETTING_MAX_LENGTH, true).await?).unwrap_or(u32::MAX),
            max_top_k: u32::try_from(get(SETTING_MAX_TOP_K, true).await?).unwrap_or(u32::MAX),
            max_suggestions: u32::try_from(get(SETTING_MAX_SUGGESTIONS, true).await?).unwrap_or(u32::MAX),
        })
    }
}

/// Visits between two looks at the cancel flag and the deadline.
const TICKS: usize = 4096;

/// The stop signals of one step: its run's (`Control`) and its own deadline.
pub struct Budget<'a> {
    control: &'a Control,
    until: Instant,
    secs: u64,
    ticks: Cell<usize>,
}

impl<'a> Budget<'a> {
    pub fn new(control: &'a Control) -> Self {
        let secs = control.algorithm_limits().timeout_secs;
        Self { control, until: Instant::now() + Duration::from_secs(secs), secs, ticks: Cell::new(0) }
    }

    /// Fails when the step should stop.
    pub fn check(&self) -> Result<(), Detail> {
        self.control.check()?;
        if Instant::now() >= self.until {
            return Err(Detail::new(
                "steps.algorithm_timeout",
                format!("the algorithm took longer than {} s and was stopped", self.secs),
            )
            .with("seconds", self.secs));
        }
        Ok(())
    }

    /// The limits the step runs within.
    pub fn limits(&self) -> AlgoLimits {
        self.control.algorithm_limits()
    }

    /// `check`, every `TICKS` calls: once per node or edge visited.
    pub fn tick(&self) -> Result<(), Detail> {
        let t = self.ticks.get().wrapping_add(1);
        self.ticks.set(t);
        if t.is_multiple_of(TICKS) { self.check() } else { Ok(()) }
    }
}

/// Algorithm steps computing on this server now (`gate`).
static RUNNING: AtomicUsize = AtomicUsize::new(0);

/// A place among the steps that compute at once; given back when dropped.
pub struct Slot;

impl Drop for Slot {
    fn drop(&mut self) {
        RUNNING.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Waits for one of `max` places, as long as the step may run.
pub fn gate(budget: &Budget, max: usize) -> Result<Slot, Detail> {
    loop {
        let now = RUNNING.load(Ordering::SeqCst);
        if now < max.max(1) && RUNNING.compare_exchange(now, now + 1, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            return Ok(Slot);
        }
        budget.check()?;
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// The graph as the algorithms read it: the result's nodes (by their place in `nodes`) and the
/// edges whose ends both are among them (of the step's edge types, when it names some), with a
/// weight each (1 without a weight property).
pub struct Topo {
    pub n: usize,
    /// Per kept edge: its place in the graph's `edges`, its start and its end.
    pub edge_at: Vec<usize>,
    pub ends: Vec<(usize, usize)>,
    pub weight: Vec<f64>,
    /// Per node: (neighbour, kept edge) along and against the edges' direction.
    pub out: Vec<Vec<(usize, usize)>>,
    pub inn: Vec<Vec<(usize, usize)>>,
}

impl Topo {
    /// The topology of `graph`; with `weight`, the weight of each edge from that property, which
    /// must be a number of 0 or more where it is set; with `types`, only edges of those types.
    pub fn build(graph: &GraphSet, weight: Option<&str>, types: &[String]) -> Result<Self, Detail> {
        let index: HashMap<&str, usize> = graph.nodes.iter().enumerate().map(|(i, n)| (n.id.as_str(), i)).collect();
        let n = graph.nodes.len();
        let mut topo = Topo {
            n,
            edge_at: Vec::new(),
            ends: Vec::new(),
            weight: Vec::new(),
            out: vec![Vec::new(); n],
            inn: vec![Vec::new(); n],
        };
        for (at, e) in graph.edges.iter().enumerate() {
            if !types.is_empty() && !types.contains(&e.edge_type) {
                continue;
            }
            let (Some(&a), Some(&b)) = (index.get(e.from.as_str()), index.get(e.to.as_str())) else { continue };
            let w = match weight {
                None => 1.0,
                Some(key) => match e.properties.get(key).filter(|v| !v.is_null()) {
                    None => 1.0,
                    Some(v) => match super::graph::number_of(v) {
                        Some(w) if w >= 0.0 => w,
                        _ => {
                            return Err(Detail::new(
                                "steps.weight_invalid",
                                format!("the weight {key} of edge {} is no number of 0 or more", e.id),
                            )
                            .with("edge", &e.id)
                            .with("key", key));
                        }
                    },
                },
            };
            let k = topo.ends.len();
            topo.edge_at.push(at);
            topo.ends.push((a, b));
            topo.weight.push(w);
            topo.out[a].push((b, k));
            topo.inn[b].push((a, k));
        }
        Ok(topo)
    }

    /// The topology a step reads: its weight and edge types.
    pub fn of(graph: &GraphSet, kind: &StepKind) -> Result<Self, Detail> {
        Self::build(graph, weight_of(kind), edge_types_of(kind))
    }

    pub fn m(&self) -> usize {
        self.ends.len()
    }

    /// The (neighbour, edge) pairs of `v` in `direction`; a loop is listed twice for `Both`.
    pub fn around(&self, v: usize, direction: Direction) -> impl Iterator<Item = (usize, usize)> + '_ {
        let out = (direction != Direction::In).then(|| self.out[v].iter().copied());
        let inn = (direction != Direction::Out).then(|| self.inn[v].iter().copied());
        out.into_iter().flatten().chain(inn.into_iter().flatten())
    }

    /// The distinct neighbours of every node in `direction`, sorted, without the node itself:
    /// the simple graph that triangles, cores, bridges, similarity and link prediction read.
    pub fn simple(&self, direction: Direction) -> Vec<Vec<usize>> {
        (0..self.n)
            .map(|v| {
                let mut list: Vec<usize> = self.around(v, direction).map(|(u, _)| u).filter(|u| *u != v).collect();
                list.sort_unstable();
                list.dedup();
                list
            })
            .collect()
    }
}

/// What an algorithm found, before it becomes part of the graph (`finish`). The server's
/// algorithms and the answers of a library (`library::merge`) both end here.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// One number per node.
    Scores(Vec<f64>),
    /// The community or component of every node.
    Partition(Vec<usize>),
    /// The core number of every node.
    Cores(Vec<u64>),
    /// Triangles and the local clustering coefficient of every node.
    Triangles(Vec<u64>, Vec<f64>),
    /// Scored pairs of nodes; per node at most the step's top k (similarity) or the step's top
    /// k of all (link prediction).
    Pairs(Vec<(usize, usize, f64)>),
    /// Paths as nodes and kept edges, and how many there are when not all are given.
    Paths { paths: Vec<(Vec<usize>, Vec<usize>)>, total: Option<u64> },
    /// The distance in edges of every node reached.
    Reached(Vec<Option<u32>>),
    /// Per kept edge whether it is a bridge.
    EdgeFlags(Vec<bool>),
    /// Per node whether it is an articulation point.
    NodeFlags(Vec<bool>),
    /// Cycles as nodes and kept edges, and whether there may be more than were given.
    Cycles { cycles: Vec<(Vec<usize>, Vec<usize>)>, cut: bool },
}

/// The direction a step reads when it does not say: along the edges for cycles and
/// `aggregateAlong`, either way for the others (board 0.8.2: paths and centrality "Beide").
pub fn direction_of(kind: &StepKind) -> Direction {
    let given = match kind {
        StepKind::Centrality { direction, .. }
        | StepKind::Similarity { direction, .. }
        | StepKind::Paths { direction, .. }
        | StepKind::Reachable { direction, .. }
        | StepKind::Cycles { direction, .. }
        | StepKind::AggregateAlong { direction, .. } => *direction,
        _ => None,
    };
    given.unwrap_or(match kind {
        StepKind::Cycles { .. } | StepKind::AggregateAlong { .. } => Direction::Out,
        _ => Direction::Both,
    })
}

/// The weight property a step reads, if any.
pub fn weight_of(kind: &StepKind) -> Option<&str> {
    match kind {
        StepKind::Paths { weight, .. } | StepKind::Centrality { weight, .. } | StepKind::Communities { weight, .. } => {
            weight.as_deref()
        }
        _ => None,
    }
}

/// The edge types a step reads (all when empty).
pub fn edge_types_of(kind: &StepKind) -> &[String] {
    match kind {
        StepKind::Paths { edge_types, .. }
        | StepKind::Reachable { edge_types, .. }
        | StepKind::Similarity { edge_types, .. }
        | StepKind::AggregateAlong { edge_types, .. } => edge_types,
        _ => &[],
    }
}

/// The steps whose work grows fastest with the graph; they read a fifth of the nodes.
pub fn costly(kind: &StepKind) -> bool {
    matches!(
        kind,
        StepKind::Centrality {
            measure: CentralityMeasure::Betweenness | CentralityMeasure::Closeness | CentralityMeasure::Harmonic,
            ..
        } | StepKind::Similarity { .. }
    )
}

/// How many paths or cycles a step lists and how long they may be, as given or by default.
pub struct Bounds {
    pub max_count: u32,
    pub max_length: u32,
}

/// Defaults of the steps' optional parameters (board 0.8.2, frames 2 and 3).
pub const DEFAULT_RESULTS: u32 = 200;
pub const DEFAULT_CYCLE_LENGTH: u32 = 6;
pub const DEFAULT_K: u32 = 3;
pub const DEFAULT_HOPS: u32 = 2;
pub const DEFAULT_SIMILAR: u32 = 10;
pub const DEFAULT_SUGGESTIONS: u32 = 50;

fn bound(param: &str, value: u32, max: u32) -> Result<u32, Detail> {
    if value > max {
        return Err(Detail::new(
            "steps.algorithm_bound",
            format!("{param} may be at most {max} here (server setting)"),
        )
        .with("param", param)
        .with("max", max));
    }
    Ok(value)
}

/// How many similar nodes per node (similarity) or suggestions (link prediction) a step gives:
/// as given, else the default within the limits.
pub fn top_k(kind: &StepKind, limits: &AlgoLimits) -> u32 {
    match kind {
        StepKind::Similarity { top_k, .. } => top_k.unwrap_or(DEFAULT_SIMILAR.min(limits.max_top_k)),
        StepKind::LinkPrediction { top_k, .. } => top_k.unwrap_or(DEFAULT_SUGGESTIONS.min(limits.max_suggestions)),
        _ => u32::MAX,
    }
}

/// The bounds of a listing step within the limits; a value above them is refused.
pub fn bounds(kind: &StepKind, limits: &AlgoLimits) -> Result<Bounds, Detail> {
    let results = DEFAULT_RESULTS.min(limits.max_results);
    match kind {
        StepKind::Similarity { .. } => {
            bound("topK", top_k(kind, limits), limits.max_top_k)?;
        }
        StepKind::LinkPrediction { .. } => {
            bound("topK", top_k(kind, limits), limits.max_suggestions)?;
        }
        _ => {}
    }
    Ok(match kind {
        StepKind::Cycles { max_length, max_count, .. } => Bounds {
            max_count: bound("maxCount", max_count.unwrap_or(results), limits.max_results)?,
            max_length: bound(
                "maxLength",
                max_length.unwrap_or(DEFAULT_CYCLE_LENGTH.min(limits.max_length)),
                limits.max_length,
            )?,
        },
        StepKind::Paths { mode: PathMode::KShortest, k, max_length, .. } => Bounds {
            max_count: bound("k", k.unwrap_or(DEFAULT_K), limits.max_results)?,
            max_length: bound("maxLength", max_length.unwrap_or(limits.max_length), limits.max_length)?,
        },
        StepKind::Paths { mode: PathMode::AllShortest, max_paths, max_length, .. } => Bounds {
            max_count: bound("maxPaths", max_paths.unwrap_or(results), limits.max_results)?,
            max_length: max_length.unwrap_or(super::MAX_PATH_LENGTH),
        },
        StepKind::Paths { max_length, .. } => {
            Bounds { max_count: 1, max_length: max_length.unwrap_or(super::MAX_PATH_LENGTH) }
        }
        _ => Bounds { max_count: u32::MAX, max_length: u32::MAX },
    })
}

/// Refuses a graph above the step's limits, before anything is built for it.
pub fn check_size(kind: &StepKind, graph: &GraphSet, limits: &AlgoLimits) -> Result<(), Detail> {
    bounds(kind, limits)?;
    let n = graph.nodes.len();
    let m = graph.edges.len();
    let max = if costly(kind) { (limits.max_nodes / 5).max(1) } else { limits.max_nodes };
    if n > max {
        return Err(Detail::new(
            "steps.algorithm_too_large",
            format!("the result has {n} nodes; this step reads at most {max}"),
        )
        .with("nodes", n)
        .with("maxNodes", max));
    }
    let needed = estimate(kind, n, m);
    if needed > limits.max_memory_bytes {
        return Err(Detail::new(
            "steps.algorithm_memory",
            format!(
                "the step would need about {} MB; a step may take {} MB",
                needed.div_ceil(1 << 20),
                limits.max_memory_bytes.div_ceil(1 << 20)
            ),
        )
        .with("neededMb", needed.div_ceil(1 << 20))
        .with("maxMb", limits.max_memory_bytes.div_ceil(1 << 20)));
    }
    Ok(())
}

/// The memory a step takes on a graph of `n` nodes and `m` edges, in bytes, generously: the
/// topology and what the algorithm keeps per node, pair or path at most, and the graph it answers.
pub fn estimate(kind: &StepKind, n: usize, m: usize) -> usize {
    let topology = n.saturating_mul(112).saturating_add(m.saturating_mul(112));
    let answer = n.saturating_mul(160).saturating_add(m.saturating_mul(160));
    let own = match kind {
        StepKind::Centrality { .. } => n.saturating_mul(64),
        StepKind::Communities { .. } => n.saturating_mul(96).saturating_add(m.saturating_mul(64)),
        StepKind::KCore { .. } | StepKind::Triangles { .. } => {
            n.saturating_mul(48).saturating_add(m.saturating_mul(16))
        }
        StepKind::Similarity { top_k, properties, .. } => n
            .saturating_mul(top_k.unwrap_or(DEFAULT_SIMILAR) as usize * 24 + 64 + properties.len() * 8)
            .saturating_add(m.saturating_mul(16)),
        StepKind::LinkPrediction { top_k, .. } => n
            .saturating_mul(64)
            .saturating_add(m.saturating_mul(16))
            .saturating_add(top_k.unwrap_or(DEFAULT_SUGGESTIONS) as usize * 64),
        StepKind::Paths { mode, k, max_paths, .. } => {
            let paths = match mode {
                PathMode::KShortest => k.unwrap_or(DEFAULT_K) as usize * 4,
                PathMode::AllShortest => max_paths.unwrap_or(DEFAULT_RESULTS) as usize,
                _ => 1,
            };
            n.saturating_mul(64).saturating_add(paths.saturating_mul(n.min(10_000)).saturating_mul(16))
        }
        StepKind::Reachable { .. } | StepKind::Bridges { .. } | StepKind::ArticulationPoints { .. } => {
            n.saturating_mul(48)
        }
        StepKind::Cycles { max_length, max_count, .. } => n.saturating_mul(48).saturating_add(
            max_length.unwrap_or(DEFAULT_CYCLE_LENGTH) as usize * max_count.unwrap_or(DEFAULT_RESULTS) as usize * 32,
        ),
        StepKind::MergeNodes { aggregates, .. } => n.saturating_mul(96 + aggregates.len() * 32),
        StepKind::AggregateAlong { .. } => n.saturating_mul(64),
        _ => 0,
    };
    topology.saturating_add(answer).saturating_add(own)
}

/// Runs an algorithm step on the server: what it makes of the graph, and its summary.
pub fn apply(kind: &StepKind, graph: &GraphSet, control: &Control) -> Result<(GraphOut, StepSummary), Detail> {
    let limits = control.algorithm_limits();
    check_size(kind, graph, &limits)?;
    let budget = Budget::new(control);
    let _slot = gate(&budget, limits.max_parallel)?;
    if let StepKind::MergeNodes { .. } | StepKind::AggregateAlong { .. } = kind {
        return transform::apply(kind, graph, &budget).map(|(g, s)| (GraphOut::Graph(g), s));
    }
    let topo = Topo::of(graph, kind)?;
    let direction = direction_of(kind);
    let b = bounds(kind, &limits)?;
    let outcome =
        match kind {
            StepKind::Centrality { measure, damping, max_iterations, tolerance, .. } => Outcome::Scores(
                centrality::run(&topo, *measure, direction, *damping, *max_iterations, *tolerance, &budget)?,
            ),
            StepKind::Communities { algorithm, max_iterations, resolution, .. } => Outcome::Partition(community::run(
                &topo,
                *algorithm,
                *max_iterations,
                resolution.unwrap_or(1.0),
                &budget,
            )?),
            StepKind::KCore { .. } => Outcome::Cores(structure::cores(&topo, &budget)?),
            StepKind::Triangles { .. } => {
                let (t, c) = structure::triangles(&topo, &budget)?;
                Outcome::Triangles(t, c)
            }
            StepKind::Similarity { .. } => Outcome::Pairs(similarity::similar(graph, &topo, kind, &budget)?),
            StepKind::LinkPrediction { .. } => Outcome::Pairs(similarity::predict(graph, &topo, kind, &budget)?),
            StepKind::Paths { .. } => paths::run(graph, &topo, kind, &b, &budget)?,
            StepKind::Reachable { from, max_hops, .. } => Outcome::Reached(paths::reachable(
                &topo,
                &starts(graph, from)?,
                max_hops.unwrap_or(DEFAULT_HOPS),
                direction,
                &budget,
            )?),
            StepKind::Bridges { .. } => Outcome::EdgeFlags(structure::bridges(&topo, &budget)?),
            StepKind::ArticulationPoints { .. } => Outcome::NodeFlags(structure::articulation(&topo, &budget)?),
            StepKind::Cycles { .. } => {
                let (cycles, cut) = structure::cycles(&topo, direction, b.max_length, b.max_count, &budget)?;
                Outcome::Cycles { cycles, cut }
            }
            _ => unreachable!("only algorithm steps run here"),
        };
    finish(kind, graph, &topo, outcome)
}

/// The places of the nodes `ids` in `graph`; a node the result does not have is refused.
pub fn starts(graph: &GraphSet, ids: &[String]) -> Result<Vec<usize>, Detail> {
    ids.iter().map(|id| node_place(graph, id)).collect()
}

pub fn node_place(graph: &GraphSet, id: &str) -> Result<usize, Detail> {
    graph
        .nodes
        .iter()
        .position(|n| n.id == id)
        .ok_or_else(|| Detail::new("steps.node_missing", format!("the result has no node {id}")).with("node", id))
}

pub(crate) fn number(x: f64) -> Value {
    super::expr::to_json(super::expr::V::Num(x))
}

/// The name of a node for a summary or a table: its text property `name`, else its id.
pub(crate) fn display(graph: &GraphSet, v: usize) -> String {
    let n = &graph.nodes[v];
    n.properties.get("name").and_then(Value::as_str).unwrap_or(&n.id).to_string()
}

pub(crate) fn summary(key: &str, values: Value) -> StepSummary {
    let Value::Object(map) = values else { unreachable!("summaries are objects") };
    StepSummary { key: key.to_string(), values: map.into_iter().collect::<BTreeMap<_, _>>() }
}

pub(crate) fn notice(code: &str, params: &[(&str, String)], text: String) -> Notice {
    Notice {
        severity: NoticeSeverity::Info,
        code: code.to_string(),
        params: Some(params.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()),
        text,
    }
}

/// The graph with the property `name` set on every node to its value (none: removed).
pub(crate) fn with_node_values(graph: &GraphSet, name: &str, values: impl Fn(usize) -> Option<Value>) -> GraphSet {
    let nodes: Vec<_> = graph
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let mut n = n.clone();
            match values(i) {
                Some(v) => n.properties.insert(name.to_string(), v),
                None => n.properties.remove(name),
            };
            n
        })
        .collect();
    GraphSet { schema: schema_of(&nodes, &graph.edges), nodes, ..graph.clone() }
}

/// Modularity of a partition of the undirected multigraph (each edge once with its weight,
/// loops included), with resolution 1: how much more the communities hold inside than chance.
pub fn modularity(topo: &Topo, partition: &[usize]) -> f64 {
    let m2: f64 = topo.weight.iter().sum::<f64>() * 2.0;
    if m2 == 0.0 {
        return 0.0;
    }
    let communities = partition.iter().max().map_or(0, |c| c + 1);
    let mut inside = vec![0.0; communities];
    let mut total = vec![0.0; communities];
    for (k, &(a, b)) in topo.ends.iter().enumerate() {
        let w = topo.weight[k];
        total[partition[a]] += w;
        total[partition[b]] += w;
        if partition[a] == partition[b] {
            inside[partition[a]] += 2.0 * w;
        }
    }
    (0..communities).map(|c| inside[c] / m2 - (total[c] / m2).powi(2)).sum()
}

/// Communities numbered from 0 in the order their first node comes in the result.
pub fn canonical(partition: &[usize]) -> Vec<usize> {
    let mut seen: HashMap<usize, usize> = HashMap::new();
    partition
        .iter()
        .map(|c| {
            let next = seen.len();
            *seen.entry(*c).or_insert(next)
        })
        .collect()
}

/// Communities numbered from 0 in the order of their smallest node id: a community keeps its
/// number from run to run as long as its smallest member stays, whatever order the result has
/// and whatever numbers a library gave.
pub fn stable(graph: &GraphSet, partition: &[usize]) -> Vec<usize> {
    let mut least: HashMap<usize, usize> = HashMap::new();
    for (v, c) in partition.iter().enumerate() {
        let entry = least.entry(*c).or_insert(v);
        if text_order(&graph.nodes[v].id, &graph.nodes[*entry].id).is_lt() {
            *entry = v;
        }
    }
    let mut order: Vec<(usize, usize)> = least.into_iter().collect();
    order.sort_by(|a, b| text_order(&graph.nodes[a.1].id, &graph.nodes[b.1].id));
    let number: HashMap<usize, usize> = order.iter().enumerate().map(|(i, (c, _))| (*c, i)).collect();
    partition.iter().map(|c| number[c]).collect()
}

fn measure_name(m: CentralityMeasure) -> &'static str {
    match m {
        CentralityMeasure::PageRank => "pagerank",
        CentralityMeasure::Betweenness => "betweenness",
        CentralityMeasure::Closeness => "closeness",
        CentralityMeasure::Eigenvector => "eigenvector",
        CentralityMeasure::Harmonic => "harmonic",
    }
}

fn measure_text(kind: &StepKind) -> &'static str {
    use super::LinkMeasure;
    match kind {
        StepKind::Similarity { measure: SimilarityMeasure::Jaccard, .. } => "jaccard",
        StepKind::Similarity { measure: SimilarityMeasure::Overlap, .. } => "overlap",
        StepKind::Similarity { measure: SimilarityMeasure::Cosine, .. } => "cosine",
        StepKind::Similarity { measure: SimilarityMeasure::Knn, .. } => "knn",
        StepKind::LinkPrediction { measure: LinkMeasure::CommonNeighbours, .. } => "commonNeighbours",
        StepKind::LinkPrediction { measure: LinkMeasure::AdamicAdar, .. } => "adamicAdar",
        StepKind::LinkPrediction { measure: LinkMeasure::PreferentialAttachment, .. } => "preferentialAttachment",
        _ => "",
    }
}

/// What a similarity step answers when it does not say: edges for k nearest neighbours, a table
/// for the others.
pub fn similarity_output(kind: &StepKind) -> SimilarityOutput {
    match kind {
        StepKind::Similarity { output: Some(o), .. } => *o,
        StepKind::Similarity { measure: SimilarityMeasure::Knn, .. } => SimilarityOutput::Edges,
        _ => SimilarityOutput::Table,
    }
}

/// The node with the highest value, ties to the smaller id.
fn top(graph: &GraphSet, scores: &[f64]) -> Option<usize> {
    (0..scores.len()).max_by(|a, b| {
        scores[*a].total_cmp(&scores[*b]).then_with(|| text_order(&graph.nodes[*b].id, &graph.nodes[*a].id))
    })
}

/// The best pair, for a summary: the highest score, ties to the earlier nodes.
fn best_pair(graph: &GraphSet, pairs: &BTreeMap<(usize, usize), f64>, values: &mut Value) {
    if let Some(((a, b), s)) = pairs.iter().max_by(|x, y| x.1.total_cmp(y.1).then_with(|| y.0.cmp(x.0))) {
        values["best"] = number(*s);
        values["a"] = json!(display(graph, *a));
        values["b"] = json!(display(graph, *b));
    }
}

/// What the step found as part of the graph (or as a table), and the step's summary.
pub fn finish(
    kind: &StepKind,
    graph: &GraphSet,
    topo: &Topo,
    outcome: Outcome,
) -> Result<(GraphOut, StepSummary), Detail> {
    let name = |given: &Option<String>, default: &str| given.clone().unwrap_or_else(|| default.to_string());
    let g = GraphOut::Graph;
    Ok(match (kind, outcome) {
        (StepKind::Centrality { measure, name: n, .. }, Outcome::Scores(scores)) => {
            let out = with_node_values(graph, &name(n, measure_name(*measure)), |i| Some(number(scores[i])));
            let mut values = json!({ "measure": measure_name(*measure), "nodes": graph.nodes.len() });
            if let Some(t) = top(graph, &scores) {
                values["max"] = number(scores[t]);
                values["top"] = json!(display(graph, t));
                let same = scores.iter().all(|s| (s - scores[t]).abs() <= 1e-12 * scores[t].abs().max(1.0));
                values["allSame"] = json!(same);
            }
            (g(out), summary("analysis.summary.centrality", values))
        }
        (StepKind::Communities { algorithm, name: n, .. }, Outcome::Partition(partition)) => {
            let partition = stable(graph, &partition);
            let components =
                matches!(algorithm, CommunityAlgorithm::WeaklyConnected | CommunityAlgorithm::StronglyConnected);
            let key = name(n, if components { "component" } else { "community" });
            let out = with_node_values(graph, &key, |i| Some(json!(partition[i])));
            let count = partition.iter().max().map_or(0, |c| c + 1);
            let mut sizes = vec![0usize; count];
            for c in &partition {
                sizes[*c] += 1;
            }
            let largest = sizes.iter().max().copied().unwrap_or(0);
            let smallest = sizes.iter().min().copied().unwrap_or(0);
            let s = if components {
                summary(
                    "analysis.summary.components",
                    json!({ "count": count, "largest": largest, "nodes": graph.nodes.len() }),
                )
            } else {
                summary(
                    "analysis.summary.communities",
                    json!({
                        "count": count, "largest": largest, "smallest": smallest,
                        "modularity": number(modularity(topo, &partition))
                    }),
                )
            };
            (g(out), s)
        }
        (StepKind::KCore { name: n, k, .. }, Outcome::Cores(cores)) => {
            let marked = with_node_values(graph, &name(n, "core"), |i| Some(json!(cores[i])));
            let max = cores.iter().max().copied().unwrap_or(0);
            let (out, s) = match k {
                None => {
                    let in_max = cores.iter().filter(|c| **c == max).count();
                    let values = json!({ "maxCore": max, "nodes": in_max, "of": graph.nodes.len() });
                    (marked, summary("analysis.summary.kCore", values))
                }
                // Only the k-core, which may be empty.
                Some(k) => {
                    let keep: Vec<bool> = cores.iter().map(|c| *c >= u64::from(*k)).collect();
                    let kept = keep.iter().filter(|x| **x).count();
                    let values = json!({ "k": k, "maxCore": max, "nodes": kept, "of": graph.nodes.len() });
                    (subgraph(&marked, topo, &keep), summary("analysis.summary.kCoreOf", values))
                }
            };
            (g(out), s)
        }
        (StepKind::Triangles { name: n, clustering, .. }, Outcome::Triangles(t, c)) => {
            let first = with_node_values(graph, &name(n, "triangles"), |i| Some(json!(t[i])));
            let out = with_node_values(&first, &name(clustering, "clustering"), |i| Some(number(c[i])));
            let triangles = t.iter().sum::<u64>() / 3;
            let average = if c.is_empty() { 0.0 } else { c.iter().sum::<f64>() / c.len() as f64 };
            let s = summary(
                "analysis.summary.triangles",
                json!({ "triangles": triangles, "averageClustering": number(average) }),
            );
            (g(out), s)
        }
        (StepKind::Similarity { name: n, min_score, .. }, Outcome::Pairs(pairs)) => {
            let pairs = unordered(pairs);
            let mut values = json!({ "pairs": pairs.len(), "measure": measure_text(kind), "minScore": number(min_score.unwrap_or(0.0)) });
            best_pair(graph, &pairs, &mut values);
            let s = summary("analysis.summary.similarity", values);
            match similarity_output(kind) {
                SimilarityOutput::Table => (GraphOut::Frame(pair_table(graph, &pairs)), s),
                SimilarityOutput::Edges => {
                    let mut out = graph.clone();
                    out.edges.extend(pair_edges(graph, &name(n, "SIMILAR"), &pairs, false));
                    out.schema = schema_of(&out.nodes, &out.edges);
                    (g(out), s)
                }
            }
        }
        (StepKind::LinkPrediction { name: n, .. }, Outcome::Pairs(pairs)) => {
            let pairs = unordered(pairs);
            let mut out = graph.clone();
            let mut values = json!({ "pairs": pairs.len(), "measure": measure_text(kind) });
            best_pair(graph, &pairs, &mut values);
            out.suggested = Some(pair_edges(graph, &name(n, "SUGGESTED"), &pairs, true));
            (g(out), summary("analysis.summary.linkPrediction", values))
        }
        (StepKind::Paths { name: n, keep_all, mode, from, to, weight, .. }, Outcome::Paths { paths, total }) => {
            let (out, mut s) = paths::finish(graph, topo, &name(n, "path_order"), *keep_all, paths, total);
            let mode = match mode {
                PathMode::Shortest => "shortest",
                PathMode::AllShortest => "allShortest",
                PathMode::Weighted => "weighted",
                PathMode::KShortest => "kShortest",
            };
            s.values.insert("mode".into(), json!(mode));
            for (key, id) in [("from", from), ("to", to)] {
                if let Ok(v) = node_place(graph, id) {
                    s.values.insert(key.into(), json!(display(graph, v)));
                }
            }
            if let Some(w) = weight {
                s.values.insert("weight".into(), json!(w));
            }
            (g(out), s)
        }
        (StepKind::Reachable { name: n, max_hops, from, .. }, Outcome::Reached(reached)) => {
            let keep: Vec<bool> = reached.iter().map(Option::is_some).collect();
            let kept = keep.iter().filter(|k| **k).count();
            let starts = reached.iter().filter(|d| **d == Some(0)).count();
            let marked = with_node_values(graph, &name(n, "distance"), |i| reached[i].map(|d| json!(d)));
            let out = subgraph(&marked, topo, &keep);
            let mut values = json!({
                "nodes": kept - starts, "of": graph.nodes.len() - starts,
                "maxHops": max_hops.unwrap_or(DEFAULT_HOPS), "starts": from.len()
            });
            if let [one] = from.as_slice()
                && let Ok(v) = node_place(graph, one)
            {
                values["from"] = json!(display(graph, v));
            }
            (g(out), summary("analysis.summary.reachable", values))
        }
        (StepKind::Bridges { name: n, .. }, Outcome::EdgeFlags(flags)) => {
            let key = name(n, "bridge");
            let mut out = graph.clone();
            let mut flag_at: HashMap<usize, bool> = HashMap::new();
            for (k, at) in topo.edge_at.iter().enumerate() {
                flag_at.insert(*at, flags[k]);
            }
            for (at, e) in out.edges.iter_mut().enumerate() {
                match flag_at.get(&at) {
                    Some(f) => e.properties.insert(key.clone(), json!(f)),
                    None => e.properties.remove(&key),
                };
            }
            let count = flags.iter().filter(|f| **f).count();
            let mut values = json!({ "count": count });
            if let Some(k) = flags.iter().position(|f| *f) {
                let (a, b) = topo.ends[k];
                values["a"] = json!(display(graph, a));
                values["b"] = json!(display(graph, b));
            }
            (g(out), summary("analysis.summary.bridges", values))
        }
        (StepKind::ArticulationPoints { name: n, .. }, Outcome::NodeFlags(flags)) => {
            let out = with_node_values(graph, &name(n, "articulation"), |i| Some(json!(flags[i])));
            let count = flags.iter().filter(|f| **f).count();
            let mut values = json!({ "count": count });
            if let Some(v) = flags.iter().position(|f| *f) {
                values["first"] = json!(display(graph, v));
            }
            (g(out), summary("analysis.summary.articulationPoints", values))
        }
        (StepKind::Cycles { name: n, max_count, max_length, .. }, Outcome::Cycles { cycles, cut }) => {
            let mut on = vec![false; graph.nodes.len()];
            for (nodes, _) in &cycles {
                for v in nodes {
                    on[*v] = true;
                }
            }
            let max_count = max_count.unwrap_or(DEFAULT_RESULTS);
            let max_length = max_length.unwrap_or(DEFAULT_CYCLE_LENGTH);
            let mut out = with_node_values(graph, &name(n, "in_cycle"), |i| Some(json!(on[i])));
            out.paths = Some(cycles.iter().map(|(nodes, edges)| path_of(graph, topo, nodes, edges)).collect());
            if cut {
                out.notices.get_or_insert_with(Vec::new).push(notice(
                    "analysis.cycles_cut",
                    &[("limit", max_count.to_string())],
                    format!("{max_count} of at least {max_count} cycles are shown (the most asked for)"),
                ));
            }
            let s = summary(
                "analysis.summary.cycles",
                json!({ "count": cycles.len(), "cut": cut, "maxCount": max_count, "maxLength": max_length }),
            );
            (g(out), s)
        }
        (_, outcome) => {
            return Err(Detail::new(
                "steps.algorithm_answer",
                format!("the algorithm answered in a form the step does not take: {outcome:?}"),
            ));
        }
    })
}

/// Each unordered pair once, with its highest score.
fn unordered(pairs: Vec<(usize, usize, f64)>) -> BTreeMap<(usize, usize), f64> {
    let mut best: BTreeMap<(usize, usize), f64> = BTreeMap::new();
    for (a, b, s) in pairs {
        if a == b {
            continue;
        }
        let entry = best.entry((a.min(b), a.max(b))).or_insert(s);
        if s > *entry {
            *entry = s;
        }
    }
    best
}

/// An edge per pair from the node that comes first in the result, with its `score`; a
/// suggestion also `suggested: true`.
fn pair_edges(graph: &GraphSet, edge_type: &str, pairs: &BTreeMap<(usize, usize), f64>, suggested: bool) -> Vec<Edge> {
    pairs
        .iter()
        .map(|((a, b), score)| {
            let (from, to) = (&graph.nodes[*a].id, &graph.nodes[*b].id);
            let mut properties = BTreeMap::new();
            properties.insert("score".to_string(), number(*score));
            if suggested {
                properties.insert("suggested".to_string(), Value::Bool(true));
            }
            Edge {
                id: format!("~{edge_type}~{from}~{to}"),
                edge_type: edge_type.to_string(),
                from: from.clone(),
                to: to.clone(),
                properties,
            }
        })
        .collect()
}

/// Pairs as a table: `a`, `b` (the nodes' names), `score`, `aId`, `bId`; the best first.
fn pair_table(graph: &GraphSet, pairs: &BTreeMap<(usize, usize), f64>) -> Frame {
    let mut rows: Vec<(&(usize, usize), &f64)> = pairs.iter().collect();
    rows.sort_by(|x, y| y.1.total_cmp(x.1).then_with(|| x.0.cmp(y.0)));
    let field = |name: &str, field_type: FieldType, values: Vec<Value>| Field {
        name: name.to_string(),
        field_type,
        unit: None,
        values,
        labels: None,
    };
    let meta = FrameMeta {
        executed_query: None,
        rows_truncated: graph.truncated.is_some(),
        notices: graph.notices.clone().unwrap_or_default(),
    };
    Frame::new(vec![
        field("a", FieldType::String, rows.iter().map(|((a, _), _)| json!(display(graph, *a))).collect()),
        field("b", FieldType::String, rows.iter().map(|((_, b), _)| json!(display(graph, *b))).collect()),
        field("score", FieldType::Number, rows.iter().map(|(_, s)| number(**s)).collect()),
        field("aId", FieldType::String, rows.iter().map(|((a, _), _)| json!(graph.nodes[*a].id)).collect()),
        field("bId", FieldType::String, rows.iter().map(|((_, b), _)| json!(graph.nodes[*b].id)).collect()),
    ])
    .expect("fields of equal length")
    .with_meta(meta)
}

/// A path of the graph from places in it.
pub(crate) fn path_of(graph: &GraphSet, topo: &Topo, nodes: &[usize], edges: &[usize]) -> GraphPath {
    GraphPath::new(
        nodes.iter().map(|v| graph.nodes[*v].id.clone()).collect(),
        edges.iter().map(|k| graph.edges[topo.edge_at[*k]].id.clone()).collect(),
    )
}

/// The nodes marked in `keep` and the edges between them.
fn subgraph(graph: &GraphSet, topo: &Topo, keep: &[bool]) -> GraphSet {
    let nodes: Vec<_> = graph.nodes.iter().enumerate().filter(|(i, _)| keep[*i]).map(|(_, n)| n.clone()).collect();
    let edges: Vec<_> = topo
        .ends
        .iter()
        .enumerate()
        .filter(|(_, (a, b))| keep[*a] && keep[*b])
        .map(|(k, _)| graph.edges[topo.edge_at[k]].clone())
        .collect();
    GraphSet {
        schema: schema_of(&nodes, &edges),
        nodes,
        edges,
        paths: None,
        truncated: graph.truncated.clone(),
        notices: graph.notices.clone(),
        suggested: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::parse_step;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    fn cases() -> Value {
        serde_json::from_str(include_str!("../conformance.json")).unwrap()
    }

    fn graph(name: &str) -> GraphSet {
        serde_json::from_value(cases()["algorithmGraphs"][name].clone()).unwrap()
    }

    fn step(v: &Value) -> StepKind {
        let mut v = v.clone();
        v["id"] = json!("s");
        v["frame"] = json!("A");
        parse_step(&v).unwrap().kind
    }

    /// Every algorithm case of `conformance.json` on the server: exact for deterministic steps,
    /// within the stated tolerance for iterative ones; refusals with their reason.
    #[test]
    fn algorithm_conformance_cases() {
        let all = cases();
        let list = all["algorithms"].as_array().unwrap();
        assert!(list.len() >= 40, "every step has cases");
        for case in list {
            let name = case["name"].as_str().unwrap();
            let kind = step(&case["step"]);
            let g = graph(case["graph"].as_str().unwrap());
            let ran = apply(&kind, &g, &Control::unbounded());
            match (ran, case.get("error")) {
                (Ok((GraphOut::Graph(out), summary)), None) => {
                    conformance::check_case(case, &out, Some(&summary), false).unwrap_or_else(|e| panic!("{e}"));
                    // The same input answers the same every time.
                    let again = apply(&kind, &g, &Control::unbounded()).unwrap();
                    assert_eq!(again.0, GraphOut::Graph(out), "{name}");
                }
                (Ok((GraphOut::Frame(_), summary)), None) => {
                    let empty = GraphSet::default();
                    conformance::check_case(case, &empty, Some(&summary), false).unwrap_or_else(|e| panic!("{e}"));
                }
                (Err(detail), Some(want)) => {
                    assert_eq!(detail.reason, want["reason"].as_str().unwrap(), "{name}");
                    assert_eq!(serde_json::to_value(&detail.params).unwrap(), want["params"], "{name}");
                }
                (got, _) => panic!("{name}: {got:?}"),
            }
        }
    }

    /// Similarity answers a table of pairs unless it is asked for edges; suggestions stay apart
    /// from the graph's edges and no later step reads them.
    #[test]
    fn shapes_of_similarity_and_suggestions() {
        let g = graph("baskets");
        let (out, _) =
            apply(&step(&json!({ "type": "similarity", "measure": "jaccard", "topK": 2 })), &g, &Control::unbounded())
                .unwrap();
        let GraphOut::Frame(frame) = out else { panic!("a table") };
        let names: Vec<&str> = frame.fields().iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "score", "aId", "bId"]);
        assert_eq!(frame.fields()[0].values[0], json!("k1"));
        assert_eq!(frame.fields()[2].values[0], json!(1.0));
        let t = graph("triangles");
        let lp = step(&json!({ "type": "linkPrediction", "measure": "commonNeighbours" }));
        let (GraphOut::Graph(out), _) = apply(&lp, &t, &Control::unbounded()).unwrap() else { panic!() };
        assert_eq!(out.edges, t.edges, "suggestions are no edges of the graph");
        let suggested = out.suggested.as_ref().unwrap();
        assert_eq!(suggested.len(), 4);
        assert!(suggested.iter().all(|e| e.properties["suggested"] == json!(true)));
        // A later step does not see them: the degrees are those of the graph.
        let (GraphOut::Graph(after), _) = apply(&lp, &out, &Control::unbounded()).unwrap() else { panic!() };
        assert_eq!(after.suggested.as_ref().unwrap().len(), 4);
    }

    #[test]
    fn limits_refuse_before_computing() {
        let t = graph("triangles");
        let small = |limits: AlgoLimits| Control::unbounded().with_algorithm_limits(limits);
        let pr = step(&json!({ "type": "centrality", "measure": "pageRank" }));
        let e = apply(&pr, &t, &small(AlgoLimits { max_nodes: 5, ..AlgoLimits::default() })).unwrap_err();
        assert_eq!((e.reason, e.params["maxNodes"].as_str()), ("steps.algorithm_too_large", "5"));
        // Costly steps read a fifth of the nodes.
        let bc = step(&json!({ "type": "centrality", "measure": "betweenness" }));
        let e = apply(&bc, &t, &small(AlgoLimits { max_nodes: 25, ..AlgoLimits::default() })).unwrap_err();
        assert_eq!(e.params["maxNodes"], "5");
        assert!(apply(&pr, &t, &small(AlgoLimits { max_nodes: 25, ..AlgoLimits::default() })).is_ok());
        let e = apply(&pr, &t, &small(AlgoLimits { max_memory_bytes: 1024, ..AlgoLimits::default() })).unwrap_err();
        assert_eq!(e.reason, "steps.algorithm_memory");
        let cycles = step(&json!({ "type": "cycles", "maxLength": 6 }));
        let e = apply(&cycles, &t, &small(AlgoLimits { max_length: 5, ..AlgoLimits::default() })).unwrap_err();
        assert_eq!((e.reason, e.params["param"].as_str()), ("steps.algorithm_bound", "maxLength"));
        // Defaults stay within lower settings.
        assert!(
            apply(
                &step(&json!({ "type": "cycles" })),
                &t,
                &small(AlgoLimits { max_results: 1, max_length: 3, ..AlgoLimits::default() })
            )
            .is_ok()
        );
    }

    #[test]
    fn a_cancelled_or_late_step_stops() {
        let t = graph("triangles");
        let pr = step(&json!({ "type": "centrality", "measure": "pageRank" }));
        let flag = Arc::new(AtomicBool::new(true));
        assert_eq!(apply(&pr, &t, &Control::new(flag, 30)).unwrap_err().reason, "steps.cancelled");
        let late = Control::new(Arc::new(AtomicBool::new(false)), 30)
            .with_algorithm_limits(AlgoLimits { timeout_secs: 0, ..AlgoLimits::default() });
        assert_eq!(apply(&pr, &t, &late).unwrap_err().reason, "steps.algorithm_timeout");
    }

    /// Community numbers follow the smallest id of each community, not the order of the result.
    #[test]
    fn community_numbers_are_stable() {
        let mut t = graph("triangles");
        let louvain = step(&json!({ "type": "communities", "algorithm": "louvain" }));
        let numbers = |g: &GraphSet| -> BTreeMap<String, Value> {
            let (GraphOut::Graph(out), _) = apply(&louvain, g, &Control::unbounded()).unwrap() else { panic!() };
            out.nodes.iter().map(|n| (n.id.clone(), n.properties["community"].clone())).collect()
        };
        let before = numbers(&t);
        t.nodes.reverse();
        t.edges.reverse();
        assert_eq!(numbers(&t), before);
        assert_eq!(before["a"], json!(0));
        assert_eq!(before["f"], json!(1));
    }

    fn checked(v: Value) -> Result<(), String> {
        let mut v = v;
        v["id"] = json!("s");
        v["frame"] = json!("A");
        let refs = std::collections::BTreeSet::from(["A"]);
        crate::analysis::check_steps(&[v], &refs, "t").map(|_| ())
    }

    /// With `k`, only the k-core stays: the nodes of core number k or more and their edges.
    #[test]
    fn k_core_keeps_only_the_core() {
        let g = graph("components");
        let (GraphOut::Graph(out), s) =
            apply(&step(&json!({ "type": "kCore", "k": 1 })), &g, &Control::unbounded()).unwrap()
        else {
            panic!()
        };
        let ids: Vec<&str> = out.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c", "d", "e"], "the lone node has core 0");
        assert_eq!(out.edges.len(), 3);
        assert_eq!(s.key, "analysis.summary.kCoreOf");
        assert_eq!((&s.values["nodes"], &s.values["k"]), (&json!(5), &json!(1)));
        let (GraphOut::Graph(none), _) =
            apply(&step(&json!({ "type": "kCore", "k": 2 })), &g, &Control::unbounded()).unwrap()
        else {
            panic!()
        };
        assert!(none.nodes.is_empty() && none.edges.is_empty());
        assert!(checked(json!({ "type": "kCore", "k": 0 })).is_err());
        assert!(checked(json!({ "type": "kCore", "k": 3 })).is_ok());
    }

    /// Along the paths: per path the sum of an edge property, as the path's value; the paths step
    /// before it found them.
    #[test]
    fn aggregate_along_the_paths() {
        let g = graph("diamond");
        let paths =
            step(&json!({ "type": "paths", "mode": "kShortest", "from": "s", "to": "t", "k": 2, "weight": "w" }));
        let (GraphOut::Graph(found), _) = apply(&paths, &g, &Control::unbounded()).unwrap() else { panic!() };
        let along = |extra: Value| {
            let mut v =
                json!({ "type": "aggregateAlong", "along": "paths", "op": "sum", "property": "w", "name": "aufwand" });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            step(&v)
        };
        let (GraphOut::Graph(out), s) = apply(&along(json!({ "of": "edges" })), &found, &Control::unbounded()).unwrap()
        else {
            panic!()
        };
        let sums: Vec<&Value> =
            out.paths.as_ref().unwrap().iter().map(|p| &p.values.as_ref().unwrap()["aufwand"]).collect();
        assert_eq!(sums, [&json!(4.0), &json!(6.0)]);
        assert_eq!(out.nodes, found.nodes, "the graph stays as it was");
        assert_eq!((&s.values["paths"], &s.values["min"], &s.values["max"]), (&json!(2), &json!(4.0), &json!(6.0)));
        // Over the nodes, which have no such property: no value, and no error.
        let (GraphOut::Graph(out), s) = apply(&along(json!({})), &found, &Control::unbounded()).unwrap() else {
            panic!()
        };
        assert!(out.paths.as_ref().unwrap().iter().all(|p| p.values.is_none()));
        assert_eq!((&s.values["paths"], &s.values["of"]), (&json!(0), &json!(2)));
        // Counting the nodes of each path; a graph without paths keeps its form.
        let count = step(&json!({ "type": "aggregateAlong", "along": "paths", "op": "count", "name": "n" }));
        let (GraphOut::Graph(out), _) = apply(&count, &found, &Control::unbounded()).unwrap() else { panic!() };
        assert_eq!(out.paths.as_ref().unwrap()[0].values.as_ref().unwrap()["n"], json!(3));
        let (GraphOut::Graph(out), s) = apply(&count, &g, &Control::unbounded()).unwrap() else { panic!() };
        assert_eq!(out, g);
        assert_eq!(s.values["of"], json!(0));
        // Options of the neighbours do not belong to the paths, nor the other way round.
        assert!(
            checked(json!({ "type": "aggregateAlong", "along": "paths", "op": "count", "name": "n", "depth": 2 }))
                .is_err()
        );
        assert!(checked(json!({ "type": "aggregateAlong", "op": "count", "name": "n", "of": "edges" })).is_err());
        assert!(
            checked(json!({ "type": "aggregateAlong", "along": "paths", "op": "count", "name": "n", "of": "edges" }))
                .is_ok()
        );
    }

    /// Degree over some edge types, and weighted: the sum of a weight instead of the count.
    #[test]
    fn degree_by_edge_type_and_weight() {
        let g = graph("diamond");
        let degree = |v: Value| -> BTreeMap<String, Value> {
            let Ok(GraphOut::Graph(out)) = crate::analysis::graph::apply(&step(&v), &g, &Control::unbounded()) else {
                panic!()
            };
            out.nodes.iter().map(|n| (n.id.clone(), n.properties["degree"].clone())).collect()
        };
        let plain = degree(json!({ "type": "degree" }));
        assert_eq!((&plain["s"], &plain["t"]), (&json!(2), &json!(2)));
        let weighted = degree(json!({ "type": "degree", "weight": "w", "direction": "out" }));
        assert_eq!((&weighted["s"], &weighted["a"], &weighted["t"]), (&json!(3.0), &json!(5.0), &json!(0.0)));
        let none = degree(json!({ "type": "degree", "edgeTypes": ["NONE"] }));
        assert_eq!(none["s"], json!(0));
        let degree_step = step(&json!({ "type": "degree", "weight": "w" }));
        let e = crate::analysis::graph::apply(&degree_step, &graph("negative"), &Control::unbounded()).unwrap_err();
        assert_eq!(e.reason, "steps.weight_invalid");
    }

    /// Top k and suggestions stay within the settings; the defaults within lower ones.
    #[test]
    fn top_k_and_suggestions_stay_within_the_settings() {
        let t = graph("triangles");
        let limits = AlgoLimits { max_top_k: 2, max_suggestions: 3, ..AlgoLimits::default() };
        let low = || Control::unbounded().with_algorithm_limits(limits);
        let lp = step(&json!({ "type": "linkPrediction", "measure": "commonNeighbours" }));
        let (GraphOut::Graph(out), _) = apply(&lp, &t, &low()).unwrap() else { panic!() };
        assert_eq!(out.suggested.unwrap().len(), 3, "the default within the lower setting");
        let (GraphOut::Graph(out), _) = apply(&lp, &t, &Control::unbounded()).unwrap() else { panic!() };
        assert_eq!(out.suggested.unwrap().len(), 4, "all 4 within the default 50");
        let many = step(&json!({ "type": "linkPrediction", "measure": "commonNeighbours", "topK": 4 }));
        let e = apply(&many, &t, &low()).unwrap_err();
        assert_eq!(e.reason, "steps.algorithm_bound");
        assert_eq!((e.params["param"].as_str(), e.params["max"].as_str()), ("topK", "3"));
        let similar = step(&json!({ "type": "similarity", "measure": "jaccard", "topK": 3 }));
        assert_eq!(apply(&similar, &graph("baskets"), &low()).unwrap_err().reason, "steps.algorithm_bound");
        let similar = step(&json!({ "type": "similarity", "measure": "jaccard" }));
        assert!(apply(&similar, &graph("baskets"), &low()).is_ok());
    }

    /// Nothing an algorithm step does reaches the source or its input: every step reads the graph
    /// it is given and answers a new one, the input unchanged, also when it fails.
    #[test]
    fn steps_only_read_their_input() {
        for case in cases()["algorithms"].as_array().unwrap() {
            let g = graph(case["graph"].as_str().unwrap());
            let before = g.clone();
            let _ = apply(&step(&case["step"]), &g, &Control::unbounded());
            assert_eq!(g, before, "{}", case["name"]);
        }
    }

    #[test]
    fn place_belongs_to_algorithm_steps() {
        let s = parse_step(&json!({ "id": "s", "type": "kCore", "frame": "A", "place": "server" })).unwrap();
        assert_eq!(s.place, crate::analysis::Place::Server);
        assert!(parse_step(&json!({ "id": "s", "type": "countLabels", "frame": "A", "place": "server" })).is_err());
        assert!(parse_step(&json!({ "id": "s", "type": "kCore", "frame": "A", "place": "elsewhere" })).is_err());
    }
}
