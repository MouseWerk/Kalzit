//! Analysis steps on `frame` results: calculated fields, joins of two queries, statistics, group
//! and pivot (docs/api/settings-dashboards.md, "Analysis steps"). Steps are explicit, ordered and visible: they are stored with
//! the panel (`transformations`) or sent with an Explore export, each can be disabled, and the
//! query's own result stays as it was. Nothing here runs unless a step asks for it.
//!
//! Where they run: the browser runs them for what it shows (`ui/src/analysis/`); the server runs
//! the same steps here for exports, so a file holds what the panel shows and the permission check
//! stays on the server. Both engines pass the cases in `conformance.json`.
//!
//! Pushdown (later): steps work on results already held in memory, bounded by the query's row
//! limit. Heavy work belongs in the database (SQL `GROUP BY`, Mongo `$group`, Cypher
//! aggregation); a later version will turn a leading group, reduce or pivot step into the query
//! for sources that can do it, and run here only what the source cannot.

pub mod algo;
pub mod export;
pub mod expr;
pub mod graph;
pub mod projection;
pub mod pushdown;
pub mod stats;
pub mod steps;
pub mod trace;

use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::Value;

/// Steps per panel or export.
pub const MAX_STEPS: usize = 50;
/// Field lists of one step (statistics over fields, group-by fields, aggregations).
pub const MAX_STEP_FIELDS: usize = 50;
pub const MAX_GROUP_BY: usize = 10;
pub const MAX_PERCENTILES: usize = 10;
pub const MAX_WINDOW: u32 = 10_000;
const MAX_NAME_CHARS: usize = 200;
const MAX_REF_CHARS: usize = 64;

/// One step as stored: `{"id", "type", "disabled"?, ...}`.
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub id: String,
    pub disabled: bool,
    /// Where a graph algorithm step may run (`"place"`; `auto` when absent).
    pub place: Place,
    pub kind: StepKind,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum StepKind {
    /// A new field computed by an expression over the fields of `frame`.
    Calculate {
        frame: String,
        name: String,
        expression: String,
    },
    /// Joins frame `right` onto frame `left` by time or by key fields; the result takes the
    /// place of `left` and `right` is used up.
    Join {
        left: String,
        right: String,
        on: JoinOn,
        mode: JoinMode,
    },
    /// Statistics per field: one row per field, one column per measure.
    Reduce {
        frame: String,
        fields: Vec<String>,
        stats: Vec<Stat>,
        #[serde(default)]
        percentiles: Vec<f64>,
    },
    /// The least-squares line of `field` over `x` (the frame's time field, else the row number).
    Trend {
        frame: String,
        field: String,
        #[serde(default)]
        x: Option<String>,
        output: TrendOutput,
        #[serde(default)]
        name: Option<String>,
    },
    MovingAverage {
        frame: String,
        field: String,
        window: u32,
        name: String,
    },
    /// Pearson's correlation of two fields.
    Correlate {
        frame: String,
        x: String,
        y: String,
    },
    /// Each value next to the value one period earlier (UTC calendar).
    Compare {
        frame: String,
        field: String,
        #[serde(default)]
        time: Option<String>,
        period: Period,
        output: CompareOutput,
        name: String,
    },
    Group {
        frame: String,
        by: Vec<String>,
        aggregations: Vec<Aggregation>,
    },
    Pivot {
        frame: String,
        row: String,
        column: String,
        value: String,
        op: Agg,
    },
    /// The projection (docs/PLAN.md, section 1): the `documents` result of query `frame` as a
    /// frame, one column per field path. The steps after it work on that frame; a result that
    /// already is a frame passes unchanged. With `rows` it projects a `graph` result: one row per
    /// node or per edge, optionally only nodes with `label` or edges of `edgeType`; the paths are
    /// property keys, and `@id`, `@labels` (nodes), `@type`, `@from`, `@to` (edges).
    ToFrame {
        frame: String,
        columns: Vec<ProjectionColumn>,
        #[serde(default)]
        rows: Option<GraphRows>,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        edge_type: Option<String>,
    },
    /// Graph to frame: nodes per label (`label`, `nodes`, `share` of all nodes).
    CountLabels {
        frame: String,
    },
    /// Graph to frame: edges per type and the labels of their ends (`type`, `from`, `to`, `edges`).
    CountEdgeTypes {
        frame: String,
    },
    /// Graph to frame: how many nodes have each degree (`degree`, `nodes`), zero included.
    DegreeDistribution {
        frame: String,
        #[serde(default)]
        direction: Direction,
    },
    /// Graph to graph: the `n` nodes with the highest degree (among those with `label`, when
    /// given) and the edges between them.
    TopDegree {
        frame: String,
        n: u32,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        direction: Direction,
    },
    /// Graph to frame: pairs of `label` nodes that share neighbours with the label `via` (over
    /// edges of `edgeType`, either direction): `a`, `b`, `shared`, `neighbours`; pairs with at
    /// least `min` shared neighbours, the `limit` with the most. Nodes are named by their text
    /// property `name`, else by their id.
    SharedNeighbours {
        frame: String,
        label: String,
        via: String,
        #[serde(default)]
        edge_type: Option<String>,
        min: u32,
        limit: u32,
        #[serde(default)]
        name: Option<String>,
    },
    /// Graph to graph ("Grad berechnen"): every node gets its degree as the property `name`
    /// (`degree` when absent).
    Degree {
        frame: String,
        #[serde(default)]
        direction: Direction,
        #[serde(default)]
        name: Option<String>,
    },
    /// Graph to graph ("Teilgraph filtern"): the nodes with one of `labels` (all when absent) that
    /// pass `property`, and the edges of `edgeTypes` (all when absent) between them.
    FilterGraph {
        frame: String,
        #[serde(default)]
        labels: Vec<String>,
        #[serde(default)]
        edge_types: Vec<String>,
        #[serde(default)]
        property: Option<PropertyFilter>,
    },
    /// Graph to graph: a centrality score per node as the property `name` (the measure's name,
    /// `pagerank`, `betweenness`, ...), the graph algorithms of docs/PLAN.md, section 15
    /// (`algo::centrality`). The degree is the step `degree` above.
    Centrality {
        frame: String,
        measure: CentralityMeasure,
        #[serde(default)]
        direction: Option<Direction>,
        #[serde(default)]
        weight: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        damping: Option<f64>,
        #[serde(default)]
        max_iterations: Option<u32>,
        #[serde(default)]
        tolerance: Option<f64>,
    },
    /// Graph to graph: the community (`community`) or component (`component`) of every node as
    /// the property `name`, numbered from 0 (`algo::community`).
    Communities {
        frame: String,
        algorithm: CommunityAlgorithm,
        #[serde(default)]
        weight: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        max_iterations: Option<u32>,
        #[serde(default)]
        resolution: Option<f64>,
        /// The start value of a randomised library run (42 when absent); the server's own run
        /// is the same every time.
        #[serde(default)]
        seed: Option<u64>,
    },
    /// Graph to graph: every node's core number as the property `name` (`core`).
    KCore {
        frame: String,
        #[serde(default)]
        name: Option<String>,
    },
    /// Graph to graph: every node's triangles (`name`, `triangles`) and local clustering
    /// coefficient (`clustering`, `clustering`).
    Triangles {
        frame: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        clustering: Option<String>,
    },
    /// The `topK` most similar nodes of every node (`algo::similarity`): a table of pairs `a`,
    /// `b`, `score` (`output: table`, the default but for `knn`), or edges of the type `name`
    /// (`SIMILAR`) with the property `score` in the graph (`output: edges`).
    Similarity {
        frame: String,
        measure: SimilarityMeasure,
        #[serde(default)]
        top_k: Option<u32>,
        #[serde(default)]
        properties: Vec<String>,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        edge_types: Vec<String>,
        #[serde(default)]
        direction: Option<Direction>,
        #[serde(default)]
        min_score: Option<f64>,
        #[serde(default)]
        output: Option<SimilarityOutput>,
        #[serde(default)]
        name: Option<String>,
    },
    /// Graph to graph: the `topK` (50) pairs of unconnected nodes with the highest topological
    /// score as suggested edges of the type `name` (`SUGGESTED`); no trained model. Suggestions
    /// stay apart from the graph's edges (`GraphSet::suggested`).
    LinkPrediction {
        frame: String,
        measure: LinkMeasure,
        #[serde(default)]
        top_k: Option<u32>,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        min_score: Option<f64>,
        #[serde(default)]
        name: Option<String>,
    },
    /// Graph to graph: the paths from node `from` to node `to` (`algo::paths`); the nodes on them
    /// get their place along the path, in edges from `from`, as the property `name` (`path_order`).
    Paths {
        frame: String,
        mode: PathMode,
        from: String,
        to: String,
        #[serde(default)]
        direction: Option<Direction>,
        #[serde(default)]
        edge_types: Vec<String>,
        #[serde(default)]
        weight: Option<String>,
        #[serde(default)]
        k: Option<u32>,
        #[serde(default)]
        max_paths: Option<u32>,
        #[serde(default)]
        max_length: Option<u32>,
        #[serde(default)]
        keep_all: bool,
        #[serde(default)]
        name: Option<String>,
    },
    /// Graph to graph: the nodes reachable from the nodes `from` within `maxHops` (2) edges, with
    /// their distance in edges as the property `name` (`distance`), and the edges between them.
    Reachable {
        frame: String,
        from: Vec<String>,
        #[serde(default)]
        max_hops: Option<u32>,
        #[serde(default)]
        direction: Option<Direction>,
        #[serde(default)]
        edge_types: Vec<String>,
        #[serde(default)]
        name: Option<String>,
    },
    /// Graph to graph: every edge says whether it is a bridge (property `name`, `bridge`).
    Bridges {
        frame: String,
        #[serde(default)]
        name: Option<String>,
    },
    /// Graph to graph: every node says whether it is an articulation point (`name`,
    /// `articulation`).
    ArticulationPoints {
        frame: String,
        #[serde(default)]
        name: Option<String>,
    },
    /// Graph to graph: at most `maxCount` (200) cycles of at most `maxLength` (6) edges as the
    /// graph's paths; every node says whether it lies on one (`name`, `in_cycle`).
    Cycles {
        frame: String,
        #[serde(default)]
        max_length: Option<u32>,
        #[serde(default)]
        max_count: Option<u32>,
        #[serde(default)]
        direction: Option<Direction>,
        #[serde(default)]
        name: Option<String>,
    },
    /// Graph to graph ("Knoten zusammenfassen"): one group node per label, or per value of the
    /// node property `property` (such as a community), with `aggregates` over its members; the
    /// edges between two groups become one edge per type (or one for all types with
    /// `mergeTypes`) with `edgeAggregates`; edges inside a group become a loop (`loops`, the
    /// default) or are left out (`algo::transform`).
    MergeNodes {
        frame: String,
        by: MergeBy,
        #[serde(default)]
        property: Option<String>,
        #[serde(default)]
        aggregates: Vec<GraphAggregate>,
        #[serde(default)]
        edge_aggregates: Vec<GraphAggregate>,
        #[serde(default = "yes")]
        loops: bool,
        #[serde(default)]
        merge_types: bool,
    },
    /// Graph to graph ("Entlang aggregieren"): for every node with `label` (every node when
    /// absent), `op` over the property `property` of the nodes reached within `depth` (1) edges
    /// of `edgeTypes` in `direction` (`out`), each reached node once, as the property `name`.
    AggregateAlong {
        frame: String,
        #[serde(default)]
        label: Option<String>,
        op: AlongOp,
        #[serde(default)]
        property: Option<String>,
        #[serde(default)]
        edge_types: Vec<String>,
        #[serde(default)]
        direction: Option<Direction>,
        #[serde(default)]
        depth: Option<u32>,
        name: String,
    },
    /// Trace to frame ("Span-Tabelle"): one row per span of the `trace` result, with the fixed
    /// span columns and one column per key of `attributes` (docs/guide/traces.md).
    SpanTable {
        frame: String,
        #[serde(default)]
        attributes: Vec<String>,
    },
    /// Trace to frame ("Trace-Tabelle"): one row per trace with its root, start, duration and
    /// counts of spans, errors and services.
    TraceTable {
        frame: String,
    },
    /// Trace to graph ("Service-Karte"): the services as nodes and the calls between them as
    /// edges with their counts and durations. More than `trace::MAX_GRAPH_SPANS` spans need
    /// `confirmLarge`.
    ServiceMap {
        frame: String,
        #[serde(default)]
        confirm_large: bool,
    },
    /// Trace to graph ("Span-Baum"): every span a node, every parent an edge to its child.
    /// More than `trace::MAX_GRAPH_SPANS` spans need `confirmLarge`.
    SpanTree {
        frame: String,
        #[serde(default)]
        confirm_large: bool,
    },
    /// Trace to trace ("Spans filtern"): the spans that pass every given condition.
    FilterSpans {
        frame: String,
        #[serde(default)]
        services: Vec<String>,
        #[serde(default)]
        operations: Vec<String>,
        #[serde(default)]
        status: Option<crate::shapes::SpanStatus>,
        #[serde(default)]
        kinds: Vec<crate::shapes::SpanKind>,
        #[serde(default)]
        min_duration_ms: Option<f64>,
        #[serde(default)]
        max_duration_ms: Option<f64>,
        #[serde(default)]
        attribute: Option<PropertyFilter>,
    },
    /// Trace to trace ("Kritischer Pfad"): per trace the spans on its critical path.
    CriticalPath {
        frame: String,
    },
}

/// A condition on a node property: `exists`, equal or not to `value`, a number compared with
/// it, or text that contains it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyFilter {
    pub key: String,
    pub op: PropertyOp,
    #[serde(default)]
    pub value: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PropertyOp {
    Exists,
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains,
}

/// Which edges count for a node's degree.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    #[default]
    Both,
    Out,
    In,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CentralityMeasure {
    PageRank,
    Betweenness,
    Closeness,
    Eigenvector,
    Harmonic,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommunityAlgorithm {
    Louvain,
    Leiden,
    LabelPropagation,
    WeaklyConnected,
    StronglyConnected,
}

/// Jaccard and overlap compare the neighbours of two nodes; cosine and k nearest neighbours
/// (`knn`) compare the numbers in `properties` by their cosine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SimilarityMeasure {
    Jaccard,
    Overlap,
    Cosine,
    Knn,
}

/// What a similarity step answers: a table of pairs (its shape changes), or edges in the graph.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SimilarityOutput {
    Table,
    Edges,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkMeasure {
    CommonNeighbours,
    AdamicAdar,
    PreferentialAttachment,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PathMode {
    /// One path with the fewest edges.
    Shortest,
    /// Every path with the fewest edges, at most `maxPaths`.
    AllShortest,
    /// One path with the least total `weight`.
    Weighted,
    /// The `k` shortest paths without repeated nodes (by `weight` when given).
    KShortest,
}

/// What `mergeNodes` makes one group of.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeBy {
    /// The node's labels (joined with `:`).
    Label,
    /// The value of the node property `property`, such as a community.
    Property,
}

/// An aggregate of a group: `count` of its members, or `sum`, `mean`, `min`, `max` of a number
/// property, `distinct` values of any property; as the property `name`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphAggregate {
    pub op: AggregateOp,
    #[serde(default)]
    pub property: Option<String>,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AggregateOp {
    Count,
    Sum,
    Mean,
    Min,
    Max,
    Distinct,
}

/// What `aggregateAlong` makes of the values it reaches.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AlongOp {
    Sum,
    Mean,
    Count,
    Min,
    Max,
}

fn yes() -> bool {
    true
}

/// Where a graph algorithm step may run (`"place"` on the step): in the source's library where
/// it can (`auto`, the default) or always on the Kalzit server (`server`), to compare runs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Place {
    #[default]
    Auto,
    Server,
}

/// Bounds of the graph algorithm steps' parameters; the server settings may bound some of them
/// lower when the step runs (`algo::AlgoLimits`).
pub const MAX_SIMILAR: u32 = 100;
pub const MAX_SUGGESTIONS: u32 = 500;
pub const MAX_ITERATIONS: u32 = 1000;
pub const MAX_K_PATHS: u32 = 100;
pub const MAX_ALL_PATHS: u32 = 1000;
pub const MAX_PATH_LENGTH: u32 = 30;
pub const MAX_HOPS: u32 = 8;
pub const MAX_START_NODES: usize = 100;
pub const MAX_CYCLE_LENGTH: u32 = 20;
pub const MAX_CYCLES: u32 = 1000;
pub const MAX_DEPTH: u32 = 4;
pub const MAX_ID_CHARS: usize = 512;

/// What a graph projection makes rows of.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GraphRows {
    Nodes,
    Edges,
}

/// Nodes a top-N step keeps, and pairs a shared-neighbours step answers at most.
pub const MAX_TOP_NODES: u32 = 1000;
pub const MAX_PAIRS: u32 = 1000;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionColumn {
    /// A dotted MongoDB path, array indexes as numbers (`items.0.price`).
    pub path: String,
    /// The column's name; the path when absent.
    #[serde(default)]
    pub name: Option<String>,
    /// The column's type (not `json`); taken from the first value when absent.
    #[serde(default, rename = "type")]
    pub field_type: Option<crate::shapes::FieldType>,
}

impl ProjectionColumn {
    pub fn output_name(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.path)
    }
}

/// Columns of one projection, and the longest field path.
pub const MAX_PROJECTION_COLUMNS: usize = 200;
pub const MAX_PATH_CHARS: usize = 500;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "by", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum JoinOn {
    /// The first time field of each frame.
    Time,
    Key {
        left_field: String,
        right_field: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JoinMode {
    Inner,
    Left,
    Outer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stat {
    Count,
    Sum,
    Mean,
    Median,
    Min,
    Max,
    Stddev,
    Percentile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrendOutput {
    /// A new field with the line's value at every row.
    Fitted,
    /// One row: slope (per day over time), intercept, r2, n.
    Summary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Period {
    Week,
    Month,
    Year,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompareOutput {
    Previous,
    Difference,
    Percent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Agg {
    Count,
    Sum,
    Mean,
    Median,
    Min,
    Max,
    Stddev,
    First,
    Last,
}

impl Agg {
    pub fn as_str(self) -> &'static str {
        match self {
            Agg::Count => "count",
            Agg::Sum => "sum",
            Agg::Mean => "mean",
            Agg::Median => "median",
            Agg::Min => "min",
            Agg::Max => "max",
            Agg::Stddev => "stddev",
            Agg::First => "first",
            Agg::Last => "last",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Aggregation {
    pub field: String,
    pub op: Agg,
    /// The result field's name; `op(field)` when absent.
    #[serde(default)]
    pub name: Option<String>,
}

impl Aggregation {
    pub fn output_name(&self) -> String {
        self.name.clone().unwrap_or_else(|| format!("{}({})", self.op.as_str(), self.field))
    }
}

impl StepKind {
    /// The frames this step reads.
    pub fn frames(&self) -> Vec<&str> {
        match self {
            StepKind::Join { left, right, .. } => vec![left, right],
            StepKind::Calculate { frame, .. }
            | StepKind::Reduce { frame, .. }
            | StepKind::Trend { frame, .. }
            | StepKind::MovingAverage { frame, .. }
            | StepKind::Correlate { frame, .. }
            | StepKind::Compare { frame, .. }
            | StepKind::Group { frame, .. }
            | StepKind::Pivot { frame, .. } => vec![frame],
            StepKind::ToFrame { frame, .. }
            | StepKind::CountLabels { frame }
            | StepKind::CountEdgeTypes { frame }
            | StepKind::DegreeDistribution { frame, .. }
            | StepKind::TopDegree { frame, .. }
            | StepKind::SharedNeighbours { frame, .. }
            | StepKind::Degree { frame, .. }
            | StepKind::FilterGraph { frame, .. } => vec![frame],
            StepKind::Centrality { frame, .. }
            | StepKind::Communities { frame, .. }
            | StepKind::KCore { frame, .. }
            | StepKind::Triangles { frame, .. }
            | StepKind::Similarity { frame, .. }
            | StepKind::LinkPrediction { frame, .. }
            | StepKind::Paths { frame, .. }
            | StepKind::Reachable { frame, .. }
            | StepKind::Bridges { frame, .. }
            | StepKind::ArticulationPoints { frame, .. }
            | StepKind::Cycles { frame, .. }
            | StepKind::MergeNodes { frame, .. }
            | StepKind::AggregateAlong { frame, .. } => vec![frame],
            StepKind::SpanTable { frame, .. }
            | StepKind::TraceTable { frame }
            | StepKind::ServiceMap { frame, .. }
            | StepKind::SpanTree { frame, .. }
            | StepKind::FilterSpans { frame, .. }
            | StepKind::CriticalPath { frame } => vec![frame],
        }
    }

    /// Whether the step reads a trace: the projections of a trace into a frame or a graph, and
    /// the steps that keep it a trace. They run with the query on the server, before the steps
    /// that read what they make.
    pub fn is_trace_step(&self) -> bool {
        matches!(
            self,
            StepKind::SpanTable { .. }
                | StepKind::TraceTable { .. }
                | StepKind::ServiceMap { .. }
                | StepKind::SpanTree { .. }
                | StepKind::FilterSpans { .. }
                | StepKind::CriticalPath { .. }
        )
    }

    /// Whether the step runs with its query (`QueryItem::steps`): graph and trace steps.
    pub fn runs_with_query(&self) -> bool {
        self.is_graph_step() || self.is_trace_step()
    }

    /// Whether the step reads a graph. Graph steps run where the query runs (in the database
    /// when the source can, else on the server), before the steps that read frames.
    pub fn is_graph_step(&self) -> bool {
        matches!(
            self,
            StepKind::CountLabels { .. }
                | StepKind::CountEdgeTypes { .. }
                | StepKind::DegreeDistribution { .. }
                | StepKind::TopDegree { .. }
                | StepKind::SharedNeighbours { .. }
                | StepKind::Degree { .. }
                | StepKind::FilterGraph { .. }
                | StepKind::ToFrame { rows: Some(_), .. }
        ) || self.is_algorithm()
    }

    /// Whether the step is a graph algorithm (`algo`): it keeps the graph and adds properties,
    /// suggested edges or paths, runs in the source's library where it has one and else on the
    /// server, within the algorithm limits of the server settings.
    pub fn is_algorithm(&self) -> bool {
        matches!(
            self,
            StepKind::Centrality { .. }
                | StepKind::Communities { .. }
                | StepKind::KCore { .. }
                | StepKind::Triangles { .. }
                | StepKind::Similarity { .. }
                | StepKind::LinkPrediction { .. }
                | StepKind::Paths { .. }
                | StepKind::Reachable { .. }
                | StepKind::Bridges { .. }
                | StepKind::ArticulationPoints { .. }
                | StepKind::Cycles { .. }
                | StepKind::MergeNodes { .. }
                | StepKind::AggregateAlong { .. }
        )
    }
}

fn check_text(what: &str, value: &str, max: usize) -> Result<(), String> {
    let chars = value.chars().count();
    if chars == 0 || chars > max {
        return Err(format!("{what} needs 1 to {max} characters"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{what} contains control characters"));
    }
    Ok(())
}

fn check_list(what: &str, items: &[String], min: usize, max: usize) -> Result<(), String> {
    if items.len() < min || items.len() > max {
        return Err(format!("{what} takes {min} to {max} entries"));
    }
    for (i, item) in items.iter().enumerate() {
        check_text(&format!("{what}[{i}]"), item, MAX_NAME_CHARS)?;
    }
    Ok(())
}

/// The key and the value of a property condition (`at` is the condition's place).
fn check_property_filter(f: &PropertyFilter, at: &str) -> Result<(), String> {
    check_text(&format!("{at}.key"), &f.key, MAX_NAME_CHARS)?;
    let ok = matches!(
        (f.op, &f.value),
        (PropertyOp::Exists, None)
            | (PropertyOp::Eq | PropertyOp::Ne, Some(Value::String(_) | Value::Number(_) | Value::Bool(_)))
            | (PropertyOp::Gt | PropertyOp::Gte | PropertyOp::Lt | PropertyOp::Lte, Some(Value::Number(_)))
            | (PropertyOp::Contains, Some(Value::String(_)))
    );
    if !ok {
        return Err(format!(
            "{at}.value: exists takes none, eq and ne text, a number or true or false, \
             gt, gte, lt and lte a number, contains text"
        ));
    }
    if let Some(Value::String(t)) = &f.value {
        check_text(&format!("{at}.value"), t, MAX_NAME_CHARS)?;
    }
    Ok(())
}

/// One step from its stored JSON.
pub fn parse_step(value: &Value) -> Result<Step, String> {
    let Value::Object(map) = value else { return Err("must be an object".into()) };
    let mut rest = map.clone();
    let id = match rest.remove("id") {
        Some(Value::String(s)) => s,
        _ => return Err("id must be text".into()),
    };
    let disabled = match rest.remove("disabled") {
        None => false,
        Some(Value::Bool(b)) => b,
        Some(_) => return Err("disabled must be true or false".into()),
    };
    let place = match rest.remove("place") {
        None => Place::Auto,
        Some(v) => serde_json::from_value(v).map_err(|_| "place must be auto or server".to_string())?,
    };
    let kind: StepKind = serde_json::from_value(Value::Object(rest)).map_err(|e| e.to_string())?;
    if place != Place::Auto && !kind.is_algorithm() {
        return Err("place belongs to graph algorithm steps".into());
    }
    Ok(Step { id, disabled, place, kind })
}

/// Parses and bounds a list of steps whose frames must be among `frames` (the reference ids of
/// the queries they follow). Expressions are parsed here; their fields and types are checked
/// against the data when the step runs, since only then the fields are known. Errors name the
/// place (`at[2].expression: ...`).
pub fn check_steps(raw: &[Value], frames: &BTreeSet<&str>, at: &str) -> Result<Vec<Step>, String> {
    if raw.len() > MAX_STEPS {
        return Err(format!("{at} takes at most {MAX_STEPS} entries"));
    }
    let mut ids = BTreeSet::new();
    let mut steps = Vec::with_capacity(raw.len());
    for (i, value) in raw.iter().enumerate() {
        let at = format!("{at}[{i}]");
        let step = parse_step(value).map_err(|e| format!("{at}: {e}"))?;
        check_text(&format!("{at}.id"), &step.id, MAX_REF_CHARS)?;
        if !ids.insert(step.id.clone()) {
            return Err(format!("{at}.id {} is used twice", step.id));
        }
        for frame in step.kind.frames() {
            check_text(&format!("{at}.frame"), frame, MAX_REF_CHARS)?;
            if !frames.contains(frame) {
                return Err(format!("{at}: there is no query {frame}"));
            }
        }
        check_kind(&step.kind, &at)?;
        steps.push(step);
    }
    Ok(steps)
}

fn check_kind(kind: &StepKind, at: &str) -> Result<(), String> {
    let name = |n: &str| check_text(&format!("{at}.name"), n, MAX_NAME_CHARS);
    let field = |what: &str, f: &str| check_text(&format!("{at}.{what}"), f, MAX_NAME_CHARS);
    // Labels, edge types and property keys of graph steps may run in the database as quoted
    // Cypher text or names: no backslash, which only escape sequences need.
    let graph_name = |what: &str, f: &str| {
        field(what, f)?;
        if f.contains('\\') {
            return Err(format!("{at}.{what} may not contain a backslash"));
        }
        Ok::<(), String>(())
    };
    match kind {
        StepKind::Calculate { name: n, expression, .. } => {
            name(n)?;
            expr::parse(expression).map_err(|e| format!("{at}.expression: {e}"))?;
        }
        StepKind::Join { left, right, on, .. } => {
            if left == right {
                return Err(format!("{at}: a query cannot be joined with itself"));
            }
            if let JoinOn::Key { left_field, right_field } = on {
                field("on.leftField", left_field)?;
                field("on.rightField", right_field)?;
            }
        }
        StepKind::Reduce { fields, stats, percentiles, .. } => {
            check_list(&format!("{at}.fields"), fields, 1, MAX_STEP_FIELDS)?;
            if stats.is_empty() || stats.iter().collect::<BTreeSet<_>>().len() != stats.len() {
                return Err(format!("{at}.stats needs at least one measure, each once"));
            }
            let wants = stats.contains(&Stat::Percentile);
            if wants != !percentiles.is_empty() || percentiles.len() > MAX_PERCENTILES {
                return Err(format!(
                    "{at}.percentiles: give 1 to {MAX_PERCENTILES} with the percentile measure, none without"
                ));
            }
            let mut seen = BTreeSet::new();
            for p in percentiles {
                if !(0.0..=100.0).contains(p) || !seen.insert(expr::number_text(*p)) {
                    return Err(format!("{at}.percentiles must be distinct numbers from 0 to 100"));
                }
            }
        }
        StepKind::Trend { field: f, x, output, name: n, .. } => {
            field("field", f)?;
            if let Some(x) = x {
                field("x", x)?;
            }
            match (output, n) {
                (TrendOutput::Fitted, Some(n)) => name(n)?,
                (TrendOutput::Fitted, None) => return Err(format!("{at}.name is required for the fitted line")),
                (TrendOutput::Summary, Some(_)) => return Err(format!("{at}.name belongs only to the fitted line")),
                (TrendOutput::Summary, None) => {}
            }
        }
        StepKind::MovingAverage { field: f, window, name: n, .. } => {
            field("field", f)?;
            name(n)?;
            if !(1..=MAX_WINDOW).contains(window) {
                return Err(format!("{at}.window must be 1 to {MAX_WINDOW} rows"));
            }
        }
        StepKind::Correlate { x, y, .. } => {
            field("x", x)?;
            field("y", y)?;
        }
        StepKind::Compare { field: f, time, name: n, .. } => {
            field("field", f)?;
            if let Some(t) = time {
                field("time", t)?;
            }
            name(n)?;
        }
        StepKind::Group { by, aggregations, .. } => {
            check_list(&format!("{at}.by"), by, 1, MAX_GROUP_BY)?;
            if aggregations.len() > MAX_STEP_FIELDS {
                return Err(format!("{at}.aggregations takes at most {MAX_STEP_FIELDS} entries"));
            }
            for (i, a) in aggregations.iter().enumerate() {
                field(&format!("aggregations[{i}].field"), &a.field)?;
                if let Some(n) = &a.name {
                    check_text(&format!("{at}.aggregations[{i}].name"), n, MAX_NAME_CHARS)?;
                }
            }
        }
        StepKind::Pivot { row, column, value, .. } => {
            field("row", row)?;
            field("column", column)?;
            field("value", value)?;
        }
        StepKind::CountLabels { .. } | StepKind::CountEdgeTypes { .. } | StepKind::DegreeDistribution { .. } => {}
        StepKind::TopDegree { n, label, .. } => {
            if !(1..=MAX_TOP_NODES).contains(n) {
                return Err(format!("{at}.n must be 1 to {MAX_TOP_NODES}"));
            }
            if let Some(l) = label {
                graph_name("label", l)?;
            }
        }
        StepKind::SharedNeighbours { label, via, edge_type, min, limit, name: n, .. } => {
            graph_name("label", label)?;
            graph_name("via", via)?;
            if label == via {
                return Err(format!("{at}.via must be another label than label"));
            }
            if let Some(t) = edge_type {
                graph_name("edgeType", t)?;
            }
            if let Some(n) = n {
                graph_name("name", n)?;
            }
            if *min < 1 {
                return Err(format!("{at}.min must be at least 1"));
            }
            if !(1..=MAX_PAIRS).contains(limit) {
                return Err(format!("{at}.limit must be 1 to {MAX_PAIRS}"));
            }
        }
        StepKind::Degree { name: n, .. } => {
            if let Some(n) = n {
                graph_name("name", n)?;
            }
        }
        StepKind::FilterGraph { labels, edge_types, property, .. } => {
            if labels.len() > MAX_STEP_FIELDS || edge_types.len() > MAX_STEP_FIELDS {
                return Err(format!("{at}: labels and edgeTypes take at most {MAX_STEP_FIELDS} entries"));
            }
            for (i, l) in labels.iter().enumerate() {
                graph_name(&format!("labels[{i}]"), l)?;
            }
            for (i, t) in edge_types.iter().enumerate() {
                graph_name(&format!("edgeTypes[{i}]"), t)?;
            }
            if let Some(f) = property {
                graph_name("property.key", &f.key)?;
                check_property_filter(f, &format!("{at}.property"))?;
            }
        }
        StepKind::Centrality { .. }
        | StepKind::Communities { .. }
        | StepKind::KCore { .. }
        | StepKind::Triangles { .. }
        | StepKind::Similarity { .. }
        | StepKind::LinkPrediction { .. }
        | StepKind::Paths { .. }
        | StepKind::Reachable { .. }
        | StepKind::Bridges { .. }
        | StepKind::ArticulationPoints { .. }
        | StepKind::Cycles { .. }
        | StepKind::MergeNodes { .. }
        | StepKind::AggregateAlong { .. } => check_algorithm(kind, at, &graph_name)?,
        StepKind::SpanTable { attributes, .. } => {
            check_list(&format!("{at}.attributes"), attributes, 0, MAX_STEP_FIELDS)?;
            if attributes.iter().collect::<BTreeSet<_>>().len() != attributes.len() {
                return Err(format!("{at}.attributes names a key twice"));
            }
        }
        StepKind::TraceTable { .. }
        | StepKind::ServiceMap { .. }
        | StepKind::SpanTree { .. }
        | StepKind::CriticalPath { .. } => {}
        StepKind::FilterSpans { services, operations, kinds, min_duration_ms, max_duration_ms, attribute, .. } => {
            check_list(&format!("{at}.services"), services, 0, MAX_STEP_FIELDS)?;
            check_list(&format!("{at}.operations"), operations, 0, MAX_STEP_FIELDS)?;
            if kinds.len() > 6 {
                return Err(format!("{at}.kinds takes each kind once"));
            }
            for d in [min_duration_ms, max_duration_ms].into_iter().flatten() {
                if !d.is_finite() || *d < 0.0 {
                    return Err(format!("{at}: durations are milliseconds of 0 or more"));
                }
            }
            if let Some(f) = attribute {
                check_property_filter(f, &format!("{at}.attribute"))?;
            }
        }
        StepKind::ToFrame { columns, rows, label, edge_type, .. } => {
            match (rows, label, edge_type) {
                (None, Some(_), _) | (None, _, Some(_)) => {
                    return Err(format!("{at}: label and edgeType belong to a projection of a graph (rows)"));
                }
                (Some(GraphRows::Edges), Some(_), _) => return Err(format!("{at}.label belongs to rows of nodes")),
                (Some(GraphRows::Nodes), _, Some(_)) => return Err(format!("{at}.edgeType belongs to rows of edges")),
                _ => {}
            }
            if let Some(l) = label {
                graph_name("label", l)?;
            }
            if let Some(t) = edge_type {
                graph_name("edgeType", t)?;
            }
            if columns.is_empty() || columns.len() > MAX_PROJECTION_COLUMNS {
                return Err(format!("{at}.columns takes 1 to {MAX_PROJECTION_COLUMNS} entries"));
            }
            let mut names = BTreeSet::new();
            for (i, c) in columns.iter().enumerate() {
                let at = format!("{at}.columns[{i}]");
                check_text(&format!("{at}.path"), &c.path, MAX_PATH_CHARS)?;
                if let Some(n) = &c.name {
                    check_text(&format!("{at}.name"), n, MAX_NAME_CHARS)?;
                }
                if matches!(
                    c.field_type,
                    Some(
                        crate::shapes::FieldType::Json
                            | crate::shapes::FieldType::Decimal
                            | crate::shapes::FieldType::Date
                    )
                ) {
                    return Err(format!("{at}.type must be string, number, int64, bool or time"));
                }
                if !names.insert(c.output_name()) {
                    return Err(format!("{at}: a column is already named {}", c.output_name()));
                }
            }
        }
    }
    Ok(())
}

/// The parameters of a graph algorithm step (`StepKind::is_algorithm`). `graph_name` checks a
/// label, type or property key that may reach the database as a parameter or a quoted name.
fn check_algorithm(
    kind: &StepKind,
    at: &str,
    graph_name: &dyn Fn(&str, &str) -> Result<(), String>,
) -> Result<(), String> {
    let in_range = |what: &str, v: Option<u32>, min: u32, max: u32| match v {
        Some(v) if !(min..=max).contains(&v) => Err(format!("{at}.{what} must be {min} to {max}")),
        _ => Ok(()),
    };
    let fraction = |what: &str, v: Option<f64>, min: f64, max: f64| match v {
        Some(v) if !(v.is_finite() && v > min && v < max) => {
            Err(format!("{at}.{what} must be a number above {min} and below {max}"))
        }
        _ => Ok(()),
    };
    let named = |what: &str, n: &Option<String>| n.as_deref().map_or(Ok(()), |n| graph_name(what, n));
    let node_id = |what: &str, id: &str| check_text(&format!("{at}.{what}"), id, MAX_ID_CHARS);
    let min_score = |v: Option<f64>| match v {
        Some(v) if !(v.is_finite() && v >= 0.0) => Err(format!("{at}.minScore must be a number of 0 or more")),
        _ => Ok(()),
    };
    let types = |list: &[String]| {
        if list.len() > MAX_STEP_FIELDS {
            return Err(format!("{at}.edgeTypes takes at most {MAX_STEP_FIELDS} entries"));
        }
        list.iter().enumerate().try_for_each(|(i, t)| graph_name(&format!("edgeTypes[{i}]"), t))
    };
    match kind {
        StepKind::Centrality { measure, name, weight, damping, max_iterations, tolerance, .. } => {
            named("name", name)?;
            named("weight", weight)?;
            let iterative = matches!(measure, CentralityMeasure::PageRank | CentralityMeasure::Eigenvector);
            if !iterative && (max_iterations.is_some() || tolerance.is_some() || weight.is_some()) {
                return Err(format!("{at}: weight, maxIterations and tolerance belong to pageRank and eigenvector"));
            }
            if *measure != CentralityMeasure::PageRank && damping.is_some() {
                return Err(format!("{at}.damping belongs to pageRank"));
            }
            fraction("damping", *damping, 0.0, 1.0)?;
            fraction("tolerance", *tolerance, 0.0, 1.0)?;
            in_range("maxIterations", *max_iterations, 1, MAX_ITERATIONS)?;
        }
        StepKind::Communities { algorithm, name, weight, max_iterations, resolution, seed, .. } => {
            named("name", name)?;
            named("weight", weight)?;
            let components = matches!(algorithm, CommunityAlgorithm::WeaklyConnected | CommunityAlgorithm::StronglyConnected);
            if components && (max_iterations.is_some() || weight.is_some() || seed.is_some()) {
                return Err(format!("{at}: weight, maxIterations and seed do not belong to connected components"));
            }
            if !matches!(algorithm, CommunityAlgorithm::Louvain | CommunityAlgorithm::Leiden) && resolution.is_some() {
                return Err(format!("{at}.resolution belongs to louvain and leiden"));
            }
            in_range("maxIterations", *max_iterations, 1, MAX_ITERATIONS)?;
            fraction("resolution", *resolution, 0.0, 100.0)?;
        }
        StepKind::KCore { name, .. } | StepKind::Bridges { name, .. } | StepKind::ArticulationPoints { name, .. } => {
            named("name", name)?;
        }
        StepKind::Triangles { name, clustering, .. } => {
            named("name", name)?;
            named("clustering", clustering)?;
            if name.as_deref().unwrap_or("triangles") == clustering.as_deref().unwrap_or("clustering") {
                return Err(format!("{at}: name and clustering must differ"));
            }
        }
        StepKind::Similarity { measure, top_k, properties, label, edge_types, min_score: m, name, .. } => {
            named("name", name)?;
            named("label", label)?;
            types(edge_types)?;
            min_score(*m)?;
            in_range("topK", *top_k, 1, MAX_SIMILAR)?;
            let by_properties = matches!(measure, SimilarityMeasure::Cosine | SimilarityMeasure::Knn);
            if by_properties && properties.is_empty() {
                return Err(format!("{at}.properties: cosine and knn compare 1 to {MAX_STEP_FIELDS} number properties"));
            }
            if !by_properties && !properties.is_empty() {
                return Err(format!("{at}.properties belong to cosine and knn; jaccard and overlap compare neighbours"));
            }
            if by_properties && !edge_types.is_empty() {
                return Err(format!("{at}.edgeTypes belong to jaccard and overlap"));
            }
            if properties.len() > MAX_STEP_FIELDS || properties.iter().collect::<BTreeSet<_>>().len() != properties.len() {
                return Err(format!("{at}.properties takes 1 to {MAX_STEP_FIELDS} keys, each once"));
            }
            for (i, p) in properties.iter().enumerate() {
                graph_name(&format!("properties[{i}]"), p)?;
            }
        }
        StepKind::LinkPrediction { top_k, label, min_score: m, name, .. } => {
            named("name", name)?;
            named("label", label)?;
            min_score(*m)?;
            in_range("topK", *top_k, 1, MAX_SUGGESTIONS)?;
        }
        StepKind::Paths { mode, from, to, edge_types, weight, k, max_paths, max_length, name, .. } => {
            named("name", name)?;
            named("weight", weight)?;
            types(edge_types)?;
            node_id("from", from)?;
            node_id("to", to)?;
            if from == to {
                return Err(format!("{at}: from and to must be two nodes"));
            }
            match mode {
                PathMode::Weighted if weight.is_none() => return Err(format!("{at}.weight is required for a weighted path")),
                PathMode::Shortest | PathMode::AllShortest if weight.is_some() => {
                    return Err(format!("{at}.weight belongs to weighted and kShortest paths"));
                }
                _ => {}
            }
            if *mode != PathMode::KShortest && k.is_some() {
                return Err(format!("{at}.k belongs to kShortest paths"));
            }
            in_range("k", *k, 1, MAX_K_PATHS)?;
            if *mode != PathMode::AllShortest && max_paths.is_some() {
                return Err(format!("{at}.maxPaths belongs to allShortest paths"));
            }
            in_range("maxPaths", *max_paths, 1, MAX_ALL_PATHS)?;
            in_range("maxLength", *max_length, 1, MAX_PATH_LENGTH)?;
        }
        StepKind::Reachable { from, max_hops, edge_types, name, .. } => {
            named("name", name)?;
            types(edge_types)?;
            if from.is_empty() || from.len() > MAX_START_NODES {
                return Err(format!("{at}.from takes 1 to {MAX_START_NODES} nodes"));
            }
            for (i, id) in from.iter().enumerate() {
                node_id(&format!("from[{i}]"), id)?;
            }
            in_range("maxHops", *max_hops, 1, MAX_HOPS)?;
        }
        StepKind::Cycles { max_length, max_count, name, .. } => {
            named("name", name)?;
            in_range("maxLength", *max_length, 2, MAX_CYCLE_LENGTH)?;
            in_range("maxCount", *max_count, 1, MAX_CYCLES)?;
        }
        StepKind::MergeNodes { by, property, aggregates, edge_aggregates, .. } => {
            match (by, property) {
                (MergeBy::Property, None) => return Err(format!("{at}.property is required to merge by a property")),
                (MergeBy::Label, Some(_)) => return Err(format!("{at}.property belongs to merging by a property")),
                _ => {}
            }
            named("property", property)?;
            for (what, list) in [("aggregates", aggregates), ("edgeAggregates", edge_aggregates)] {
                if list.len() > MAX_STEP_FIELDS {
                    return Err(format!("{at}.{what} takes at most {MAX_STEP_FIELDS} entries"));
                }
                let mut names = BTreeSet::new();
                for (i, a) in list.iter().enumerate() {
                    graph_name(&format!("{what}[{i}].name"), &a.name)?;
                    if !names.insert(a.name.as_str()) {
                        return Err(format!("{at}.{what}[{i}]: a value is already named {}", a.name));
                    }
                    match (a.op, &a.property) {
                        (AggregateOp::Count, Some(_)) => return Err(format!("{at}.{what}[{i}]: count takes no property")),
                        (AggregateOp::Count, None) => {}
                        (_, None) => return Err(format!("{at}.{what}[{i}].property is required")),
                        (_, Some(p)) => graph_name(&format!("{what}[{i}].property"), p)?,
                    }
                }
            }
        }
        StepKind::AggregateAlong { label, op, property, edge_types, depth, name, .. } => {
            graph_name("name", name)?;
            named("label", label)?;
            types(edge_types)?;
            match (op, property) {
                (AlongOp::Count, Some(_)) => return Err(format!("{at}: count takes no property")),
                (AlongOp::Count, None) => {}
                (_, None) => return Err(format!("{at}.property is required")),
                (_, Some(p)) => graph_name("property", p)?,
            }
            in_range("depth", *depth, 1, MAX_DEPTH)?;
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frames() -> BTreeSet<&'static str> {
        BTreeSet::from(["A", "B"])
    }

    fn check(steps: Value) -> Result<Vec<Step>, String> {
        check_steps(steps.as_array().unwrap(), &frames(), "steps")
    }

    /// Numbers agree exactly; a case marked `"ulp": true` (exp, ln, log10, pow, whose platform
    /// libraries may round the last bit differently) within one unit in the last place.
    fn close(a: &Value, b: &Value, ulp: bool) -> bool {
        match (a.as_f64(), b.as_f64()) {
            (Some(x), Some(y)) if a.is_number() && b.is_number() => {
                x == y || (ulp && x.signum() == y.signum() && x.to_bits().abs_diff(y.to_bits()) <= 1)
            }
            _ => a == b,
        }
    }

    fn same_values(got: &[Value], want: &Value, ulp: bool) -> bool {
        let want = want.as_array().unwrap();
        got.len() == want.len() && got.iter().zip(want).all(|(g, w)| close(g, w, ulp))
    }

    /// The cases both engines share (`conformance.json`); the UI runs them in
    /// `ui/src/analysis/conformance.test.ts`.
    #[test]
    fn conformance_cases() {
        use crate::shapes::{Field, Frame};
        let cases: Value = serde_json::from_str(include_str!("conformance.json")).unwrap();
        let frame = |name: &str| -> Frame {
            let fields: Vec<Field> = serde_json::from_value(cases["frames"][name].clone()).unwrap();
            Frame::new(fields).unwrap()
        };
        for case in cases["expressions"].as_array().unwrap() {
            let text = case["expression"].as_str().unwrap();
            let f = frame(case["frame"].as_str().unwrap());
            let ulp = case.get("ulp").and_then(Value::as_bool).unwrap_or(false);
            let calendar = case.get("calendar").map_or_else(expr::Calendar::default, |c| {
                let zone = c.get("timeZone").map(|z| z.as_str().unwrap().parse::<chrono_tz::Tz>().unwrap());
                let week_start = c.get("weekStart").map_or(crate::dashboards::model::WeekStart::Monday, |w| {
                    serde_json::from_value(w.clone()).unwrap()
                });
                expr::Calendar::new(zone, week_start)
            });
            let outcome = expr::parse(text).and_then(|e| expr::compile_in(&e, f.fields(), calendar)).and_then(|c| {
                let cells: Result<Vec<Value>, _> = (0..f.rows()).map(|row| c.cell(f.fields(), row)).collect();
                Ok((c.result, cells?))
            });
            match (outcome, case.get("error")) {
                (Ok((result, got)), None) => {
                    assert!(same_values(&got, &case["values"], ulp), "{text}: {got:?}");
                    let t = serde_json::to_value(result.field_type()).unwrap();
                    assert_eq!(t, case["type"], "{text}");
                }
                (Err(e), Some(want)) => {
                    assert_eq!(e.reason, want["reason"].as_str().unwrap(), "{text}");
                    assert_eq!(serde_json::to_value(&e.params).unwrap(), want["params"], "{text}");
                }
                (got, _) => panic!("{text}: {got:?}"),
            }
        }
        for case in cases["steps"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let inputs: Vec<(String, steps::Input)> = case["frames"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(n, source)| {
                    let source = source.as_str().unwrap();
                    let input = match (cases["documents"].get(source), cases["graphs"].get(source)) {
                        (Some(set), _) => steps::Input::Documents(serde_json::from_value(set.clone()).unwrap()),
                        (_, Some(graph)) => steps::Input::Graph(serde_json::from_value(graph.clone()).unwrap()),
                        _ => steps::Input::Frame(frame(source)),
                    };
                    (n.clone(), input)
                })
                .collect();
            let list: Vec<Step> = case["steps"].as_array().unwrap().iter().map(|s| parse_step(s).unwrap()).collect();
            let ran = steps::run_shapes(&list, inputs, &steps::Control::unbounded(), &BTreeSet::new());
            match (ran, case.get("error")) {
                (Ok((out, graphs)), None) => {
                    for (graph_name, want) in case.get("expectGraphs").and_then(Value::as_object).into_iter().flatten()
                    {
                        let got = &graphs.iter().find(|(n, _)| n == graph_name).unwrap().1;
                        let ids = |v: Vec<&str>| json!(v);
                        assert_eq!(ids(got.nodes.iter().map(|n| n.id.as_str()).collect()), want["nodes"], "{name}");
                        assert_eq!(ids(got.edges.iter().map(|e| e.id.as_str()).collect()), want["edges"], "{name}");
                        assert_eq!(serde_json::to_value(&got.schema).unwrap(), want["schema"], "{name}");
                    }
                    if let Some(order) = case.get("outputOrder") {
                        let got: Vec<&str> = out.iter().map(|f| f.name.as_str()).collect();
                        assert_eq!(json!(got), *order, "{name}");
                    }
                    for (frame_name, want) in case.get("expect").and_then(Value::as_object).into_iter().flatten() {
                        let got = &out.iter().find(|f| &f.name == frame_name).unwrap().frame;
                        if let Some(names) = want.get("names") {
                            let got_names: Vec<&str> = got.fields().iter().map(|f| f.name.as_str()).collect();
                            assert_eq!(json!(got_names), *names, "{name}");
                        }
                        for field in want["fields"].as_array().unwrap() {
                            let f = got.fields().iter().find(|f| f.name == field["name"]).unwrap();
                            assert_eq!(serde_json::to_value(f.field_type).unwrap(), field["type"], "{name}");
                            assert!(
                                same_values(&f.values, &field["values"], false),
                                "{name} {}: {:?}",
                                f.name,
                                f.values
                            );
                        }
                    }
                    for gone in case.get("gone").and_then(Value::as_array).into_iter().flatten() {
                        assert!(!out.iter().any(|f| f.name == gone.as_str().unwrap()), "{name}");
                    }
                }
                (Err(failure), Some(want)) => {
                    assert_eq!(failure.index as u64, want["index"].as_u64().unwrap(), "{name}");
                    assert_eq!(failure.detail.reason, want["reason"].as_str().unwrap(), "{name}");
                    assert_eq!(serde_json::to_value(&failure.detail.params).unwrap(), want["params"], "{name}");
                }
                (got, _) => panic!("{name}: {got:?}"),
            }
        }
    }

    /// The projection step: `{"id", "type": "toFrame", "frame", "columns": [{path, name?, type?}]}`.
    #[test]
    fn projections_are_bounded() {
        let steps = check(json!([
            { "id": "p", "type": "toFrame", "frame": "A", "columns": [
                { "path": "at" }, { "path": "items.0.price", "name": "Preis", "type": "number" }
            ] },
            { "id": "c", "type": "calculate", "frame": "A", "name": "x", "expression": "Preis * 2" }
        ]))
        .unwrap();
        let StepKind::ToFrame { frame, columns, .. } = &steps[0].kind else { panic!() };
        assert_eq!((frame.as_str(), columns.len()), ("A", 2));
        assert_eq!(columns[1].field_type, Some(crate::shapes::FieldType::Number));
        let one = |columns: Value| json!([{ "id": "p", "type": "toFrame", "frame": "A", "columns": columns }]);
        for (bad, expect) in [
            (
                json!([{ "id": "p", "type": "toFrame", "frame": "C", "columns": [{ "path": "a" }] }]),
                "there is no query C",
            ),
            (json!([{ "type": "toFrame", "frame": "A", "columns": [{ "path": "a" }] }]), "id must be text"),
            (json!([{ "id": "p", "type": "toFrame", "refId": "A", "columns": [{ "path": "a" }] }]), "unknown field"),
            (one(json!([])), "columns takes 1 to 200"),
            (one(json!(vec![json!({ "path": "a" }); 201])), "columns takes 1 to 200"),
            (one(json!([{ "path": "" }])), "columns[0].path needs 1 to 500"),
            (one(json!([{ "path": "x".repeat(501) }])), "columns[0].path needs 1 to 500"),
            (one(json!([{ "path": "a", "colour": 1 }])), "unknown field"),
            (one(json!([{ "path": "a", "type": "decimal" }])), "columns[0].type must be"),
            (one(json!([{ "path": "a", "type": "date" }])), "columns[0].type must be"),
            (one(json!([{ "path": "a", "type": "money" }])), "unknown variant"),
            (one(json!([{ "path": "a", "type": "json" }])), "columns[0].type must be"),
            (one(json!([{ "path": "a", "name": "" }])), "columns[0].name"),
            (one(json!([{ "path": "a", "name": "a\nb" }])), "columns[0].name"),
            (one(json!([{ "path": "a" }, { "path": "b", "name": "a" }])), "columns[1]: a column is already named a"),
        ] {
            let err = check(bad.clone()).unwrap_err();
            assert!(err.contains(expect), "{bad}: {err}");
        }
    }

    #[test]
    fn every_kind_parses() {
        let steps = check(json!([
            { "id": "1", "type": "calculate", "frame": "A", "name": "Brutto", "expression": "betrag * 1.19" },
            { "id": "2", "type": "join", "left": "A", "right": "B", "on": { "by": "time" }, "mode": "outer" },
            { "id": "3", "type": "join", "left": "B", "right": "A", "mode": "inner",
              "on": { "by": "key", "leftField": "land", "rightField": "land" }, "disabled": true },
            { "id": "4", "type": "reduce", "frame": "A", "fields": ["betrag"], "stats": ["mean", "percentile"], "percentiles": [90, 99.5] },
            { "id": "5", "type": "trend", "frame": "A", "field": "betrag", "output": "fitted", "name": "Trend" },
            { "id": "6", "type": "trend", "frame": "A", "field": "betrag", "x": "zeit", "output": "summary" },
            { "id": "7", "type": "movingAverage", "frame": "A", "field": "betrag", "window": 7, "name": "Schnitt" },
            { "id": "8", "type": "correlate", "frame": "A", "x": "a", "y": "b" },
            { "id": "9", "type": "compare", "frame": "A", "field": "betrag", "period": "month", "output": "percent", "name": "Vormonat" },
            { "id": "10", "type": "group", "frame": "A", "by": ["land"], "aggregations": [{ "field": "betrag", "op": "sum" }] },
            { "id": "11", "type": "pivot", "frame": "A", "row": "land", "column": "jahr", "value": "betrag", "op": "mean" }
        ]))
        .unwrap();
        assert_eq!(steps.len(), 11);
        assert!(steps[2].disabled && !steps[0].disabled);
        assert_eq!(
            steps[1].kind,
            StepKind::Join { left: "A".into(), right: "B".into(), on: JoinOn::Time, mode: JoinMode::Outer }
        );
        let StepKind::Group { aggregations, .. } = &steps[9].kind else { panic!() };
        assert_eq!(aggregations[0].output_name(), "sum(betrag)");
    }

    #[test]
    fn invalid_steps_are_refused_with_the_place() {
        let base = json!({ "id": "s", "type": "calculate", "frame": "A", "name": "x", "expression": "1" });
        let with = |key: &str, value: Value| {
            let mut s = base.clone();
            s[key] = value;
            json!([s])
        };
        for (steps, expect) in [
            (json!([1]), "steps[0]: must be an object"),
            (with("id", json!(3)), "steps[0]: id must be text"),
            (with("id", json!("")), "steps[0].id"),
            (with("disabled", json!("ja")), "disabled"),
            (with("type", json!("magic")), "unknown variant"),
            (with("colour", json!("red")), "unknown field"),
            (with("frame", json!("Z")), "there is no query Z"),
            (with("name", json!("")), "steps[0].name"),
            (with("name", json!("a\nb")), "control characters"),
            (with("expression", json!("1 +")), "steps[0].expression: unexpected input at 4"),
            (with("expression", json!("x".repeat(2001))), "more than 2000"),
            (json!([base, base]), "steps[1].id s is used twice"),
            (
                json!([{ "id": "j", "type": "join", "left": "A", "right": "A", "on": { "by": "time" }, "mode": "left" }]),
                "with itself",
            ),
            (
                json!([{ "id": "j", "type": "join", "left": "A", "right": "B", "on": { "by": "key" }, "mode": "left" }]),
                "missing field",
            ),
            (
                json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": [], "stats": ["sum"] }]),
                "fields takes 1 to 50",
            ),
            (
                json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["sum", "sum"] }]),
                "each once",
            ),
            (
                json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["percentile"] }]),
                "percentiles",
            ),
            (
                json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["sum"], "percentiles": [5] }]),
                "none without",
            ),
            (
                json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["percentile"], "percentiles": [101] }]),
                "0 to 100",
            ),
            (
                json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["percentile"], "percentiles": [5, 5.0] }]),
                "distinct",
            ),
            (
                json!([{ "id": "t", "type": "trend", "frame": "A", "field": "a", "output": "fitted" }]),
                "name is required",
            ),
            (
                json!([{ "id": "t", "type": "trend", "frame": "A", "field": "a", "output": "summary", "name": "n" }]),
                "only to the fitted",
            ),
            (
                json!([{ "id": "m", "type": "movingAverage", "frame": "A", "field": "a", "window": 0, "name": "n" }]),
                "window",
            ),
            (
                json!([{ "id": "m", "type": "movingAverage", "frame": "A", "field": "a", "window": 10001, "name": "n" }]),
                "window",
            ),
            (
                json!([{ "id": "m", "type": "movingAverage", "frame": "A", "field": "a", "window": -1, "name": "n" }]),
                "invalid value",
            ),
            (json!([{ "id": "g", "type": "group", "frame": "A", "by": [], "aggregations": [] }]), "by takes 1 to 10"),
            (
                json!([{ "id": "g", "type": "group", "frame": "A", "by": ["a"], "aggregations": [{ "field": "b", "op": "avg" }] }]),
                "unknown variant",
            ),
        ] {
            let err = check(steps.clone()).unwrap_err();
            assert!(err.contains(expect), "{steps}: {err}");
        }
        let many: Vec<Value> = (0..=MAX_STEPS)
            .map(
                |i| json!({ "id": format!("s{i}"), "type": "calculate", "frame": "A", "name": "x", "expression": "1" }),
            )
            .collect();
        assert!(check(json!(many)).unwrap_err().contains("at most 50"));
    }
}
