import type { EdgeDisplayData, NodeDisplayData } from "sigma/types";
import type { GraphPalette, RampName } from "./colors";
import { LABEL_PAD } from "./labelCollisions";
import type { LabelMode, ShowWhen } from "./options";
import { SHAPE_SCALE } from "./shapes";
import type { StyledView } from "./style/apply";
import {
  BORDER_ATTRIBUTE,
  BORDER_CODE,
  BORDER_COLOR_ATTRIBUTE,
  CLEAR,
  DASH_PATTERN,
  EDGE_DASH_ATTRIBUTE,
  EDGE_GAP_ATTRIBUTE,
  EDGE_PLAIN_ATTRIBUTE,
  ICON_ATTRIBUTE,
  ICON_COLOR_ATTRIBUTE,
} from "./style/attributes";
import { ruleColor } from "./style/colors";
import { iconRect, NO_ICON } from "./style/iconAtlas";
import type { StyleColor } from "./style/schema";
import { type GraphView, LABEL_BUDGET, labelAllowed, rampStep, type Visibility } from "./view";

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
  /** The selected edges (view indexes); absent or empty when none is. */
  selectedEdges?: ReadonlySet<number> | undefined;
  drawStyle: DrawStyle;
  /** What the style rules of the panel set, by view index (style/apply.ts); absent without rules. */
  styled?: StyledView | null | undefined;
  /** A path or a quick action's answer, held up while everything else is dimmed. */
  emphasis?: Emphasis | null | undefined;
}

/**
 * What a quick action holds up (board Graph082, frames 9 and 10): its nodes and edges stay lit,
 * the edges of the chosen path are drawn strong in the text color, everything else is dimmed.
 * Never the accent color: it is a state of the view, not a property of the data.
 */
export interface Emphasis {
  /** View node indexes. */
  nodes: ReadonlySet<number>;
  /** View edge indexes, drawn lit. */
  edges: ReadonlySet<number>;
  /** View edge indexes of the chosen path, drawn strong. */
  strong: ReadonlySet<number>;
}

/** Whether something is singled out, so the rest is dimmed: a selected node or edge. */
export function singlesOut(p: Pick<DrawState, "selected" | "selectedEdges" | "emphasis">): boolean {
  return p.selected.size > 0 || (p.selectedEdges?.size ?? 0) > 0 || (p.emphasis ?? null) !== null;
}

/** Whether a node is lit: nothing singled out, or it is selected, a neighbour or held up. */
export function nodeLit(
  index: number,
  p: Pick<DrawState, "selected" | "selectedEdges" | "neighbours" | "emphasis">,
): boolean {
  if (p.emphasis !== null && p.emphasis !== undefined) return p.emphasis.nodes.has(index);
  return !singlesOut(p) || p.selected.has(index) || p.neighbours.has(index);
}

/** A selected edge is drawn this much wider. */
export const SELECTED_EDGE_SCALE = 1.75;

/** Space around a label's text on its background, in px (what the label check counts with). */
const LABEL_BACKGROUND_PADDING = LABEL_PAD;

function nodeColor(
  group: number,
  lit: boolean,
  p: Pick<DrawState, "palette" | "drawStyle">,
): string {
  const step = rampStep(group);
  if (step !== null) {
    return (
      (lit ? p.palette.ramps : p.palette.dimmedRamps)[p.drawStyle.ramp][step] ?? p.palette.neutral
    );
  }
  if (group < 0) return lit ? p.palette.neutral : p.palette.neutralDimmed;
  return (
    (lit ? p.palette.series : p.palette.dimmed)[group % p.palette.series.length] ??
    p.palette.neutral
  );
}

/** A selected node is drawn this much larger. */
export const SELECTED_SCALE = 1.4;

/**
 * Whether a node's label shows: "visible" whatever it covers (selected, or labels set to always),
 * "auto" where there is room for it, "hidden" not at all (dimmed, or not at this zoom level).
 */
export function labelWish(
  index: number,
  p: Pick<
    DrawState,
    | "view"
    | "visibility"
    | "ranks"
    | "selected"
    | "neighbours"
    | "selectedEdges"
    | "drawStyle"
    | "emphasis"
  >,
  ratio: number,
  budget: number = LABEL_BUDGET,
): "visible" | "auto" | "hidden" {
  const node = p.view.nodes[index];
  if (node === undefined || p.visibility.nodes[index] === 0) return "hidden";
  if (p.selected.has(index)) return "visible";
  // A path's nodes carry their name tags; the rest of the drawing is dimmed and unnamed.
  if (p.emphasis !== null && p.emphasis !== undefined) {
    return p.emphasis.nodes.has(index) ? "visible" : "hidden";
  }
  if (singlesOut(p) && !p.neighbours.has(index)) return "hidden";
  const mode = p.drawStyle.labels;
  if (mode === "always") return "visible";
  const rank = p.ranks[index] ?? 0;
  const allowed =
    mode === "zoom" &&
    (rank < p.drawStyle.labelTop || labelAllowed(rank, ratio, node.cluster >= 0, budget));
  return allowed ? "auto" : "hidden";
}

/**
 * What the renderer draws for one node, from the panel's state. A selected node is shown quietly:
 * its label always, in the bold weight, on the neutral selection tint; everything that is neither
 * selected nor a neighbour is dimmed. No ring, glow or accent color. The node takes its label's
 * shape (shapes.ts), scaled so every shape covers about the area of the circle, and all nodes by
 * `nodeScale` in a panel too short for their size (spread.ts). Whether a label that may show has
 * room for it is decided per frame (labelRoom.ts).
 */
export function nodeDisplay(
  index: number,
  data: NodeDisplayData,
  p: DrawState,
  ratio: number,
  budget: number = LABEL_BUDGET,
  nodeScale = 1,
): Partial<NodeDisplayData> {
  const node = p.view.nodes[index];
  if (node === undefined || p.visibility.nodes[index] === 0) {
    return { ...data, visibility: "hidden" };
  }
  const isSelected = p.selected.has(index);
  const lit = nodeLit(index, p);
  // What a rule set wins over the basis; a rule's size is in px, like the panel's size range.
  const look = p.styled?.nodes[index];
  const shape = look?.shape ?? node.shape;
  const color =
    look?.color === undefined
      ? nodeColor(node.group, lit, p)
      : ruleColor(p.palette, look.color, lit);
  const labelVisibility = labelWish(index, p, ratio, budget);
  const size = (look?.size ?? data.size) * SHAPE_SCALE[shape] * nodeScale;
  const caption = look?.caption ?? data.label;
  // What the style layers of the renderer read (style/sigmaLayers.ts). The frame is neutral, in
  // the text color, and the icon in the canvas color so it reads on every fill; the frame
  // follows the node when a selection dims it.
  const layers = {
    [BORDER_ATTRIBUTE]: BORDER_CODE[look?.border ?? "none"],
    [BORDER_COLOR_ATTRIBUTE]: lit ? p.palette.text : p.palette.neutralDimmed,
    [ICON_ATTRIBUTE]: look?.icon === undefined ? NO_ICON : iconRect(look.icon),
    [ICON_COLOR_ATTRIBUTE]: p.palette.background,
  };
  return {
    ...data,
    ...layers,
    color,
    labelColor: p.palette.text,
    // A label on the canvas color stays readable where it crosses edges or a neighbour node; a
    // selected node's label sits on the selection tint.
    labelBackgroundColor: isSelected ? p.palette.selection : p.palette.background,
    labelBackgroundPadding: LABEL_BACKGROUND_PADDING,
    shape,
    size: isSelected ? size * SELECTED_SCALE : size,
    labelVisibility,
    // A hidden label is dropped, not only hidden: the renderer lays out the glyphs of every
    // label it has, which for thousands of nodes takes seconds.
    label: labelVisibility === "hidden" ? null : caption,
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

/**
 * An edge's color: dimmed when a selection leaves it out (in graphs that dim edges). A selected
 * edge takes the text color: strong and neutral, never an accent, and over a rule's color too.
 * `rule` is the color a style rule set for it.
 */
export function edgeColor(
  edge: { source: number; target: number },
  p: Pick<DrawState, "view" | "palette" | "selected" | "selectedEdges" | "emphasis">,
  index = -1,
  rule?: StyleColor,
): string {
  if (p.selectedEdges?.has(index) === true) return p.palette.text;
  if (p.emphasis !== null && p.emphasis !== undefined) {
    if (p.emphasis.strong.has(index)) return p.palette.text;
    const held = p.emphasis.edges.has(index);
    if (rule !== undefined) return ruleColor(p.palette, rule, held);
    return held ? p.palette.edge : p.palette.edgeDimmed;
  }
  const lit = !singlesOut(p) || touches(edge, p.selected) || !dimsEdges(p.view);
  if (rule !== undefined) return ruleColor(p.palette, rule, lit);
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
  const isSelected = p.selectedEdges?.has(index) === true || p.emphasis?.strong.has(index) === true;
  const near = isSelected || touches(edge, p.selected);
  const shows = (when: ShowWhen) => when === "always" || (when === "selection" && near);
  // What a rule set wins over the panel's options: its arrow and its text show always.
  const look = p.styled?.edges[index];
  const color = edgeColor(edge, p, index, look?.color);
  const arrow = look?.arrow === undefined ? shows(p.drawStyle.arrows) : look.arrow === "direction";
  // A selected edge always names its type, where the panel draws edge labels at all.
  const typeLabel =
    (isSelected ? p.drawStyle.edgeLabels !== "never" : shows(p.drawStyle.edgeLabels)) &&
    edge.type !== ""
      ? edge.type
      : null;
  const pattern = look?.dash === undefined ? null : DASH_PATTERN[look.dash];
  // What the edge layers of the renderer read: a dashed edge has no plain color (its gaps stay
  // clear), a solid one no dashes.
  const layers = {
    [EDGE_PLAIN_ATTRIBUTE]: pattern === null ? color : CLEAR,
    [EDGE_DASH_ATTRIBUTE]: pattern === null ? 0 : pattern[0],
    [EDGE_GAP_ATTRIBUTE]: pattern === null ? 0 : pattern[1],
  };
  return {
    ...data,
    ...layers,
    color,
    size: (look?.width ?? data.size) * (isSelected ? SELECTED_EDGE_SCALE : 1),
    ...(isSelected ? { zIndex: 1 } : {}),
    ...(arrow ? { head: "arrow" } : {}),
    label: look?.label ?? typeLabel,
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
