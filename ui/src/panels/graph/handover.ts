import Graph from "graphology";
import type { GraphView } from "./view";

/**
 * Handing a view to the renderer. The renderer processes everything it is given at once, and
 * 20,000 edges take it most of a second; so it is created with the nodes and a first chunk of
 * edges, and the remaining edges go into that same graph in chunks of EDGE_CHUNK, one chunk per
 * frame.
 *
 * The renderer has to be created for the graph it draws: Sigma 4 builds its index of parallel
 * edges for the graph it was constructed with, and `setGraph` does not rebuild it, so edges added
 * to a graph handed over with `setGraph` fail (NotFoundGraphError). A new view therefore gets a
 * new renderer, never `setGraph`.
 */
export const EDGE_CHUNK = 3_000;

export interface Scheduler {
  schedule(callback: () => void): number;
  cancel(handle: number): void;
}

export const frames: Scheduler = {
  schedule: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export interface Handover<R> {
  renderer: R;
  graph: Graph;
  /** Stops adding edges, for a newer view or an unmount. */
  cancel(): void;
}

function addEdges(graph: Graph, view: GraphView, from: number, to: number): void {
  for (let i = from; i < to; i++) {
    const edge = view.edges[i];
    if (edge !== undefined) {
      graph.addEdgeWithKey(`e${i}`, String(edge.source), String(edge.target), {
        size: edge.width,
      });
    }
  }
}

/** Builds the view's graph with its nodes and first edges, creates the renderer for it, and
 * adds the remaining edges to the same graph, a chunk per frame. */
export function handOver<R>(
  view: GraphView,
  positions: Float32Array,
  create: (graph: Graph) => R,
  scheduler: Scheduler = frames,
): Handover<R> {
  const graph = new Graph({ type: "directed", multi: true, allowSelfLoops: true });
  view.nodes.forEach((node, i) => {
    graph.addNode(String(i), {
      x: positions[2 * i] ?? 0,
      y: positions[2 * i + 1] ?? 0,
      size: node.size,
      label: node.caption,
    });
  });
  let added = Math.min(EDGE_CHUNK, view.edges.length);
  addEdges(graph, view, 0, added);
  const renderer = create(graph);
  let handle: number | null = null;
  const next = () => {
    handle = null;
    const end = Math.min(added + EDGE_CHUNK, view.edges.length);
    addEdges(graph, view, added, end);
    added = end;
    if (added < view.edges.length) handle = scheduler.schedule(next);
  };
  if (added < view.edges.length) handle = scheduler.schedule(next);
  return {
    renderer,
    graph,
    cancel: () => {
      if (handle !== null) scheduler.cancel(handle);
      handle = null;
    },
  };
}
