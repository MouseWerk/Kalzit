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
use std::collections::{BinaryHeap, HashMap, HashSet};

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

pub fn similar(graph: &GraphSet, topo: &Topo, kind: &StepKind, budget: &Budget) -> Result<Vec<(usize, usize, f64)>, Detail> {
    let StepKind::Similarity { measure, top_k, properties, label, min_score, .. } = kind else {
        unreachable!("a similarity step")
    };
    let take = members(graph, label.as_deref());
    let k = top_k.unwrap_or(super::DEFAULT_SIMILAR) as usize;
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

pub fn predict(graph: &GraphSet, topo: &Topo, kind: &StepKind, budget: &Budget) -> Result<Vec<(usize, usize, f64)>, Detail> {
    let StepKind::LinkPrediction { measure, top_k, label, min_score, .. } = kind else {
        unreachable!("a link prediction step")
    };
    let take = members(graph, label.as_deref());
    let adj = topo.simple(Direction::Both);
    let linked = |a: usize, b: usize| adj[a].binary_search(&b).is_ok();
    let min = min_score.unwrap_or(0.0);
    let k = top_k.unwrap_or(super::DEFAULT_SUGGESTIONS) as usize;
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
            // The pairs in falling order of their product, from the nodes sorted by degree: the
            // first k without an edge are the best.
            let mut order: Vec<usize> = (0..topo.n).filter(|v| take[*v] && !adj[*v].is_empty()).collect();
            order.sort_by(|a, b| adj[*b].len().cmp(&adj[*a].len()).then(a.cmp(b)));
            let degree = |i: usize| adj[order[i]].len() as f64;
            let mut frontier: BinaryHeap<Pair> = BinaryHeap::new();
            let mut seen: HashSet<(usize, usize)> = HashSet::new();
            if order.len() >= 2 {
                frontier.push(Pair(degree(0) * degree(1), 0, 1));
            }
            // Past the k-th pair, those with the same score still come in, so ties go to the
            // earlier nodes as everywhere.
            let mut accepted = 0;
            let mut kth = f64::INFINITY;
            while let Some(Pair(s, i, j)) = frontier.pop() {
                budget.tick()?;
                if (accepted >= k && s < kth) || !keep(s) {
                    break;
                }
                let (a, b) = (order[i].min(order[j]), order[i].max(order[j]));
                if !linked(a, b) {
                    top.offer(Pair(s, a, b));
                    accepted += 1;
                    if accepted == k {
                        kth = s;
                    }
                }
                for (x, y) in [(i, j + 1), (i + 1, i + 2)] {
                    if y < order.len() && (y == j + 1 && x == i || j == i + 1) && seen.insert((x, y)) {
                        frontier.push(Pair(degree(x) * degree(y), x, y));
                    }
                }
            }
        }
    }
    Ok(top.into_sorted())
}
