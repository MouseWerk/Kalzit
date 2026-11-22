//! Centrality: how important each node is by the importance of its neighbours (`pageRank`,
//! `eigenvector`, both by an edge `weight` when given) or by its place on shortest paths
//! (`betweenness`, `closeness`, `harmonic`). `direction` says which edges lead from a node: `out`
//! along them, `in` against them, `both` (the default) either way. Paths count parallel edges once.
//! The degree is the step `degree` (`graph.rs`).

use std::collections::VecDeque;

use super::{Budget, Topo};
use crate::analysis::{CentralityMeasure, Direction};
use crate::datasources::detail::Detail;

pub const PAGE_RANK_DAMPING: f64 = 0.85;
pub const PAGE_RANK_ITERATIONS: u32 = 100;
pub const PAGE_RANK_TOLERANCE: f64 = 1e-7;
pub const EIGENVECTOR_ITERATIONS: u32 = 100;
pub const EIGENVECTOR_TOLERANCE: f64 = 1e-6;

pub fn run(
    topo: &Topo,
    measure: CentralityMeasure,
    direction: Direction,
    damping: Option<f64>,
    max_iterations: Option<u32>,
    tolerance: Option<f64>,
    budget: &Budget,
) -> Result<Vec<f64>, Detail> {
    match measure {
        CentralityMeasure::PageRank => page_rank(
            topo,
            direction,
            damping.unwrap_or(PAGE_RANK_DAMPING),
            max_iterations.unwrap_or(PAGE_RANK_ITERATIONS),
            tolerance.unwrap_or(PAGE_RANK_TOLERANCE),
            budget,
        ),
        CentralityMeasure::Eigenvector => eigenvector(
            topo,
            direction,
            max_iterations.unwrap_or(EIGENVECTOR_ITERATIONS),
            tolerance.unwrap_or(EIGENVECTOR_TOLERANCE),
            budget,
        ),
        CentralityMeasure::Betweenness => betweenness(topo, direction, budget),
        CentralityMeasure::Closeness => distances(topo, direction, budget, |reached, sum, _, _| {
            if sum > 0.0 { reached as f64 / sum } else { 0.0 }
        }),
        CentralityMeasure::Harmonic => distances(topo, direction, budget, |_, _, inverse, n| {
            if n > 1 { inverse / (n - 1) as f64 } else { 0.0 }
        }),
    }
}

/// PageRank as shares that sum to 1: every node keeps `1 - damping` spread evenly and passes the
/// rest on along its edges in `direction`, in proportion to their weight; a node without such
/// edges (or only of weight 0) passes it to all nodes.
/// Stops after `max_iterations` or when no score changes by more than `tolerance`.
fn page_rank(
    topo: &Topo,
    direction: Direction,
    damping: f64,
    max_iterations: u32,
    tolerance: f64,
    budget: &Budget,
) -> Result<Vec<f64>, Detail> {
    let n = topo.n;
    if n == 0 {
        return Ok(Vec::new());
    }
    let degree: Vec<f64> = (0..n).map(|v| topo.around(v, direction).map(|(_, k)| topo.weight[k]).sum()).collect();
    let mut rank = vec![1.0 / n as f64; n];
    for _ in 0..max_iterations {
        budget.check()?;
        let dangling: f64 = (0..n).filter(|v| degree[*v] <= 0.0).map(|v| rank[v]).sum();
        let base = (1.0 - damping) / n as f64 + damping * dangling / n as f64;
        let mut next = vec![base; n];
        for v in 0..n {
            if degree[v] <= 0.0 {
                continue;
            }
            let share = damping * rank[v] / degree[v];
            for (u, k) in topo.around(v, direction) {
                budget.tick()?;
                next[u] += share * topo.weight[k];
            }
        }
        let change = rank.iter().zip(&next).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
        rank = next;
        if change < tolerance {
            break;
        }
    }
    Ok(rank)
}

/// The principal eigenvector of the (weighted) adjacency in `direction` (a node scores the sum of
/// the nodes whose edges lead to it), by power iteration on the adjacency plus the identity, which has the
/// same eigenvectors and always converges; scaled to length 1.
fn eigenvector(
    topo: &Topo,
    direction: Direction,
    max_iterations: u32,
    tolerance: f64,
    budget: &Budget,
) -> Result<Vec<f64>, Detail> {
    let n = topo.n;
    if n == 0 {
        return Ok(Vec::new());
    }
    let mut x = vec![1.0 / (n as f64).sqrt(); n];
    for _ in 0..max_iterations {
        budget.check()?;
        let mut next = x.clone();
        for (v, xv) in x.iter().enumerate() {
            for (u, k) in topo.around(v, direction) {
                budget.tick()?;
                next[u] += xv * topo.weight[k];
            }
        }
        let norm = next.iter().map(|a| a * a).sum::<f64>().sqrt();
        if norm > 0.0 {
            for a in &mut next {
                *a /= norm;
            }
        }
        let change = x.iter().zip(&next).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
        x = next;
        if change < tolerance {
            break;
        }
    }
    Ok(x)
}

/// Brandes' betweenness: how many shortest paths between other nodes run through each node.
/// With `both`, each pair counts once (its two directions are halved).
fn betweenness(topo: &Topo, direction: Direction, budget: &Budget) -> Result<Vec<f64>, Detail> {
    let n = topo.n;
    let next = topo.simple(direction);
    let mut score = vec![0.0; n];
    let mut sigma = vec![0.0f64; n];
    let mut dist = vec![-1i64; n];
    let mut delta = vec![0.0f64; n];
    let mut preds: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut order = Vec::with_capacity(n);
    let mut queue = VecDeque::new();
    for s in 0..n {
        budget.check()?;
        for v in 0..n {
            sigma[v] = 0.0;
            dist[v] = -1;
            delta[v] = 0.0;
            preds[v].clear();
        }
        order.clear();
        sigma[s] = 1.0;
        dist[s] = 0;
        queue.push_back(s);
        while let Some(v) = queue.pop_front() {
            order.push(v);
            for &w in &next[v] {
                budget.tick()?;
                if dist[w] < 0 {
                    dist[w] = dist[v] + 1;
                    queue.push_back(w);
                }
                if dist[w] == dist[v] + 1 {
                    sigma[w] += sigma[v];
                    preds[w].push(v);
                }
            }
        }
        while let Some(w) = order.pop() {
            for &v in &preds[w] {
                delta[v] += sigma[v] / sigma[w] * (1.0 + delta[w]);
            }
            if w != s {
                score[w] += delta[w];
            }
        }
    }
    if direction == Direction::Both {
        for s in &mut score {
            *s /= 2.0;
        }
    }
    Ok(score)
}

/// Per node, the score `f(reached, sum of distances, sum of inverse distances, nodes)` from a
/// breadth-first search over the nodes it reaches.
fn distances(
    topo: &Topo,
    direction: Direction,
    budget: &Budget,
    f: impl Fn(usize, f64, f64, usize) -> f64,
) -> Result<Vec<f64>, Detail> {
    let n = topo.n;
    let next = topo.simple(direction);
    let mut dist = vec![u32::MAX; n];
    let mut queue = VecDeque::new();
    let mut out = Vec::with_capacity(n);
    for s in 0..n {
        budget.check()?;
        dist.iter_mut().for_each(|d| *d = u32::MAX);
        dist[s] = 0;
        queue.push_back(s);
        let (mut reached, mut sum, mut inverse) = (0usize, 0.0, 0.0);
        while let Some(v) = queue.pop_front() {
            if v != s {
                reached += 1;
                sum += f64::from(dist[v]);
                inverse += 1.0 / f64::from(dist[v]);
            }
            for &w in &next[v] {
                budget.tick()?;
                if dist[w] == u32::MAX {
                    dist[w] = dist[v] + 1;
                    queue.push_back(w);
                }
            }
        }
        out.push(f(reached, sum, inverse, n));
    }
    Ok(out)
}
