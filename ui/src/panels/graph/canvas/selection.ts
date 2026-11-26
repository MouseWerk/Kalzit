import type { GraphView, Visibility } from "../view";

/**
 * Selecting by area and by rule on a graph panel's canvas (Graph 0.8.1 board, frame 4): what lies
 * in a rectangle or inside a lasso, the selection inverted, its neighbours added, and the edges a
 * selection of nodes carries. Pure functions of the view, so they are tested without a renderer.
 */

/** What an area does to the selection: replace it, add to it (Shift), take out of it (Alt). */
export type AreaMode = "replace" | "add" | "remove";

export type Point = readonly [number, number];

/** An area on the canvas, in px from its top left. */
export type Area =
  | { kind: "rect"; from: Point; to: Point }
  | { kind: "lasso"; points: readonly Point[] };

/** Whether a point lies inside a closed polygon (even-odd rule; the last point joins the first). */
export function insidePolygon(x: number, y: number, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as Point;
    const [xj, yj] = polygon[j] as Point;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether a point lies in the area. A lasso of fewer than three points holds nothing. */
export function inArea(x: number, y: number, area: Area): boolean {
  if (area.kind === "rect") {
    const [x0, x1] = [Math.min(area.from[0], area.to[0]), Math.max(area.from[0], area.to[0])];
    const [y0, y1] = [Math.min(area.from[1], area.to[1]), Math.max(area.from[1], area.to[1])];
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  }
  return area.points.length >= 3 && insidePolygon(x, y, area.points);
}

/**
 * The nodes whose centre lies in the area. `points` holds each node's centre on the canvas in px
 * (interleaved x, y); a node that is not drawn has NaN there and is never taken.
 */
export function nodesInArea(points: ArrayLike<number>, area: Area): number[] {
  const out: number[] = [];
  for (let i = 0; 2 * i + 1 < points.length; i++) {
    const x = points[2 * i] as number;
    const y = points[2 * i + 1] as number;
    if (Number.isFinite(x) && Number.isFinite(y) && inArea(x, y, area)) out.push(i);
  }
  return out;
}

/** The selection after an area took `keys`: replaced, extended (in order), or reduced. */
export function applyArea(
  current: readonly string[],
  keys: readonly string[],
  mode: AreaMode,
): string[] {
  if (mode === "replace") return [...new Set(keys)];
  if (mode === "add") return [...new Set([...current, ...keys])];
  const out = new Set(keys);
  return current.filter((key) => !out.has(key));
}

/** Every visible node that is not selected: "Invert selection". */
export function inverted(
  view: GraphView,
  visibility: Visibility,
  selected: ReadonlySet<number>,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < view.nodes.length; i++) {
    if (visibility.nodes[i] === 1 && !selected.has(i)) out.push(i);
  }
  return out;
}

/** Every visible node: "Select all". */
export function allNodes(view: GraphView, visibility: Visibility): number[] {
  return inverted(view, visibility, new Set());
}

/** The visible neighbours of the selection that are not selected yet, in the order of the edges. */
export function neighboursOf(
  view: GraphView,
  visibility: Visibility,
  selected: ReadonlySet<number>,
): number[] {
  const out = new Set<number>();
  view.edges.forEach((edge, i) => {
    if (visibility.edges[i] !== 1) return;
    if (selected.has(edge.source) && !selected.has(edge.target)) out.add(edge.target);
    if (selected.has(edge.target) && !selected.has(edge.source)) out.add(edge.source);
  });
  return [...out].filter((i) => visibility.nodes[i] === 1);
}

/** The visible edges a selection of nodes carries: the ones with both ends selected. */
export function edgesWithin(
  view: GraphView,
  visibility: Visibility,
  selected: ReadonlySet<number>,
): number[] {
  const out: number[] = [];
  view.edges.forEach((edge, i) => {
    if (visibility.edges[i] === 1 && selected.has(edge.source) && selected.has(edge.target)) {
      out.push(i);
    }
  });
  return out;
}

/** The visible edges of a type: "Select all edges of type PLACED". */
export function edgesOfType(view: GraphView, visibility: Visibility, type: string): number[] {
  const out: number[] = [];
  view.edges.forEach((edge, i) => {
    if (visibility.edges[i] === 1 && edge.edge >= 0 && edge.type === type) out.push(i);
  });
  return out;
}

/**
 * A visibility without the hidden nodes and edges (by view index), and without the edges that
 * lost an end: hiding takes things out of the view, never out of the result.
 */
export function withoutHidden(
  view: GraphView,
  visibility: Visibility,
  hiddenNodes: ReadonlySet<number>,
  hiddenEdges: ReadonlySet<number>,
): Visibility {
  if (hiddenNodes.size === 0 && hiddenEdges.size === 0) return visibility;
  const nodes = visibility.nodes.slice();
  for (const i of hiddenNodes) nodes[i] = 0;
  const edges = visibility.edges.slice();
  for (const i of hiddenEdges) edges[i] = 0;
  view.edges.forEach((edge, i) => {
    if (nodes[edge.source] === 0 || nodes[edge.target] === 0) edges[i] = 0;
  });
  return { nodes, edges };
}

/** How many nodes and edges a visibility shows. */
export function shownCounts(visibility: Visibility): { nodes: number; edges: number } {
  let nodes = 0;
  let edges = 0;
  for (const v of visibility.nodes) nodes += v;
  for (const v of visibility.edges) edges += v;
  return { nodes, edges };
}
