import { dimsEdges } from "./drawing";
import type { GraphView, Visibility } from "./view";

/** What the renderer is asked to draw again: everything, or the listed nodes and edges. */
export interface RefreshRequest {
  skipIndexation: true;
  partialGraph?: { nodes: string[]; edges: string[] };
}

export interface Refresher {
  refresh(request: RefreshRequest): unknown;
}

/**
 * Draws a new visibility (the time slider). In graphs that dim edges every edge may change with
 * the selection anyway, so all is drawn again; in large ones only the nodes and edges whose
 * visibility changed are, since drawing 20,000 edges again on every slider step would stall the
 * page. Node keys are view indexes, edge keys `e<index>`, as in SigmaCanvas.
 */
export function refreshVisibility(
  target: Refresher,
  view: GraphView,
  previous: Visibility | null,
  next: Visibility,
): void {
  if (
    previous === null ||
    dimsEdges(view) ||
    previous.nodes.length !== next.nodes.length ||
    previous.edges.length !== next.edges.length
  ) {
    target.refresh({ skipIndexation: true });
    return;
  }
  const nodes: string[] = [];
  for (let i = 0; i < next.nodes.length; i++) {
    if (previous.nodes[i] !== next.nodes[i]) nodes.push(String(i));
  }
  const edges: string[] = [];
  for (let i = 0; i < next.edges.length; i++) {
    if (previous.edges[i] !== next.edges[i]) edges.push(`e${i}`);
  }
  if (nodes.length > 0 || edges.length > 0) {
    target.refresh({ skipIndexation: true, partialGraph: { nodes, edges } });
  }
}
