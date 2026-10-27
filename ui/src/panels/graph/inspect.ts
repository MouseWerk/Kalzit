import { isRecord } from "../../api/client";
import type { Edge, GraphSet, Node } from "../../api/generated/shapes";
import { propertyText } from "./adapter";
import type { GraphModel } from "./model";
import type { GraphView, Visibility } from "./view";

/**
 * What the node inspector, the selection and the pins work with, as pure functions of the
 * model, so they are tested without a renderer.
 */

/** The kind of a property value, as the inspector names it. */
export type PropertyType =
  | "text"
  | "integer"
  | "float"
  | "boolean"
  | "date"
  | "dateTime"
  | "time"
  | "duration"
  | "point"
  | "list"
  | "map"
  | "null";

/** A property's type: from JSON, or from the `$type` of values JSON has no type for. */
export function propertyType(value: unknown): PropertyType {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return "text";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number" || typeof value === "bigint") {
    return Number.isInteger(value) || typeof value === "bigint" ? "integer" : "float";
  }
  if (Array.isArray(value)) return "list";
  if (isRecord(value) && typeof value.$type === "string") {
    switch (value.$type) {
      case "int64":
        return "integer";
      case "decimal":
      case "float":
        return "float";
      case "date":
        return "date";
      case "dateTime":
      case "localDateTime":
        return "dateTime";
      case "time":
      case "localTime":
        return "time";
      case "duration":
        return "duration";
      case "point":
        return "point";
      default:
        return "text";
    }
  }
  return "map";
}

/** One neighbour of the inspected node, through one edge. */
export interface Neighbour {
  /** Model node index. */
  node: number;
  /** Model edge index. */
  edge: number;
}

/** The neighbours along one edge type, in one direction, with one label. */
export interface NeighbourGroup {
  key: string;
  type: string;
  /** The edge points away from the inspected node. */
  outgoing: boolean;
  /** The neighbours' first label ("" without one). */
  label: string;
  items: Neighbour[];
}

/**
 * The node's neighbours grouped by edge type, direction and the neighbour's label, as the
 * inspector lists them ("BOUGHT → Product · 4"); groups by size, then by type.
 */
export function neighbourGroups(model: GraphModel, node: number): NeighbourGroup[] {
  const groups = new Map<string, NeighbourGroup>();
  model.edges.forEach((edge, i) => {
    const outgoing = edge.source === node;
    if (!outgoing && edge.target !== node) return;
    const other = outgoing ? edge.target : edge.source;
    const label = model.nodes[other]?.labels[0] ?? "";
    const key = `${edge.type}\u0000${outgoing ? ">" : "<"}\u0000${label}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, type: edge.type, outgoing, label, items: [] };
      groups.set(key, group);
    }
    group.items.push({ node: other, edge: i });
  });
  return [...groups.values()].sort(
    (a, b) => b.items.length - a.items.length || a.type.localeCompare(b.type),
  );
}

/** An edge's first property as short text for a neighbour line ("at 2026-09-02"), or "". */
export function edgeSummary(properties: Record<string, unknown>): string {
  const first = Object.entries(properties)[0];
  if (first === undefined) return "";
  return `${first[0]} ${propertyText(first[1])}`;
}

/**
 * What "show only the selection" leaves of a visibility: the selected nodes, and edges whose both
 * ends are selected. Everything else is hidden, not dimmed.
 */
export function onlySelection(
  view: GraphView,
  visibility: Visibility,
  selected: ReadonlySet<number>,
): Visibility {
  const nodes = new Uint8Array(view.nodes.length);
  for (const i of selected) {
    if (visibility.nodes[i] === 1) nodes[i] = 1;
  }
  const edges = new Uint8Array(view.edges.length);
  view.edges.forEach((edge, i) => {
    if (visibility.edges[i] === 1 && nodes[edge.source] === 1 && nodes[edge.target] === 1) {
      edges[i] = 1;
    }
  });
  return { nodes, edges };
}

/** A visibility without the nodes of hidden labels (the legend) and their edges. */
export function withoutLabels(
  model: GraphModel,
  view: GraphView,
  visibility: Visibility,
  hidden: ReadonlySet<string>,
): Visibility {
  if (hidden.size === 0) return visibility;
  const nodes = visibility.nodes.slice();
  view.nodes.forEach((node, i) => {
    const label =
      node.node >= 0
        ? (model.nodes[node.node]?.labels[0] ?? "")
        : (model.labels[node.cluster] ?? "");
    if (hidden.has(label)) nodes[i] = 0;
  });
  const edges = visibility.edges.slice();
  view.edges.forEach((edge, i) => {
    if (nodes[edge.source] === 0 || nodes[edge.target] === 0) edges[i] = 0;
  });
  return { nodes, edges };
}

/** Nodes per first label, in the order of the model's labels; "" for nodes without one. */
export function labelCounts(model: GraphModel): { label: string; index: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const node of model.nodes) counts.set(node.label, (counts.get(node.label) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => (a < 0 ? 1 : b < 0 ? -1 : a - b))
    .map(([index, count]) => ({ label: model.labels[index] ?? "", index, count }));
}

/**
 * The values a selection gives a multi-value variable: each selected node's property (or id),
 * once, in the order of the selection; nodes without the property give none.
 */
export function selectionValues(
  model: GraphModel,
  nodes: readonly number[],
  property: string,
): string[] {
  const values: string[] = [];
  for (const index of nodes) {
    const node = model.nodes[index];
    if (node === undefined) continue;
    const value = property === "" ? node.id : propertyText(node.properties[property]);
    if (value !== "" && !values.includes(value)) values.push(value);
  }
  return values;
}

/** A pinned node as it is kept while its step is taken back: the node and its edges. */
export interface PinnedNode {
  node: Node;
  edges: Edge[];
}

/** The model node with its edges, as a pin keeps it. */
export function pinOf(model: GraphModel, index: number): PinnedNode | null {
  const node = model.nodes[index];
  if (node === undefined) return null;
  const edges: Edge[] = [];
  for (const edge of model.edges) {
    if (edge.source !== index && edge.target !== index) continue;
    const from = model.nodes[edge.source]?.id;
    const to = model.nodes[edge.target]?.id;
    if (from === undefined || to === undefined) continue;
    edges.push({ id: edge.id, type: edge.type, from, to, properties: edge.properties });
  }
  return { node: { id: node.id, labels: node.labels, properties: node.properties }, edges };
}

/**
 * The pinned nodes as one more result for the model: each node, and its kept edges whose other
 * end is still there (in `present`, or pinned too), so taking back a step leaves no loose edge.
 */
export function pinnedGraph(
  pins: ReadonlyMap<string, PinnedNode>,
  present: ReadonlySet<string>,
): GraphSet | null {
  if (pins.size === 0) return null;
  const there = (id: string) => present.has(id) || pins.has(id);
  const edges = new Map<string, Edge>();
  for (const pin of pins.values()) {
    for (const edge of pin.edges) {
      if (there(edge.from) && there(edge.to)) edges.set(edge.id, edge);
    }
  }
  return {
    nodes: [...pins.values()].map((p) => p.node),
    edges: [...edges.values()],
    schema: { labels: [], edgeTypes: [], propertyKeys: {} },
  };
}

/** Every node id of some results, for `pinnedGraph`. */
export function nodeIds(sets: readonly GraphSet[]): Set<string> {
  const ids = new Set<string>();
  for (const set of sets) for (const node of set.nodes ?? []) ids.add(node.id);
  return ids;
}
