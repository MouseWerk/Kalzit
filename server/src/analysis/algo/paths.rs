//! Paths between two nodes of the result and the nodes within reach of some. `direction` says
//! which edges a path may take: `out` along them, `in` against them, `both` (the default) either
//! way. Without `weight` every edge counts 1; a weight property must be a number of 0 or more
//! where it is set, and counts 1 where it is not. Ties go to the edge and node that come first in
//! the result, so the server finds the same path every time; a library may find another path of
//! the same length.

use std::cmp::{Ordering, Reverse};
use std::collections::{BTreeSet, BinaryHeap, VecDeque};

use serde_json::json;

use super::{Bounds, Budget, Outcome, Topo, direction_of, node_place, notice, number, path_of, summary, with_node_values};
use crate::analysis::{Direction, PathMode, StepKind};
use crate::datasources::detail::Detail;
use crate::shapes::{GraphSet, StepSummary};

/// How many paths `allShortest` gives when the step does not say.
pub const ALL_PATHS: u32 = 100;

pub fn run(graph: &GraphSet, topo: &Topo, kind: &StepKind, bounds: &Bounds, budget: &Budget) -> Result<Outcome, Detail> {
    let StepKind::Paths { mode, from, to, .. } = kind else { unreachable!("a paths step") };
    let (s, t) = (node_place(graph, from)?, node_place(graph, to)?);
    let direction = direction_of(kind);
    let max = bounds.max_length as usize;
    let fits = |p: &(Vec<usize>, Vec<usize>)| p.1.len() <= max;
    Ok(match mode {
        PathMode::Shortest => {
            let parent = bfs(topo, s, direction, budget)?;
            Outcome::Paths { paths: back(&parent, s, t).into_iter().filter(fits).collect(), total: None }
        }
        PathMode::Weighted => {
            let found = dijkstra(topo, s, t, direction, &[], &[], budget)?;
            Outcome::Paths { paths: found.into_iter().filter(fits).collect(), total: None }
        }
        PathMode::AllShortest => all_shortest(topo, s, t, direction, bounds.max_count as usize, max, budget)?,
        PathMode::KShortest => {
            let found = yen(topo, s, t, direction, bounds.max_count as usize, max, budget)?;
            Outcome::Paths { paths: found, total: None }
        }
    })
}

/// Breadth-first search: the edge each node was first reached by.
fn bfs(topo: &Topo, s: usize, direction: Direction, budget: &Budget) -> Result<Vec<Option<(usize, usize)>>, Detail> {
    let mut parent: Vec<Option<(usize, usize)>> = vec![None; topo.n];
    let mut seen = vec![false; topo.n];
    seen[s] = true;
    let mut queue = VecDeque::from([s]);
    while let Some(v) = queue.pop_front() {
        for (w, k) in topo.around(v, direction) {
            budget.tick()?;
            if !seen[w] {
                seen[w] = true;
                parent[w] = Some((v, k));
                queue.push_back(w);
            }
        }
    }
    Ok(parent)
}

/// The path to `t` along `parent`, if `t` was reached.
fn back(parent: &[Option<(usize, usize)>], s: usize, t: usize) -> Option<(Vec<usize>, Vec<usize>)> {
    let (mut nodes, mut edges) = (vec![t], Vec::new());
    let mut v = t;
    while v != s {
        let (p, k) = parent[v]?;
        nodes.push(p);
        edges.push(k);
        v = p;
    }
    nodes.reverse();
    edges.reverse();
    Some((nodes, edges))
}

/// Dijkstra from `s` to `t`, without the nodes and edges `banned`: the path with the least total
/// weight (ties: fewer edges, then the earlier node).
fn dijkstra(
    topo: &Topo,
    s: usize,
    t: usize,
    direction: Direction,
    banned_nodes: &[usize],
    banned_edges: &[usize],
    budget: &Budget,
) -> Result<Option<(Vec<usize>, Vec<usize>)>, Detail> {
    #[derive(PartialEq)]
    struct Item(f64, usize, usize);
    impl Eq for Item {}
    impl PartialOrd for Item {
        fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
            Some(self.cmp(other))
        }
    }
    impl Ord for Item {
        fn cmp(&self, other: &Self) -> Ordering {
            self.0.total_cmp(&other.0).then(self.1.cmp(&other.1)).then(self.2.cmp(&other.2))
        }
    }
    let mut dist = vec![(f64::INFINITY, usize::MAX); topo.n];
    let mut parent: Vec<Option<(usize, usize)>> = vec![None; topo.n];
    let mut done = vec![false; topo.n];
    for v in banned_nodes {
        done[*v] = true;
    }
    dist[s] = (0.0, 0);
    let mut heap = BinaryHeap::from([Reverse(Item(0.0, 0, s))]);
    while let Some(Reverse(Item(d, hops, v))) = heap.pop() {
        if done[v] {
            continue;
        }
        done[v] = true;
        if v == t {
            break;
        }
        for (w, k) in topo.around(v, direction) {
            budget.tick()?;
            if done[w] || banned_edges.contains(&k) {
                continue;
            }
            let candidate = (d + topo.weight[k], hops + 1);
            if candidate.0 < dist[w].0 || (candidate.0 == dist[w].0 && candidate.1 < dist[w].1) {
                dist[w] = candidate;
                parent[w] = Some((v, k));
                heap.push(Reverse(Item(candidate.0, candidate.1, w)));
            }
        }
    }
    if dist[t].0.is_infinite() {
        return Ok(None);
    }
    Ok(back(&parent, s, t))
}

fn cost(topo: &Topo, edges: &[usize]) -> f64 {
    edges.iter().map(|k| topo.weight[*k]).sum()
}

/// Every shortest path (fewest edges) from `s` to `t`, at most `max`; with their number when
/// there are more.
fn all_shortest(
    topo: &Topo,
    s: usize,
    t: usize,
    direction: Direction,
    max: usize,
    max_length: usize,
    budget: &Budget,
) -> Result<Outcome, Detail> {
    let mut dist = vec![u32::MAX; topo.n];
    let mut count = vec![0u64; topo.n];
    let mut preds: Vec<Vec<(usize, usize)>> = vec![Vec::new(); topo.n];
    dist[s] = 0;
    count[s] = 1;
    let mut queue = VecDeque::from([s]);
    while let Some(v) = queue.pop_front() {
        if dist[t] != u32::MAX && dist[v] >= dist[t] {
            continue;
        }
        for (w, k) in topo.around(v, direction) {
            budget.tick()?;
            if dist[w] == u32::MAX {
                dist[w] = dist[v] + 1;
                queue.push_back(w);
            }
            if dist[w] == dist[v] + 1 {
                count[w] = count[w].saturating_add(count[v]);
                preds[w].push((v, k));
            }
        }
    }
    if dist[t] == u32::MAX || dist[t] as usize > max_length {
        return Ok(Outcome::Paths { paths: Vec::new(), total: None });
    }
    // Backwards from t, the predecessors in the order they were found.
    let mut paths = Vec::new();
    let mut stack: Vec<(usize, usize)> = vec![(t, 0)];
    let mut edges: Vec<usize> = Vec::new();
    while let Some(&mut (v, ref mut i)) = stack.last_mut() {
        budget.tick()?;
        if v == s {
            let mut nodes: Vec<usize> = stack.iter().map(|(v, _)| *v).collect();
            nodes.reverse();
            let mut e = edges.clone();
            e.reverse();
            paths.push((nodes, e));
            if paths.len() == max {
                break;
            }
            stack.pop();
            edges.pop();
            continue;
        }
        match preds[v].get(*i) {
            Some(&(p, k)) => {
                *i += 1;
                stack.push((p, 0));
                edges.push(k);
            }
            None => {
                stack.pop();
                edges.pop();
            }
        }
    }
    let total = (count[t] > paths.len() as u64).then_some(count[t]);
    Ok(Outcome::Paths { paths, total })
}

/// Yen's `k` shortest paths without repeated nodes and of at most `max_length` edges, by total weight (ties: fewer edges, then
/// the nodes in the order of the result).
fn yen(
    topo: &Topo,
    s: usize,
    t: usize,
    direction: Direction,
    k: usize,
    max_length: usize,
    budget: &Budget,
) -> Result<Vec<(Vec<usize>, Vec<usize>)>, Detail> {
    let Some(first) = dijkstra(topo, s, t, direction, &[], &[], budget)? else { return Ok(Vec::new()) };
    let mut found = vec![first];
    let key = |p: &(Vec<usize>, Vec<usize>)| (ordered(cost(topo, &p.1)), p.1.len(), p.0.clone(), p.1.clone());
    let mut candidates: BTreeSet<(Ordered, usize, Vec<usize>, Vec<usize>)> = BTreeSet::new();
    while found.len() < k {
        budget.check()?;
        let last = found.last().expect("one path at least").clone();
        for i in 0..last.0.len() - 1 {
            let spur = last.0[i];
            let root_nodes = &last.0[..=i];
            let root_edges = &last.1[..i];
            let banned_edges: Vec<usize> =
                found.iter().filter(|p| p.0.len() > i + 1 && p.0[..=i] == *root_nodes && p.1[..i] == *root_edges).map(|p| p.1[i]).collect();
            let banned_nodes: Vec<usize> = root_nodes[..i].to_vec();
            if let Some((nodes, edges)) = dijkstra(topo, spur, t, direction, &banned_nodes, &banned_edges, budget)? {
                let mut all_nodes = root_nodes[..i].to_vec();
                all_nodes.extend(nodes);
                let mut all_edges = root_edges.to_vec();
                all_edges.extend(edges);
                let path = (all_nodes, all_edges);
                if !found.contains(&path) && path.1.len() <= max_length {
                    candidates.insert(key(&path));
                }
            }
        }
        let Some(best) = candidates.pop_first() else { break };
        found.push((best.2, best.3));
    }
    found.retain(|p| p.1.len() <= max_length);
    Ok(found)
}

/// A float that orders (no NaN reaches it: weights are checked numbers).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Ordered(f64);
impl Eq for Ordered {}
impl PartialOrd for Ordered {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Ordered {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0)
    }
}
fn ordered(x: f64) -> Ordered {
    Ordered(x)
}

/// The distance in edges of every node within `max_hops` of one of `starts` (those 0).
pub fn reachable(
    topo: &Topo,
    starts: &[usize],
    max_hops: u32,
    direction: Direction,
    budget: &Budget,
) -> Result<Vec<Option<u32>>, Detail> {
    let mut dist: Vec<Option<u32>> = vec![None; topo.n];
    let mut queue = VecDeque::new();
    for s in starts {
        if dist[*s].is_none() {
            dist[*s] = Some(0);
            queue.push_back(*s);
        }
    }
    while let Some(v) = queue.pop_front() {
        let d = dist[v].expect("queued nodes have a distance");
        if d == max_hops {
            continue;
        }
        for (w, _) in topo.around(v, direction) {
            budget.tick()?;
            if dist[w].is_none() {
                dist[w] = Some(d + 1);
                queue.push_back(w);
            }
        }
    }
    Ok(dist)
}

/// The edges along `nodes` in `direction`: between each two the lightest edge, then the one that
/// comes first in the result; `None` when two of them have no edge between them. For paths a
/// library answers as nodes only.
pub fn edges_along(topo: &Topo, nodes: &[usize], direction: Direction) -> Option<Vec<usize>> {
    nodes
        .windows(2)
        .map(|p| {
            topo.around(p[0], direction)
                .filter(|(w, _)| *w == p[1])
                .map(|(_, k)| k)
                .min_by(|a, b| topo.weight[*a].total_cmp(&topo.weight[*b]).then(a.cmp(b)))
        })
        .collect()
}

/// The graph of the paths found (all of it with `keep_all`), the nodes on them with their place
/// along them, in edges from the start, as the property `name` (the least where a node lies on
/// several), and the summary.
pub fn finish(
    graph: &GraphSet,
    topo: &Topo,
    name: &str,
    keep_all: bool,
    paths: Vec<(Vec<usize>, Vec<usize>)>,
    total: Option<u64>,
) -> (GraphSet, StepSummary) {
    let mut order: Vec<Option<usize>> = vec![None; graph.nodes.len()];
    let mut on_path = vec![false; topo.m()];
    for (nodes, edges) in &paths {
        for (i, v) in nodes.iter().enumerate() {
            order[*v] = Some(order[*v].map_or(i, |old| old.min(i)));
        }
        for k in edges {
            on_path[*k] = true;
        }
    }
    let marked = with_node_values(graph, name, |i| order[i].map(|o| json!(o)));
    let listed: Vec<_> = paths.iter().map(|(n, e)| path_of(graph, topo, n, e)).collect();
    let mut out = if keep_all {
        GraphSet { paths: Some(listed), ..marked }
    } else {
        let nodes: Vec<_> =
            marked.nodes.iter().enumerate().filter(|(i, _)| order[*i].is_some()).map(|(_, n)| n.clone()).collect();
        let edges: Vec<_> =
            (0..topo.m()).filter(|k| on_path[*k]).map(|k| marked.edges[topo.edge_at[k]].clone()).collect();
        GraphSet {
            schema: crate::analysis::graph::schema_of(&nodes, &edges),
            nodes,
            edges,
            paths: Some(listed),
            truncated: marked.truncated.clone(),
            notices: marked.notices.clone(),
            suggested: None,
        }
    };
    if let Some(total) = total {
        out.notices.get_or_insert_with(Vec::new).push(notice(
            "analysis.paths_cut",
            &[("shown", paths.len().to_string()), ("total", total.to_string())],
            format!("{} of {total} shortest paths are shown", paths.len()),
        ));
    }
    let s = match paths.first() {
        None => summary("analysis.summary.noPath", json!({})),
        Some((_, edges)) => {
            let mut values = json!({ "paths": paths.len(), "edges": edges.len(), "cost": number(cost(topo, edges)) });
            if let Some(total) = total {
                values["total"] = json!(total);
            }
            summary("analysis.summary.paths", values)
        }
    };
    (out, s)
}
