import type { NodeDisplayData } from "sigma/types";
import type { GraphPalette } from "./colors";
import { type GraphView, labelAllowed, type Visibility } from "./view";

/**
 * What the renderer draws, as pure functions of the panel's state, so they are tested without
 * WebGL (SigmaCanvas.tsx applies them in its reducers).
 */

export type Direction = "left" | "right" | "up" | "down";

export interface DrawState {
  view: GraphView;
  palette: GraphPalette;
  visibility: Visibility;
  ranks: Int32Array;
  selected: number | null;
  /** Neighbours of the selection (view indexes), kept undimmed. */
  neighbours: ReadonlySet<number>;
}

/** What the renderer draws for one node, from the panel's state. */
export function nodeDisplay(
  index: number,
  data: NodeDisplayData,
  p: DrawState,
  ratio: number,
): Partial<NodeDisplayData> {
  const node = p.view.nodes[index];
  if (node === undefined || p.visibility.nodes[index] === 0) {
    return { ...data, visibility: "hidden" };
  }
  const isSelected = p.selected === index;
  const lit = p.selected === null || isSelected || p.neighbours.has(index);
  const group = node.group;
  const color =
    group < 0
      ? lit
        ? p.palette.neutral
        : p.palette.neutralDimmed
      : ((lit ? p.palette.series : p.palette.dimmed)[group % p.palette.series.length] ?? "#666");
  const allowed = labelAllowed(p.ranks[index] ?? 0, ratio, node.cluster >= 0);
  const labelVisibility = isSelected
    ? "visible"
    : p.selected !== null && !lit
      ? "hidden"
      : allowed
        ? "auto"
        : "hidden";
  return {
    ...data,
    color,
    labelColor: p.palette.text,
    size: isSelected ? data.size * 1.4 : data.size,
    labelVisibility,
    // A hidden label is dropped, not only hidden: the renderer lays out the glyphs of every
    // label it has, which for thousands of nodes takes seconds.
    label: labelVisibility === "hidden" ? null : data.label,
    zIndex: isSelected ? 1 : 0,
    labelFont: isSelected ? `${p.palette.boldWeight} ${p.palette.font}` : p.palette.font,
  };
}

/**
 * Up to this many edges, selecting a node dims the edges it does not touch. Beyond it, edges keep
 * their color and only the nodes are dimmed: drawing every edge again on each selection would
 * stall the page for a noticeable moment.
 */
export const DIM_EDGES_UP_TO = 5_000;

export function dimsEdges(view: GraphView): boolean {
  return view.edges.length <= DIM_EDGES_UP_TO;
}

/** An edge's color: dimmed when a selection leaves it out (in graphs that dim edges). */
export function edgeColor(
  edge: { source: number; target: number },
  p: Pick<DrawState, "view" | "palette" | "selected">,
): string {
  const lit =
    p.selected === null ||
    edge.source === p.selected ||
    edge.target === p.selected ||
    !dimsEdges(p.view);
  return lit ? p.palette.edge : p.palette.edgeDimmed;
}

/**
 * Keyboard navigation in the drawing: the visible node whose screen position lies most nearly in
 * the direction, weighing distance along it and the offset across it. Without a selection the
 * most connected visible node comes first.
 */
export function nodeToward(
  view: GraphView,
  visibility: Visibility,
  ranks: Int32Array,
  from: number | null,
  direction: Direction,
  display: (node: number) => { x: number; y: number } | undefined,
  toViewport: (point: { x: number; y: number }) => { x: number; y: number },
): number | null {
  if (from === null || display(from) === undefined) {
    let best: number | null = null;
    for (let i = 0; i < view.nodes.length; i++) {
      if (visibility.nodes[i] === 1 && (best === null || (ranks[i] ?? 0) < (ranks[best] ?? 0))) {
        best = i;
      }
    }
    return best;
  }
  const origin = toViewport(display(from) as { x: number; y: number });
  let best: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < view.nodes.length; i++) {
    if (i === from || visibility.nodes[i] === 0) continue;
    const data = display(i);
    if (data === undefined) continue;
    const point = toViewport(data);
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    // Along: distance in the direction (screen y grows downwards); across: sideways offset.
    const along =
      direction === "right" ? dx : direction === "left" ? -dx : direction === "down" ? dy : -dy;
    const across = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0) continue;
    const score = along + 2 * across;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
