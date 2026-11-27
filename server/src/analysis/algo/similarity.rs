//! Similarity and link prediction, always as the top k. Similarity: per node the `topK` (10) most
//! similar other nodes, by their neighbours over `edgeTypes` in `direction` (`jaccard`: shared over
//! all, `overlap`: shared over the smaller set; either way by default) or by the cosine of the
//! numbers in `properties` (`cosine`, and `knn`, its k nearest neighbours as edges; a missing or
//! non-numeric property counts 0, a node with only zeros is compared with none). Link prediction: the `topK`
//! pairs of nodes without an edge between them by a topological score of the undirected result
//! (`commonNeighbours`, `adamicAdar`: shared neighbours weighted by 1 / ln of their degree,
//! `preferentialAttachment`: the product of the degrees), 50 by default. No trained model takes
//! part. Only
//! nodes with `label` take part when it is given; scores of 0 are no pair, nor are those below
//! `minScore`. Ties go to the node that comes first in the result.

use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap};

use super::{Budget, Topo, direction_of};
use crate::analysis::{Direction, LinkMeasure, SimilarityMeasure, StepKind};
use crate::datasources::detail::Detail;
use crate::shapes::GraphSet;

fn members(graph: &GraphSet, label: Option<&str>) -> Vec<bool> {
    graph.nodes.iter().map(|n| label.is_none_or(|l| n.labels.iter().any(|x| x == l))).collect()
}

fn reverse(d: Direction) -> Direction {
    match d {
        Direction::Out => Direction::In,
        Direction::In => Direction::Out,
        Direction::Both => Direction::Both,
    }
}

/// The best `k` of `scored` (higher score first, then the earlier node), at or above `min`.
fn best(mut scored: Vec<(f64, usize)>, k: usize, min: f64) -> Vec<(f64, usize)> {
    scored.retain(|(s, _)| *s > 0.0 && *s >= min);
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.truncate(k);
    scored
}

pub fn similar(
    graph: &GraphSet,
    topo: &Topo,
    kind: &StepKind,
    budget: &Budget,
) -> Result<Vec<(usize, usize, f64)>, Detail> {
    let StepKind::Similarity { measure, properties, label, min_score, .. } = kind else {
        unreachable!("a similarity step")
    };
    let take = members(graph, label.as_deref());
    let k = super::top_k(kind, &budget.limits()) as usize;
    let min = min_score.unwrap_or(0.0);
    let mut out = Vec::new();
    match measure {
        SimilarityMeasure::Jaccard | SimilarityMeasure::Overlap => {
            let direction = direction_of(kind);
            let next = topo.simple(direction);
            let back = topo.simple(reverse(direction));
            let mut shared: HashMap<usize, usize> = HashMap::new();
            for u in (0..topo.n).filter(|u| take[*u] && !next[*u].is_empty()) {
                shared.clear();
                for &w in &next[u] {
                    for &v in &back[w] {
                        budget.tick()?;
                        if v != u && take[v] {
                            *shared.entry(v).or_default() += 1;
                        }
                    }
                }
                let scored = shared
                    .iter()
                    .map(|(&v, &c)| {
                        let (a, b, c) = (next[u].len() as f64, next[v].len() as f64, c as f64);
                        let s = match measure {
                            SimilarityMeasure::Jaccard => c / (a + b - c),
                            _ => c / a.min(b),
                        };
                        (s, v)
                    })
                    .collect();
                out.extend(best(scored, k, min).into_iter().map(|(s, v)| (u, v, s)));
            }
        }
        SimilarityMeasure::Cosine | SimilarityMeasure::Knn => {
            let vectors: Vec<Option<Vec<f64>>> = graph
                .nodes
                .iter()
                .enumerate()
                .map(|(i, n)| {
                    if !take[i] {
                        return None;
                    }
                    let v: Vec<f64> = properties
                        .iter()
                        .map(|p| n.properties.get(p).and_then(crate::analysis::graph::number_of).unwrap_or(0.0))
                        .collect();
                    let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
                    (norm > 0.0).then(|| v.into_iter().map(|x| x / norm).collect())
                })
                .collect();
            let with: Vec<usize> = (0..topo.n).filter(|i| vectors[*i].is_some()).collect();
            for &u in &with {
                budget.check()?;
                let a = vectors[u].as_ref().expect("filtered");
                let scored = with
                    .iter()
                    .filter(|v| **v != u)
                    .map(|&v| {
                        let b = vectors[v].as_ref().expect("filtered");
                        (a.iter().zip(b).map(|(x, y)| x * y).sum::<f64>(), v)
                    })
                    .collect();
                out.extend(best(scored, k, min).into_iter().map(|(s, v)| (u, v, s)));
            }
        }
    }
    Ok(out)
}

/// A scored pair; the greater is the better (higher score, then the earlier nodes).
#[derive(Clone, Copy, PartialEq)]
struct Pair(f64, usize, usize);
impl Eq for Pair {}
impl PartialOrd for Pair {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Pair {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0).then(other.1.cmp(&self.1)).then(other.2.cmp(&self.2))
    }
}

/// Keeps the best `k` pairs offered.
struct TopK {
    k: usize,
    heap: BinaryHeap<Reverse<Pair>>,
}

impl TopK {
    fn offer(&mut self, p: Pair) {
        if self.heap.len() < self.k {
            self.heap.push(Reverse(p));
        } else if self.heap.peek().is_some_and(|Reverse(worst)| p > *worst) {
            self.heap.pop();
            self.heap.push(Reverse(p));
        }
    }

    fn into_sorted(self) -> Vec<(usize, usize, f64)> {
        let mut all: Vec<Pair> = self.heap.into_iter().map(|Reverse(p)| p).collect();
        all.sort_by(|a, b| b.cmp(a));
        all.into_iter().map(|Pair(s, a, b)| (a, b, s)).collect()
    }
}

pub fn predict(
    graph: &GraphSet,
    topo: &Topo,
    kind: &StepKind,
    budget: &Budget,
) -> Result<Vec<(usize, usize, f64)>, Detail> {
    let StepKind::LinkPrediction { measure, label, min_score, .. } = kind else {
        unreachable!("a link prediction step")
    };
    let take = members(graph, label.as_deref());
    let adj = topo.simple(Direction::Both);
    let linked = |a: usize, b: usize| adj[a].binary_search(&b).is_ok();
    let min = min_score.unwrap_or(0.0);
    let k = super::top_k(kind, &budget.limits()) as usize;
    let mut top = TopK { k, heap: BinaryHeap::new() };
    let keep = |s: f64| s > 0.0 && s >= min;
    match measure {
        LinkMeasure::CommonNeighbours | LinkMeasure::AdamicAdar => {
            let mut score: HashMap<usize, f64> = HashMap::new();
            for u in (0..topo.n).filter(|u| take[*u]) {
                score.clear();
                for &w in &adj[u] {
                    let add = match measure {
                        LinkMeasure::AdamicAdar => 1.0 / (adj[w].len() as f64).ln(),
                        _ => 1.0,
                    };
                    for &v in &adj[w] {
                        budget.tick()?;
                        if v > u && take[v] && !linked(u, v) {
                            *score.entry(v).or_default() += add;
                        }
                    }
                }
                for (&v, &s) in &score {
                    if keep(s) {
                        top.offer(Pair(s, u, v));
                    }
                }
            }
        }
        LinkMeasure::PreferentialAttachment => {
            for pair in preferential(&adj, &take, k, min, budget)?.0 {
                top.offer(pair);
            }
        }
    }
    Ok(top.into_sorted())
}

/// The best `k` pairs without an edge by the product of their degrees (at least `min`), ties to
/// the earlier nodes, and the pairs looked at, which stay within `k + m` and, for ties, `k + degree`
/// per node: never all pairs of a large tie class (a ring, a regular graph).
///
/// First the pairs in falling order of their product, one cursor per node of the degree order,
/// until `k` are found; that gives the k-th score. Every pair above it is in. The pairs with
/// exactly that score are the products of a node's degree with one other degree; per node they
/// form one run of the degree order, sorted by node, so the first few without an edge are that
/// node's best and the rest cannot change the result.
fn preferential(
    adj: &[Vec<usize>],
    take: &[bool],
    k: usize,
    min: f64,
    budget: &Budget,
) -> Result<(Vec<Pair>, usize), Detail> {
    let linked = |a: usize, b: usize| adj[a].binary_search(&b).is_ok();
    let keep = |s: f64| s > 0.0 && s >= min;
    let mut order: Vec<usize> = (0..adj.len()).filter(|v| take[*v] && !adj[*v].is_empty()).collect();
    order.sort_by(|a, b| adj[*b].len().cmp(&adj[*a].len()).then(a.cmp(b)));
    let degree = |i: usize| adj[order[i]].len() as f64;
    let node_pair = |i: usize, j: usize| (order[i].min(order[j]), order[i].max(order[j]));
    let mut looked = 0usize;
    // Per row i the cursor j > i; a row joins once the one before it was first taken from.
    let mut rows: BinaryHeap<(Ordered, Reverse<usize>, Reverse<usize>)> = BinaryHeap::new();
    if order.len() >= 2 {
        rows.push((Ordered(degree(0) * degree(1)), Reverse(0), Reverse(1)));
    }
    let mut above: Vec<Pair> = Vec::new();
    let mut kth: Option<f64> = None;
    let mut found = 0usize;
    while let Some((Ordered(s), Reverse(i), Reverse(j))) = rows.pop() {
        budget.tick()?;
        looked += 1;
        if !keep(s) || kth.is_some_and(|t| s < t) {
            break;
        }
        if j == i + 1 && i + 2 < order.len() {
            rows.push((Ordered(degree(i + 1) * degree(i + 2)), Reverse(i + 1), Reverse(i + 2)));
        }
        if j + 1 < order.len() {
            rows.push((Ordered(degree(i) * degree(j + 1)), Reverse(i), Reverse(j + 1)));
        }
        let (a, b) = node_pair(i, j);
        if linked(a, b) {
            continue;
        }
        found += 1;
        if kth.is_none() {
            above.push(Pair(s, a, b));
        }
        if found == k && kth.is_none() {
            kth = Some(s);
        }
        if kth.is_some() {
            break;
        }
    }
    let Some(t) = kth else { return Ok((above, looked)) };
    // The k-th score's ties: keep those above it, then the best of the tied pairs by node.
    let mut result: Vec<Pair> = above.into_iter().filter(|p| p.0 > t).collect();
    let need = k - result.len();
    let mut tied = TopK { k: need, heap: BinaryHeap::new() };
    let degrees: Vec<usize> = order.iter().map(|v| adj[*v].len()).collect();
    for i in 0..order.len() {
        let di = degrees[i];
        if t % di as f64 != 0.0 {
            continue;
        }
        let want = (t / di as f64) as usize;
        // The run of the degree order with that degree (degrees fall along the order).
        let from = degrees.partition_point(|d| *d > want).max(i + 1);
        let to = degrees.partition_point(|d| *d >= want);
        let mut taken = 0;
        for j in from..to {
            budget.tick()?;
            looked += 1;
            let (a, b) = node_pair(i, j);
            if linked(a, b) {
                continue;
            }
            tied.offer(Pair(t, a, b));
            taken += 1;
            if taken == need {
                break;
            }
        }
    }
    result.extend(tied.heap.into_iter().map(|Reverse(p)| p));
    Ok((result, looked))
}

/// A score that orders by `total_cmp`.
#[derive(Clone, Copy, PartialEq)]
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::steps::Control;

    /// Brute force: every pair without an edge, best first, ties to the earlier nodes.
    fn every_pair(adj: &[Vec<usize>], k: usize) -> Vec<(usize, usize, f64)> {
        let mut top = TopK { k, heap: BinaryHeap::new() };
        for a in 0..adj.len() {
            for b in a + 1..adj.len() {
                let s = (adj[a].len() * adj[b].len()) as f64;
                if s > 0.0 && adj[a].binary_search(&b).is_err() {
                    top.offer(Pair(s, a, b));
                }
            }
        }
        top.into_sorted()
    }

    fn sorted(pairs: Vec<Pair>, k: usize) -> Vec<(usize, usize, f64)> {
        let mut top = TopK { k, heap: BinaryHeap::new() };
        pairs.into_iter().for_each(|p| top.offer(p));
        top.into_sorted()
    }

    fn ring(n: usize, extra: &[(usize, usize)]) -> Vec<Vec<usize>> {
        let mut adj = vec![Vec::new(); n];
        for (v, list) in adj.iter_mut().enumerate() {
            list.extend([(v + 1) % n, (v + n - 1) % n]);
        }
        for &(a, b) in extra {
            adj[a].push(b);
            adj[b].push(a);
        }
        for l in &mut adj {
            l.sort_unstable();
            l.dedup();
        }
        adj
    }

    /// The same pairs as looking at all of them, on graphs with ties across degrees.
    #[test]
    fn preferential_attachment_matches_brute_force() {
        let control = Control::unbounded();
        let budget = Budget::new(&control);
        for (n, extra) in
            [(12, vec![(0, 6), (0, 3), (2, 9), (4, 10), (4, 7)]), (9, vec![(1, 5), (1, 7), (3, 7)]), (7, vec![])]
        {
            let adj = ring(n, &extra);
            let take = vec![true; n];
            for k in [1, 2, 3, 5, 8, 40] {
                let (got, _) = preferential(&adj, &take, k, 0.0, &budget).unwrap();
                assert_eq!(sorted(got, k), every_pair(&adj, k), "n {n}, k {k}");
            }
        }
    }

    /// A large ring: every pair ties, yet only a few pairs per node are looked at and little is
    /// kept, so the step stays small in time and memory.
    #[test]
    fn preferential_attachment_on_a_large_tie_stays_bounded() {
        let control = Control::unbounded();
        let budget = Budget::new(&control);
        let n = 100_000;
        let adj = ring(n, &[]);
        let take = vec![true; n];
        let k = 50;
        let (got, looked) = preferential(&adj, &take, k, 0.0, &budget).unwrap();
        let got = sorted(got, k);
        assert_eq!(got.len(), k);
        assert_eq!((got[0].0, got[0].1), (0, 2), "ties to the earlier nodes");
        assert_eq!((got[k - 1].0, got[k - 1].1), (0, 51));
        // Before: about n * n / 2 pairs; now k + m first, then at most k + 2 per node.
        assert!(looked <= k + 2 * n + n * (k + 3), "looked at {looked}");
    }
}
