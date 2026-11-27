//! Algorithm steps in a source's own library: Neo4j Graph Data Science (GDS) and Memgraph MAGE.
//! The library computes on exactly the result's subgraph, the nodes the query returned and the
//! edges between them (`Topo`), given by their ids, never on the whole database, and only reads:
//!
//! - GDS: a projection of those nodes and edges under a name made for the step
//!   (`kalzit-algorithm-<uuid>`), then the algorithm's `stream` mode, then the projection is
//!   dropped (`datasources/neo4j.rs`). The projection in GDS's in-memory catalog is the one
//!   exception to "only reading" that docs/PLAN.md, section 15 allows, and only for this fixed
//!   text; a user's query still may not project or drop (`cypher::check`). The fixed queries pass
//!   `cypher::check_fixed`, which allows exactly that.
//! - MAGE: the `*_subgraph` procedures with the nodes and edges as lists, or `project()` of the
//!   result's edges, in one read query.
//! - TigerGraph: no library here yet. An administrator-installed, read-only variant of a library
//!   query that takes the vertex set would answer through the same hook
//!   (`DataSourcePlugin::algorithm_library`); until then TigerGraph steps run on the server.
//!
//! What a library cannot do this way runs on the Kalzit server, and the step's place says why
//! (`route`, the reasons `algorithm.*`). The answer comes back as rows with the node ids of the
//! result and becomes part of the graph with the same code as the server's own (`merge`,
//! `super::finish`).

use std::collections::HashMap;

use serde_json::{Value, json};

use super::{AlgoLimits, Outcome, Topo, bounds, check_size, direction_of, finish, paths::edges_along, weight_of};
use crate::analysis::graph::GraphOut;
use crate::analysis::{CentralityMeasure, CommunityAlgorithm, Direction, PathMode, SimilarityMeasure, StepKind};
use crate::datasources::detail::Detail;
use crate::shapes::{GraphSet, StepSummary};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Library {
    /// Neo4j Graph Data Science.
    Gds,
    /// Memgraph MAGE.
    Mage,
}

/// A parameter of the fixed queries; node and edge ids become numbers where the source's ids are
/// numbers (Memgraph, Neo4j over Bolt 4.4), else text (Neo4j's element ids).
#[derive(Clone, Debug, PartialEq)]
pub enum Param {
    Int(i64),
    Float(f64),
    Bool(bool),
    Text(String),
    Texts(Vec<String>),
    Id(String),
    Ids(Vec<String>),
}

/// The queries that run a step in a library, with their parameters. GDS also gets `$graph`,
/// the projection's name, from the runner.
#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    pub library: Library,
    /// GDS: projects `$nodes` and the edges `$rels` between them under `$graph`.
    pub project: Option<String>,
    /// The queries whose rows answer the step, in order.
    pub runs: Vec<String>,
    pub params: Vec<(String, Param)>,
    /// Whether ids are sent as numbers.
    pub numeric: bool,
    /// The most rows one run may answer.
    pub max_rows: usize,
    /// The result's nodes and edges together, the size the job computes on.
    pub size: usize,
}

impl Job {
    /// What the source remembers when the library lacks what the job needs, so it is not tried
    /// again for a while.
    pub fn memo_key(&self) -> Value {
        json!({ "algorithm": self.runs, "project": self.project })
    }

    /// What the source remembers when the job ran out of time: the job and its size class (the
    /// power of two of nodes plus edges), so neither it nor a larger result of the same step is
    /// sent to the library again for a while, while smaller results still are.
    pub fn slow_key(&self) -> Value {
        self.slow_key_of(size_class(self.size))
    }

    /// The slow keys of this job's size class and every smaller one; any of them remembered
    /// means the library was too slow for a result no larger than this one.
    pub fn slow_keys(&self) -> impl Iterator<Item = Value> + '_ {
        (0..=size_class(self.size)).map(|class| self.slow_key_of(class))
    }

    fn slow_key_of(&self, class: u32) -> Value {
        json!({ "slow": self.memo_key(), "class": class })
    }
}

/// The size class of a result: the number of bits of its size, 0 for none.
fn size_class(size: usize) -> u32 {
    usize::BITS - size.leading_zeros()
}

/// The start value of randomised library runs when the step gives none (board 0.8.2: fixed).
pub const DEFAULT_SEED: u64 = 42;

/// Why a step runs on the server although a library might have computed it.
pub mod reason {
    /// The source has no algorithm library Kalzit uses.
    pub const NO_LIBRARY: &str = "algorithm.no_library";
    /// The step needs only the result; the round trip would cost more than the computing.
    pub const LOCAL: &str = "algorithm.local";
    /// The library has no read-only variant of the algorithm that is limited to the result.
    pub const NOT_IN_LIBRARY: &str = "algorithm.not_in_library";
    /// The step lists paths or cycles, which runs on the server with its count and length bounds.
    pub const ENUMERATING: &str = "algorithm.enumerating";
    /// The library could not be stopped while it runs (Memgraph's procedures), so steps whose
    /// work grows fastest run on the server, where they can.
    pub const NOT_CANCELLABLE: &str = "algorithm.not_cancellable";
    /// An option of the step the library does not offer (a label filter, a direction, ...).
    pub const OPTION: &str = "algorithm.option";
    /// Memgraph's projection holds no nodes without edges, which change the answer.
    pub const ISOLATED_NODES: &str = "algorithm.isolated_nodes";
    /// Nothing to compute: no edges or no nodes.
    pub const EMPTY: &str = "algorithm.empty";
    /// The library failed or did not answer in time; the server computed the step instead.
    pub const LIBRARY_FAILED: &str = "algorithm.library_failed";
    /// The step asks to run on the server (`"place": "server"`).
    pub const PLACE_SERVER: &str = "algorithm.place_server";
    /// The library answered in a form Kalzit does not read; nothing is guessed, the step fails
    /// with `steps.algorithm_answer` and may be run on the server (`"place": "server"`).
    pub const ANSWER_UNREADABLE: &str = "algorithm.answer_unreadable";
}

/// How the library reads the result's edges for a step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Orientation {
    Natural,
    Reverse,
    Undirected,
}

fn orientation(d: Direction) -> Orientation {
    match d {
        Direction::Out => Orientation::Natural,
        Direction::In => Orientation::Reverse,
        Direction::Both => Orientation::Undirected,
    }
}

/// The function that reads a node's or edge's id as Kalzit knows it.
fn key(numeric: bool) -> &'static str {
    if numeric { "id" } else { "elementId" }
}

/// A list of property values as numbers for GDS (0 where none).
fn vector(var: &str) -> String {
    format!(
        "[__kz_k IN $keys | CASE WHEN valueType({var}[__kz_k]) STARTS WITH 'INTEGER' \
         OR valueType({var}[__kz_k]) STARTS WITH 'FLOAT' THEN toFloat({var}[__kz_k]) ELSE 0.0 END]"
    )
}

/// The GDS projection of the result's nodes and edges. The edges are sought by their ids (no
/// node's other relationships are read, which matters for nodes with many of them), the nodes
/// without any of the result's edges (`$lone`) by theirs; each becomes one row of `n`, `r`, `m`.
fn gds_project(numeric: bool, orientation: Orientation, weight: bool, vectors: bool) -> String {
    let key = key(numeric);
    let (source, target) = match orientation {
        Orientation::Reverse => ("coalesce(m, n)", "CASE WHEN m IS NULL THEN null ELSE n END"),
        _ => ("n", "m"),
    };
    let mut data = Vec::new();
    if weight {
        data.push("relationshipProperties: {w: coalesce(toFloat(r[$weight]), 1.0)}".to_string());
    }
    if vectors {
        data.push(format!("sourceNodeProperties: {{kz_v: {}}}", vector(source)));
        data.push(format!("targetNodeProperties: {{kz_v: {}}}", vector(target)));
    }
    let config = match orientation {
        Orientation::Undirected => "{undirectedRelationshipTypes: ['*']}",
        _ => "{}",
    };
    format!(
        "MATCH (__kz_a)-[__kz_r]->(__kz_b) WHERE {key}(__kz_r) IN $rels \
         WITH collect({{n: __kz_a, r: __kz_r, m: __kz_b}}) AS __kz_e \
         OPTIONAL MATCH (__kz_x) WHERE {key}(__kz_x) IN $lone \
         WITH __kz_e, collect(__kz_x) AS __kz_l \
         WITH __kz_e + [__kz_y IN __kz_l | {{n: __kz_y, r: null, m: null}}] AS __kz_all \
         UNWIND __kz_all AS __kz_p \
         WITH __kz_p.n AS n, __kz_p.r AS r, __kz_p.m AS m \
         WITH gds.graph.project($graph, {source}, {target}, {{{data}}}, {config}) AS g \
         RETURN g.nodeCount AS nodes",
        data = data.join(", ")
    )
}

/// A GDS stream answering one value per node as `id`, `value`.
fn gds_nodes(numeric: bool, call: &str, column: &str) -> String {
    let key = key(numeric);
    format!("CALL {call} YIELD nodeId, {column} RETURN {key}(gds.util.asNode(nodeId)) AS id, {column} AS value")
}

/// The MAGE subgraph as lists: `nodes` and the result's edges between them, `rels`, both sought
/// by their ids (no node's other relationships are read).
const MAGE_LISTS: &str = "MATCH (n) WHERE id(n) IN $nodes \
     WITH collect(n) AS nodes \
     OPTIONAL MATCH ()-[r]->() WHERE id(r) IN $rels \
     WITH nodes, collect(r) AS rels ";

/// The MAGE projection of the result's edges, `graph`, sought by their ids.
const MAGE_PROJECT: &str = "MATCH p = ()-[r]->() WHERE id(r) IN $rels \
     WITH project(p) AS graph ";

/// The filter of Memgraph's path expansions: only the result's edges between its nodes.
const MAGE_FILTER: &str = "(__kz_r, __kz_n | id(__kz_r) IN $rels AND id(__kz_n) IN $nodes)";

/// A Memgraph path pattern from `a` to `b` with `expansion` in `direction`.
fn mage_pattern(direction: Direction, a: &str, expansion: &str, b: &str) -> String {
    match direction {
        Direction::Out => format!("({a})-[{expansion}]->({b})"),
        Direction::In => format!("({a})<-[{expansion}]-({b})"),
        Direction::Both => format!("({a})-[{expansion}]-({b})"),
    }
}

/// The ids of the result's nodes, of the edges between them and of the nodes without any of
/// those edges, and whether they are all numbers.
fn ids(graph: &GraphSet, topo: &Topo) -> (Vec<String>, Vec<String>, Vec<String>, bool) {
    let nodes: Vec<String> = graph.nodes.iter().map(|n| n.id.clone()).collect();
    let rels: Vec<String> = topo.edge_at.iter().map(|at| graph.edges[*at].id.clone()).collect();
    let lone: Vec<String> =
        (0..topo.n).filter(|v| topo.out[*v].is_empty() && topo.inn[*v].is_empty()).map(|v| nodes[v].clone()).collect();
    let numeric = nodes.iter().chain(&rels).all(|id| id.parse::<i64>().is_ok());
    (nodes, rels, lone, numeric)
}

/// Whether the step runs in `library`, and how; else why not. The graph's size and weights are
/// checked first, as on the server, so both ways refuse the same steps.
pub fn route(
    library: Option<Library>,
    kind: &StepKind,
    graph: &GraphSet,
    limits: &AlgoLimits,
) -> Result<Result<Job, &'static str>, Detail> {
    check_size(kind, graph, limits)?;
    let topo = Topo::of(graph, kind)?;
    // A node the step names must be in the result, in the library as on the server.
    match kind {
        StepKind::Paths { from, to, .. } => {
            super::node_place(graph, from)?;
            super::node_place(graph, to)?;
        }
        StepKind::Reachable { from, .. } => {
            super::starts(graph, from)?;
        }
        _ => {}
    }
    if let StepKind::MergeNodes { .. } | StepKind::AggregateAlong { .. } = kind {
        return Ok(Err(if library.is_some() { reason::LOCAL } else { reason::NO_LIBRARY }));
    }
    let Some(library) = library else { return Ok(Err(reason::NO_LIBRARY)) };
    if graph.nodes.is_empty() || topo.m() == 0 {
        return Ok(Err(reason::EMPTY));
    }
    let (nodes, rels, lone, numeric) = ids(graph, &topo);
    if library == Library::Mage && !numeric {
        return Ok(Err(reason::NO_LIBRARY));
    }
    let direction = direction_of(kind);
    let weighted = weight_of(kind).is_some();
    let mut params = vec![("nodes".to_string(), Param::Ids(nodes)), ("rels".to_string(), Param::Ids(rels))];
    if library == Library::Gds {
        params.push(("lone".to_string(), Param::Ids(lone)));
    }
    let n = graph.nodes.len();
    let size = n + topo.m();
    let max_rows = size + 16;
    let job = |project: Option<String>, runs: Vec<String>, params: Vec<(String, Param)>, max_rows: usize| {
        Ok(Ok(Job { library, project, runs, params, numeric, max_rows, size }))
    };
    match library {
        Library::Gds => {
            let k = key(numeric);
            let project = |o: Orientation, weight: bool, vectors: bool| Some(gds_project(numeric, o, weight, vectors));
            match kind {
                StepKind::Centrality { measure, damping, max_iterations, tolerance, .. } => {
                    if let Some(w) = weight_of(kind) {
                        params.push(("weight".into(), Param::Text(w.to_string())));
                    }
                    let w = if weighted { ", relationshipWeightProperty: 'w'" } else { "" };
                    let call = match measure {
                        CentralityMeasure::PageRank => {
                            params.push((
                                "damping".into(),
                                Param::Float(damping.unwrap_or(super::centrality::PAGE_RANK_DAMPING)),
                            ));
                            params.push((
                                "iterations".into(),
                                Param::Int(i64::from(
                                    max_iterations.unwrap_or(super::centrality::PAGE_RANK_ITERATIONS),
                                )),
                            ));
                            params.push((
                                "tolerance".into(),
                                Param::Float(tolerance.unwrap_or(super::centrality::PAGE_RANK_TOLERANCE)),
                            ));
                            format!(
                                "gds.pageRank.stream($graph, {{dampingFactor: $damping, maxIterations: $iterations, tolerance: $tolerance{w}}})"
                            )
                        }
                        CentralityMeasure::Eigenvector => {
                            params.push((
                                "iterations".into(),
                                Param::Int(i64::from(
                                    max_iterations.unwrap_or(super::centrality::EIGENVECTOR_ITERATIONS),
                                )),
                            ));
                            params.push((
                                "tolerance".into(),
                                Param::Float(tolerance.unwrap_or(super::centrality::EIGENVECTOR_TOLERANCE)),
                            ));
                            format!(
                                "gds.eigenvector.stream($graph, {{maxIterations: $iterations, tolerance: $tolerance{w}}})"
                            )
                        }
                        CentralityMeasure::Betweenness => "gds.betweenness.stream($graph)".to_string(),
                        CentralityMeasure::Closeness => "gds.closeness.stream($graph)".to_string(),
                        CentralityMeasure::Harmonic => "gds.closeness.harmonic.stream($graph)".to_string(),
                    };
                    job(
                        project(orientation(direction), weighted, false),
                        vec![gds_nodes(numeric, &call, "score")],
                        params,
                        max_rows,
                    )
                }
                StepKind::Communities { algorithm, max_iterations, resolution, seed, .. } => {
                    if let Some(w) = weight_of(kind) {
                        params.push(("weight".into(), Param::Text(w.to_string())));
                    }
                    let w = if weighted { ", relationshipWeightProperty: 'w'" } else { "" };
                    let (call, column, o) = match algorithm {
                        CommunityAlgorithm::Louvain if resolution.is_some() => return Ok(Err(reason::OPTION)),
                        CommunityAlgorithm::Louvain => {
                            params.push((
                                "levels".into(),
                                Param::Int(i64::from(max_iterations.unwrap_or(super::community::LEVELS))),
                            ));
                            (
                                format!("gds.louvain.stream($graph, {{maxLevels: $levels{w}}})"),
                                "communityId",
                                Orientation::Undirected,
                            )
                        }
                        CommunityAlgorithm::Leiden => {
                            params.push(("gamma".into(), Param::Float(resolution.unwrap_or(1.0))));
                            params.push((
                                "levels".into(),
                                Param::Int(i64::from(max_iterations.unwrap_or(super::community::LEVELS))),
                            ));
                            params.push((
                                "seed".into(),
                                Param::Int(i64::try_from(seed.unwrap_or(DEFAULT_SEED)).unwrap_or(i64::MAX)),
                            ));
                            (
                                format!(
                                    "gds.leiden.stream($graph, {{gamma: $gamma, maxLevels: $levels, randomSeed: $seed, concurrency: 1{w}}})"
                                ),
                                "communityId",
                                Orientation::Undirected,
                            )
                        }
                        CommunityAlgorithm::LabelPropagation => {
                            params.push((
                                "iterations".into(),
                                Param::Int(i64::from(max_iterations.unwrap_or(super::community::LABEL_ITERATIONS))),
                            ));
                            (
                                format!("gds.labelPropagation.stream($graph, {{maxIterations: $iterations{w}}})"),
                                "communityId",
                                Orientation::Undirected,
                            )
                        }
                        CommunityAlgorithm::WeaklyConnected => {
                            ("gds.wcc.stream($graph)".to_string(), "componentId", Orientation::Natural)
                        }
                        CommunityAlgorithm::StronglyConnected => {
                            ("gds.scc.stream($graph)".to_string(), "componentId", Orientation::Natural)
                        }
                    };
                    job(project(o, weighted, false), vec![gds_nodes(numeric, &call, column)], params, max_rows)
                }
                StepKind::KCore { .. } => job(
                    project(Orientation::Undirected, false, false),
                    vec![gds_nodes(numeric, "gds.kcore.stream($graph)", "coreValue")],
                    params,
                    max_rows,
                ),
                StepKind::Triangles { .. } => job(
                    project(Orientation::Undirected, false, false),
                    vec![
                        gds_nodes(numeric, "gds.triangleCount.stream($graph)", "triangleCount"),
                        gds_nodes(
                            numeric,
                            "gds.localClusteringCoefficient.stream($graph)",
                            "localClusteringCoefficient",
                        ),
                    ],
                    params,
                    max_rows,
                ),
                StepKind::Similarity { label: Some(_), .. } => Ok(Err(reason::OPTION)),
                StepKind::Similarity { measure, min_score, .. } => {
                    let top_k = super::top_k(kind, limits);
                    params.push(("topK".into(), Param::Int(i64::from(top_k))));
                    let min_score = min_score.unwrap_or(0.0);
                    let pairs = |call: &str, value: &str| {
                        format!(
                            "CALL {call} YIELD node1, node2, similarity \
                             RETURN {k}(gds.util.asNode(node1)) AS a, {k}(gds.util.asNode(node2)) AS b, {value} AS value"
                        )
                    };
                    let max_rows = n * top_k as usize + 16;
                    match measure {
                        SimilarityMeasure::Cosine | SimilarityMeasure::Knn => {
                            let StepKind::Similarity { properties, .. } = kind else { unreachable!() };
                            params.push(("keys".into(), Param::Texts(properties.clone())));
                            // GDS's kNN answers the cosine moved to 0..1, (cos + 1) / 2: its cutoff
                            // moves alike, and the answer moves back to the cosine the server gives.
                            params.push(("cutoff".into(), Param::Float(((min_score + 1.0) / 2.0).max(1e-42))));
                            let call = "gds.knn.stream($graph, {nodeProperties: {kz_v: 'COSINE'}, topK: $topK, \
                                        similarityCutoff: $cutoff, sampleRate: 1.0, deltaThreshold: 0.0, randomJoins: 0, \
                                        maxIterations: 100, randomSeed: 19, concurrency: 1})";
                            job(
                                project(Orientation::Natural, false, true),
                                vec![pairs(call, "2.0 * similarity - 1.0")],
                                params,
                                max_rows,
                            )
                        }
                        _ => {
                            let metric = if *measure == SimilarityMeasure::Jaccard { "JACCARD" } else { "OVERLAP" };
                            params.push(("metric".into(), Param::Text(metric.into())));
                            // GDS keeps pairs above its cutoff; 0 is not allowed there, the smallest
                            // number is.
                            params.push(("cutoff".into(), Param::Float(min_score.max(1e-42))));
                            let call = "gds.nodeSimilarity.stream($graph, {similarityMetric: $metric, topK: $topK, \
                                        similarityCutoff: $cutoff})";
                            job(
                                project(orientation(direction), false, false),
                                vec![pairs(call, "similarity")],
                                params,
                                max_rows,
                            )
                        }
                    }
                }
                StepKind::LinkPrediction { .. } => Ok(Err(reason::NOT_IN_LIBRARY)),
                StepKind::Paths { mode: PathMode::AllShortest, .. } => Ok(Err(reason::ENUMERATING)),
                StepKind::Paths { mode, from, to, weight, .. } => {
                    // Not `k`, which names the id function of the queries below.
                    let count = bounds(kind, limits)?.max_count;
                    params.push(("from".into(), Param::Id(from.clone())));
                    params.push(("to".into(), Param::Id(to.clone())));
                    if let Some(w) = weight {
                        params.push(("weight".into(), Param::Text(w.clone())));
                    }
                    let w = if weighted { ", relationshipWeightProperty: 'w'" } else { "" };
                    let call = match mode {
                        PathMode::KShortest => {
                            params.push(("k".into(), Param::Int(i64::from(count))));
                            format!("gds.shortestPath.yens.stream($graph, {{sourceNode: s, targetNode: t, k: $k{w}}})")
                        }
                        _ => format!("gds.shortestPath.dijkstra.stream($graph, {{sourceNode: s, targetNode: t{w}}})"),
                    };
                    let run = format!(
                        "MATCH (s) WHERE {k}(s) = $from MATCH (t) WHERE {k}(t) = $to \
                         CALL {call} YIELD index, nodeIds \
                         RETURN [__kz_x IN nodeIds | {k}(gds.util.asNode(__kz_x))] AS nodes ORDER BY index"
                    );
                    job(project(orientation(direction), weighted, false), vec![run], params, 128)
                }
                StepKind::Reachable { from, .. } if from.len() != 1 => Ok(Err(reason::OPTION)),
                StepKind::Reachable { from, .. } => {
                    params.push(("from".into(), Param::Id(from[0].clone())));
                    let run = format!(
                        "MATCH (s) WHERE {k}(s) = $from \
                         CALL gds.allShortestPaths.delta.stream($graph, {{sourceNode: s}}) YIELD targetNode, totalCost \
                         RETURN {k}(gds.util.asNode(targetNode)) AS id, totalCost AS value"
                    );
                    job(project(orientation(direction), false, false), vec![run], params, max_rows)
                }
                StepKind::Bridges { .. } => job(
                    project(Orientation::Undirected, false, false),
                    vec![format!(
                        "CALL gds.bridges.stream($graph) YIELD from, to \
                         RETURN {k}(gds.util.asNode(from)) AS a, {k}(gds.util.asNode(to)) AS b"
                    )],
                    params,
                    max_rows,
                ),
                StepKind::ArticulationPoints { .. } => job(
                    project(Orientation::Undirected, false, false),
                    vec![format!(
                        "CALL gds.articulationPoints.stream($graph) YIELD nodeId RETURN {k}(gds.util.asNode(nodeId)) AS id"
                    )],
                    params,
                    max_rows,
                ),
                StepKind::Cycles { .. } => Ok(Err(reason::ENUMERATING)),
                _ => Ok(Err(reason::NOT_IN_LIBRARY)),
            }
        }
        Library::Mage => {
            let isolated = (0..topo.n).any(|v| topo.out[v].is_empty() && topo.inn[v].is_empty());
            match kind {
                StepKind::Centrality { measure: CentralityMeasure::PageRank, .. }
                    if direction != Direction::Out || weighted =>
                {
                    Ok(Err(reason::OPTION))
                }
                StepKind::Centrality { measure: CentralityMeasure::PageRank, .. } if isolated => {
                    Ok(Err(reason::ISOLATED_NODES))
                }
                StepKind::Centrality {
                    measure: CentralityMeasure::PageRank,
                    damping,
                    max_iterations,
                    tolerance,
                    ..
                } => {
                    params.push((
                        "damping".into(),
                        Param::Float(damping.unwrap_or(super::centrality::PAGE_RANK_DAMPING)),
                    ));
                    params.push((
                        "iterations".into(),
                        Param::Int(i64::from(max_iterations.unwrap_or(super::centrality::PAGE_RANK_ITERATIONS))),
                    ));
                    params.push((
                        "tolerance".into(),
                        Param::Float(tolerance.unwrap_or(super::centrality::PAGE_RANK_TOLERANCE)),
                    ));
                    let run = format!(
                        "{MAGE_PROJECT}CALL pagerank.get(graph, $iterations, $damping, $tolerance) YIELD node, rank \
                         RETURN id(node) AS id, rank AS value"
                    );
                    job(None, vec![run], params, max_rows)
                }
                // Betweenness grows with nodes times edges, and a running MAGE procedure cannot be
                // stopped: on the server, which stops it at the step's time limit.
                StepKind::Centrality { measure: CentralityMeasure::Betweenness, .. } => {
                    Ok(Err(reason::NOT_CANCELLABLE))
                }
                StepKind::Communities { resolution: Some(_), .. }
                | StepKind::Communities { max_iterations: Some(_), .. } => Ok(Err(reason::OPTION)),
                StepKind::Communities {
                    algorithm: algorithm @ (CommunityAlgorithm::Louvain | CommunityAlgorithm::Leiden),
                    ..
                } => {
                    // The weight property by name; one no edge has counts every edge 1.
                    params.push(("weight".into(), Param::Text(weight_of(kind).unwrap_or("__kz_none").to_string())));
                    let procedure = if *algorithm == CommunityAlgorithm::Louvain {
                        "community_detection.get_subgraph"
                    } else {
                        "leiden_community_detection.get_subgraph"
                    };
                    job(
                        None,
                        vec![format!(
                            "{MAGE_LISTS}CALL {procedure}(nodes, rels, $weight) YIELD node, community_id \
                             RETURN id(node) AS id, community_id AS value"
                        )],
                        params,
                        max_rows,
                    )
                }
                StepKind::Communities { algorithm: CommunityAlgorithm::WeaklyConnected, .. } => job(
                    None,
                    vec![format!(
                        "{MAGE_PROJECT}CALL weakly_connected_components.get(graph) YIELD node, component_id \
                         RETURN id(node) AS id, component_id AS value"
                    )],
                    params,
                    max_rows,
                ),
                StepKind::Bridges { .. } => job(
                    None,
                    vec![format!(
                        "{MAGE_PROJECT}CALL bridges.get(graph) YIELD node_from, node_to \
                         RETURN id(node_from) AS a, id(node_to) AS b"
                    )],
                    params,
                    max_rows,
                ),
                StepKind::ArticulationPoints { .. } => job(
                    None,
                    vec![format!(
                        "{MAGE_PROJECT}CALL biconnected_components.get(graph) YIELD bcc_id, node_from, node_to \
                         RETURN bcc_id AS part, id(node_from) AS a, id(node_to) AS b"
                    )],
                    params,
                    max_rows * 2,
                ),
                StepKind::Similarity { .. } => Ok(Err(reason::NOT_CANCELLABLE)),
                StepKind::Cycles { .. } => Ok(Err(reason::NOT_CANCELLABLE)),
                // Memgraph's own path expansions, limited by their filter to the result's edges
                // (and so to its nodes): breadth first for the fewest edges, weighted for the
                // least sum. Listing several paths keeps its bounds on the server.
                StepKind::Paths { mode: PathMode::AllShortest, .. } => Ok(Err(reason::ENUMERATING)),
                StepKind::Paths { mode: PathMode::KShortest, .. } => Ok(Err(reason::NOT_IN_LIBRARY)),
                StepKind::Paths { mode, from, to, weight, .. } => {
                    let max = bounds(kind, limits)?.max_length;
                    params.push(("from".into(), Param::Id(from.clone())));
                    params.push(("to".into(), Param::Id(to.clone())));
                    let expansion = match (mode, weight) {
                        (PathMode::Weighted, Some(w)) => {
                            params.push(("weight".into(), Param::Text(w.clone())));
                            format!(
                                "*WSHORTEST {max} (__kz_r, __kz_n | coalesce(toFloat(properties(__kz_r)[$weight]), 1.0)) \
                                 __kz_total {MAGE_FILTER}"
                            )
                        }
                        _ => format!("*BFS ..{max} {MAGE_FILTER}"),
                    };
                    let run = format!(
                        "MATCH (s) WHERE id(s) = $from MATCH (t) WHERE id(t) = $to \
                         MATCH p = {} \
                         RETURN [__kz_x IN nodes(p) | id(__kz_x)] AS nodes LIMIT 1",
                        mage_pattern(direction, "s", &expansion, "t")
                    );
                    job(None, vec![run], params, 4)
                }
                StepKind::Reachable { from, max_hops, .. } => {
                    let hops = max_hops.unwrap_or(super::DEFAULT_HOPS);
                    params.push(("starts".into(), Param::Ids(from.clone())));
                    let run = format!(
                        "MATCH (s) WHERE id(s) IN $starts \
                         MATCH p = {} \
                         RETURN id(m) AS id, min(size(relationships(p))) AS value",
                        mage_pattern(direction, "s", &format!("*BFS ..{hops} {MAGE_FILTER}"), "m")
                    );
                    job(None, vec![run], params, max_rows)
                }
                _ => Ok(Err(reason::NOT_IN_LIBRARY)),
            }
        }
    }
}

/// An id in a library's answer as Kalzit knows it.
fn id_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn answer() -> Detail {
    Detail::new("steps.algorithm_answer", "the library answered in a form Kalzit does not read")
}

/// The library's answers (rows of each run) as the step's result: the graph with what it found,
/// and the summary, as the server would build them.
pub fn merge(
    kind: &StepKind,
    graph: &GraphSet,
    job: &Job,
    answers: &[Vec<Vec<Value>>],
) -> Result<(GraphOut, StepSummary), Detail> {
    let topo = Topo::of(graph, kind)?;
    let place: HashMap<&str, usize> = graph.nodes.iter().enumerate().map(|(i, n)| (n.id.as_str(), i)).collect();
    let at = |v: &Value| id_text(v).and_then(|id| place.get(id.as_str()).copied());
    let first = answers.first().map(Vec::as_slice).unwrap_or(&[]);
    let values = |rows: &[Vec<Value>]| -> Vec<Option<f64>> {
        let mut out = vec![None; topo.n];
        for row in rows {
            if let (Some(v), Some(x)) = (row.first().and_then(at), row.get(1).and_then(Value::as_f64)) {
                out[v] = Some(x);
            }
        }
        out
    };
    let outcome = match kind {
        StepKind::Centrality { measure, .. } => {
            let mut scores: Vec<f64> = values(first).into_iter().map(|x| x.unwrap_or(0.0)).collect();
            if *measure == CentralityMeasure::PageRank {
                // Libraries keep their own scale; the server's scores are shares that sum to 1.
                let sum: f64 = scores.iter().sum();
                if sum > 0.0 {
                    scores.iter_mut().for_each(|s| *s /= sum);
                }
            }
            Outcome::Scores(scores)
        }
        StepKind::Communities { .. } => {
            // A node the library did not answer for (one without edges in a projection) is alone.
            let given = values(first);
            let partition =
                given.iter().enumerate().map(|(i, c)| c.map_or(usize::MAX - i, |c| c.max(0.0) as usize)).collect();
            Outcome::Partition(partition)
        }
        StepKind::KCore { .. } => Outcome::Cores(values(first).into_iter().map(|x| x.unwrap_or(0.0) as u64).collect()),
        StepKind::Triangles { .. } => {
            let triangles = values(first).into_iter().map(|x| x.unwrap_or(0.0) as u64).collect();
            let clustering = values(answers.get(1).map(Vec::as_slice).unwrap_or(&[]))
                .into_iter()
                .map(|x| x.unwrap_or(0.0))
                .collect();
            Outcome::Triangles(triangles, clustering)
        }
        StepKind::Similarity { .. } => {
            let mut pairs = Vec::new();
            for row in first {
                let (Some(a), Some(b), Some(s)) =
                    (row.first().and_then(at), row.get(1).and_then(at), row.get(2).and_then(Value::as_f64))
                else {
                    return Err(answer());
                };
                if s > 0.0 {
                    pairs.push((a, b, s));
                }
            }
            Outcome::Pairs(pairs)
        }
        StepKind::Paths { .. } => {
            let direction = direction_of(kind);
            let unbounded = AlgoLimits { max_results: u32::MAX, max_length: u32::MAX, ..AlgoLimits::default() };
            let max_length = bounds(kind, &unbounded)?.max_length as usize;
            let mut paths = Vec::new();
            let mut beyond: Option<usize> = None;
            for row in first {
                let nodes: Option<Vec<usize>> =
                    row.first().and_then(Value::as_array).and_then(|l| l.iter().map(at).collect());
                let nodes = nodes.ok_or_else(answer)?;
                let edges = edges_along(&topo, &nodes, direction).ok_or_else(answer)?;
                if edges.len() <= max_length {
                    paths.push((nodes, edges));
                } else {
                    beyond = Some(beyond.map_or(edges.len(), |b| b.min(edges.len())));
                }
            }
            // A library that searched within the bound answers nothing; whether a longer path
            // exists is one search here.
            let StepKind::Paths { from, to, .. } = kind else { unreachable!() };
            let (s, t) = (super::node_place(graph, from)?, super::node_place(graph, to)?);
            let longer = || super::paths::fewest_edges(&topo, s, t, direction).filter(|e| *e > max_length);
            match beyond.or_else(longer) {
                Some(edges) if paths.is_empty() => Outcome::PathsTooLong { edges },
                _ => Outcome::Paths { paths, total: None },
            }
        }
        StepKind::Reachable { from, max_hops, .. } => {
            let max_hops = max_hops.unwrap_or(super::DEFAULT_HOPS);
            let mut reached: Vec<Option<u32>> = values(first)
                .into_iter()
                .map(|c| c.filter(|c| *c <= f64::from(max_hops)).map(|c| c.round() as u32))
                .collect();
            for start in super::starts(graph, from)? {
                reached[start] = Some(0);
            }
            Outcome::Reached(reached)
        }
        StepKind::Bridges { .. } => {
            // The kept edges between each pair of nodes, either way, so each answer finds its
            // edges at once.
            let mut between: HashMap<(usize, usize), Vec<usize>> = HashMap::new();
            for (k, &(x, y)) in topo.ends.iter().enumerate() {
                between.entry((x.min(y), x.max(y))).or_default().push(k);
            }
            let mut flags = vec![false; topo.m()];
            for row in first {
                let (Some(a), Some(b)) = (row.first().and_then(at), row.get(1).and_then(at)) else {
                    return Err(answer());
                };
                for k in between.get(&(a.min(b), a.max(b))).into_iter().flatten() {
                    flags[*k] = true;
                }
            }
            Outcome::EdgeFlags(flags)
        }
        StepKind::ArticulationPoints { .. } => {
            let mut flags = vec![false; topo.n];
            match job.library {
                Library::Gds => {
                    for row in first {
                        flags[row.first().and_then(at).ok_or_else(answer)?] = true;
                    }
                }
                Library::Mage => {
                    // A node in two or more biconnected parts is an articulation point.
                    let mut parts: Vec<std::collections::BTreeSet<String>> = vec![Default::default(); topo.n];
                    for row in first {
                        let part = row.first().map(Value::to_string).ok_or_else(answer)?;
                        for v in [row.get(1), row.get(2)] {
                            parts[v.and_then(at).ok_or_else(answer)?].insert(part.clone());
                        }
                    }
                    for (v, p) in parts.iter().enumerate() {
                        flags[v] = p.len() >= 2;
                    }
                }
            }
            Outcome::NodeFlags(flags)
        }
        _ => return Err(answer()),
    };
    finish(kind, graph, &topo, outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::parse_step;
    use crate::datasources::cypher::{check, check_fixed};

    fn step(v: Value) -> StepKind {
        let mut v = v;
        v["id"] = json!("s");
        v["frame"] = json!("A");
        parse_step(&v).unwrap().kind
    }

    fn graph(numeric: bool) -> GraphSet {
        let id = |i: usize| if numeric { i.to_string() } else { format!("4:x:{i}") };
        let nodes = (0..4)
            .map(|i| crate::shapes::Node { id: id(i), labels: vec!["K".into()], properties: Default::default() })
            .collect();
        let edges = [(0, 1), (1, 2), (2, 0), (2, 3)]
            .iter()
            .enumerate()
            .map(|(k, (a, b))| crate::shapes::Edge {
                id: id(10 + k),
                edge_type: "T".into(),
                from: id(*a),
                to: id(*b),
                properties: [("w".to_string(), json!(2))].into(),
            })
            .collect();
        GraphSet { nodes, edges, ..Default::default() }
    }

    fn every_step() -> Vec<StepKind> {
        let mut steps = Vec::new();
        for m in ["pageRank", "betweenness", "closeness", "eigenvector", "harmonic"] {
            steps.push(step(json!({ "type": "centrality", "measure": m })));
            steps.push(step(json!({ "type": "centrality", "measure": m, "direction": "in" })));
        }
        for a in ["louvain", "leiden", "labelPropagation", "weaklyConnected", "stronglyConnected"] {
            steps.push(step(json!({ "type": "communities", "algorithm": a })));
        }
        steps.extend([
            step(json!({ "type": "kCore" })),
            step(json!({ "type": "triangles" })),
            step(json!({ "type": "similarity", "measure": "jaccard", "topK": 3 })),
            step(json!({ "type": "similarity", "measure": "overlap", "topK": 3, "direction": "both" })),
            step(json!({ "type": "similarity", "measure": "cosine", "topK": 3, "properties": ["a", "b"] })),
            step(json!({ "type": "similarity", "measure": "knn", "properties": ["a"] })),
            step(json!({ "type": "communities", "algorithm": "louvain", "weight": "w" })),
            step(json!({ "type": "centrality", "measure": "pageRank", "weight": "w", "direction": "out" })),
            step(json!({ "type": "linkPrediction", "measure": "adamicAdar", "topK": 3 })),
            step(json!({ "type": "paths", "mode": "shortest", "from": "0", "to": "3" })),
            step(json!({ "type": "paths", "mode": "weighted", "from": "0", "to": "3", "weight": "w" })),
            step(json!({ "type": "paths", "mode": "kShortest", "from": "0", "to": "3", "k": 2, "direction": "out" })),
            step(json!({ "type": "paths", "mode": "allShortest", "from": "0", "to": "3" })),
            step(json!({ "type": "reachable", "from": ["0"], "maxHops": 2 })),
            step(json!({ "type": "bridges" })),
            step(json!({ "type": "articulationPoints" })),
            step(json!({ "type": "cycles", "maxLength": 4, "maxCount": 10 })),
        ]);
        steps
    }

    /// Every fixed query passes the read-only check for Kalzit's own queries and holds no writing
    /// clause; the GDS projection and drop are exactly what the user check still refuses.
    #[test]
    fn fixed_queries_only_read() {
        for (library, numeric) in [(Library::Gds, false), (Library::Gds, true), (Library::Mage, true)] {
            for kind in every_step() {
                let mut g = graph(numeric);
                if let StepKind::Paths { .. } | StepKind::Reachable { .. } = &kind {
                    // The steps above name nodes "0" and "3"; the text ids need their own names.
                    if !numeric {
                        let json = serde_json::to_string(&serde_json::to_value(&g).unwrap()).unwrap();
                        g = serde_json::from_str(&json.replace("4:x:", "")).unwrap();
                    }
                }
                let Ok(Ok(job)) = route(Some(library), &kind, &g, &AlgoLimits::default()) else { continue };
                for q in job.project.iter().chain(&job.runs) {
                    check_fixed(q).unwrap_or_else(|e| panic!("{q}\n{}", e.message));
                    for word in ["CREATE", "MERGE", " SET ", "DELETE", "REMOVE", "LOAD", "FOREACH", ".write", ".mutate"]
                    {
                        assert!(!q.contains(word), "{word} in {q}");
                    }
                    assert!(
                        q.contains("IN $nodes") || q.contains("IN $rels") || q.contains("$graph"),
                        "the query reads only the result: {q}"
                    );
                    // The result's edges are sought by their ids, never by expanding its nodes.
                    assert!(!q.contains("(n)-[r]->") && !q.contains("(__kz_x)-["), "{q}");
                }
                if let Some(p) = &job.project {
                    assert_eq!(check(p).unwrap_err().reason, "cypher.function_not_allowed", "{p}");
                    assert!(p.contains("(__kz_r) IN $rels") && p.contains("(__kz_x) IN $lone"), "{p}");
                }
                if library == Library::Mage {
                    for q in &job.runs {
                        match check(q) {
                            Ok(_) => {}
                            // The weighted expansion's total looks like a call to the user check,
                            // and `project()` is only allowed in Kalzit's own queries.
                            Err(e) if q.contains("*WSHORTEST") || q.contains("project(p)") => {
                                assert_eq!(e.reason, "cypher.function_not_allowed", "{q}")
                            }
                            Err(e) => panic!("MAGE queries pass the user check: {q}\n{}", e.message),
                        }
                    }
                }
            }
        }
        assert_eq!(
            check("CALL gds.graph.drop('x', false) YIELD graphName RETURN graphName").unwrap_err().reason,
            "cypher.procedure_not_allowed"
        );
    }

    /// Where each step runs, per library; the reasons for the server.
    #[test]
    fn routes_follow_the_rules() {
        let g = graph(true);
        let limits = AlgoLimits::default();
        let at = |library: Option<Library>, kind: &StepKind| match route(library, kind, &g, &limits).unwrap() {
            Ok(job) => job.runs[0].clone(),
            Err(reason) => reason.to_string(),
        };
        let pr = step(json!({ "type": "centrality", "measure": "pageRank" }));
        assert!(at(Some(Library::Gds), &pr).contains("gds.pageRank.stream"));
        assert_eq!(at(Some(Library::Mage), &pr), reason::OPTION, "PageRank either way: no MAGE variant");
        let along = step(json!({ "type": "centrality", "measure": "pageRank", "direction": "out" }));
        assert!(at(Some(Library::Mage), &along).contains("pagerank.get(graph"));
        assert_eq!(at(None, &pr), reason::NO_LIBRARY);
        let cycles = step(json!({ "type": "cycles", "maxLength": 4, "maxCount": 10 }));
        assert_eq!(at(Some(Library::Gds), &cycles), reason::ENUMERATING);
        assert_eq!(at(Some(Library::Mage), &cycles), reason::NOT_CANCELLABLE);
        let similar = step(json!({ "type": "similarity", "measure": "jaccard", "topK": 2 }));
        assert_eq!(at(Some(Library::Mage), &similar), reason::NOT_CANCELLABLE);
        let betweenness = step(json!({ "type": "centrality", "measure": "betweenness" }));
        assert_eq!(at(Some(Library::Mage), &betweenness), reason::NOT_CANCELLABLE);
        assert!(at(Some(Library::Gds), &betweenness).contains("gds.betweenness.stream"));
        assert!(at(Some(Library::Gds), &similar).contains("gds.nodeSimilarity.stream"));
        let labelled = step(json!({ "type": "similarity", "measure": "jaccard", "topK": 2, "label": "K" }));
        assert_eq!(at(Some(Library::Gds), &labelled), reason::OPTION);
        let merge = step(json!({ "type": "mergeNodes", "by": "label" }));
        assert_eq!(at(Some(Library::Gds), &merge), reason::LOCAL);
        let weighted = step(json!({ "type": "centrality", "measure": "pageRank", "weight": "w", "direction": "out" }));
        assert!(at(Some(Library::Gds), &weighted).contains("relationshipWeightProperty: 'w'"));
        assert_eq!(at(Some(Library::Mage), &weighted), reason::OPTION);
        let lp = step(json!({ "type": "linkPrediction", "measure": "commonNeighbours", "topK": 2 }));
        assert_eq!(at(Some(Library::Gds), &lp), reason::NOT_IN_LIBRARY);
        // Memgraph's path expansions, filtered to the result's edges and nodes.
        let shortest = step(json!({ "type": "paths", "mode": "shortest", "from": "0", "to": "3" }));
        let q = at(Some(Library::Mage), &shortest);
        assert!(
            q.contains("(s)-[*BFS ..30 (__kz_r, __kz_n | id(__kz_r) IN $rels AND id(__kz_n) IN $nodes)]-(t)"),
            "{q}"
        );
        let least = step(
            json!({ "type": "paths", "mode": "weighted", "from": "0", "to": "3", "weight": "w", "direction": "out" }),
        );
        let q = at(Some(Library::Mage), &least);
        assert!(q.contains("(s)-[*WSHORTEST 30 ") && q.contains("]->(t)"), "{q}");
        let k = step(json!({ "type": "paths", "mode": "kShortest", "from": "0", "to": "3", "k": 2 }));
        assert_eq!(at(Some(Library::Mage), &k), reason::NOT_IN_LIBRARY);
        // GDS reads the nodes by their ids, also where the step has a count of its own.
        for path in [&shortest, &k] {
            let q = at(Some(Library::Gds), path);
            assert!(q.contains("WHERE id(s) = $from") && q.contains("| id(gds.util.asNode(__kz_x))"), "{q}");
        }
        let all = step(json!({ "type": "paths", "mode": "allShortest", "from": "0", "to": "3" }));
        assert_eq!(at(Some(Library::Mage), &all), reason::ENUMERATING);
        let reach = step(json!({ "type": "reachable", "from": ["0", "3"], "maxHops": 2, "direction": "in" }));
        assert!(at(Some(Library::Mage), &reach).contains("(s)<-[*BFS ..2 "));
        assert_eq!(at(Some(Library::Gds), &reach), reason::OPTION, "GDS: one start node");
        // A lone node: Memgraph's projection would leave it out of PageRank.
        let mut lone = graph(true);
        lone.nodes.push(crate::shapes::Node { id: "9".into(), labels: vec![], properties: Default::default() });
        assert_eq!(route(Some(Library::Mage), &along, &lone, &limits).unwrap().unwrap_err(), reason::ISOLATED_NODES);
        // Too large for the limits is refused on both ways alike.
        let small = AlgoLimits { max_nodes: 2, ..AlgoLimits::default() };
        assert_eq!(route(Some(Library::Gds), &pr, &g, &small).unwrap_err().reason, "steps.algorithm_too_large");
        // Text ids reach Memgraph never; Neo4j reads them with elementId.
        let text = graph(false);
        assert_eq!(route(Some(Library::Mage), &pr, &text, &limits).unwrap().unwrap_err(), reason::NO_LIBRARY);
        let job = route(Some(Library::Gds), &pr, &text, &limits).unwrap().unwrap();
        assert!(!job.numeric && job.project.as_ref().unwrap().contains("elementId(__kz_r) IN $rels"));
        // Only the nodes without any of the result's edges are sought one by one.
        let mut lone = graph(false);
        lone.nodes.push(crate::shapes::Node { id: "4:x:9".into(), labels: vec![], properties: Default::default() });
        let job = route(Some(Library::Gds), &pr, &lone, &limits).unwrap().unwrap();
        assert!(job.params.contains(&("lone".to_string(), Param::Ids(vec!["4:x:9".into()]))));
        // A node a step names that the result lacks is refused before any library is asked.
        for kind in [
            step(json!({ "type": "paths", "mode": "shortest", "from": "0", "to": "42" })),
            step(json!({ "type": "reachable", "from": ["42"], "maxHops": 2 })),
        ] {
            for library in [Some(Library::Gds), Some(Library::Mage), None] {
                assert_eq!(route(library, &kind, &g, &limits).unwrap_err().reason, "steps.node_missing");
            }
        }
    }

    /// A job that ran out of time is remembered for its size and larger ones only.
    #[test]
    fn slow_jobs_are_remembered_by_size() {
        let limits = AlgoLimits::default();
        let pr = step(json!({ "type": "centrality", "measure": "pageRank" }));
        let small = route(Some(Library::Gds), &pr, &graph(true), &limits).unwrap().unwrap();
        let mut larger = graph(true);
        for i in 20..60 {
            larger.nodes.push(crate::shapes::Node {
                id: i.to_string(),
                labels: vec![],
                properties: Default::default(),
            });
        }
        let large = route(Some(Library::Gds), &pr, &larger, &limits).unwrap().unwrap();
        assert!(large.slow_keys().any(|k| k == small.slow_key()), "a slow small job keeps larger ones away");
        assert!(
            !small.slow_keys().any(|k| k == large.slow_key()),
            "a slow large job leaves smaller ones to the library"
        );
        assert_ne!(small.slow_key(), small.memo_key());
    }

    /// Answers become the graph the server would make: ids map back to the nodes, scores and
    /// communities become properties, paths their nodes and edges.
    #[test]
    fn answers_map_back_to_the_nodes() {
        let g = graph(true);
        let limits = AlgoLimits::default();
        let pr = step(json!({ "type": "centrality", "measure": "pageRank" }));
        let job = route(Some(Library::Gds), &pr, &g, &limits).unwrap().unwrap();
        let rows = vec![vec![json!(0), json!(2.0)], vec![json!(1), json!(1.0)], vec![json!(2), json!(1.0)]];
        let (GraphOut::Graph(out), summary) = merge(&pr, &g, &job, &[rows]).unwrap() else { panic!() };
        assert_eq!(out.nodes[0].properties["pagerank"], json!(0.5));
        assert_eq!(out.nodes[3].properties["pagerank"], json!(0.0));
        assert_eq!(summary.key, "analysis.summary.centrality");
        let wcc = step(json!({ "type": "communities", "algorithm": "weaklyConnected" }));
        let job = route(Some(Library::Mage), &wcc, &g, &limits).unwrap().unwrap();
        let rows = vec![vec![json!(2), json!(7)], vec![json!(0), json!(7)], vec![json!(1), json!(7)]];
        let (GraphOut::Graph(out), summary) = merge(&wcc, &g, &job, &[rows]).unwrap() else { panic!() };
        let communities: Vec<&Value> = out.nodes.iter().map(|n| &n.properties["component"]).collect();
        assert_eq!(communities, [&json!(0), &json!(0), &json!(0), &json!(1)]);
        assert_eq!(summary.values["count"], json!(2));
        let path = step(json!({ "type": "paths", "mode": "weighted", "from": "0", "to": "3", "weight": "w" }));
        let job = route(Some(Library::Gds), &path, &g, &limits).unwrap().unwrap();
        let (GraphOut::Graph(out), summary) = merge(&path, &g, &job, &[vec![vec![json!([0, 1, 2, 3])]]]).unwrap()
        else {
            panic!()
        };
        assert_eq!(out.paths.as_ref().unwrap()[0].edges, ["10", "11", "13"]);
        assert_eq!(summary.values["cost"], json!(6.0));
        // An id the result does not have is no answer Kalzit reads.
        assert_eq!(merge(&path, &g, &job, &[vec![vec![json!([0, 42])]]]).unwrap_err().reason, "steps.algorithm_answer");
        let ap = step(json!({ "type": "articulationPoints" }));
        let job = route(Some(Library::Mage), &ap, &g, &limits).unwrap().unwrap();
        let rows = vec![
            vec![json!(0), json!(0), json!(1)],
            vec![json!(0), json!(1), json!(2)],
            vec![json!(0), json!(2), json!(0)],
            vec![json!(1), json!(2), json!(3)],
        ];
        let (GraphOut::Graph(out), _) = merge(&ap, &g, &job, &[rows]).unwrap() else { panic!() };
        let flags: Vec<&Value> = out.nodes.iter().map(|n| &n.properties["articulation"]).collect();
        assert_eq!(flags, [&json!(false), &json!(false), &json!(true), &json!(false)]);
        // Every start node is at distance 0, also when the library does not list it.
        let reach = step(json!({ "type": "reachable", "from": ["0", "3"], "maxHops": 1 }));
        let job = route(Some(Library::Mage), &reach, &g, &limits).unwrap().unwrap();
        let rows = vec![vec![json!(1), json!(1)], vec![json!(2), json!(1)]];
        let (GraphOut::Graph(out), summary) = merge(&reach, &g, &job, &[rows]).unwrap() else { panic!() };
        let distances: Vec<&Value> = out.nodes.iter().map(|n| &n.properties["distance"]).collect();
        assert_eq!(distances, [&json!(0), &json!(1), &json!(1), &json!(0)]);
        assert_eq!(summary.values["starts"], json!(2));
    }
}
