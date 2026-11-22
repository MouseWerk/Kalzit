//! Communities and components. Louvain and Leiden maximise modularity (with `resolution`, 1 when
//! absent) on the result as an undirected graph, label propagation lets each node take the most
//! common community of its neighbours; all three run in a fixed order, so the server answers the
//! same communities every time (a library may number or split them differently, see
//! `conformance.json`). Weakly connected components ignore the edges' direction, strongly
//! connected ones follow it.

use std::collections::{BTreeMap, HashMap};

use super::{Budget, Topo};
use crate::analysis::CommunityAlgorithm;
use crate::datasources::detail::Detail;

pub const LEVELS: u32 = 10;
pub const LABEL_ITERATIONS: u32 = 10;
/// Gains below this count as none, so rounding does not move nodes back and forth.
const EPSILON: f64 = 1e-12;

pub fn run(
    topo: &Topo,
    algorithm: CommunityAlgorithm,
    max_iterations: Option<u32>,
    resolution: f64,
    budget: &Budget,
) -> Result<Vec<usize>, Detail> {
    match algorithm {
        CommunityAlgorithm::Louvain => {
            modularity_communities(topo, resolution, max_iterations.unwrap_or(LEVELS), false, budget)
        }
        CommunityAlgorithm::Leiden => {
            modularity_communities(topo, resolution, max_iterations.unwrap_or(LEVELS), true, budget)
        }
        CommunityAlgorithm::LabelPropagation => {
            label_propagation(topo, max_iterations.unwrap_or(LABEL_ITERATIONS), budget)
        }
        CommunityAlgorithm::WeaklyConnected => Ok(weakly_connected(topo)),
        CommunityAlgorithm::StronglyConnected => strongly_connected(topo, budget),
    }
}

/// An undirected weighted graph: merged neighbours (without the node itself), the weight of its
/// loops counted at both ends (`loops`), the weighted degrees and their sum.
struct Net {
    adj: Vec<Vec<(usize, f64)>>,
    loops: Vec<f64>,
    k: Vec<f64>,
    m2: f64,
}

impl Net {
    fn of(topo: &Topo) -> Self {
        let mut maps: Vec<BTreeMap<usize, f64>> = vec![BTreeMap::new(); topo.n];
        let mut loops = vec![0.0; topo.n];
        for (k, &(a, b)) in topo.ends.iter().enumerate() {
            let w = topo.weight[k];
            if a == b {
                loops[a] += 2.0 * w;
            } else {
                *maps[a].entry(b).or_default() += w;
                *maps[b].entry(a).or_default() += w;
            }
        }
        Self::from_maps(maps, loops)
    }

    fn from_maps(maps: Vec<BTreeMap<usize, f64>>, loops: Vec<f64>) -> Self {
        let adj: Vec<Vec<(usize, f64)>> = maps.into_iter().map(|m| m.into_iter().collect()).collect();
        let k: Vec<f64> = adj.iter().zip(&loops).map(|(a, l)| a.iter().map(|(_, w)| w).sum::<f64>() + l).collect();
        let m2 = k.iter().sum();
        Self { adj, loops, k, m2 }
    }

    fn n(&self) -> usize {
        self.adj.len()
    }

    /// The graph of the communities of `p` (numbered from 0): their edges summed, the edges
    /// inside a community its loop.
    fn aggregate(&self, p: &[usize]) -> Self {
        let count = p.iter().max().map_or(0, |c| c + 1);
        let mut maps: Vec<BTreeMap<usize, f64>> = vec![BTreeMap::new(); count];
        let mut loops = vec![0.0; count];
        for v in 0..self.n() {
            loops[p[v]] += self.loops[v];
            for &(u, w) in &self.adj[v] {
                if p[u] == p[v] {
                    loops[p[v]] += w;
                } else {
                    *maps[p[v]].entry(p[u]).or_default() += w;
                }
            }
        }
        Self::from_maps(maps, loops)
    }
}

/// Numbers from 0 in the order of first appearance.
fn compact(p: &[usize]) -> Vec<usize> {
    super::canonical(p)
}

/// Moves single nodes to the neighbouring community with the largest gain of modularity until no
/// move gains; answers whether any node moved.
fn local_moving(net: &Net, p: &mut [usize], gamma: f64, budget: &Budget) -> Result<bool, Detail> {
    if net.m2 == 0.0 {
        return Ok(false);
    }
    let n = net.n();
    let size = p.iter().max().map_or(0, |c| c + 1).max(n);
    let mut tot = vec![0.0; size];
    for v in 0..n {
        tot[p[v]] += net.k[v];
    }
    let mut moved_any = false;
    let mut weights: HashMap<usize, f64> = HashMap::new();
    let mut order: Vec<usize> = Vec::new();
    loop {
        budget.check()?;
        let mut moved = false;
        for v in 0..n {
            budget.tick()?;
            let own = p[v];
            tot[own] -= net.k[v];
            weights.clear();
            order.clear();
            for &(u, w) in &net.adj[v] {
                let c = p[u];
                if !weights.contains_key(&c) {
                    order.push(c);
                }
                *weights.entry(c).or_default() += w;
            }
            let gain = |c: usize, w: f64| w - gamma * tot[c] * net.k[v] / net.m2;
            let mut best = own;
            let mut best_gain = gain(own, weights.get(&own).copied().unwrap_or(0.0));
            for &c in &order {
                let g = gain(c, weights[&c]);
                if g > best_gain + EPSILON {
                    best = c;
                    best_gain = g;
                }
            }
            tot[best] += net.k[v];
            if best != own {
                p[v] = best;
                moved = true;
                moved_any = true;
            }
        }
        if !moved {
            return Ok(moved_any);
        }
    }
}

/// Leiden's refinement, greedy: within each community of `p`, nodes still alone join the
/// well-connected part of their community that gains most, so every part stays connected.
fn refine(net: &Net, p: &[usize], gamma: f64, budget: &Budget) -> Result<Vec<usize>, Detail> {
    let n = net.n();
    let count = p.iter().max().map_or(0, |c| c + 1);
    let mut tot_p = vec![0.0; count];
    for v in 0..n {
        tot_p[p[v]] += net.k[v];
    }
    let mut r: Vec<usize> = (0..n).collect();
    let mut tot_r = net.k.clone();
    // The weight from each part to the rest of its community.
    let mut ext: Vec<f64> =
        (0..n).map(|v| net.adj[v].iter().filter(|(u, _)| p[*u] == p[v]).map(|(_, w)| w).sum()).collect();
    let mut alone = vec![true; n];
    let mut weights: HashMap<usize, f64> = HashMap::new();
    let mut order: Vec<usize> = Vec::new();
    for v in 0..n {
        budget.tick()?;
        if !alone[v] {
            continue;
        }
        let c = p[v];
        if ext[v] < gamma * net.k[v] * (tot_p[c] - net.k[v]) / net.m2 {
            continue;
        }
        weights.clear();
        order.clear();
        for &(u, w) in &net.adj[v] {
            if p[u] != c || r[u] == r[v] {
                continue;
            }
            if !weights.contains_key(&r[u]) {
                order.push(r[u]);
            }
            *weights.entry(r[u]).or_default() += w;
        }
        let mut best = None;
        let mut best_gain = 0.0;
        for &s in &order {
            let well_connected = ext[s] >= gamma * tot_r[s] * (tot_p[c] - tot_r[s]) / net.m2;
            let g = weights[&s] - gamma * tot_r[s] * net.k[v] / net.m2;
            if well_connected && g >= best_gain - EPSILON && best.is_none_or(|_| g > best_gain + EPSILON) {
                best = Some(s);
                best_gain = g;
            }
        }
        if let Some(s) = best {
            ext[s] = ext[s] + ext[v] - 2.0 * weights[&s];
            tot_r[s] += net.k[v];
            r[v] = s;
            alone[v] = false;
            alone[s] = false;
        }
    }
    Ok(r)
}

/// Louvain (`refined` false) or Leiden (`refined` true) over at most `levels` levels.
fn modularity_communities(
    topo: &Topo,
    gamma: f64,
    levels: u32,
    refined: bool,
    budget: &Budget,
) -> Result<Vec<usize>, Detail> {
    let mut net = Net::of(topo);
    let mut assign: Vec<usize> = (0..topo.n).collect();
    let mut p: Vec<usize> = (0..topo.n).collect();
    for _ in 0..levels {
        let moved = local_moving(&net, &mut p, gamma, budget)?;
        p = compact(&p);
        let communities = p.iter().max().map_or(0, |c| c + 1);
        if !moved || communities == net.n() {
            break;
        }
        if refined {
            let r = compact(&refine(&net, &p, gamma, budget)?);
            let parts = r.iter().max().map_or(0, |c| c + 1);
            let mut parent = vec![0; parts];
            for v in 0..net.n() {
                parent[r[v]] = p[v];
            }
            assign = assign.iter().map(|a| r[*a]).collect();
            net = net.aggregate(&r);
            p = parent;
        } else {
            assign = assign.iter().map(|a| p[*a]).collect();
            net = net.aggregate(&p);
            p = (0..net.n()).collect();
        }
    }
    Ok(assign.iter().map(|a| p[*a]).collect())
}

/// Each node takes the community most of its edges lead to (ties: it keeps its own, else the
/// lowest), in node order, until none changes or after `max_iterations` rounds.
fn label_propagation(topo: &Topo, max_iterations: u32, budget: &Budget) -> Result<Vec<usize>, Detail> {
    let mut label: Vec<usize> = (0..topo.n).collect();
    let mut counts: BTreeMap<usize, f64> = BTreeMap::new();
    for _ in 0..max_iterations {
        budget.check()?;
        let mut changed = false;
        for v in 0..topo.n {
            counts.clear();
            for (u, k) in topo.around(v, crate::analysis::Direction::Both) {
                budget.tick()?;
                if u != v {
                    *counts.entry(label[u]).or_default() += topo.weight[k];
                }
            }
            let Some(max) = counts.values().copied().reduce(f64::max) else { continue };
            if counts.get(&label[v]).is_some_and(|c| *c >= max) {
                continue;
            }
            let pick = counts.iter().find(|(_, c)| **c >= max).map(|(l, _)| *l).expect("a maximum");
            label[v] = pick;
            changed = true;
        }
        if !changed {
            break;
        }
    }
    Ok(label)
}

fn find(parent: &mut [usize], mut v: usize) -> usize {
    while parent[v] != v {
        parent[v] = parent[parent[v]];
        v = parent[v];
    }
    v
}

pub fn weakly_connected(topo: &Topo) -> Vec<usize> {
    let mut parent: Vec<usize> = (0..topo.n).collect();
    for &(a, b) in &topo.ends {
        let (x, y) = (find(&mut parent, a), find(&mut parent, b));
        if x != y {
            parent[x.max(y)] = x.min(y);
        }
    }
    (0..topo.n).map(|v| find(&mut parent, v)).collect()
}

/// Tarjan's strongly connected components, without recursion.
fn strongly_connected(topo: &Topo, budget: &Budget) -> Result<Vec<usize>, Detail> {
    let n = topo.n;
    let next = topo.simple(crate::analysis::Direction::Out);
    let mut index = vec![usize::MAX; n];
    let mut low = vec![0; n];
    let mut on_stack = vec![false; n];
    let mut stack = Vec::new();
    let mut component = vec![usize::MAX; n];
    let mut counter = 0;
    let mut components = 0;
    for root in 0..n {
        if index[root] != usize::MAX {
            continue;
        }
        let mut calls: Vec<(usize, usize)> = vec![(root, 0)];
        index[root] = counter;
        low[root] = counter;
        counter += 1;
        stack.push(root);
        on_stack[root] = true;
        while let Some(&mut (v, ref mut i)) = calls.last_mut() {
            budget.tick()?;
            if let Some(&w) = next[v].get(*i) {
                *i += 1;
                if index[w] == usize::MAX {
                    index[w] = counter;
                    low[w] = counter;
                    counter += 1;
                    stack.push(w);
                    on_stack[w] = true;
                    calls.push((w, 0));
                } else if on_stack[w] {
                    low[v] = low[v].min(index[w]);
                }
                continue;
            }
            calls.pop();
            if let Some(&(parent, _)) = calls.last() {
                low[parent] = low[parent].min(low[v]);
            }
            if low[v] == index[v] {
                while let Some(w) = stack.pop() {
                    on_stack[w] = false;
                    component[w] = components;
                    if w == v {
                        break;
                    }
                }
                components += 1;
            }
        }
    }
    Ok(component)
}
