import type { Node } from "../../api/generated/shapes";
import "../viz.css";

/**
 * How a graph's nodes and edges look on the map: the palette color of a node's first label and
 * one size, every edge a plain line. The style rules of the graph panels join here once they are
 * on main (0.8.1); this is the one place the map asks.
 */

/**
 * A palette color (1 to 8), a step of the light-to-dark scale, a threshold's tone (`ok`,
 * `chart-3`), or null for the plain neutral.
 */
export type MapTone = number | { heat: number } | { tone: string } | null;

export const NODE_RADIUS = 6;
export const EDGE_WIDTH = 1.25;
export const PALETTE_SIZE = 8;

/** The class that gives a mark its tone's colors (viz.css): `series-N`, `tone--name`, `heat-N`. */
export function toneClass(tone: MapTone): string {
  if (tone === null) return "";
  if (typeof tone === "number") return `series-${tone}`;
  return "heat" in tone ? `heat-${tone.heat}` : `tone--${tone.tone}`;
}

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

/** The basis of a node: its first label's palette color. */
export function basisTone(node: Node, groups: ReadonlyMap<string, number>): MapTone {
  const group = groups.get(node.labels[0] ?? "");
  return group === undefined ? null : (group % PALETTE_SIZE) + 1;
}
