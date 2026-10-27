//! Graph steps on the server: counts per label and per edge type, the degree distribution, the
//! top nodes by degree, shared neighbours and the projection of nodes or edges into a frame
//! (docs/api/settings-dashboards.md, "Graph steps"). The same steps run in the database where the
//! source can (`pushdown.rs`), and in the browser for a preview (`ui/src/analysis/graphSteps.ts`);
//! the server and the browser pass the graph cases of `conformance.json`.
//!
//! Orders are fixed so every engine answers the same rows: counts largest first, then by name;
//! names and node ids compare by UTF-16 code units, as Neo4j compares text.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde_json::Value;

use super::steps::Control;
use super::{Direction, StepKind};
use crate::datasources::detail::Detail;
use crate::shapes::{Edge, Field, FieldType, Frame, FrameMeta, GraphSchema, GraphSet, Node};

/// What a graph step makes: a frame, or a smaller graph.
#[derive(Clone, Debug, PartialEq)]
pub enum GraphOut {
    Frame(Frame),
    Graph(GraphSet),
}

/// Text in the order Neo4j sorts it: by UTF-16 code units.
pub fn text_order(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Optional text, the missing last (as `ORDER BY ... ASC` in Cypher).
fn optional_order(a: &Option<String>, b: &Option<String>) -> Ordering {
    match (a, b) {
        (Some(a), Some(b)) => text_order(a, b),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn field(name: &str, field_type: FieldType, values: Vec<Value>) -> Field {
    Field { name: name.to_string(), field_type, unit: None, values, labels: None }
}

/// A frame made from a graph keeps the graph's notices; a cut graph marks the frame cut.
fn frame(graph: &GraphSet, fields: Vec<Field>) -> Frame {
    let meta = FrameMeta {
        executed_query: None,
        rows_truncated: graph.truncated.is_some(),
        notices: graph.notices.clone().unwrap_or_default(),
    };
    Frame::new(fields).expect("graph steps build fields of equal length").with_meta(meta)
}

fn count(n: usize) -> Value {
    Value::from(n as u64)
}

/// Runs one graph step on `graph`. Steps that are no graph steps are not passed here.
pub fn apply(kind: &StepKind, graph: &GraphSet, control: &Control) -> Result<GraphOut, Detail> {
    Ok(match kind {
        StepKind::CountLabels { .. } => GraphOut::Frame(count_labels(graph)),
        StepKind::CountEdgeTypes { .. } => GraphOut::Frame(count_edge_types(graph)),
        StepKind::DegreeDistribution { direction, .. } => GraphOut::Frame(degree_distribution(graph, *direction)),
        StepKind::TopDegree { n, label, direction, .. } => {
            GraphOut::Graph(top_degree(graph, *n as usize, label.as_deref(), *direction))
        }
        StepKind::SharedNeighbours { label, via, edge_type, min, limit, name, .. } => GraphOut::Frame(shared_neighbours(
            graph,
            &SharedSpec {
                label,
                via,
                edge_type: edge_type.as_deref(),
                min: *min as usize,
                limit: *limit as usize,
                name: name.as_deref(),
            },
            control,
        )?),
        StepKind::ToFrame { columns, rows: Some(rows), label, edge_type, .. } => GraphOut::Frame(
            super::projection::project_graph(graph, *rows, label.as_deref(), edge_type.as_deref(), columns),
        ),
        _ => unreachable!("only graph steps run on graphs"),
    })
}

fn count_labels(graph: &GraphSet) -> Frame {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for n in &graph.nodes {
        let mut seen = HashSet::new();
        for l in &n.labels {
            if seen.insert(l.as_str()) {
                *counts.entry(l).or_default() += 1;
            }
        }
    }
    let mut rows: Vec<(&str, usize)> = counts.into_iter().collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| text_order(a.0, b.0)));
    let total = graph.nodes.len() as f64;
    frame(
        graph,
        vec![
            field("label", FieldType::String, rows.iter().map(|(l, _)| Value::from(*l)).collect()),
            field("nodes", FieldType::Number, rows.iter().map(|(_, c)| count(*c)).collect()),
            field("share", FieldType::Number, rows.iter().map(|(_, c)| super::expr::to_json(super::expr::V::Num(*c as f64 / total))).collect()),
        ],
    )
}

/// A node's labels joined with `:` (`Kunde:VIP`); none for a node without labels.
fn label_text(n: Option<&&Node>) -> Option<String> {
    n.filter(|n| !n.labels.is_empty()).map(|n| n.labels.join(":"))
}

fn count_edge_types(graph: &GraphSet) -> Frame {
    let nodes: HashMap<&str, &Node> = graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut counts: HashMap<(String, Option<String>, Option<String>), usize> = HashMap::new();
    for e in &graph.edges {
        let key = (
            e.edge_type.clone(),
            label_text(nodes.get(e.from.as_str())),
            label_text(nodes.get(e.to.as_str())),
        );
        *counts.entry(key).or_default() += 1;
    }
    let mut rows: Vec<_> = counts.into_iter().collect();
    rows.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| text_order(&a.0.0, &b.0.0))
            .then_with(|| optional_order(&a.0.1, &b.0.1))
            .then_with(|| optional_order(&a.0.2, &b.0.2))
    });
    let text = |v: &Option<String>| v.as_ref().map_or(Value::Null, |s| Value::from(s.as_str()));
    frame(
        graph,
        vec![
            field("type", FieldType::String, rows.iter().map(|r| Value::from(r.0.0.as_str())).collect()),
            field("from", FieldType::String, rows.iter().map(|r| text(&r.0.1)).collect()),
            field("to", FieldType::String, rows.iter().map(|r| text(&r.0.2)).collect()),
            field("edges", FieldType::Number, rows.iter().map(|r| count(r.1)).collect()),
        ],
    )
}

/// The degree of every node, in node order: edges that start (out), end (in) or either (both)
/// there; a loop counts twice for both.
fn degrees(graph: &GraphSet, direction: Direction) -> Vec<usize> {
    let index: HashMap<&str, usize> = graph.nodes.iter().enumerate().map(|(i, n)| (n.id.as_str(), i)).collect();
    let mut out = vec![0; graph.nodes.len()];
    for e in &graph.edges {
        if direction != Direction::In
            && let Some(i) = index.get(e.from.as_str())
        {
            out[*i] += 1;
        }
        if direction != Direction::Out
            && let Some(i) = index.get(e.to.as_str())
        {
            out[*i] += 1;
        }
    }
    out
}

fn degree_distribution(graph: &GraphSet, direction: Direction) -> Frame {
    let mut counts: BTreeMap<usize, usize> = BTreeMap::new();
    for d in degrees(graph, direction) {
        *counts.entry(d).or_default() += 1;
    }
    frame(
        graph,
        vec![
            field("degree", FieldType::Number, counts.keys().map(|d| count(*d)).collect()),
            field("nodes", FieldType::Number, counts.values().map(|c| count(*c)).collect()),
        ],
    )
}

/// The labels, edge types and property keys of a graph, as the graph builder lists them.
pub fn schema_of(nodes: &[Node], edges: &[Edge]) -> GraphSchema {
    let mut labels = BTreeSet::new();
    let mut edge_types = BTreeSet::new();
    let mut keys: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for n in nodes {
        for l in &n.labels {
            labels.insert(l.clone());
            keys.entry(l.clone()).or_default().extend(n.properties.keys().cloned());
        }
    }
    for e in edges {
        edge_types.insert(e.edge_type.clone());
    }
    GraphSchema {
        labels: labels.into_iter().collect(),
        edge_types: edge_types.into_iter().collect(),
        property_keys: keys.into_iter().map(|(k, v)| (k, v.into_iter().collect())).collect(),
    }
}

fn top_degree(graph: &GraphSet, n: usize, label: Option<&str>, direction: Direction) -> GraphSet {
    let deg = degrees(graph, direction);
    let mut ranked: Vec<usize> = (0..graph.nodes.len())
        .filter(|i| label.is_none_or(|l| graph.nodes[*i].labels.iter().any(|x| x == l)))
        .collect();
    ranked.sort_by(|a, b| deg[*b].cmp(&deg[*a]).then_with(|| text_order(&graph.nodes[*a].id, &graph.nodes[*b].id)));
    ranked.truncate(n);
    let nodes: Vec<Node> = ranked.iter().map(|i| graph.nodes[*i].clone()).collect();
    let kept: HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    let edges: Vec<Edge> = graph
        .edges
        .iter()
        .filter(|e| kept.contains(e.from.as_str()) && kept.contains(e.to.as_str()))
        .cloned()
        .collect();
    GraphSet {
        schema: schema_of(&nodes, &edges),
        nodes,
        edges,
        paths: None,
        truncated: graph.truncated.clone(),
        notices: graph.notices.clone(),
    }
}

struct SharedSpec<'a> {
    label: &'a str,
    via: &'a str,
    edge_type: Option<&'a str>,
    min: usize,
    limit: usize,
    name: Option<&'a str>,
}

fn shared_neighbours(graph: &GraphSet, spec: &SharedSpec, control: &Control) -> Result<Frame, Detail> {
    let nodes: HashMap<&str, &Node> = graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let has = |n: &Node, l: &str| n.labels.iter().any(|x| x == l);
    // Each neighbour (`via`) with the `label` nodes next to it, each pair of them once.
    let mut around: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut seen: HashSet<(&str, &str)> = HashSet::new();
    for (i, e) in graph.edges.iter().enumerate() {
        control.every(i)?;
        if spec.edge_type.is_some_and(|t| e.edge_type != t) {
            continue;
        }
        let (Some(s), Some(t)) = (nodes.get(e.from.as_str()), nodes.get(e.to.as_str())) else { continue };
        let (a, v) = if has(s, spec.label) && has(t, spec.via) {
            (s, t)
        } else if has(s, spec.via) && has(t, spec.label) {
            (t, s)
        } else {
            continue;
        };
        if seen.insert((a.id.as_str(), v.id.as_str())) {
            around.entry(v.id.as_str()).or_default().push(a.id.as_str());
        }
    }
    // Pairs grow with the square of a neighbour's nodes: bounded before they are made.
    let pairs: usize = around.values().map(|a| a.len() * a.len().saturating_sub(1) / 2).sum();
    control.cells(pairs, 1)?;
    let mut shared: HashMap<(&str, &str), Vec<&str>> = HashMap::new();
    for (v, list) in &around {
        for (i, x) in list.iter().enumerate() {
            control.every(i)?;
            for y in list {
                if text_order(x, y) == Ordering::Less {
                    shared.entry((*x, *y)).or_default().push(v);
                }
            }
        }
    }
    let mut rows: Vec<((&str, &str), Vec<&str>)> = shared.into_iter().filter(|(_, vs)| vs.len() >= spec.min).collect();
    rows.sort_by(|a, b| {
        b.1.len().cmp(&a.1.len()).then_with(|| text_order(a.0.0, b.0.0)).then_with(|| text_order(a.0.1, b.0.1))
    });
    rows.truncate(spec.limit);
    let display = |id: &str| -> Value {
        let named = spec.name.and_then(|k| nodes.get(id).and_then(|n| n.properties.get(k))).and_then(Value::as_str);
        Value::from(named.unwrap_or(id))
    };
    let mut neighbours = Vec::with_capacity(rows.len());
    for (_, vs) in &mut rows {
        vs.sort_by(|a, b| text_order(a, b));
        neighbours.push(Value::Array(vs.iter().map(|v| display(v)).collect()));
    }
    Ok(frame(
        graph,
        vec![
            field("a", FieldType::String, rows.iter().map(|r| display(r.0.0)).collect()),
            field("b", FieldType::String, rows.iter().map(|r| display(r.0.1)).collect()),
            field("shared", FieldType::Number, rows.iter().map(|r| count(r.1.len())).collect()),
            field("neighbours", FieldType::Json, neighbours),
        ],
    ))
}
