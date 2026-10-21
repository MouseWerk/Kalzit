//! Builds `graph` results within the limits, shared by the graph kinds (Neo4j, Memgraph,
//! TigerGraph): nodes and edges by id, each once; paths as sequences of their ids; the
//! label/edge-type/property schema of the answer. Hitting the node or edge limit or the response
//! size budget stops reading and marks the graph `truncated` instead of failing the query.
//!
//! An edge whose end node is not part of the answer still needs both ends to be drawn, so such a
//! node is added with its id only (and the labels the source knows) and replaced by the full node
//! when that arrives later.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde_json::Value;

use super::detail::Detail;
use super::frame::{ResponseBudget, json_size};
use crate::shapes::{Edge, GraphPath, GraphSchema, GraphSet, Node, Notice, NoticeSeverity, Truncated};

/// Nodes a graph answer holds unless the source's `maxNodes` says otherwise.
pub const DEFAULT_MAX_NODES: usize = 10_000;
/// Edges a graph answer holds unless the source's `maxEdges` says otherwise.
pub const DEFAULT_MAX_EDGES: usize = 50_000;
/// Integers beyond this magnitude lose precision as JavaScript numbers.
const MAX_SAFE_INT: i64 = (1 << 53) - 1;

/// An integer as a JSON number while JavaScript holds it exactly, else as
/// `{"$type": "int64", "value": "..."}`.
pub fn int_value(i: i64) -> Value {
    if (-MAX_SAFE_INT..=MAX_SAFE_INT).contains(&i) {
        Value::from(i)
    } else {
        crate::shapes::typed("int64", i.to_string())
    }
}

/// A float as a JSON number; NaN and the infinities, which JSON lacks, as
/// `{"$type": "float", "value": "NaN"}`.
pub fn float_value(f: f64) -> Value {
    match serde_json::Number::from_f64(f) {
        Some(n) => Value::Number(n),
        None if f.is_nan() => crate::shapes::typed("float", "NaN"),
        None if f > 0.0 => crate::shapes::typed("float", "Infinity"),
        None => crate::shapes::typed("float", "-Infinity"),
    }
}

/// The graph limits of one query: nodes, edges, and the request's response budget.
#[derive(Clone, Debug)]
pub struct GraphLimits {
    pub max_nodes: usize,
    pub max_edges: usize,
    pub budget: ResponseBudget,
}

impl GraphLimits {
    /// The source's `maxNodes` and `maxEdges` (defaults above), never above `max_rows`, the
    /// server-wide and per-source row limit.
    pub fn from_settings(settings: &Value, max_rows: usize, budget: ResponseBudget) -> Self {
        let own = |key: &str, default: usize| {
            settings.get(key).and_then(Value::as_u64).map_or(default, |v| v.max(1) as usize).min(max_rows.max(1))
        };
        Self { max_nodes: own("maxNodes", DEFAULT_MAX_NODES), max_edges: own("maxEdges", DEFAULT_MAX_EDGES), budget }
    }
}

pub struct GraphBuilder {
    limits: GraphLimits,
    nodes: Vec<Node>,
    node_index: HashMap<String, usize>,
    /// Nodes known only as an edge's end so far.
    stubs: HashSet<String>,
    edges: Vec<Edge>,
    edge_index: HashSet<String>,
    paths: Vec<GraphPath>,
    has_paths: bool,
    truncated: Option<Truncated>,
    notices: Vec<Notice>,
    /// Bytes taken from the budget; given back if the builder is dropped unfinished.
    taken: usize,
}

impl Drop for GraphBuilder {
    fn drop(&mut self) {
        self.limits.budget.give_back(self.taken);
    }
}

fn node_size(n: &Node) -> usize {
    n.id.len() + n.labels.iter().map(|l| l.len() + 3).sum::<usize>() + props_size(&n.properties) + 32
}

fn props_size(p: &BTreeMap<String, Value>) -> usize {
    p.iter().map(|(k, v)| k.len() + 4 + json_size(v)).sum()
}

impl GraphBuilder {
    pub fn new(limits: GraphLimits) -> Self {
        Self {
            limits,
            nodes: Vec::new(),
            node_index: HashMap::new(),
            stubs: HashSet::new(),
            edges: Vec::new(),
            edge_index: HashSet::new(),
            paths: Vec::new(),
            has_paths: false,
            truncated: None,
            notices: Vec::new(),
            taken: 0,
        }
    }

    pub fn is_full(&self) -> bool {
        self.truncated.is_some()
    }

    pub fn has_node(&self, id: &str) -> bool {
        self.node_index.contains_key(id)
    }

    /// Adds a notice once, however often it is reported.
    pub fn notice(&mut self, severity: NoticeSeverity, detail: Detail) {
        let params = (!detail.params.is_empty()).then_some(detail.params);
        if !self.notices.iter().any(|n| n.code == detail.reason && n.params == params) {
            self.notices.push(Notice { severity, code: detail.reason.to_string(), params, text: detail.message });
        }
    }

    fn truncate(&mut self, reason: &'static str, limit: usize, message: String) {
        if self.truncated.is_none() {
            self.truncated = Some(Truncated { limit: limit.min(u32::MAX as usize) as u32, reason: Some(reason.into()) });
            let detail = Detail::new(reason, message);
            let detail = if reason == "graph.size_limit" { detail } else { detail.with("limit", limit) };
            self.notice(NoticeSeverity::Warning, detail);
        }
    }

    fn take(&mut self, bytes: usize) -> bool {
        if self.limits.budget.take(bytes) {
            self.taken += bytes;
            true
        } else {
            self.truncate("graph.size_limit", 0, "the graph was cut off at the response size limit".into());
            false
        }
    }

    /// Adds a node, or completes one known only as an edge's end. False when a limit was
    /// reached; the node is then not added and the caller stops reading.
    pub fn add_node(&mut self, node: Node) -> bool {
        if self.truncated.is_some() {
            return false;
        }
        if let Some(&i) = self.node_index.get(&node.id) {
            if self.stubs.remove(&node.id) {
                let size = node_size(&node);
                if !self.take(size) {
                    return false;
                }
                self.nodes[i] = node;
            }
            return true;
        }
        if self.nodes.len() >= self.limits.max_nodes {
            let max = self.limits.max_nodes;
            self.truncate("graph.node_limit", max, format!("only the first {max} nodes are shown (node limit)"));
            return false;
        }
        let size = node_size(&node);
        if !self.take(size) {
            return false;
        }
        self.node_index.insert(node.id.clone(), self.nodes.len());
        self.nodes.push(node);
        true
    }

    /// Makes sure a node with this id exists, with the given labels if it is new.
    fn ensure_node(&mut self, id: &str, labels: &[String]) -> bool {
        if self.node_index.contains_key(id) {
            return true;
        }
        let stub = Node { id: id.to_string(), labels: labels.to_vec(), properties: BTreeMap::new() };
        if !self.add_node(stub) {
            return false;
        }
        self.stubs.insert(id.to_string());
        true
    }

    /// Adds an edge and, when missing, its end nodes (`from_labels`, `to_labels` are what the
    /// source knows of their labels). False when a limit was reached.
    pub fn add_edge(&mut self, edge: Edge, from_labels: &[String], to_labels: &[String]) -> bool {
        if self.truncated.is_some() {
            return false;
        }
        if self.edge_index.contains(&edge.id) {
            return true;
        }
        if self.edges.len() >= self.limits.max_edges {
            let max = self.limits.max_edges;
            self.truncate("graph.edge_limit", max, format!("only the first {max} edges are shown (edge limit)"));
            return false;
        }
        if !self.ensure_node(&edge.from, from_labels) || !self.ensure_node(&edge.to, to_labels) {
            return false;
        }
        let size = edge.id.len() + edge.edge_type.len() + edge.from.len() + edge.to.len() + props_size(&edge.properties) + 40;
        if !self.take(size) {
            return false;
        }
        self.edge_index.insert(edge.id.clone());
        self.edges.push(edge);
        true
    }

    /// Adds a path of node and edge ids; its nodes and edges must have been added first.
    pub fn add_path(&mut self, path: GraphPath) -> bool {
        self.has_paths = true;
        if self.truncated.is_some() {
            return false;
        }
        let size = path.nodes.iter().chain(&path.edges).map(|id| id.len() + 3).sum::<usize>() + 24;
        if !self.take(size) {
            return false;
        }
        self.paths.push(path);
        true
    }

    /// Whether anything has been added.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty() && self.edges.is_empty() && !self.has_paths
    }

    pub fn finish(mut self) -> GraphSet {
        let mut labels = BTreeSet::new();
        let mut edge_types = BTreeSet::new();
        let mut keys: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for n in &self.nodes {
            for l in &n.labels {
                labels.insert(l.clone());
                keys.entry(l.clone()).or_default().extend(n.properties.keys().cloned());
            }
        }
        for e in &self.edges {
            edge_types.insert(e.edge_type.clone());
        }
        let schema = GraphSchema {
            labels: labels.into_iter().collect(),
            edge_types: edge_types.into_iter().collect(),
            property_keys: keys.into_iter().map(|(k, v)| (k, v.into_iter().collect())).collect(),
        };
        // The bytes stay taken for the answer, which the request's budget accounts for.
        self.taken = 0;
        GraphSet {
            nodes: std::mem::take(&mut self.nodes),
            edges: std::mem::take(&mut self.edges),
            paths: self.has_paths.then(|| std::mem::take(&mut self.paths)),
            schema,
            truncated: self.truncated.take(),
            notices: Some(std::mem::take(&mut self.notices)).filter(|n| !n.is_empty()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: &str, label: &str) -> Node {
        Node { id: id.into(), labels: vec![label.into()], properties: [("name".to_string(), json!(id))].into() }
    }

    fn edge(id: &str, from: &str, to: &str) -> Edge {
        Edge { id: id.into(), edge_type: "KENNT".into(), from: from.into(), to: to.into(), properties: BTreeMap::new() }
    }

    fn limits(nodes: usize, edges: usize, bytes: usize) -> GraphLimits {
        GraphLimits { max_nodes: nodes, max_edges: edges, budget: ResponseBudget::new(bytes) }
    }

    #[test]
    fn nodes_and_edges_are_kept_once_and_edge_ends_are_completed() {
        let mut g = GraphBuilder::new(limits(10, 10, 1 << 20));
        assert!(g.add_edge(edge("e1", "a", "b"), &[], &["Person".into()]));
        assert!(g.add_node(node("a", "Person")));
        assert!(g.add_node(node("a", "Person")));
        assert!(g.add_edge(edge("e1", "a", "b"), &[], &[]));
        let set = g.finish();
        assert_eq!(set.nodes.len(), 2);
        assert_eq!(set.edges.len(), 1);
        let a = set.nodes.iter().find(|n| n.id == "a").unwrap();
        assert_eq!(a.properties["name"], "a", "the full node replaced the edge's end");
        let b = set.nodes.iter().find(|n| n.id == "b").unwrap();
        assert!(b.properties.is_empty());
        assert_eq!(b.labels, ["Person"]);
        assert_eq!(set.schema.labels, ["Person"]);
        assert_eq!(set.schema.edge_types, ["KENNT"]);
        assert_eq!(set.schema.property_keys["Person"], ["name"]);
        assert!(set.paths.is_none() && set.truncated.is_none());
    }

    #[test]
    fn limits_truncate_with_a_reason() {
        let mut g = GraphBuilder::new(limits(2, 10, 1 << 20));
        assert!(g.add_node(node("a", "X")));
        assert!(g.add_node(node("b", "X")));
        assert!(!g.add_node(node("c", "X")));
        assert!(g.is_full());
        let set = g.finish();
        assert_eq!(set.truncated, Some(Truncated { limit: 2, reason: Some("graph.node_limit".into()) }));
        assert_eq!(set.notices.unwrap()[0].code, "graph.node_limit");

        let mut g = GraphBuilder::new(limits(10, 1, 1 << 20));
        assert!(g.add_edge(edge("e1", "a", "b"), &[], &[]));
        assert!(!g.add_edge(edge("e2", "a", "b"), &[], &[]));
        assert_eq!(g.finish().truncated.unwrap().reason.as_deref(), Some("graph.edge_limit"));

        let budget = ResponseBudget::new(100);
        let mut g = GraphBuilder::new(GraphLimits { max_nodes: 100, max_edges: 100, budget: budget.clone() });
        assert!(g.add_node(node("a", "X")));
        assert!(!g.add_node(node(&"b".repeat(200), "X")));
        let left = budget.remaining();
        assert_eq!(g.finish().truncated.unwrap().reason.as_deref(), Some("graph.size_limit"));
        assert_eq!(budget.remaining(), left, "the answer keeps its bytes");
        let mut dropped = GraphBuilder::new(GraphLimits { max_nodes: 100, max_edges: 100, budget: budget.clone() });
        dropped.add_node(node("z", "X"));
        drop(dropped);
        assert_eq!(budget.remaining(), left, "an unfinished graph gives its bytes back");
    }

    #[test]
    fn values_keep_their_precision() {
        assert_eq!(int_value(42), json!(42));
        assert_eq!(int_value(9_007_199_254_740_993), json!({ "$type": "int64", "value": "9007199254740993" }));
        assert_eq!(int_value(i64::MIN), json!({ "$type": "int64", "value": i64::MIN.to_string() }));
        assert_eq!(float_value(1.5), json!(1.5));
        assert_eq!(float_value(f64::NAN), json!({ "$type": "float", "value": "NaN" }));
        assert_eq!(float_value(f64::NEG_INFINITY), json!({ "$type": "float", "value": "-Infinity" }));
        let l = GraphLimits::from_settings(&json!({ "maxNodes": 50 }), 30, ResponseBudget::new(1));
        assert_eq!((l.max_nodes, l.max_edges), (30, 30));
        let l = GraphLimits::from_settings(&json!({}), 1_000_000, ResponseBudget::new(1));
        assert_eq!((l.max_nodes, l.max_edges), (DEFAULT_MAX_NODES, DEFAULT_MAX_EDGES));
    }
}
