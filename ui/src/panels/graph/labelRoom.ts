import type Sigma from "sigma";
import type { NodeDisplayData } from "sigma/types";
import { type Box, blockedLabels, type DrawnNode, Grid, type WantedLabel } from "./labelCollisions";
import type { NodeShape } from "./shapes";

/**
 * Keeps every drawn node label clear of other nodes, of labels placed before it and of the
 * panel's edges, on every frame the renderer draws.
 *
 * Sigma 4.0.3 decides per frame which node labels it draws (its label renderer's
 * `computeDisplayedNodeLabels`, right before the labels and their backgrounds are drawn, with the
 * camera of that frame). The check runs there, on the labels it chose and with its own label
 * boxes, and takes the colliding ones out of the set. So a label never shows over a node for a
 * frame, whether the camera, the layout, the panel size or the selection changed, and nothing has
 * to wait for the drawing to settle (the check used to run 120 ms after the last change, and the
 * labels drawn in between covered their neighbours).
 *
 * The label renderer is private to Sigma; it is wrapped once per renderer, here, the way
 * labelPicking.ts wraps its programs. To be checked on every Sigma upgrade (the test in
 * sigmaCanvas.test.tsx fails when the hook no longer runs).
 */

interface LabelRendererLike {
  displayedNodeLabels: Set<string>;
  computeDisplayedNodeLabels: () => void;
  nodeLabelBox: (data: NodeDisplayData, radius: number) => Box | null;
}

function isLabelRenderer(value: unknown): value is LabelRendererLike {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<LabelRendererLike>;
  return (
    v.displayedNodeLabels instanceof Set &&
    typeof v.computeDisplayedNodeLabels === "function" &&
    typeof v.nodeLabelBox === "function"
  );
}

/** Says so in development when Sigma no longer looks as this hook expects (an upgrade). */
function notice(what: string): void {
  if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
    // biome-ignore lint/suspicious/noConsole: a note for developers only, never in a build
    console.warn(`labelRoom: ${what}; labels may cover nodes, check it against this Sigma`);
  }
}

export interface LabelRoomSource {
  /** The order labels are placed in: lower first (the node's label rank). */
  rank: (node: number) => number;
  /** The shape a node is drawn with. */
  shape: (node: number) => NodeShape;
}

/** At most this many labels are checked per frame, the best ranked first; the rest wait. */
export const MAX_CHECKED_LABELS = 400;

/** A box in the renderer's viewport around a drawn label, from Sigma's own label box. */
function viewportBox(x: number, y: number, box: Box): Box {
  return { minX: x + box.minX, maxX: x + box.maxX, minY: y + box.minY, maxY: y + box.maxY };
}

/**
 * The labels of the frame that would collide, from the renderer's display data: `displayed` in
 * the renderer's keys (view indexes as strings). Only nodes whose shape reaches a cell of the
 * grid around the wanted labels are taken in, so a large graph costs one projection per visible
 * node and nothing more. Exported for the tests.
 */
export function collidingLabels(
  renderer: Sigma,
  displayed: ReadonlySet<string>,
  labelBox: LabelRendererLike["nodeLabelBox"],
  source: LabelRoomSource,
): number[] {
  const { width, height } = renderer.getDimensions();
  // The wanted labels first, best ranked first; beyond MAX_CHECKED_LABELS they wait.
  const wanted: (WantedLabel & { rank: number })[] = [];
  for (const key of displayed) {
    const index = Number(key);
    const data = renderer.getNodeDisplayData(key);
    if (data === undefined) continue;
    const point = renderer.framedGraphToViewport(data);
    const box = labelBox(data, renderer.scaleSize(data.size));
    if (box === null) continue;
    wanted.push({
      index,
      box: viewportBox(point.x, point.y, box),
      forced: data.labelVisibility === "visible",
      rank: source.rank(index),
    });
  }
  wanted.sort((a, b) => Number(b.forced) - Number(a.forced) || a.rank - b.rank);
  const over = wanted.slice(MAX_CHECKED_LABELS).filter((l) => !l.forced);
  const labels = wanted.filter((l, i) => i < MAX_CHECKED_LABELS || l.forced);
  const near = new Grid<true>();
  for (const label of labels) near.add(label.box, true);
  const nodes: DrawnNode[] = [];
  for (const key of renderer.getGraph().nodes()) {
    const data = renderer.getNodeDisplayData(key);
    if (data === undefined || data.visibility === "hidden") continue;
    const point = renderer.framedGraphToViewport(data);
    const radius = renderer.scaleSize(data.size);
    if (
      point.x + radius < 0 ||
      point.y + radius < 0 ||
      point.x - radius > width ||
      point.y - radius > height ||
      !near.reaches(point.x - radius, point.y - radius, point.x + radius, point.y + radius)
    ) {
      continue;
    }
    const index = Number(key);
    nodes.push({ index, x: point.x, y: point.y, radius, shape: source.shape(index) });
  }
  const blocked = blockedLabels(nodes, labels, { minX: 0, minY: 0, maxX: width, maxY: height });
  return [...blocked, ...over.map((l) => l.index)];
}

/** What a frame drew: the nodes and the labels Sigma displays, in viewport px. */
export interface LabelFrame {
  nodes: DrawnNode[];
  labels: { index: number; box: Box }[];
}

/**
 * What the renderer's last frame drew, read from Sigma itself: the labels it displays (after the
 * check) with its own label boxes, and every visible node in the panel with the shape it is drawn
 * with. For the end-to-end tests' hook only; null when Sigma no longer looks as expected.
 */
export function drawnFrame(renderer: Sigma): LabelFrame | null {
  const labels = (renderer as unknown as { labelRenderer?: unknown }).labelRenderer;
  if (!isLabelRenderer(labels)) return null;
  const { width, height } = renderer.getDimensions();
  const nodes: DrawnNode[] = [];
  for (const key of renderer.getGraph().nodes()) {
    const data = renderer.getNodeDisplayData(key);
    if (data === undefined || data.visibility === "hidden") continue;
    const point = renderer.framedGraphToViewport(data);
    const radius = renderer.scaleSize(data.size);
    if (
      point.x < -radius ||
      point.y < -radius ||
      point.x > width + radius ||
      point.y > height + radius
    ) {
      continue;
    }
    const shape = data.shape === "square" || data.shape === "diamond" ? data.shape : "circle";
    nodes.push({ index: Number(key), x: point.x, y: point.y, radius, shape });
  }
  const shown: LabelFrame["labels"] = [];
  // While the camera moves the renderer draws no labels.
  if (renderer.getSetting("hideLabelsOnMove") && moving(renderer)) return { nodes, labels: shown };
  for (const key of labels.displayedNodeLabels) {
    const data = renderer.getNodeDisplayData(key);
    if (data === undefined) continue;
    const point = renderer.framedGraphToViewport(data);
    const box = labels.nodeLabelBox(data, renderer.scaleSize(data.size));
    if (box !== null) shown.push({ index: Number(key), box: viewportBox(point.x, point.y, box) });
  }
  return { nodes, labels: shown };
}

/** Whether the renderer is moving the camera or following a gesture (its own test). */
function moving(renderer: Sigma): boolean {
  const captor = renderer.getMouseCaptor() as unknown as {
    isMoving?: boolean;
    draggedEvents?: number;
    currentWheelDirection?: number;
  };
  return (
    renderer.getCamera().isAnimating() ||
    captor.isMoving === true ||
    (captor.draggedEvents ?? 0) > 0 ||
    (captor.currentWheelDirection ?? 0) !== 0
  );
}

/**
 * Hooks the label check into one renderer. Returns whether it is in place (false when Sigma no
 * longer has the label renderer this expects).
 */
export function installLabelRoom(renderer: Sigma, source: LabelRoomSource): boolean {
  const labels = (renderer as unknown as { labelRenderer?: unknown }).labelRenderer;
  if (!isLabelRenderer(labels)) {
    notice("Sigma has no label renderer with computeDisplayedNodeLabels");
    return false;
  }
  const original = labels.computeDisplayedNodeLabels.bind(labels);
  const box = labels.nodeLabelBox.bind(labels);
  labels.computeDisplayedNodeLabels = () => {
    original();
    const displayed = labels.displayedNodeLabels;
    // While the camera moves the renderer draws no labels (hideLabelsOnMove): nothing to check.
    if (displayed.size === 0) return;
    if (renderer.getSetting("hideLabelsOnMove") && moving(renderer)) return;
    for (const index of collidingLabels(renderer, displayed, box, source)) {
      displayed.delete(String(index));
    }
  };
  return true;
}
