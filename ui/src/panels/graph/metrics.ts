import type { GraphModel } from "./model";

/**
 * Graph metrics computed in the browser. Degree comes with the model; components are linear in
 * nodes and edges and run for any graph the panel draws. Community detection (Louvain) is
 * superlinear and runs only up to COMMUNITY_LIMIT nodes; for larger graphs the panel says so.
 * Sources with their own algorithms (Neo4j GDS, Memgraph MAGE) can return communities as a
 * property instead, which the panel then colors by like any label.
 */
export const COMMUNITY_LIMIT = 2_000;

export interface Components {
  /** Component index per node, largest component first. */
  of: Int32Array;
  /** Node count per component. */
  sizes: number[];
}

/** Weakly connected components (edge direction ignored), by union-find. */
export function components(model: GraphModel): Components {
  const n = model.nodes.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root] as number;
    // Path compression keeps later finds short.
    let at = x;
    while (parent[at] !== root) {
      const next = parent[at] as number;
      parent[at] = root;
      at = next;
    }
    return root;
  };
  for (const edge of model.edges) {
    const a = find(edge.source);
    const b = find(edge.target);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  const counts = new Map<number, number>();
  const roots = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const root = find(i);
    roots[i] = root;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  // Number components by size, larger first, ties by first node, so colors are stable.
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const number = new Map(ordered.map(([root], i) => [root, i]));
  const of = new Int32Array(n);
  for (let i = 0; i < n; i++) of[i] = number.get(roots[i] as number) ?? 0;
  return { of, sizes: ordered.map(([, size]) => size) };
}

export interface Communities {
  /** Community index per node, largest first. */
  of: Int32Array;
  count: number;
}

/** A small seeded generator, so the same graph always gets the same communities. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Louvain communities for graphs up to COMMUNITY_LIMIT nodes, else null. The libraries load on
 * first use, so dashboards without graph metrics do not carry them.
 */
export async function communities(model: GraphModel): Promise<Communities | null> {
  const n = model.nodes.length;
  if (n === 0 || n > COMMUNITY_LIMIT) {
    return null;
  }
  const [{ UndirectedGraph }, { default: louvain }] = await Promise.all([
    import("graphology"),
    import("graphology-communities-louvain"),
  ]);
  const graph = new UndirectedGraph();
  for (let i = 0; i < n; i++) graph.addNode(String(i));
  for (const edge of model.edges) {
    if (edge.source !== edge.target) {
      graph.mergeEdge(String(edge.source), String(edge.target));
    }
  }
  const mapping = louvain(graph, { rng: seeded(n), getEdgeWeight: null });
  const raw = new Int32Array(n);
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const c = mapping[String(i)] ?? 0;
    raw[i] = c;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const number = new Map(ordered.map(([c], i) => [c, i]));
  const of = new Int32Array(n);
  for (let i = 0; i < n; i++) of[i] = number.get(raw[i] as number) ?? 0;
  return { of, count: ordered.length };
}
