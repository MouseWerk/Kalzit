import type { LayoutGuide, LayoutRequest } from "../layoutProtocol";

/**
 * What the layouts in this folder share. They work on the flat arrays of a layout request, in the
 * layout worker and, for small graphs without one, on the page. Distances are px at a zoom that
 * shows the drawing at its natural size, as in the hierarchy (layoutEngine.ts). Graph coordinates
 * grow upwards, so "down the page" is a smaller y.
 */

/** The least room between two nodes' edges. */
export const NODE_GAP = 16;
/** Space between a label's end and the next node. */
export const LABEL_GAP = 12;
/** The room between a layout and the strip of nodes it had no place for. */
export const STRIP_GAP = 72;
/** Nodes per column of a strip. */
export const STRIP_ROWS = 12;

export interface PlacedLayout {
  positions: Float32Array;
  guides: LayoutGuide[];
}

/** Says how many nodes a layout has placed so far. */
export type Work = (done: number, total: number) => void;

export function isFixed(request: Pick<LayoutRequest, "fixed">, node: number): boolean {
  return request.fixed?.[node] === 1;
}

/** Pinned nodes go back to where they were: a layout arranges the others around them. */
export function keepFixed(
  positions: Float32Array,
  request: Pick<LayoutRequest, "fixed" | "start" | "count">,
): Float32Array {
  const { fixed, start } = request;
  if (fixed === undefined) return positions;
  for (let i = 0; i < request.count; i++) {
    if (fixed[i] === 1) {
      positions[2 * i] = start[2 * i] ?? 0;
      positions[2 * i + 1] = start[2 * i + 1] ?? 0;
    }
  }
  return positions;
}

/** The largest node size of a request; 0 without nodes. */
export function largestSize(sizes: Float32Array): number {
  let max = 0;
  for (const size of sizes) if (size > max) max = size;
  return max;
}

/**
 * Puts `nodes` into a strip of columns whose top left is at (`left`, `top`): the nodes a layout
 * could not place stand there, never out of sight. Returns the strip's box.
 */
export function placeStrip(
  positions: Float32Array,
  nodes: readonly number[],
  left: number,
  top: number,
  cell: number,
): { x: number; y: number; width: number; height: number } {
  const rows = Math.min(STRIP_ROWS, Math.max(1, nodes.length));
  nodes.forEach((node, i) => {
    positions[2 * node] = left + Math.floor(i / rows) * cell;
    positions[2 * node + 1] = top - (i % rows) * cell;
  });
  const columns = Math.ceil(nodes.length / rows);
  return {
    x: left - cell / 2,
    y: top + cell / 2,
    width: columns * cell,
    height: rows * cell,
  };
}
