import { schemaOf } from "../../../analysis/graphSteps";
import type {
  ErrorBody,
  GraphPath,
  GraphSet,
  Notice,
  StepSummary,
} from "../../../api/generated/shapes";
import type { Emphasis } from "../drawing";
import type { GraphModel } from "../model";
import type { GraphView, Visibility } from "../view";

/**
 * The quick actions of the canvas (board Graph082, frames 8 to 10): "Pfad finden" between two
 * chosen nodes (one, all, weighted, k shortest), "Wie hängen diese zusammen?" for three to
 * twenty, and
 * "Wichtigste Knoten". They compute on the Kalzit server on what the canvas has loaded
 * (`POST /orgs/{orgId}/graph/actions`) and ask no data source; they belong to the person and the
 * view and are not saved, unless taken over as a step.
 */

export type PathKind = "shortest" | "allShortest" | "weighted" | "kShortest";
export type TopMeasure = "pageRank" | "degree" | "betweenness";

/** At most this many chosen nodes for "Wie hängen diese zusammen?" (board frame 8; the server's 190 pairs). */
export const MAX_CONNECT_NODES = 20;
/** Paths "k kürzeste Pfade" asks for. */
export const K_PATHS = 3;
/** Rows a ranking lists before "and N more" (many ties). */
export const MAX_RANK_ROWS = 10;
/** "Wichtigste Knoten" holds up the first this many ranks. */
export const TOP_RANKS = 5;

/** A step the server runs for a quick action (`analysis/algoSteps.ts` forms). */
export type ActionStep = Record<string, unknown> & { id: string; type: string; frame: "A" };

/** What the server answers per step. */
export interface ActionAnswer {
  id: string;
  ranIn: "database" | "server";
  summary?: StepSummary;
  error?: ErrorBody;
  paths?: GraphPath[];
  values?: Record<string, unknown>;
  notices?: Notice[];
}

/**
 * The graph the canvas shows, as the steps read it: its drawn nodes and the drawn edges between
 * them. Hidden nodes, edges and edge types are not sent.
 */
export function loadedGraph(model: GraphModel, view: GraphView, visibility: Visibility): GraphSet {
  const shown = (i: number) => {
    const at = view.nodeOf[i] ?? -1;
    return at >= 0 && visibility.nodes[at] === 1;
  };
  const edgeShown = (i: number) => {
    const at = view.edgeOf[i] ?? -1;
    return at >= 0 && visibility.edges[at] === 1;
  };
  const nodes = model.nodes
    .filter((_, i) => shown(i))
    .map((n) => ({ id: n.id, labels: n.labels, properties: n.properties }));
  const edges = model.edges
    .filter((e, i) => shown(e.source) && shown(e.target) && edgeShown(i))
    .map((e) => ({
      id: e.id,
      type: e.type,
      from: (model.nodes[e.source] as GraphModel["nodes"][number]).id,
      to: (model.nodes[e.target] as GraphModel["nodes"][number]).id,
      properties: e.properties,
    }));
  return { nodes, edges, schema: schemaOf(nodes, edges) };
}

/** The number properties of the edges: what a weighted path may sum. */
export function edgeWeights(model: GraphModel): string[] {
  const out = new Set<string>();
  for (const e of model.edges) {
    for (const [k, v] of Object.entries(e.properties))
      if (typeof v === "number" && v >= 0) out.add(k);
  }
  return [...out].sort();
}

/** The step of "Pfad finden"; without direction unless the person asked for it (decision 11). */
export function pathStep(
  kind: PathKind,
  from: string,
  to: string,
  directed: boolean,
  weight?: string,
): ActionStep {
  return {
    id: "path",
    type: "paths",
    frame: "A",
    mode: kind,
    from,
    to,
    direction: directed ? "out" : "both",
    ...((kind === "weighted" || kind === "kShortest") && weight !== undefined ? { weight } : {}),
    ...(kind === "kShortest" ? { k: K_PATHS } : {}),
  };
}

/** One shortest path per pair of the chosen nodes, without direction. */
export function connectSteps(ids: readonly string[]): ActionStep[] {
  const steps: ActionStep[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      steps.push({
        id: `pair-${i}-${j}`,
        type: "paths",
        frame: "A",
        mode: "shortest",
        from: ids[i] as string,
        to: ids[j] as string,
        direction: "both",
      });
    }
  }
  return steps;
}

/**
 * The step behind "Wichtigste Knoten" by the chosen measure. The quick action names its value
 * `score`; taken over as a step it keeps the measure's own name (`pagerank`, `degree`,
 * `betweenness`), the property rules and tables read.
 */
export function topStep(measure: TopMeasure, named = true): ActionStep {
  const name = named ? { name: "score" } : {};
  return measure === "degree"
    ? { id: "top", type: "degree", frame: "A", ...name }
    : { id: "top", type: "centrality", frame: "A", measure, ...name };
}

/** The property a taken-over "Wichtigste Knoten" step adds. */
export function topProperty(measure: TopMeasure): string {
  return measure === "pageRank" ? "pagerank" : measure;
}

/** A quick action's step as a step of the panel: without its id, on the panel's query. */
export function adopted(step: ActionStep, frame: string): Record<string, unknown> {
  const { id: _, ...rest } = step;
  return { ...rest, frame };
}

/** One edge of a path, as its details list it. */
export interface PathEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  /** The edge's weight property, when the path is weighted; null where it has none. */
  weight: number | null;
}

/** The edges of a path in order, and the sum of their weights (null without a weight). */
export function pathDetails(
  model: GraphModel,
  path: GraphPath,
  weight: string | undefined,
): { edges: PathEdge[]; sum: number | null } {
  const byId = new Map(model.edges.map((e) => [e.id, e]));
  const caption = (i: number) => model.nodes[i]?.caption ?? "";
  const edges = path.edges.flatMap((id): PathEdge[] => {
    const e = byId.get(id);
    if (e === undefined) return [];
    const value = weight === undefined ? undefined : e.properties[weight];
    return [
      {
        id,
        from: caption(e.source),
        to: caption(e.target),
        type: e.type,
        weight: typeof value === "number" ? value : null,
      },
    ];
  });
  const sum = weight === undefined ? null : edges.reduce((total, e) => total + (e.weight ?? 1), 0);
  return { edges, sum };
}

/** One node of a ranking: ties share a rank, so the list may run longer than `TOP_RANKS`. */
export interface Ranked {
  id: string;
  score: number;
  rank: number;
}

/** The nodes on the first `ranks` ranks, highest score first, ties sharing a rank. */
export function ranking(values: Record<string, unknown>, ranks = TOP_RANKS): Ranked[] {
  const scored = Object.entries(values)
    .flatMap(([id, v]) => (typeof v === "number" && Number.isFinite(v) ? [{ id, score: v }] : []))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Ranked[] = [];
  let rank = 0;
  let last: number | null = null;
  for (const [i, entry] of scored.entries()) {
    if (entry.score !== last) {
      rank = i + 1;
      last = entry.score;
    }
    if (rank > ranks) break;
    out.push({ ...entry, rank });
  }
  return out;
}

/** The chosen nodes that no path reaches from any other chosen node. */
export function unconnected(ids: readonly string[], answers: readonly ActionAnswer[]): string[] {
  const reached = new Set<string>();
  for (const a of answers) {
    for (const p of a.paths ?? []) {
      const first = p.nodes[0];
      const last = p.nodes[p.nodes.length - 1];
      if (first !== undefined) reached.add(first);
      if (last !== undefined) reached.add(last);
    }
  }
  return ids.filter((id) => !reached.has(id));
}

/** The paths and nodes held up, by the model's ids, made into view indexes. */
export function emphasisOf(
  model: GraphModel,
  view: GraphView,
  held: { nodes: Iterable<string>; paths: readonly GraphPath[]; strong: readonly GraphPath[] },
): Emphasis {
  const edgeIndex = new Map(model.edges.map((e, i) => [e.id, i]));
  const viewNode = (id: string) => {
    const at = model.index.get(id);
    return at === undefined ? -1 : (view.nodeOf[at] ?? -1);
  };
  const viewEdge = (id: string) => {
    const at = edgeIndex.get(id);
    return at === undefined ? -1 : (view.edgeOf[at] ?? -1);
  };
  const nodes = new Set<number>();
  const edges = new Set<number>();
  const strong = new Set<number>();
  for (const id of held.nodes) {
    const at = viewNode(id);
    if (at >= 0) nodes.add(at);
  }
  for (const p of held.paths) {
    for (const id of p.nodes) {
      const at = viewNode(id);
      if (at >= 0) nodes.add(at);
    }
    for (const id of p.edges) {
      const at = viewEdge(id);
      if (at >= 0) edges.add(at);
    }
  }
  for (const p of held.strong) {
    for (const id of p.edges) {
      const at = viewEdge(id);
      if (at >= 0) strong.add(at);
    }
  }
  return { nodes, edges, strong };
}
