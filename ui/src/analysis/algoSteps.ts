import type { GraphSet, RanIn, StepSummary } from "../api/generated/shapes";
import type { Direction } from "./graphSteps";

/**
 * Graph algorithm steps (docs/api/settings-dashboards.md, "Graph algorithm steps"; board
 * docs/design/blueprint/Graph082.dc.html). They read the `graph` result of a query and keep it a
 * graph: what they find becomes node or edge properties, the graph's paths, or suggested edges;
 * only similarity may answer a table. The server runs them with the query, in the database's
 * library where it can, else on the Kalzit server; the browser has no engine for them, so a step
 * shows its result once the server answered (as the trace steps).
 */

export type CentralityMeasure =
  | "pageRank"
  | "betweenness"
  | "closeness"
  | "eigenvector"
  | "harmonic";
export type CommunityAlgorithm =
  | "louvain"
  | "leiden"
  | "labelPropagation"
  | "weaklyConnected"
  | "stronglyConnected";
export type SimilarityMeasure = "jaccard" | "overlap" | "cosine" | "knn";
export type LinkMeasure = "commonNeighbours" | "adamicAdar" | "preferentialAttachment";
export type PathMode = "shortest" | "allShortest" | "weighted" | "kShortest";
export type GraphAggregateOp = "count" | "sum" | "mean" | "min" | "max" | "distinct";
export type AlongOp = "sum" | "mean" | "count" | "min" | "max";

/** An aggregate of a group of merged nodes or edges, as the property `name`. */
export interface GraphAggregate {
  op: GraphAggregateOp;
  property?: string;
  name: string;
}

/**
 * Where an algorithm step may run: in the database's library where it can (absent, "auto"), or
 * always on the Kalzit server (`server`), to compare runs.
 */
interface Placed {
  frame: string;
  place?: "server";
}

export type AlgoStepKind =
  | (Placed & {
      type: "centrality";
      measure: CentralityMeasure;
      direction?: Direction;
      weight?: string;
      name?: string;
      damping?: number;
      maxIterations?: number;
      tolerance?: number;
    })
  | (Placed & {
      type: "communities";
      algorithm: CommunityAlgorithm;
      weight?: string;
      name?: string;
      maxIterations?: number;
      resolution?: number;
      seed?: number;
    })
  | (Placed & { type: "kCore"; k?: number; name?: string })
  | (Placed & { type: "triangles"; name?: string; clustering?: string })
  | (Placed & {
      type: "similarity";
      measure: SimilarityMeasure;
      topK?: number;
      properties?: string[];
      label?: string;
      edgeTypes?: string[];
      direction?: Direction;
      minScore?: number;
      output?: "table" | "edges";
      name?: string;
    })
  | (Placed & {
      type: "linkPrediction";
      measure: LinkMeasure;
      topK?: number;
      label?: string;
      minScore?: number;
      name?: string;
    })
  | (Placed & {
      type: "paths";
      mode: PathMode;
      from: string;
      to: string;
      direction?: Direction;
      edgeTypes?: string[];
      weight?: string;
      k?: number;
      maxPaths?: number;
      maxLength?: number;
      keepAll?: boolean;
      name?: string;
    })
  | (Placed & {
      type: "reachable";
      from: string[];
      maxHops?: number;
      direction?: Direction;
      edgeTypes?: string[];
      name?: string;
    })
  | (Placed & { type: "bridges"; name?: string })
  | (Placed & { type: "articulationPoints"; name?: string })
  | (Placed & {
      type: "cycles";
      maxLength?: number;
      maxCount?: number;
      direction?: Direction;
      name?: string;
    })
  | (Placed & {
      type: "mergeNodes";
      by: "label" | "property";
      property?: string;
      aggregates?: GraphAggregate[];
      edgeAggregates?: GraphAggregate[];
      loops?: boolean;
      mergeTypes?: boolean;
    })
  | (Placed & {
      type: "aggregateAlong";
      along?: "neighbours" | "paths";
      of?: "nodes" | "edges";
      label?: string;
      op: AlongOp;
      property?: string;
      edgeTypes?: string[];
      direction?: Direction;
      depth?: number;
      name: string;
    });

export const ALGO_STEP_TYPES = [
  "centrality",
  "communities",
  "kCore",
  "triangles",
  "similarity",
  "linkPrediction",
  "paths",
  "reachable",
  "bridges",
  "articulationPoints",
  "cycles",
  "mergeNodes",
  "aggregateAlong",
] as const;

export type AlgoStepType = (typeof ALGO_STEP_TYPES)[number];

export function isAlgoType(type: string): type is AlgoStepType {
  return (ALGO_STEP_TYPES as readonly string[]).includes(type);
}

/** The server's bounds of the steps' parameters (server/src/analysis/mod.rs). */
export const ALGO_LIMITS = {
  maxIterations: 100,
  maxCommunityIterations: 1000,
  maxCore: 10_000,
  maxTopK: 100,
  maxSuggestions: 500,
  maxKPaths: 100,
  maxAllPaths: 1000,
  maxPathLength: 30,
  maxHops: 8,
  maxStartNodes: 100,
  maxCycleLength: 8,
  maxCycles: 1000,
  maxDepth: 4,
  maxProperties: 50,
} as const;

/**
 * The catalog's groups of graph steps, in their order (board, frame 1 and decision 10): the six
 * of the plan, "Umformen", and the steps from before 0.8.2 as "Zählen, filtern, als Tabelle".
 */
export const GRAPH_GROUPS = [
  "centrality",
  "communities",
  "similarity",
  "paths",
  "structures",
  "linkPrediction",
  "transform",
  "basic",
] as const;
export type GraphGroup = (typeof GRAPH_GROUPS)[number];

/** Databases whose algorithm library a step may run in. */
export type Library = "neo4j" | "memgraph";

/**
 * One entry of the catalog: a step type with what sets it apart (PageRank and betweenness are
 * both `centrality`), its group, and the databases whose library runs it (the server decides
 * for real, `analysis::algo::library`; this is what the catalog says beforehand).
 */
export interface GraphVariant {
  key: string;
  type: string;
  group: GraphGroup;
  /** The step's own fields besides `frame`, filled in when it is added. */
  patch?: Record<string, unknown>;
  /** The step makes a table (similarity as a table); else it keeps a graph. */
  table?: boolean;
  libraries?: readonly Library[];
  /** The result may differ slightly between runs in a database (iterative, randomised). */
  varies?: boolean;
}

const BOTH: readonly Library[] = ["neo4j", "memgraph"];
const NEO4J: readonly Library[] = ["neo4j"];

/** The graph steps in the catalog, in order. Types this server does not know are left out. */
export const GRAPH_VARIANTS: readonly GraphVariant[] = [
  { key: "degree", type: "degree", group: "centrality" },
  {
    key: "centrality.pageRank",
    type: "centrality",
    group: "centrality",
    patch: { measure: "pageRank" },
    libraries: BOTH,
    varies: true,
  },
  {
    key: "centrality.betweenness",
    type: "centrality",
    group: "centrality",
    patch: { measure: "betweenness" },
    libraries: NEO4J,
  },
  {
    key: "centrality.closeness",
    type: "centrality",
    group: "centrality",
    patch: { measure: "closeness" },
    libraries: NEO4J,
  },
  {
    key: "centrality.eigenvector",
    type: "centrality",
    group: "centrality",
    patch: { measure: "eigenvector" },
    libraries: NEO4J,
    varies: true,
  },
  {
    key: "centrality.harmonic",
    type: "centrality",
    group: "centrality",
    patch: { measure: "harmonic" },
    libraries: NEO4J,
  },
  {
    key: "communities.louvain",
    type: "communities",
    group: "communities",
    patch: { algorithm: "louvain" },
    libraries: BOTH,
    varies: true,
  },
  {
    key: "communities.leiden",
    type: "communities",
    group: "communities",
    patch: { algorithm: "leiden" },
    libraries: BOTH,
    varies: true,
  },
  {
    key: "communities.labelPropagation",
    type: "communities",
    group: "communities",
    patch: { algorithm: "labelPropagation" },
    libraries: NEO4J,
    varies: true,
  },
  {
    key: "communities.weaklyConnected",
    type: "communities",
    group: "communities",
    patch: { algorithm: "weaklyConnected" },
    libraries: BOTH,
  },
  {
    key: "communities.stronglyConnected",
    type: "communities",
    group: "communities",
    patch: { algorithm: "stronglyConnected" },
    libraries: NEO4J,
  },
  { key: "kCore", type: "kCore", group: "communities", libraries: NEO4J },
  { key: "triangles", type: "triangles", group: "communities", libraries: NEO4J },
  {
    key: "similarity.jaccard",
    type: "similarity",
    group: "similarity",
    patch: { measure: "jaccard" },
    table: true,
    libraries: NEO4J,
  },
  {
    key: "similarity.overlap",
    type: "similarity",
    group: "similarity",
    patch: { measure: "overlap" },
    table: true,
    libraries: NEO4J,
  },
  {
    key: "similarity.cosine",
    type: "similarity",
    group: "similarity",
    patch: { measure: "cosine" },
    table: true,
    libraries: NEO4J,
  },
  {
    key: "similarity.knn",
    type: "similarity",
    group: "similarity",
    patch: { measure: "knn", output: "edges" },
    libraries: NEO4J,
    varies: true,
  },
  {
    key: "paths.shortest",
    type: "paths",
    group: "paths",
    patch: { mode: "shortest" },
    libraries: BOTH,
  },
  { key: "paths.allShortest", type: "paths", group: "paths", patch: { mode: "allShortest" } },
  {
    key: "paths.weighted",
    type: "paths",
    group: "paths",
    patch: { mode: "weighted" },
    libraries: BOTH,
  },
  {
    key: "paths.kShortest",
    type: "paths",
    group: "paths",
    patch: { mode: "kShortest", k: 3 },
    libraries: NEO4J,
  },
  { key: "reachable", type: "reachable", group: "paths", libraries: BOTH },
  { key: "bridges", type: "bridges", group: "structures", libraries: BOTH },
  { key: "articulationPoints", type: "articulationPoints", group: "structures", libraries: BOTH },
  { key: "cycles", type: "cycles", group: "structures" },
  {
    key: "linkPrediction.commonNeighbours",
    type: "linkPrediction",
    group: "linkPrediction",
    patch: { measure: "commonNeighbours" },
  },
  {
    key: "linkPrediction.adamicAdar",
    type: "linkPrediction",
    group: "linkPrediction",
    patch: { measure: "adamicAdar" },
  },
  {
    key: "linkPrediction.preferentialAttachment",
    type: "linkPrediction",
    group: "linkPrediction",
    patch: { measure: "preferentialAttachment" },
  },
  { key: "mergeNodes", type: "mergeNodes", group: "transform" },
  { key: "aggregateAlong", type: "aggregateAlong", group: "transform" },
  { key: "countLabels", type: "countLabels", group: "basic", table: true },
  { key: "countEdgeTypes", type: "countEdgeTypes", group: "basic", table: true },
  { key: "degreeDistribution", type: "degreeDistribution", group: "basic", table: true },
  { key: "topDegree", type: "topDegree", group: "basic" },
  { key: "sharedNeighbours", type: "sharedNeighbours", group: "basic", table: true },
  { key: "filterGraph", type: "filterGraph", group: "basic" },
  { key: "toFrame", type: "toFrame", group: "basic", table: true },
];

/** The catalog entry a step belongs to: its type, and for some types its measure or mode. */
export function variantOf(
  step: { type: string } & Record<string, unknown>,
): GraphVariant | undefined {
  const candidates = GRAPH_VARIANTS.filter((v) => v.type === step.type);
  return (
    candidates.find((v) =>
      Object.entries(v.patch ?? {}).every(
        ([key, value]) => key === "output" || key === "k" || step[key] === value,
      ),
    ) ?? candidates[0]
  );
}

/** Whether the step makes a table: similarity unless it puts edges in the graph. */
export function algoMakesTable(step: AlgoStepKind): boolean {
  return (
    step.type === "similarity" &&
    (step.output ?? (step.measure === "knn" ? "edges" : "table")) === "table"
  );
}

/**
 * A new algorithm step of the catalog entry `variant` on the graph `frame`, ready to run with
 * defaults: no field is required but the two ends of a path and the start of "reachable",
 * which come from `graph` (the first nodes) until the person picks others.
 */
export function newAlgoStep(
  variant: GraphVariant,
  frame: string,
  graph: GraphSet | undefined,
): AlgoStepKind {
  const nodes = graph?.nodes ?? [];
  const labels = graph?.schema.labels ?? [];
  const keys = graph?.schema.propertyKeys ?? {};
  const numberKeys = numericNodeKeys(graph);
  const base = { frame, ...(variant.patch ?? {}) };
  switch (variant.type) {
    case "paths":
      return {
        ...base,
        type: "paths",
        mode: (variant.patch?.mode as PathMode | undefined) ?? "shortest",
        from: nodes[0]?.id ?? "",
        to: nodes[1]?.id ?? "",
        ...(variant.patch?.mode === "weighted" ? { weight: numericEdgeKeys(graph)[0] ?? "" } : {}),
      } as AlgoStepKind;
    case "reachable":
      return { ...base, type: "reachable", from: nodes[0] === undefined ? [] : [nodes[0].id] };
    case "similarity": {
      const byProperties = variant.patch?.measure === "cosine" || variant.patch?.measure === "knn";
      return {
        ...base,
        type: "similarity",
        ...(byProperties ? { properties: numberKeys.slice(0, 3) } : {}),
      } as AlgoStepKind;
    }
    case "mergeNodes":
      return {
        ...base,
        type: "mergeNodes",
        by: "label",
        aggregates: [{ op: "count", name: "count" }],
      };
    case "aggregateAlong": {
      const label = labels[0];
      const own = label === undefined ? [] : (keys[label] ?? []);
      const property = numberKeys.find((k) => !own.includes(k)) ?? numberKeys[0];
      return {
        ...base,
        type: "aggregateAlong",
        ...(label === undefined ? {} : { label }),
        op: property === undefined ? "count" : "sum",
        ...(property === undefined ? {} : { property }),
        name: property === undefined ? "count_along" : `sum_${property}`,
      };
    }
    default:
      return { ...base, type: variant.type } as AlgoStepKind;
  }
}

/** The number properties of the graph's nodes, by name. */
export function numericNodeKeys(graph: GraphSet | undefined): string[] {
  const out = new Set<string>();
  for (const n of graph?.nodes ?? []) {
    for (const [k, v] of Object.entries(n.properties)) if (typeof v === "number") out.add(k);
  }
  return [...out].sort();
}

/** The number properties of the graph's edges, by name: what a weight may be. */
export function numericEdgeKeys(graph: GraphSet | undefined): string[] {
  const out = new Set<string>();
  for (const e of graph?.edges ?? []) {
    for (const [k, v] of Object.entries(e.properties)) if (typeof v === "number") out.add(k);
  }
  return [...out].sort();
}

/** Whether an algorithm step passes the server's checks of its form (server/src/analysis/mod.rs). */
export function algoStepComplete(step: AlgoStepKind): boolean {
  switch (step.type) {
    case "paths":
      if (step.from === "" || step.to === "" || step.from === step.to) return false;
      return step.mode !== "weighted" || (step.weight ?? "") !== "";
    case "reachable":
      return step.from.length > 0 && step.from.length <= ALGO_LIMITS.maxStartNodes;
    case "similarity": {
      const byProperties = step.measure === "cosine" || step.measure === "knn";
      return !byProperties || (step.properties ?? []).length > 0;
    }
    case "mergeNodes":
      return step.by === "label" || (step.property ?? "") !== "";
    case "aggregateAlong":
      return step.name.trim() !== "" && (step.op === "count" || (step.property ?? "") !== "");
    case "triangles":
      return (step.name ?? "triangles") !== (step.clustering ?? "clustering");
    default:
      return true;
  }
}

/** The property a step adds to nodes (or edges), for "Als Größe zeigen" and the like. */
export function algoProperty(step: AlgoStepKind): string | undefined {
  switch (step.type) {
    case "centrality":
      return step.name ?? (step.measure === "pageRank" ? "pagerank" : step.measure);
    case "communities":
      return (
        step.name ??
        (step.algorithm === "weaklyConnected" || step.algorithm === "stronglyConnected"
          ? "component"
          : "community")
      );
    case "kCore":
      return step.name ?? "core";
    case "triangles":
      return step.name ?? "triangles";
    case "paths":
      return step.name ?? "path_order";
    case "reachable":
      return step.name ?? "distance";
    case "articulationPoints":
      return step.name ?? "articulation";
    case "bridges":
      return step.name ?? "bridge";
    case "cycles":
      return step.name ?? "in_cycle";
    case "aggregateAlong":
      return step.along === "paths" ? undefined : step.name;
    default:
      return undefined;
  }
}

/** Whether a step's property is a number a size or a color by value can show. */
export function algoPropertyIsScore(step: AlgoStepKind): boolean {
  return (
    step.type === "centrality" ||
    step.type === "kCore" ||
    step.type === "triangles" ||
    (step.type === "aggregateAlong" && step.along !== "paths")
  );
}

/** Whether a step's property groups nodes (one color per value). */
export function algoPropertyIsGroup(step: AlgoStepKind): boolean {
  return step.type === "communities";
}

/** The plain-language reason of a place, as the server names it (`algorithm.*`). */
export interface AlgoPlace {
  ranIn: RanIn;
  reason?: string;
  summary?: StepSummary;
}

/** The library each database runs steps in, by data source kind. */
export const LIBRARY_NAMES: Readonly<Record<Library, { engine: string; library: string }>> = {
  neo4j: { engine: "Neo4j", library: "GDS" },
  memgraph: { engine: "Memgraph", library: "MAGE" },
};

/** The library of a data source kind, if Kalzit uses one. */
export function libraryOf(kind: string | undefined): Library | undefined {
  return kind === "neo4j" || kind === "memgraph" ? kind : undefined;
}

/**
 * Where the catalog says a step computes with this kind of source: in the database's library
 * (when installed) or on the Kalzit server. Memgraph's library cannot be stopped while running,
 * so its steps whose work grows fastest stay on the server (`algorithm.not_cancellable`).
 */
export function plannedPlace(variant: GraphVariant, kind: string | undefined): Library | undefined {
  const library = libraryOf(kind);
  return library !== undefined && (variant.libraries ?? []).includes(library) ? library : undefined;
}
