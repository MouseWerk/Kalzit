import type { GraphModel } from "../model";
import { type DrawnShape, nextShape } from "../shapes";
import type { GraphView } from "../view";
import {
  type EvaluateOptions,
  type Evaluation,
  evaluateRules,
  type ItemStyle,
  type StyleItem,
} from "./evaluate";
import { type EdgeArrow, type GraphStyle, readableStyle, type StyleColor } from "./schema";

/**
 * The style rules of a graph panel on its model, and what the drawing makes of them. The view
 * (which nodes and edges there are) stays as it is: rules change how things look, never the
 * layout's input, so editing a rule neither lays the graph out again nor moves the camera.
 */

/** A graph's nodes as the rules read them. */
export function nodeItems(model: Pick<GraphModel, "nodes">): StyleItem[] {
  return model.nodes.map((node) => ({ kinds: node.labels, properties: node.properties }));
}

/** A graph's edges as the rules read them. */
export function edgeItems(model: Pick<GraphModel, "edges">): StyleItem[] {
  return model.edges.map((edge) => ({ kinds: [edge.type], properties: edge.properties }));
}

/** The rules of both kinds evaluated on a model: per model node and per model edge. */
export interface GraphEvaluation {
  nodes: Evaluation;
  edges: Evaluation;
}

/** Evaluates a panel's style on its model; null when the panel has no rules. */
export function evaluateStyle(
  model: Pick<GraphModel, "nodes" | "edges">,
  style: GraphStyle,
  options?: EvaluateOptions,
): GraphEvaluation | null {
  const readable = readableStyle(style);
  if (readable.nodes.length === 0 && readable.edges.length === 0) return null;
  return {
    nodes: evaluateRules(readable.nodes, nodeItems(model), options),
    edges: evaluateRules(readable.edges, edgeItems(model), options),
  };
}

/** What rules set on a drawn node; a field that is absent keeps the basis. */
export interface NodeLook {
  caption?: string;
  /** In px. */
  size?: number;
  shape?: DrawnShape;
  color?: StyleColor;
  /** How saturated the color draws, 0.25 to 1 (a color by value); absent: fully. */
  shade?: number;
  icon?: string;
  border?: "solid" | "dashed";
  badge?: string;
}

/** What rules set on a drawn edge. */
export interface EdgeLook {
  /** In px. */
  width?: number;
  color?: StyleColor;
  dash?: "dashed" | "dotted";
  label?: string;
  arrow?: EdgeArrow;
}

/** The looks of a view's nodes and edges, by view index; a hole where only the basis applies. */
export interface StyledView {
  nodes: (NodeLook | undefined)[];
  edges: (EdgeLook | undefined)[];
  /** Whether a rule gives an edge a text of its own (the renderer then draws edge labels). */
  edgeLabels: boolean;
  /** The icons the looks name, each once. */
  icons: string[];
}

/**
 * The second cue of a color the palette hands out a second time (the ninth to twelfth value of a
 * rule "per unique value"): a node takes the shape after its own, an edge a dashed line. The
 * legend and the editor draw the same.
 */
export function shiftedShape(shape: DrawnShape): DrawnShape {
  return nextShape(shape);
}
export const SHIFTED_DASH = "dashed" as const;

/** One node's look from what the rules made of it; `shape` is the node's basis shape. */
export function nodeLook(style: ItemStyle, shape: DrawnShape): NodeLook {
  const { set } = style;
  const look: NodeLook = {};
  if (set.label !== undefined) look.caption = set.label;
  if (set.size !== undefined) look.size = set.size;
  if (set.shape !== undefined) look.shape = set.shape;
  // A color the palette hands out a second time comes with another shape, unless a rule set one.
  else if (style.shifted) look.shape = shiftedShape(shape);
  if (set.color !== undefined) look.color = set.color;
  if (set.color !== undefined && set.shade !== undefined) look.shade = set.shade;
  if (set.icon !== undefined) look.icon = set.icon;
  if (set.border === "solid" || set.border === "dashed") look.border = set.border;
  if (set.badge !== undefined) look.badge = set.badge;
  return look;
}

export function edgeLook(style: ItemStyle): EdgeLook {
  const { set } = style;
  const look: EdgeLook = {};
  if (set.width !== undefined) look.width = set.width;
  if (set.color !== undefined) look.color = set.color;
  if (set.dash === "dashed" || set.dash === "dotted") look.dash = set.dash;
  // A color handed out a second time comes with a dashed line, unless a rule set the line.
  else if (style.shifted && set.dash === undefined) look.dash = SHIFTED_DASH;
  if (set.label !== undefined) look.label = set.label;
  if (set.arrow !== undefined) look.arrow = set.arrow;
  return look;
}

/**
 * The looks of a view. A group of nodes (a cluster) and an edge merged between groups stand for
 * many items and keep the basis.
 */
export function styleView(view: GraphView, evaluation: GraphEvaluation): StyledView {
  const icons = new Set<string>();
  let edgeLabels = false;
  const nodes = view.nodes.map((node) => {
    const style = node.node >= 0 ? evaluation.nodes.styles[node.node] : null;
    if (style === null || style === undefined) return undefined;
    const look = nodeLook(style, node.shape);
    if (look.icon !== undefined) icons.add(look.icon);
    return look;
  });
  const edges = view.edges.map((edge) => {
    const style = edge.edge >= 0 ? evaluation.edges.styles[edge.edge] : null;
    if (style === null || style === undefined) return undefined;
    const look = edgeLook(style);
    if (look.label !== undefined) edgeLabels = true;
    return look;
  });
  return { nodes, edges, edgeLabels, icons: [...icons].sort() };
}

/** The view indexes of the nodes a node rule applies to, for selecting them from the legend. */
export function ruleNodes(view: GraphView, evaluation: GraphEvaluation, rule: number): number[] {
  const out: number[] = [];
  view.nodes.forEach((node, i) => {
    const style = node.node >= 0 ? evaluation.nodes.styles[node.node] : null;
    if (style?.rules.includes(rule) === true) out.push(i);
  });
  return out;
}

/**
 * The view indexes of the nodes a rule "per unique value" gives one of its colors; `value` null
 * stands for the values beyond the colored ones.
 */
export function valueNodes(
  view: GraphView,
  model: Pick<GraphModel, "nodes">,
  evaluation: GraphEvaluation,
  rule: number,
  property: string,
  value: string | null,
  shown: ReadonlySet<string>,
  text: (value: unknown) => string,
): number[] {
  const out: number[] = [];
  view.nodes.forEach((node, i) => {
    if (node.node < 0) return;
    if (evaluation.nodes.styles[node.node]?.rules.includes(rule) !== true) return;
    const own = text(model.nodes[node.node]?.properties[property]);
    if (value === null ? !shown.has(own) : own === value) out.push(i);
  });
  return out;
}
