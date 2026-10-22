import Graph from "graphology";
import type { GraphView } from "./view";

/**
 * Handing a view to the renderer. The renderer processes everything it is given at once, and
 * 20,000 edges take it most of a second; so the nodes (and a first chunk of edges) go over in
 * one step, the remaining edges in chunks of EDGE_CHUNK, one chunk per frame.
 */
export const EDGE_CHUNK = 3_000;

export interface HandoverTarget {
  setGraph(graph: Graph): unknown;
}

export interface Scheduler {
  schedule(callback: () => void): number;
  cancel(handle: number): void;
}

export const frames: Scheduler = {
  schedule: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export interface Handover {
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

export function handOver(
  target: HandoverTarget,
  view: GraphView,
  positions: Float32Array,
  scheduler: Scheduler = frames,
): Handover {
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
  target.setGraph(graph);
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
    graph,
    cancel: () => {
      if (handle !== null) scheduler.cancel(handle);
      handle = null;
    },
  };
}
