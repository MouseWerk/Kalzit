import type { GraphPath, GraphSet, Notice } from "../../api/generated/shapes";
import { graphExtras, nodeCaption, normalizeGraph, readNumber, readTime } from "./adapter";

/** Node colors cycle through this many palette entries (`--chart-1` ... `--chart-8`). */
export const GRAPH_COLORS = 8;

export interface ModelNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  caption: string;
  /** Index of the node's first label in `GraphModel.labels`; -1 without a label. */
  label: number;
  degree: number;
  inDegree: number;
  outDegree: number;
}

export interface ModelEdge {
  id: string;
  type: string;
  /** Indexes into `GraphModel.nodes`. */
  source: number;
  target: number;
  properties: Record<string, unknown>;
}

/**
 * One or more graph results merged by id and cut to the node limit, the form every graph panel
 * and the layout work on. Nodes and edges are arrays, so typed arrays can mirror them by index.
 */
export interface GraphModel {
  nodes: ModelNode[];
  edges: ModelEdge[];
  index: Map<string, number>;
  /** Distinct first labels in order of appearance; colors follow this order. */
  labels: string[];
  edgeTypes: string[];
  paths: GraphPath[];
  /** Node and edge counts before the node limit. */
  total: { nodes: number; edges: number };
  /** The node limit dropped nodes (and their edges). */
  cut: boolean;
  /** Edges whose ends are not in the result, which cannot be drawn. */
  dangling: number;
  /** The server cut the result at its own limit. */
  truncated: boolean;
  /** What the sources said about their results, each code once. */
  notices: Notice[];
}

export interface ModelOptions {
  nodeLimit: number;
  caption: string;
}

/**
 * Merges results by id (a later one adds labels and properties to a node it repeats), then keeps
 * the `nodeLimit` best connected nodes when there are more. Ties keep the order of the result, so
 * the same data always draws the same graph.
 */
export function buildGraphModel(sets: readonly GraphSet[], options: ModelOptions): GraphModel {
  const nodeById = new Map<string, { labels: string[]; properties: Record<string, unknown> }>();
  const edgeById = new Map<string, GraphSet["edges"][number]>();
  const paths: GraphPath[] = [];
  const labelOrder: string[] = [];
  const seenLabels = new Set<string>();
  const edgeTypes: string[] = [];
  const seenTypes = new Set<string>();
  let truncated = false;
  const notices: Notice[] = [];

  for (const raw of sets) {
    const set = normalizeGraph(raw);
    const extras = graphExtras(raw);
    truncated ||= set.truncated !== undefined;
    for (const notice of extras.notices) {
      if (!notices.some((n) => n.code === notice.code)) notices.push(notice);
    }
    // A cut without its own notice still says so, by the reason it names: a code the UI
    // translates, with no English text of its own (the panel's generic text stands in).
    const reason = extras.truncatedReason;
    if (reason !== null && !notices.some((n) => n.code === reason)) {
      notices.push({
        severity: "warning",
        code: reason,
        params: { limit: String(set.truncated?.limit ?? "") },
        text: "",
      });
    }
    for (const label of set.schema.labels) {
      if (!seenLabels.has(label)) {
        seenLabels.add(label);
        labelOrder.push(label);
      }
    }
    for (const node of set.nodes) {
      const known = nodeById.get(node.id);
      if (known === undefined) {
        nodeById.set(node.id, { labels: [...node.labels], properties: { ...node.properties } });
      } else {
        for (const label of node.labels) {
          if (!known.labels.includes(label)) known.labels.push(label);
        }
        Object.assign(known.properties, node.properties);
      }
      const first = node.labels[0];
      if (first !== undefined && !seenLabels.has(first)) {
        seenLabels.add(first);
        labelOrder.push(first);
      }
    }
    for (const edge of set.edges) {
      edgeById.set(edge.id, edge);
      if (!seenTypes.has(edge.type)) {
        seenTypes.add(edge.type);
        edgeTypes.push(edge.type);
      }
    }
    paths.push(...(set.paths ?? []));
  }

  // Degrees over every edge whose ends exist, before the cut, so the cut keeps the hubs.
  const ids = [...nodeById.keys()];
  const position = new Map(ids.map((id, i) => [id, i]));
  const fullDegree = new Uint32Array(ids.length);
  let dangling = 0;
  for (const edge of edgeById.values()) {
    const s = position.get(edge.from);
    const t = position.get(edge.to);
    if (s === undefined || t === undefined) {
      dangling++;
      continue;
    }
    fullDegree[s] = (fullDegree[s] ?? 0) + 1;
    fullDegree[t] = (fullDegree[t] ?? 0) + 1;
  }

  const limit = Math.max(0, options.nodeLimit);
  let kept = ids;
  if (ids.length > limit) {
    const order = ids.map((_, i) => i);
    order.sort((a, b) => (fullDegree[b] ?? 0) - (fullDegree[a] ?? 0) || a - b);
    const keep = new Uint8Array(ids.length);
    for (let i = 0; i < limit; i++) keep[order[i] ?? 0] = 1;
    kept = ids.filter((_, i) => keep[i] === 1);
  }

  const index = new Map<string, number>();
  const labelIndex = new Map(labelOrder.map((label, i) => [label, i]));
  const nodes: ModelNode[] = kept.map((id, i) => {
    index.set(id, i);
    const data = nodeById.get(id) as { labels: string[]; properties: Record<string, unknown> };
    const node = { id, labels: data.labels, properties: data.properties };
    const first = data.labels[0];
    return {
      ...node,
      caption: nodeCaption(node, options.caption),
      label: first === undefined ? -1 : (labelIndex.get(first) ?? -1),
      degree: 0,
      inDegree: 0,
      outDegree: 0,
    };
  });

  const edges: ModelEdge[] = [];
  for (const edge of edgeById.values()) {
    const source = index.get(edge.from);
    const target = index.get(edge.to);
    if (source === undefined || target === undefined) {
      continue;
    }
    edges.push({ id: edge.id, type: edge.type, source, target, properties: edge.properties });
    const s = nodes[source] as ModelNode;
    const t = nodes[target] as ModelNode;
    s.degree++;
    s.outDegree++;
    t.degree++;
    t.inDegree++;
  }

  return {
    nodes,
    edges,
    index,
    labels: labelOrder,
    edgeTypes,
    paths,
    total: { nodes: ids.length, edges: edgeById.size - dangling },
    cut: kept.length < ids.length,
    dangling,
    truncated,
    notices,
  };
}

/** Every property key of the model's nodes, sorted, for option pickers. */
export function nodePropertyKeys(model: GraphModel): string[] {
  const keys = new Set<string>();
  for (const node of model.nodes) {
    for (const key of Object.keys(node.properties)) keys.add(key);
  }
  return [...keys].sort();
}

export function edgePropertyKeys(model: GraphModel): string[] {
  const keys = new Set<string>();
  for (const edge of model.edges) {
    for (const key of Object.keys(edge.properties)) keys.add(key);
  }
  return [...keys].sort();
}

export const MIN_NODE_SIZE = 4;
export const MAX_NODE_SIZE = 14;
export const MIN_EDGE_WIDTH = 0.5;
export const MAX_EDGE_WIDTH = 4;

/**
 * Values mapped onto [min, max] by square root, so a hub with 1,000 edges is bigger than one with
 * 10 without hiding everything else. Missing values take the minimum; equal values the middle.
 */
export function scaleValues(values: readonly (number | null)[], min: number, max: number) {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v !== null && v >= 0) {
      if (v < low) low = v;
      if (v > high) high = v;
    }
  }
  const out = new Float32Array(values.length);
  if (!Number.isFinite(low)) {
    out.fill(min);
    return out;
  }
  const a = Math.sqrt(low);
  const span = Math.sqrt(high) - a;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? null;
    out[i] =
      v === null || v < 0
        ? min
        : span === 0
          ? (min + max) / 2
          : min + ((Math.sqrt(v) - a) / span) * (max - min);
  }
  return out;
}

/** Node sizes in px: by degree, by a numeric property, or all the same, within [min, max]. */
export function nodeSizes(
  model: GraphModel,
  sizeBy: string,
  min = MIN_NODE_SIZE,
  max = MAX_NODE_SIZE,
): Float32Array {
  if (sizeBy === "") {
    return new Float32Array(model.nodes.length).fill((min + max) / 3);
  }
  const values =
    sizeBy === "degree"
      ? model.nodes.map((n) => n.degree)
      : model.nodes.map((n) => readNumber(n.properties[sizeBy]));
  return scaleValues(values, min, max);
}

/** Edge widths by a numeric property, or all the thinnest. */
export function edgeWidths(model: GraphModel, widthBy: string): Float32Array {
  if (widthBy === "") {
    return new Float32Array(model.edges.length).fill(1);
  }
  return scaleValues(
    model.edges.map((e) => readNumber(e.properties[widthBy])),
    MIN_EDGE_WIDTH,
    MAX_EDGE_WIDTH,
  );
}

/** Edge times in Unix ms (NaN without one), for the time slider. */
export function edgeTimes(model: GraphModel, property: string): Float64Array {
  const out = new Float64Array(model.edges.length).fill(Number.NaN);
  if (property === "") {
    return out;
  }
  model.edges.forEach((edge, i) => {
    out[i] = readTime(edge.properties[property]) ?? Number.NaN;
  });
  return out;
}
