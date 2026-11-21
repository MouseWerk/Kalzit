import type { Edge, Node } from "../../api/generated/shapes";

/**
 * How a graph's nodes and edges look on the map. This is the one place the map asks; the graph
 * panels' style rules (`panels/graph/style`, the rule list of a panel: color, size, shape, label,
 * dash per condition) take over the bodies of `nodeStyle` and `edgeStyle` once they are there, so
 * a rule list means the same in the graph panel and on the map. Until then every node takes the
 * palette color of its first label and one size, and every edge is a plain line.
 */

export interface MapNodeStyle {
  /** 1 to 8, a color of the data palette; null draws the neutral tone. */
  tone: number | null;
  /** Radius in pixels. */
  radius: number;
}

export interface MapEdgeStyle {
  dashed: boolean;
  /** Stroke width in pixels of one edge; bundled edges grow from it. */
  width: number;
}

export const NODE_RADIUS = 6;
export const EDGE_WIDTH = 1.25;
export const PALETTE_SIZE = 8;

/** The legend group of each label: by how often it occurs, then by name, as the graph panels do. */
export function labelGroups(nodes: readonly Node[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const label = node.labels[0] ?? "";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort(
    ([a, countA], [b, countB]) => countB - countA || a.localeCompare(b),
  );
  return new Map(ordered.map(([label], index) => [label, index]));
}

export function nodeStyle(node: Node, groups: ReadonlyMap<string, number>): MapNodeStyle {
  const group = groups.get(node.labels[0] ?? "");
  return {
    tone: group === undefined ? null : (group % PALETTE_SIZE) + 1,
    radius: NODE_RADIUS,
  };
}

export function edgeStyle(_edge: Edge): MapEdgeStyle {
  return { dashed: false, width: EDGE_WIDTH };
}
