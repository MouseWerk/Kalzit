//! Structures: core numbers, triangles and the clustering coefficient, bridges, articulation
//! points and cycles. All but cycles read the result as an undirected simple graph (parallel
//! edges once, loops left out); bridges know parallel edges, since two edges between the same
//! nodes are no bridge. Cycles follow the edges' direction (`out`, the default; `in` finds the
//! same cycles) or ignore it (`both`, cycles of three nodes or more); loops are no cycles here.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

use super::{Budget, Topo};
use crate::analysis::Direction;
use crate::datasources::detail::Detail;

/// The core number of every node: the largest k such that it lies in a part of the graph where
/// every node has at least k neighbours.
pub fn cores(topo: &Topo, budget: &Budget) -> Result<Vec<u64>, Detail> {
    let adj = topo.simple(Direction::Both);
    let mut degree: Vec<usize> = adj.iter().map(Vec::len).collect();
    let mut heap: BinaryHeap<Reverse<(usize, usize)>> = (0..topo.n).map(|v| Reverse((degree[v], v))).collect();
    let mut done = vec![false; topo.n];
    let mut core = vec![0u64; topo.n];
    let mut k = 0usize;
    while let Some(Reverse((d, v))) = heap.pop() {
        budget.tick()?;
        if done[v] || d != degree[v] {
            continue;
        }
        k = k.max(d);
        core[v] = k as u64;
        done[v] = true;
        for &u in &adj[v] {
            if !done[u] {
                degree[u] -= 1;
                heap.push(Reverse((degree[u], u)));
            }
        }
    }
    Ok(core)
}

/// Triangles through every node and its local clustering coefficient (the share of pairs of its
/// neighbours that are neighbours themselves; 0 with fewer than two neighbours).
pub fn triangles(topo: &Topo, budget: &Budget) -> Result<(Vec<u64>, Vec<f64>), Detail> {
    let adj = topo.simple(Direction::Both);
    let mut count = vec![0u64; topo.n];
    for v in 0..topo.n {
        for &u in adj[v].iter().filter(|u| **u > v) {
            for &w in adj[u].iter().filter(|w| **w > u) {
                budget.tick()?;
                if adj[v].binary_search(&w).is_ok() {
                    count[v] += 1;
                    count[u] += 1;
                    count[w] += 1;
                }
            }
        }
    }
    let clustering = (0..topo.n)
        .map(|v| {
            let k = adj[v].len() as f64;
            if k < 2.0 { 0.0 } else { 2.0 * count[v] as f64 / (k * (k - 1.0)) }
        })
        .collect();
    Ok((count, clustering))
}

/// Per node its (neighbour, edge) pairs in either direction, loops left out.
fn undirected(topo: &Topo) -> Vec<Vec<(usize, usize)>> {
    let mut adj = vec![Vec::new(); topo.n];
    for (k, &(a, b)) in topo.ends.iter().enumerate() {
        if a != b {
            adj[a].push((b, k));
            adj[b].push((a, k));
        }
    }
    adj
}

/// Depth-first search over the undirected graph: per edge whether it is a bridge, per node
/// whether it is an articulation point.
fn low_links(topo: &Topo, budget: &Budget) -> Result<(Vec<bool>, Vec<bool>), Detail> {
    let adj = undirected(topo);
    let n = topo.n;
    let mut tin = vec![usize::MAX; n];
    let mut low = vec![0; n];
    let mut bridge = vec![false; topo.m()];
    let mut cut = vec![false; n];
    let mut timer = 0;
    for root in 0..n {
        if tin[root] != usize::MAX {
            continue;
        }
        tin[root] = timer;
        low[root] = timer;
        timer += 1;
        let mut children = 0;
        // (node, the edge it was reached by, the next neighbour to look at)
        let mut stack: Vec<(usize, usize, usize)> = vec![(root, usize::MAX, 0)];
        while let Some(&mut (v, via, ref mut i)) = stack.last_mut() {
            budget.tick()?;
            if let Some(&(to, k)) = adj[v].get(*i) {
                *i += 1;
                if k == via {
                    continue;
                }
                if tin[to] != usize::MAX {
                    low[v] = low[v].min(tin[to]);
                } else {
                    tin[to] = timer;
                    low[to] = timer;
                    timer += 1;
                    if v == root {
                        children += 1;
                    }
                    stack.push((to, k, 0));
                }
                continue;
            }
            stack.pop();
            if let Some(&(parent, _, _)) = stack.last() {
                low[parent] = low[parent].min(low[v]);
                if low[v] > tin[parent] {
                    bridge[via] = true;
                }
                if parent != root && low[v] >= tin[parent] {
                    cut[parent] = true;
                }
            }
        }
        if children > 1 {
            cut[root] = true;
        }
    }
    Ok((bridge, cut))
}

pub fn bridges(topo: &Topo, budget: &Budget) -> Result<Vec<bool>, Detail> {
    Ok(low_links(topo, budget)?.0)
}

pub fn articulation(topo: &Topo, budget: &Budget) -> Result<Vec<bool>, Detail> {
    Ok(low_links(topo, budget)?.1)
}

/// Cycles as nodes and edges, each once: it starts at its node that comes first in the result,
/// and an undirected cycle goes towards the smaller of its two neighbours there. At most
/// `max_count` cycles of at most `max_length` edges; `true` when there are more.
#[expect(clippy::type_complexity, reason = "cycles as lists of nodes and edges, and whether more exist")]
pub fn cycles(
    topo: &Topo,
    direction: Direction,
    max_length: u32,
    max_count: u32,
    budget: &Budget,
) -> Result<(Vec<(Vec<usize>, Vec<usize>)>, bool), Detail> {
    let undirected = direction == Direction::Both;
    let adj = topo.simple(if undirected { Direction::Both } else { Direction::Out });
    // The first edge between two nodes, along the direction (either way for `both`).
    let mut edge: HashMap<(usize, usize), usize> = HashMap::new();
    for (k, &(a, b)) in topo.ends.iter().enumerate() {
        edge.entry((a, b)).or_insert(k);
        if undirected {
            edge.entry((b, a)).or_insert(k);
        }
    }
    let max_length = max_length as usize;
    let mut found: Vec<(Vec<usize>, Vec<usize>)> = Vec::new();
    let mut on_path = vec![false; topo.n];
    for s in 0..topo.n {
        let mut path = vec![s];
        on_path[s] = true;
        let mut next = vec![0usize];
        while let Some(i) = next.last_mut() {
            budget.tick()?;
            let v = *path.last().expect("a node per entry");
            let Some(&w) = adj[v].get(*i) else {
                next.pop();
                on_path[v] = false;
                path.pop();
                continue;
            };
            *i += 1;
            if w == s {
                let closes = if undirected { path.len() >= 3 && path[1] < v } else { path.len() >= 2 };
                if closes && path.len() <= max_length {
                    if found.len() == max_count as usize {
                        return Ok((found, true));
                    }
                    let mut edges: Vec<usize> = path.windows(2).map(|p| edge[&(p[0], p[1])]).collect();
                    edges.push(edge[&(v, s)]);
                    found.push((path.clone(), edges));
                }
                continue;
            }
            if w < s || on_path[w] || path.len() >= max_length {
                continue;
            }
            on_path[w] = true;
            path.push(w);
            next.push(0);
        }
    }
    Ok((found, false))
}
