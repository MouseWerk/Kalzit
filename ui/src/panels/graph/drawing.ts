import type { EdgeDisplayData, NodeDisplayData } from "sigma/types";
import type { GraphPalette, RampName } from "./colors";
import type { LabelMode, ShowWhen } from "./options";
import { type GraphView, labelAllowed, rampStep, type Visibility } from "./view";

/**
 * What the renderer draws, as pure functions of the panel's state, so they are tested without
 * WebGL (SigmaCanvas.tsx applies them in its reducers).
 */

export type Direction = "left" | "right" | "up" | "down";

/** How the panel draws: arrows, edge type labels, node labels (GraphPanelOptions). */
export interface DrawStyle {
  arrows: ShowWhen;
  edgeLabels: ShowWhen;
  labels: LabelMode;
  /** The largest nodes always labelled; 0 for none. */
  labelTop: number;
  /** The ramp of nodes colored by a number property. */
  ramp: RampName;
}

export const DEFAULT_STYLE: DrawStyle = {
  arrows: "always",
  edgeLabels: "never",
  labels: "zoom",
  labelTop: 0,
  ramp: "blues",
};

export interface DrawState {
  view: GraphView;
  palette: GraphPalette;
  visibility: Visibility;
  ranks: Int32Array;
  /** The selected nodes (view indexes); empty when nothing is selected. */
  selected: ReadonlySet<number>;
  /** Neighbours of the selection (view indexes), kept undimmed. */
  neighbours: ReadonlySet<number>;
  style: DrawStyle;
}

/** Space around a label's text on its background, in px. */
const LABEL_BACKGROUND_PADDING = 2;

function nodeColor(group: number, lit: boolean, p: Pick<DrawState, "palette" | "style">): string {
  const step = rampStep(group);
  if (step !== null) {
    return (lit ? p.palette.ramps : p.palette.dimmedRamps)[p.style.ramp][step] ?? p.palette.neutral;
  }
  if (group < 0) return lit ? p.palette.neutral : p.palette.neutralDimmed;
  return (
    (lit ? p.palette.series : p.palette.dimmed)[group % p.palette.series.length] ??
    p.palette.neutral
  );
}

/**
 * What the renderer draws for one node, from the panel's state. A selected node is shown quietly:
 * its label always, in the bold weight, on the neutral selection tint; everything that is neither
 * selected nor a neighbour is dimmed. No ring, glow or accent color.
 */
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
  const isSelected = p.selected.has(index);
  const selecting = p.selected.size > 0;
  const lit = !selecting || isSelected || p.neighbours.has(index);
  const color = nodeColor(node.group, lit, p);
  const rank = p.ranks[index] ?? 0;
  const mode = p.style.labels;
  const allowed =
    mode === "always" ||
    (mode === "zoom" && (rank < p.style.labelTop || labelAllowed(rank, ratio, node.cluster >= 0)));
  const labelVisibility = isSelected
    ? "visible"
    : selecting && !lit
      ? "hidden"
      : mode === "always"
        ? "visible"
        : allowed
          ? "auto"
          : "hidden";
  return {
    ...data,
    color,
    labelColor: p.palette.text,
    // A label on the canvas color stays readable where it crosses edges or a neighbour node; a
    // selected node's label sits on the selection tint.
    labelBackgroundColor: isSelected ? p.palette.selection : p.palette.background,
    labelBackgroundPadding: LABEL_BACKGROUND_PADDING,
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

function touches(edge: { source: number; target: number }, selected: ReadonlySet<number>) {
  return selected.has(edge.source) || selected.has(edge.target);
}

/** An edge's color: dimmed when a selection leaves it out (in graphs that dim edges). */
export function edgeColor(
  edge: { source: number; target: number },
  p: Pick<DrawState, "view" | "palette" | "selected">,
): string {
  const lit = p.selected.size === 0 || touches(edge, p.selected) || !dimsEdges(p.view);
  return lit ? p.palette.edge : p.palette.edgeDimmed;
}

/** What the renderer draws for one edge: color, arrow and type label by the panel's style. */
export function edgeDisplay(
  index: number,
  data: EdgeDisplayData,
  p: DrawState,
): Partial<EdgeDisplayData> {
  const edge = p.view.edges[index];
  if (edge === undefined || p.visibility.edges[index] === 0) {
    return { ...data, visibility: "hidden" };
  }
  const near = touches(edge, p.selected);
  const shows = (when: ShowWhen) => when === "always" || (when === "selection" && near);
  return {
    ...data,
    color: edgeColor(edge, p),
    ...(shows(p.style.arrows) ? { head: "arrow" } : {}),
    label: shows(p.style.edgeLabels) && edge.type !== "" ? edge.type : null,
    labelColor: p.palette.text,
    labelBackgroundColor: p.palette.background,
  };
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
