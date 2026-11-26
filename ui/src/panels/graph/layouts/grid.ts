import type { LayoutRequest } from "../layoutProtocol";
import { movable } from "./circular";
import { keepFixed, LABEL_GAP, largestSize, NODE_GAP, type PlacedLayout } from "./shared";

/** How much wider than tall the grid is drawn, about the shape of a panel. */
export const GRID_ASPECT = 1.5;

export interface GridLayout extends PlacedLayout {
  columns: number;
  rows: number;
  cell: { width: number; height: number };
}

/**
 * Rows and columns, filled row by row from the top left in the request's order: good for counting
 * and comparing. A cell is as wide as the largest node and an average label, so names have room
 * beside their nodes.
 */
export function gridLayout(request: LayoutRequest): GridLayout {
  const positions = new Float32Array(request.count * 2);
  const nodes = movable(request);
  const n = nodes.length;
  const largest = largestSize(request.sizes);
  let labels = 0;
  for (const node of nodes) labels += request.labels[node] ?? 0;
  const label = n === 0 ? 0 : labels / n;
  const cell = {
    width: 2 * largest + NODE_GAP + (label > 0 ? LABEL_GAP + label : 0),
    height: 2 * largest + NODE_GAP,
  };
  const columns = Math.max(1, Math.ceil(Math.sqrt((n * GRID_ASPECT * cell.height) / cell.width)));
  const rows = Math.ceil(n / columns);
  const left = (-(columns - 1) * cell.width) / 2;
  const top = ((rows - 1) * cell.height) / 2;
  nodes.forEach((node, i) => {
    positions[2 * node] = left + (i % columns) * cell.width;
    positions[2 * node + 1] = top - Math.floor(i / columns) * cell.height;
  });
  return { positions: keepFixed(positions, request), guides: [], columns, rows, cell };
}
