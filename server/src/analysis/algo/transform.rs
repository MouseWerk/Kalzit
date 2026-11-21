//! The steps that reshape a graph (board 0.8.2, "Umformen"):
//!
//! - `mergeNodes` ("Knoten zusammenfassen"): one group node per label (the node's labels joined
//!   with `:`) or per value of a property (such as `community`), with aggregates over its
//!   members. A group node has the id `group:<value>`, the label `Gruppe`, the properties `name`
//!   (the value), `count`, the aggregates, and `members` (the members' names) and `memberIds`;
//!   it cannot be opened again, the members are listed. Nodes without the property form the group
//!   with an empty value. Edges between two groups become one edge per type (or one for all types
//!   with `mergeTypes`) with `count` and the edge aggregates; edges inside a group become a loop
//!   (`loops`, the default) or are left out. Paths are left out.
//! - `aggregateAlong` ("Entlang aggregieren"): for every node with `label` (all when absent),
//!   `op` over the property of the nodes reached within `depth` edges of `edgeTypes` in
//!   `direction`, each reached node once; no reached value leaves the property out.
//!
//! Aggregates: `count`, `sum`, `mean`, `min`, `max` of numbers (other values are passed over), and
//! `distinct`, the number of distinct values of any kind.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use serde_json::{Value, json};

use super::{Budget, Topo, direction_of, display, number, summary, with_node_values};
use crate::analysis::graph::{number_of, schema_of};
use crate::analysis::{AggregateOp, AlongOp, GraphAggregate, MergeBy, StepKind};
use crate::datasources::detail::Detail;
use crate::shapes::{Edge, GraphSet, Node, StepSummary};

/// The label of a group node.
pub const GROUP_LABEL: &str = "Gruppe";
/// Members a group node lists by name and id at most.
pub const MAX_MEMBERS: usize = 1000;

pub fn apply(kind: &StepKind, graph: &GraphSet, budget: &Budget) -> Result<(GraphSet, StepSummary), Detail> {
    match kind {
        StepKind::MergeNodes { .. } => merge(kind, graph, budget),
        StepKind::AggregateAlong { .. } => along(kind, graph, budget),
        _ => unreachable!("only reshaping steps run here"),
    }
}

/// The aggregate of `values` (the properties of the members, `None` where missing).
fn aggregate(op: AggregateOp, values: &[Option<&Value>], members: usize) -> Value {
    let numbers: Vec<f64> = values.iter().filter_map(|v| v.and_then(number_of)).collect();
    match op {
        AggregateOp::Count => json!(members),
        AggregateOp::Distinct => {
            json!(values.iter().flatten().filter(|v| !v.is_null()).map(|v| v.to_string()).collect::<BTreeSet<_>>().len())
        }
        _ if numbers.is_empty() => Value::Null,
        AggregateOp::Sum => number(numbers.iter().sum()),
        AggregateOp::Mean => number(numbers.iter().sum::<f64>() / numbers.len() as f64),
        AggregateOp::Min => number(numbers.iter().copied().fold(f64::INFINITY, f64::min)),
        AggregateOp::Max => number(numbers.iter().copied().fold(f64::NEG_INFINITY, f64::max)),
    }
}

fn apply_aggregates(
    into: &mut BTreeMap<String, Value>,
    list: &[GraphAggregate],
    members: usize,
    value_of: impl Fn(&str) -> Vec<Option<Value>>,
) {
    for a in list {
        let values = a.property.as_deref().map(&value_of).unwrap_or_default();
        let refs: Vec<Option<&Value>> = values.iter().map(Option::as_ref).collect();
        let v = aggregate(a.op, &refs, members);
        if !v.is_null() {
            into.insert(a.name.clone(), v);
        }
    }
}

fn merge(kind: &StepKind, graph: &GraphSet, budget: &Budget) -> Result<(GraphSet, StepSummary), Detail> {
    let StepKind::MergeNodes { by, property, aggregates, edge_aggregates, loops, merge_types, .. } = kind else {
        unreachable!()
    };
    // The group of every node, in the order the groups first come.
    let key_of = |n: &Node| -> String {
        match by {
            MergeBy::Label => n.labels.join(":"),
            MergeBy::Property => match n.properties.get(property.as_deref().unwrap_or_default()) {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(s)) => s.clone(),
                Some(v) => v.to_string(),
            },
        }
    };
    let mut order: Vec<String> = Vec::new();
    let mut members: HashMap<String, Vec<usize>> = HashMap::new();
    let mut group_of: HashMap<&str, String> = HashMap::new();
    for (i, n) in graph.nodes.iter().enumerate() {
        budget.tick()?;
        let key = key_of(n);
        if !members.contains_key(&key) {
            order.push(key.clone());
        }
        members.entry(key.clone()).or_default().push(i);
        group_of.insert(n.id.as_str(), key);
    }
    let id = |key: &str| format!("group:{key}");
    let nodes: Vec<Node> = order
        .iter()
        .map(|key| {
            let list = &members[key];
            let mut properties = BTreeMap::new();
            properties.insert("name".to_string(), json!(key));
            properties.insert("count".to_string(), json!(list.len()));
            apply_aggregates(&mut properties, aggregates, list.len(), |p| {
                list.iter().map(|v| graph.nodes[*v].properties.get(p).cloned()).collect()
            });
            let shown = &list[..list.len().min(MAX_MEMBERS)];
            properties.insert("members".to_string(), json!(shown.iter().map(|v| display(graph, *v)).collect::<Vec<_>>()));
            properties.insert(
                "memberIds".to_string(),
                json!(shown.iter().map(|v| graph.nodes[*v].id.clone()).collect::<Vec<_>>()),
            );
            Node { id: id(key), labels: vec![GROUP_LABEL.to_string()], properties }
        })
        .collect();
    // Edges per (from group, to group, type), in the order they first come.
    let mut edge_order: Vec<(String, String, String)> = Vec::new();
    let mut grouped: HashMap<(String, String, String), Vec<usize>> = HashMap::new();
    for (k, e) in graph.edges.iter().enumerate() {
        budget.tick()?;
        let (Some(a), Some(b)) = (group_of.get(e.from.as_str()), group_of.get(e.to.as_str())) else { continue };
        if a == b && !loops {
            continue;
        }
        let t = if *merge_types { String::new() } else { e.edge_type.clone() };
        let key = (a.clone(), b.clone(), t);
        if !grouped.contains_key(&key) {
            edge_order.push(key.clone());
        }
        grouped.entry(key).or_default().push(k);
    }
    let edges: Vec<Edge> = edge_order
        .iter()
        .map(|key| {
            let list = &grouped[key];
            let mut properties = BTreeMap::new();
            properties.insert("count".to_string(), json!(list.len()));
            apply_aggregates(&mut properties, edge_aggregates, list.len(), |p| {
                list.iter().map(|k| graph.edges[*k].properties.get(p).cloned()).collect()
            });
            let types: BTreeSet<&str> = list.iter().map(|k| graph.edges[*k].edge_type.as_str()).collect();
            let edge_type = if *merge_types { types.into_iter().collect::<Vec<_>>().join("|") } else { key.2.clone() };
            Edge {
                id: format!("group:{}~{}~{}", key.0, key.1, key.2),
                edge_type,
                from: id(&key.0),
                to: id(&key.1),
                properties,
            }
        })
        .collect();
    let largest = order.iter().max_by(|a, b| members[*a].len().cmp(&members[*b].len()).then_with(|| b.cmp(a)));
    let mut values = json!({
        "nodes": graph.nodes.len(), "groups": nodes.len(), "edges": graph.edges.len(), "groupEdges": edges.len()
    });
    if let Some(l) = largest {
        values["largest"] = json!(l);
        values["largestCount"] = json!(members[l].len());
    }
    let out = GraphSet {
        schema: schema_of(&nodes, &edges),
        nodes,
        edges,
        paths: None,
        truncated: graph.truncated.clone(),
        notices: graph.notices.clone(),
        suggested: None,
    };
    Ok((out, summary("analysis.summary.mergeNodes", values)))
}

fn along(kind: &StepKind, graph: &GraphSet, budget: &Budget) -> Result<(GraphSet, StepSummary), Detail> {
    let StepKind::AggregateAlong { label, op, property, depth, name, .. } = kind else { unreachable!() };
    let topo = Topo::of(graph, kind)?;
    let direction = direction_of(kind);
    let depth = depth.unwrap_or(1);
    let takes = |v: usize| label.as_deref().is_none_or(|l| graph.nodes[v].labels.iter().any(|x| x == l));
    let mut result: Vec<Option<Value>> = vec![None; topo.n];
    let mut seen = vec![u32::MAX; topo.n];
    let mut queue = VecDeque::new();
    for s in (0..topo.n).filter(|v| takes(*v)) {
        budget.check()?;
        let mut reached = Vec::new();
        seen.iter_mut().for_each(|d| *d = u32::MAX);
        seen[s] = 0;
        queue.push_back(s);
        while let Some(v) = queue.pop_front() {
            if seen[v] == depth {
                continue;
            }
            for (w, _) in topo.around(v, direction) {
                budget.tick()?;
                if seen[w] == u32::MAX {
                    seen[w] = seen[v] + 1;
                    reached.push(w);
                    queue.push_back(w);
                }
            }
        }
        let values: Vec<Option<&Value>> =
            reached.iter().map(|w| property.as_deref().and_then(|p| graph.nodes[*w].properties.get(p))).collect();
        let op = match op {
            AlongOp::Sum => AggregateOp::Sum,
            AlongOp::Mean => AggregateOp::Mean,
            AlongOp::Count => AggregateOp::Count,
            AlongOp::Min => AggregateOp::Min,
            AlongOp::Max => AggregateOp::Max,
        };
        let v = aggregate(op, &values, reached.len());
        result[s] = (!v.is_null() && !(op == AggregateOp::Count && reached.is_empty())).then_some(v);
    }
    let out = with_node_values(graph, name, |i| if takes(i) { result[i].clone() } else { graph.nodes[i].properties.get(name).cloned() });
    let taken = (0..topo.n).filter(|v| takes(*v)).count();
    let with = result.iter().filter(|v| v.is_some()).count();
    let mut values = json!({ "nodes": with, "of": taken, "name": name });
    let top = (0..topo.n)
        .filter_map(|v| result[v].as_ref().and_then(Value::as_f64).map(|x| (x, v)))
        .max_by(|a, b| a.0.total_cmp(&b.0).then_with(|| b.1.cmp(&a.1)));
    if let Some((x, v)) = top {
        values["max"] = number(x);
        values["top"] = json!(display(graph, v));
    }
    Ok((out, summary("analysis.summary.aggregateAlong", values)))
}
