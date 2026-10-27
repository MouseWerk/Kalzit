import type { GraphModel } from "./model";
import { MAX_EDGE_WIDTH, MAX_NODE_SIZE, MIN_EDGE_WIDTH, MIN_NODE_SIZE, scaleValues } from "./model";

/**
 * What a graph panel draws: the model's nodes one by one, or, for large graphs, groups of nodes
 * with the same label ("clusters") until a group is opened. Layout, renderer, keyboard and the
 * table all work on this, so a cluster behaves like one node everywhere.
 */

export interface ViewNode {
  key: string;
  /** Model node index, or -1 for a cluster. */
  node: number;
  /** Label index the cluster stands for; -1 for a single node. */
  cluster: number;
  caption: string;
  /**
   * Palette index, -1 for the neutral color, or a step of the panel's ramp (`rampGroup`) when
   * nodes are colored by a number property.
   */
  group: number;
  size: number;
  /** Nodes a cluster stands for (1 for a node). */
  members: number;
}

export interface ViewEdge {
  key: string;
  /** View node indexes. */
  source: number;
  target: number;
  width: number;
  /** Model edge index, or -1 for edges merged between clusters. */
  edge: number;
  /** Model edges this one stands for. */
  count: number;
  /** The edge's type, for its label; "" for edges merged between clusters. */
  type: string;
}

export interface GraphView {
  nodes: ViewNode[];
  edges: ViewEdge[];
  /** Model node index to its view node. */
  nodeOf: Int32Array;
  /** Model edge index to its view edge, -1 when it is inside a cluster. */
  edgeOf: Int32Array;
  clustered: boolean;
}

export interface ViewInput {
  sizes: Float32Array;
  widths: Float32Array;
  /** Palette group per model node. */
  groups: Int32Array;
  /** Group nodes by label. */
  cluster: boolean;
  /** Label indexes of clusters the user opened. */
  open: ReadonlySet<number>;
  /** Caption of a cluster: its label and how many nodes it holds. */
  clusterCaption: (label: string, members: number) => string;
  /** The name of nodes without a label. */
  unlabelled: string;
  /** The palette group of a cluster, by its label index (default: the label index). */
  labelGroup?: (label: number) => number;
}

/** The group of a ramp step (0 to 4): below -1, so it is neither a palette index nor neutral. */
export function rampGroup(step: number): number {
  return -2 - step;
}

/** The ramp step of a group, or null when the group is a palette index or neutral. */
export function rampStep(group: number): number | null {
  return group <= -2 ? -2 - group : null;
}

export function buildView(model: GraphModel, input: ViewInput): GraphView {
  const nodes: ViewNode[] = [];
  const nodeOf = new Int32Array(model.nodes.length).fill(-1);
  const clusterIndex = new Map<number, number>();
  const clusterMembers: number[] = [];

  model.nodes.forEach((node, i) => {
    const grouped = input.cluster && !input.open.has(node.label);
    if (!grouped) {
      nodeOf[i] = nodes.length;
      nodes.push({
        key: `n:${node.id}`,
        node: i,
        cluster: -1,
        caption: node.caption,
        group: input.groups[i] ?? -1,
        size: input.sizes[i] ?? MIN_NODE_SIZE,
        members: 1,
      });
      return;
    }
    let at = clusterIndex.get(node.label);
    if (at === undefined) {
      at = nodes.length;
      clusterIndex.set(node.label, at);
      clusterMembers.push(at);
      nodes.push({
        key: `c:${node.label}`,
        node: -1,
        cluster: node.label,
        caption: "",
        group: node.label < 0 ? -1 : (input.labelGroup?.(node.label) ?? node.label),
        size: MIN_NODE_SIZE,
        members: 0,
      });
    }
    nodeOf[i] = at;
    (nodes[at] as ViewNode).members++;
  });

  if (clusterMembers.length > 0) {
    const sizes = scaleValues(
      clusterMembers.map((at) => (nodes[at] as ViewNode).members),
      MIN_NODE_SIZE * 2,
      MAX_NODE_SIZE * 1.5,
    );
    clusterMembers.forEach((at, i) => {
      const view = nodes[at] as ViewNode;
      view.size = sizes[i] ?? MAX_NODE_SIZE;
      view.caption = input.clusterCaption(
        model.labels[view.cluster] ?? input.unlabelled,
        view.members,
      );
    });
  }

  const edges: ViewEdge[] = [];
  const edgeOf = new Int32Array(model.edges.length).fill(-1);
  const merged = new Map<string, number>();
  model.edges.forEach((edge, i) => {
    const source = nodeOf[edge.source] as number;
    const target = nodeOf[edge.target] as number;
    const sourceNode = nodes[source] as ViewNode;
    const targetNode = nodes[target] as ViewNode;
    if (sourceNode.node >= 0 && targetNode.node >= 0) {
      edgeOf[i] = edges.length;
      edges.push({
        key: `e:${edge.id}`,
        source,
        target,
        width: input.widths[i] ?? 1,
        edge: i,
        count: 1,
        type: edge.type,
      });
      return;
    }
    if (source === target) {
      // Inside one cluster: nothing to draw.
      return;
    }
    const key = `m:${source}>${target}`;
    let at = merged.get(key);
    if (at === undefined) {
      at = edges.length;
      merged.set(key, at);
      edges.push({ key, source, target, width: 1, edge: -1, count: 0, type: "" });
    }
    edgeOf[i] = at;
    (edges[at] as ViewEdge).count++;
  });
  if (merged.size > 0) {
    const ats = [...merged.values()];
    const widths = scaleValues(
      ats.map((at) => (edges[at] as ViewEdge).count),
      MIN_EDGE_WIDTH * 2,
      MAX_EDGE_WIDTH,
    );
    ats.forEach((at, i) => {
      (edges[at] as ViewEdge).width = widths[i] ?? 1;
    });
  }

  return { nodes, edges, nodeOf, edgeOf, clustered: clusterMembers.length > 0 };
}

/** Whether the network groups nodes: always, never, or above either automatic threshold. */
export function shouldCluster(
  mode: "auto" | "label" | "off",
  size: { nodes: number; edges: number },
  limits: { nodes: number; edges: number },
) {
  return (
    mode === "label" ||
    (mode === "auto" && (size.nodes > limits.nodes || size.edges > limits.edges))
  );
}

export interface Visibility {
  nodes: Uint8Array;
  edges: Uint8Array;
}

/** Everything visible: without a time slider, or with the slider at the end. */
export function allVisible(view: GraphView): Visibility {
  return {
    nodes: new Uint8Array(view.nodes.length).fill(1),
    edges: new Uint8Array(view.edges.length).fill(1),
  };
}

/**
 * The graph at time `at`: edges with a timestamp after it are hidden, and so are nodes whose
 * every timestamped edge is hidden. Edges without a timestamp always show, so do nodes without
 * timestamped edges, since nothing says when they appear.
 */
export function visibleAt(
  model: GraphModel,
  view: GraphView,
  times: Float64Array,
  at: number,
): Visibility {
  const edgeShown = new Uint8Array(view.edges.length);
  // Per model node: 0 no timed edge, 1 only later ones, 2 at least one shown.
  const nodeState = new Uint8Array(model.nodes.length);
  for (let i = 0; i < model.edges.length; i++) {
    const time = times[i] as number;
    const edge = model.edges[i] as GraphModel["edges"][number];
    const timed = !Number.isNaN(time);
    const shown = !timed || time <= at;
    const v = view.edgeOf[i] as number;
    if (shown && v >= 0) edgeShown[v] = 1;
    if (timed) {
      const mark = shown ? 2 : 1;
      if ((nodeState[edge.source] as number) < mark) nodeState[edge.source] = mark;
      if ((nodeState[edge.target] as number) < mark) nodeState[edge.target] = mark;
    }
  }
  const nodeShown = new Uint8Array(view.nodes.length);
  for (let i = 0; i < model.nodes.length; i++) {
    if (nodeState[i] !== 1) nodeShown[view.nodeOf[i] as number] = 1;
  }
  // An edge needs both ends.
  view.edges.forEach((edge, i) => {
    if (nodeShown[edge.source] === 0 || nodeShown[edge.target] === 0) edgeShown[i] = 0;
  });
  return { nodes: nodeShown, edges: edgeShown };
}

/** Sorted distinct edge times, for the slider's steps. */
export function timeSteps(times: Float64Array): number[] {
  const set = new Set<number>();
  for (const time of times) {
    if (!Number.isNaN(time)) set.add(time);
  }
  return [...set].sort((a, b) => a - b);
}

/** Labels shown at the fitted zoom; zooming in by a factor shows that factor squared more. */
export const LABEL_BUDGET = 40;

/** Rank per view node by size (then by order), the order labels appear in as one zooms in. */
export function labelRanks(view: GraphView): Int32Array {
  const order = view.nodes.map((_, i) => i);
  order.sort(
    (a, b) => (view.nodes[b] as ViewNode).size - (view.nodes[a] as ViewNode).size || a - b,
  );
  const rank = new Int32Array(view.nodes.length);
  order.forEach((node, i) => {
    rank[node] = i;
  });
  return rank;
}

/**
 * Whether a node's label may show at a camera ratio (1 is the whole graph, 0.5 twice as close):
 * the LABEL_BUDGET best connected first, more as one zooms in. Clusters always carry their label.
 */
export function labelAllowed(rank: number, cameraRatio: number, isCluster: boolean): boolean {
  if (isCluster) {
    return true;
  }
  const ratio = Math.max(cameraRatio, 1e-3);
  return rank < LABEL_BUDGET / (ratio * ratio);
}
