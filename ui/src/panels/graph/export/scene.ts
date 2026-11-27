import {
  type Box,
  blockedLabels,
  type DrawnNode,
  labelBox,
  type WantedLabel,
} from "../labelCollisions";
import type { NodeShape } from "../shapes";

/**
 * What a graph panel draws at one moment, read from the renderer (readScene.ts) and free of it:
 * every visible node with its place, size, shape, color and label, and every visible edge. The
 * picture formats (SVG, PDF, PNG) are all made from this, so they show the same drawing.
 */

export interface SceneNode {
  /** The view node's index. */
  index: number;
  /** The centre, in px from the top left of the drawing area. */
  x: number;
  y: number;
  /** The circle's radius, the square's half side or the diamond's half diagonal, in px. */
  radius: number;
  shape: NodeShape;
  color: string;
  /** The label the node would show at this zoom level; null for none. */
  label: string | null;
  /** Whether the drawing shows that label right now (it had room). */
  labelShown: boolean;
  /** Shown whatever it covers: a selected node, or labels set to "always". */
  labelForced: boolean;
  /** A selected node: its label is bold, on the selection tint. */
  selected: boolean;
  /** The order labels are placed in: lower first. */
  rank: number;
}

export interface SceneEdge {
  /** Places in `Scene.nodes`. */
  source: number;
  target: number;
  color: string;
  width: number;
  arrow: boolean;
  /** The edge's type, where the panel shows it; null for none. */
  label: string | null;
}

export interface Scene {
  /** The drawing area's size in px. */
  width: number;
  height: number;
  nodes: SceneNode[];
  edges: SceneEdge[];
  colors: { text: string; background: string; selection: string };
  /** The label font: its family as CSS writes it, the weight of bold labels and the size in px. */
  font: string;
  boldWeight: string;
  labelSize: number;
}

/** Which part of the drawing a picture holds. */
export type ImageScope = "view" | "all" | "selection";

/** The width of a text in px at the label size. */
export type Measure = (text: string, bold: boolean) => number;

/** Free room around a picture's content, in px. */
export const SCENE_PADDING = 24;
/** A fitted picture is never drawn more than this much larger than the panel shows it. */
export const MAX_FIT_SCALE = 3;
/** The smallest picture, so a single node still has a frame around it. */
const MIN_SIZE = 120;

/** A scene cut to a scope: what is drawn, where, and whether it is clipped to its size. */
export interface FramedScene extends Scene {
  /** Places in `nodes` of the nodes whose label is drawn. */
  labelled: Set<number>;
  /** The visible part is cut at the panel's edges; a fitted picture holds all of its content. */
  clipped: boolean;
}

function drawn(node: SceneNode): DrawnNode {
  return { index: node.index, x: node.x, y: node.y, radius: node.radius, shape: node.shape };
}

/** The box a node's label takes, as the panel places it: right of the node. */
export function sceneLabelBox(node: SceneNode, measure: Measure, labelSize: number): Box {
  return labelBox(drawn(node), measure(node.label ?? "", node.selected), labelSize);
}

/** The scene with only the nodes that pass, and the edges between them. */
function keepNodes(scene: Scene, keep: (node: SceneNode) => boolean): Scene {
  const place = new Map<number, number>();
  const nodes: SceneNode[] = [];
  scene.nodes.forEach((node, i) => {
    if (keep(node)) {
      place.set(i, nodes.length);
      nodes.push(node);
    }
  });
  const edges: SceneEdge[] = [];
  for (const edge of scene.edges) {
    const source = place.get(edge.source);
    const target = place.get(edge.target);
    if (source !== undefined && target !== undefined) edges.push({ ...edge, source, target });
  }
  return { ...scene, nodes, edges };
}

/**
 * The scene for a picture.
 *
 * - `view`: what the panel shows, at its size, cut at its edges, with the labels it shows.
 * - `all`: every visible node, also those the camera left out, fitted into the panel's size (as
 *   "Show all" would) and then sized to its content.
 * - `selection`: only the selected nodes and the edges between them, fitted the same way.
 *
 * A fitted picture moves the nodes, so which labels have room is decided again, by the rules of
 * the panel (labelCollisions.ts): forced labels first, then the best ranked, none over a node or
 * another label.
 */
export function frameScene(scene: Scene, scope: ImageScope, measure: Measure): FramedScene {
  if (scope === "view") {
    const labelled = new Set<number>();
    scene.nodes.forEach((node, i) => {
      if (node.label !== null && node.labelShown) labelled.add(i);
    });
    return { ...scene, labelled, clipped: true };
  }
  const part = scope === "selection" ? keepNodes(scene, (node) => node.selected) : scene;
  if (part.nodes.length === 0) {
    return { ...part, width: MIN_SIZE, height: MIN_SIZE, labelled: new Set(), clipped: false };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of part.nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  // Node sizes are px on screen whatever the zoom, so only the centres are scaled.
  const room = (size: number) => Math.max(1, size - 2 * SCENE_PADDING);
  const scaleFor = (span: number, size: number) =>
    span <= 0 ? Number.POSITIVE_INFINITY : room(size) / span;
  const scale = Math.min(
    MAX_FIT_SCALE,
    scaleFor(maxX - minX, scene.width),
    scaleFor(maxY - minY, scene.height),
  );
  const factor = Number.isFinite(scale) ? scale : 1;
  const moved = part.nodes.map((node) => ({
    ...node,
    x: (node.x - minX) * factor,
    y: (node.y - minY) * factor,
  }));
  const wanted: (WantedLabel & { rank: number; place: number })[] = [];
  moved.forEach((node, place) => {
    if (node.label === null) return;
    wanted.push({
      index: node.index,
      box: sceneLabelBox(node, measure, scene.labelSize),
      forced: node.labelForced,
      rank: node.rank,
      place,
    });
  });
  wanted.sort((a, b) => a.rank - b.rank);
  const blocked = blockedLabels(moved.map(drawn), wanted);
  const shown = wanted.filter((label) => !blocked.has(label.index));
  // The content's box: every node's shape and every label that shows.
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const reach = (box: Box) => {
    left = Math.min(left, box.minX);
    top = Math.min(top, box.minY);
    right = Math.max(right, box.maxX);
    bottom = Math.max(bottom, box.maxY);
  };
  for (const node of moved) {
    reach({
      minX: node.x - node.radius,
      maxX: node.x + node.radius,
      minY: node.y - node.radius,
      maxY: node.y + node.radius,
    });
  }
  for (const label of shown) reach(label.box);
  const width = Math.max(MIN_SIZE, Math.ceil(right - left + 2 * SCENE_PADDING));
  const height = Math.max(MIN_SIZE, Math.ceil(bottom - top + 2 * SCENE_PADDING));
  // Centred where the content is smaller than the smallest picture.
  const dx = (width - (right - left)) / 2 - left;
  const dy = (height - (bottom - top)) / 2 - top;
  return {
    ...part,
    width,
    height,
    nodes: moved.map((node) => ({ ...node, x: node.x + dx, y: node.y + dy })),
    labelled: new Set(shown.map((label) => label.place)),
    clipped: false,
  };
}

/**
 * The scene in other colors: every color that is one of `from`'s takes the one at the same place
 * in `to` (the panel's palette in another color scheme). A color that is in neither stays.
 */
export function recolorScene<T extends Scene>(
  scene: T,
  from: readonly string[],
  to: readonly string[],
): T {
  const map = new Map<string, string>();
  from.forEach((color, i) => {
    const other = to[i];
    // The first place of a color decides, should the palette hold it twice.
    if (other !== undefined && !map.has(color.toLowerCase())) map.set(color.toLowerCase(), other);
  });
  const swap = (color: string) => map.get(color.toLowerCase()) ?? color;
  return {
    ...scene,
    nodes: scene.nodes.map((node) => ({ ...node, color: swap(node.color) })),
    edges: scene.edges.map((edge) => ({ ...edge, color: swap(edge.color) })),
    colors: {
      text: swap(scene.colors.text),
      background: swap(scene.colors.background),
      selection: swap(scene.colors.selection),
    },
  };
}
