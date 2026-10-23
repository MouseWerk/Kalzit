import type { Edge, GraphSet, Node } from "../../../api/generated/shapes";

/**
 * A deterministic graph generator for tests and budgets (docs/PLAN.md, section 11): the same
 * arguments always give the same graph. Nodes get one of a few labels, a name and a score;
 * edges connect mostly within groups (so communities exist), with a timestamp and a weight.
 */
export function generateGraph(nodeCount: number, edgeCount: number, seed = 1): GraphSet {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const labels = ["Customer", "Product", "Order", "Supplier"];
  const nodes: Node[] = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`,
    labels: [labels[i % labels.length] as string],
    properties: { name: `Node ${i}`, score: Math.floor(random() * 100) },
  }));
  const groupSize = 50;
  const edges: Edge[] = [];
  const day = 86_400_000;
  for (let e = 0; e < edgeCount; e++) {
    const from = Math.floor(random() * nodeCount);
    const local = random() < 0.85;
    const base = Math.floor(from / groupSize) * groupSize;
    const to = local
      ? Math.min(nodeCount - 1, base + Math.floor(random() * groupSize))
      : Math.floor(random() * nodeCount);
    edges.push({
      id: `e${e}`,
      type: local ? "KNOWS" : "BOUGHT",
      from: `n${from}`,
      to: `n${to}`,
      properties: {
        since: Date.UTC(2026, 0, 1) + Math.floor(random() * 300) * day,
        weight: 1 + Math.floor(random() * 9),
      },
    });
  }
  return {
    nodes,
    edges,
    schema: {
      labels,
      edgeTypes: ["KNOWS", "BOUGHT"],
      propertyKeys: Object.fromEntries(labels.map((label) => [label, ["name", "score"]])),
    },
  };
}

/** The best of a few runs in ms: the cost of the work, not of whatever else the machine does. */
export function bestOf(runs: number, work: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}
