import type { Edge, Node } from "../../api/generated/shapes";
import { evaluateRules, type ItemStyle, type StyleItem } from "../graph/style/evaluate";
import { type GraphStyle, readableStyle, type StyleColor } from "../graph/style/schema";
import "../viz.css";

/**
 * How a graph's nodes and edges look on the map. This is the one place the map asks: the basis
 * is the palette color of a node's first label and one size, every edge a plain line; the style
 * rules of the panel (`options.style`, the same rule list and evaluator as the graph panels,
 * panels/graph/style/evaluate.ts) win over it, so a rule list means the same in the graph panel
 * and on the map. The map draws a rule's color, size, edge width and dash; shapes, icons, frames
 * and badges are the graph panels' alone.
 */

/** A palette color (1 to 8), a status tone, the neutral tone, or null for the plain neutral. */
export type MapTone = number | "ok" | "warn" | "critical" | "neutral" | null;

export interface MapNodeStyle {
  tone: MapTone;
  /** Radius in pixels. */
  radius: number;
}

export interface MapEdgeStyle {
  dashed: boolean;
  /** Stroke width in pixels of one edge; bundled edges grow from it. */
  width: number;
  /** A rule's color; null keeps the edges' own tone. */
  tone: MapTone;
}

export const NODE_RADIUS = 6;
export const EDGE_WIDTH = 1.25;
export const PALETTE_SIZE = 8;

/** The class that gives a mark its tone's colors (viz.css): `series-N` or `tone--name`. */
export function toneClass(tone: MapTone): string {
  if (tone === null) return "";
  return typeof tone === "number" ? `series-${tone}` : `tone--${tone}`;
}

/** A rule's color as a tone of the map. */
export function ruleTone(color: StyleColor): MapTone {
  switch (color) {
    case "neutral":
    case "neutral-strong":
      return "neutral";
    case "good":
      return "ok";
    case "warning":
      return "warn";
    case "critical":
      return "critical";
    default:
      return Number(color.slice("chart-".length));
  }
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

export function nodeStyle(
  node: Node,
  groups: ReadonlyMap<string, number>,
  rule: ItemStyle | null = null,
): MapNodeStyle {
  const set = rule?.set;
  return {
    tone: set?.color === undefined ? basisTone(node, groups) : ruleTone(set.color),
    // A rule's size is a node's diameter in px, as in the graph panels.
    radius: set?.size === undefined ? NODE_RADIUS : set.size / 2,
  };
}

export function edgeStyle(_edge: Edge, rule: ItemStyle | null = null): MapEdgeStyle {
  const set = rule?.set;
  return {
    dashed: set?.dash !== undefined && set.dash !== "solid",
    width: set?.width ?? EDGE_WIDTH,
    tone: set?.color === undefined ? null : ruleTone(set.color),
  };
}

/** The rules evaluated on the map's nodes and edges, in the order given; null per item without. */
export function evaluateMapStyle(
  style: GraphStyle,
  nodes: readonly Node[],
  edges: readonly Edge[],
  now?: number,
): { nodes: (ItemStyle | null)[]; edges: (ItemStyle | null)[] } {
  const drawn = readableStyle(style);
  const nodeItems: StyleItem[] = nodes.map((n) => ({ kinds: n.labels, properties: n.properties }));
  const edgeItems: StyleItem[] = edges.map((e) => ({ kinds: [e.type], properties: e.properties }));
  const options = now === undefined ? {} : { now };
  return {
    nodes:
      drawn.nodes.length === 0
        ? nodes.map(() => null)
        : evaluateRules(drawn.nodes, nodeItems, options).styles,
    edges:
      drawn.edges.length === 0
        ? edges.map(() => null)
        : evaluateRules(drawn.edges, edgeItems, options).styles,
  };
}
