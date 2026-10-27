import type {
  Edge,
  Field,
  FieldType,
  Frame,
  GraphSchema,
  GraphSet,
  Node,
} from "../api/generated/shapes";
import { detail } from "./expr";
import { projectGraph } from "./projection";

/**
 * Graph steps in the browser (docs/api/settings-dashboards.md, "Graph steps"): the same rules as
 * the server's (`server/src/analysis/graph.rs`), which runs them, or the database runs them
 * (`server/src/analysis/pushdown.rs`). Here they preview a step on the graph the browser holds
 * until the server's answer is there; both engines pass the graph cases of `conformance.json`.
 *
 * Orders are fixed so every engine answers the same rows: counts largest first, then by name;
 * names and node ids compare by UTF-16 code units, as Neo4j compares text.
 */

export type Direction = "both" | "out" | "in";
export type GraphRows = "nodes" | "edges";

export type GraphStepKind =
  | { type: "countLabels"; frame: string }
  | { type: "countEdgeTypes"; frame: string }
  | { type: "degreeDistribution"; frame: string; direction?: Direction }
  | { type: "topDegree"; frame: string; n: number; label?: string; direction?: Direction }
  | {
      type: "sharedNeighbours";
      frame: string;
      label: string;
      via: string;
      edgeType?: string;
      min: number;
      limit: number;
      name?: string;
    };

/** The server's bounds (server/src/analysis/mod.rs). */
export const MAX_TOP_NODES = 1000;
export const MAX_PAIRS = 1000;

/** What a graph step makes: a frame, or a smaller graph. */
export type GraphOut = { frame: Frame } | { graph: GraphSet };

/** Text in the order Neo4j sorts it: UTF-16 code units. */
export function textOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Text by code points, as the server's sorted sets (the graph schema) hold it. */
function codePointOrder(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const y = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Optional text, the missing last (as `ORDER BY ... ASC` in Cypher). */
function optionalOrder(a: string | null, b: string | null): number {
  if (a !== null && b !== null) return textOrder(a, b);
  return a !== null ? -1 : b !== null ? 1 : 0;
}

const field = (name: string, type: FieldType, values: unknown[]): Field => ({ name, type, values });

/** A frame made from a graph keeps the graph's notices; a cut graph marks the frame cut. */
function frameOf(graph: GraphSet, fields: Field[]): Frame {
  return {
    fields,
    meta: { rowsTruncated: graph.truncated !== undefined, notices: graph.notices ?? [] },
  };
}

/** Runs one graph step on `graph`. */
export function applyGraphStep(
  step: GraphStepKind | { type: "toFrame"; rows: GraphRows; label?: string; edgeType?: string; columns: Parameters<typeof projectGraph>[4] },
  graph: GraphSet,
  maxCells: number,
): GraphOut {
  switch (step.type) {
    case "countLabels":
      return { frame: countLabels(graph) };
    case "countEdgeTypes":
      return { frame: countEdgeTypes(graph) };
    case "degreeDistribution":
      return { frame: degreeDistribution(graph, step.direction ?? "both") };
    case "topDegree":
      return { graph: topDegree(graph, step.n, step.label, step.direction ?? "both") };
    case "sharedNeighbours":
      return { frame: sharedNeighbours(graph, step, maxCells) };
    case "toFrame":
      return { frame: projectGraph(graph, step.rows, step.label, step.edgeType, step.columns) };
  }
}

function countLabels(graph: GraphSet): Frame {
  const counts = new Map<string, number>();
  for (const n of graph.nodes) {
    for (const l of new Set(n.labels)) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const rows = [...counts].sort((a, b) => b[1] - a[1] || textOrder(a[0], b[0]));
  const total = graph.nodes.length;
  return frameOf(graph, [
    field(
      "label",
      "string",
      rows.map(([l]) => l),
    ),
    field(
      "nodes",
      "number",
      rows.map(([, c]) => c),
    ),
    field(
      "share",
      "number",
      rows.map(([, c]) => c / total),
    ),
  ]);
}

/** A node's labels joined with `:`; null for a node without labels. */
function labelText(n: Node | undefined): string | null {
  return n === undefined || n.labels.length === 0 ? null : n.labels.join(":");
}

function countEdgeTypes(graph: GraphSet): Frame {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const counts = new Map<string, { type: string; from: string | null; to: string | null; n: number }>();
  for (const e of graph.edges) {
    const from = labelText(nodes.get(e.from));
    const to = labelText(nodes.get(e.to));
    const key = JSON.stringify([e.type, from, to]);
    const row = counts.get(key);
    if (row === undefined) counts.set(key, { type: e.type, from, to, n: 1 });
    else row.n++;
  }
  const rows = [...counts.values()].sort(
    (a, b) =>
      b.n - a.n ||
      textOrder(a.type, b.type) ||
      optionalOrder(a.from, b.from) ||
      optionalOrder(a.to, b.to),
  );
  return frameOf(graph, [
    field(
      "type",
      "string",
      rows.map((r) => r.type),
    ),
    field(
      "from",
      "string",
      rows.map((r) => r.from),
    ),
    field(
      "to",
      "string",
      rows.map((r) => r.to),
    ),
    field(
      "edges",
      "number",
      rows.map((r) => r.n),
    ),
  ]);
}

/** The degree of every node, in node order; a loop counts twice for both directions. */
export function degrees(graph: GraphSet, direction: Direction): number[] {
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const out = new Array<number>(graph.nodes.length).fill(0);
  for (const e of graph.edges) {
    const from = index.get(e.from);
    const to = index.get(e.to);
    if (direction !== "in" && from !== undefined) out[from] = (out[from] ?? 0) + 1;
    if (direction !== "out" && to !== undefined) out[to] = (out[to] ?? 0) + 1;
  }
  return out;
}

function degreeDistribution(graph: GraphSet, direction: Direction): Frame {
  const counts = new Map<number, number>();
  for (const d of degrees(graph, direction)) counts.set(d, (counts.get(d) ?? 0) + 1);
  const rows = [...counts].sort((a, b) => a[0] - b[0]);
  return frameOf(graph, [
    field(
      "degree",
      "number",
      rows.map(([d]) => d),
    ),
    field(
      "nodes",
      "number",
      rows.map(([, c]) => c),
    ),
  ]);
}

/** The labels, edge types and property keys of a graph, as the server's graph builder lists them. */
export function schemaOf(nodes: readonly Node[], edges: readonly Edge[]): GraphSchema {
  const labels = new Set<string>();
  const keys = new Map<string, Set<string>>();
  for (const n of nodes) {
    for (const l of n.labels) {
      labels.add(l);
      const set = keys.get(l) ?? new Set<string>();
      for (const k of Object.keys(n.properties)) set.add(k);
      keys.set(l, set);
    }
  }
  const sorted = (s: Iterable<string>) => [...s].sort(codePointOrder);
  const propertyKeys: Record<string, string[]> = {};
  for (const l of sorted(keys.keys())) propertyKeys[l] = sorted(keys.get(l) ?? []);
  return {
    labels: sorted(labels),
    edgeTypes: sorted(new Set(edges.map((e) => e.type))),
    propertyKeys,
  };
}

function topDegree(
  graph: GraphSet,
  n: number,
  label: string | undefined,
  direction: Direction,
): GraphSet {
  const deg = degrees(graph, direction);
  const ranked = graph.nodes
    .map((_, i) => i)
    .filter((i) => label === undefined || (graph.nodes[i] as Node).labels.includes(label))
    .sort(
      (a, b) =>
        (deg[b] ?? 0) - (deg[a] ?? 0) ||
        textOrder((graph.nodes[a] as Node).id, (graph.nodes[b] as Node).id),
    )
    .slice(0, n);
  const nodes = ranked.map((i) => graph.nodes[i] as Node);
  const kept = new Set(nodes.map((x) => x.id));
  const edges = graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to));
  const out: GraphSet = { nodes, edges, schema: schemaOf(nodes, edges) };
  if (graph.truncated !== undefined) out.truncated = graph.truncated;
  if (graph.notices !== undefined) out.notices = graph.notices;
  return out;
}

function sharedNeighbours(
  graph: GraphSet,
  spec: Extract<GraphStepKind, { type: "sharedNeighbours" }>,
  maxCells: number,
): Frame {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const has = (n: Node, l: string) => n.labels.includes(l);
  // Each neighbour (`via`) with the `label` nodes next to it, each pair of them once.
  const around = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const e of graph.edges) {
    if (spec.edgeType !== undefined && e.type !== spec.edgeType) continue;
    const s = nodes.get(e.from);
    const t = nodes.get(e.to);
    if (s === undefined || t === undefined) continue;
    let pair: [Node, Node];
    if (has(s, spec.label) && has(t, spec.via)) pair = [s, t];
    else if (has(s, spec.via) && has(t, spec.label)) pair = [t, s];
    else continue;
    const [a, v] = pair;
    const key = JSON.stringify([a.id, v.id]);
    if (seen.has(key)) continue;
    seen.add(key);
    const list = around.get(v.id);
    if (list === undefined) around.set(v.id, [a.id]);
    else list.push(a.id);
  }
  // Pairs grow with the square of a neighbour's nodes: bounded before they are made.
  let pairs = 0;
  for (const list of around.values()) pairs += (list.length * (list.length - 1)) / 2;
  if (pairs > maxCells) {
    throw detail("steps.too_many_cells", `the step would make more than ${maxCells} cells`, {
      max: maxCells,
    });
  }
  const shared = new Map<string, { x: string; y: string; vs: string[] }>();
  for (const [v, list] of around) {
    for (const x of list) {
      for (const y of list) {
        if (textOrder(x, y) >= 0) continue;
        const key = JSON.stringify([x, y]);
        const row = shared.get(key);
        if (row === undefined) shared.set(key, { x, y, vs: [v] });
        else row.vs.push(v);
      }
    }
  }
  const rows = [...shared.values()]
    .filter((r) => r.vs.length >= spec.min)
    .sort((a, b) => b.vs.length - a.vs.length || textOrder(a.x, b.x) || textOrder(a.y, b.y))
    .slice(0, spec.limit);
  const display = (id: string): string => {
    const value = spec.name === undefined ? undefined : nodes.get(id)?.properties[spec.name];
    return typeof value === "string" ? value : id;
  };
  return frameOf(graph, [
    field(
      "a",
      "string",
      rows.map((r) => display(r.x)),
    ),
    field(
      "b",
      "string",
      rows.map((r) => display(r.y)),
    ),
    field(
      "shared",
      "number",
      rows.map((r) => r.vs.length),
    ),
    field(
      "neighbours",
      "json",
      rows.map((r) => [...r.vs].sort(textOrder).map(display)),
    ),
  ]);
}
