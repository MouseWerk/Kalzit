import type Sigma from "sigma";
import type { NodeDisplayData } from "sigma/types";
import { type Box, blockedLabels, type DrawnNode, type WantedLabel } from "./labelCollisions";
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

/** Nodes this far outside the panel can still reach into it, in px. */
const OUTSIDE = 240;

export interface LabelRoomSource {
  /** The order labels are placed in: lower first (the node's label rank). */
  rank: (node: number) => number;
  /** The shape a node is drawn with. */
  shape: (node: number) => NodeShape;
}

/** What one frame drew: the nodes and the labels that kept their place, in viewport px. */
export interface LabelFrame {
  nodes: DrawnNode[];
  labels: { index: number; box: Box }[];
}

/**
 * The labels of the frame that would collide, from the renderer's display data: `displayed` in
 * the renderer's keys (view indexes as strings), with the frame as drawn once they are left out.
 * Exported for the tests.
 */
export function collidingLabels(
  renderer: Sigma,
  displayed: ReadonlySet<string>,
  labelBox: LabelRendererLike["nodeLabelBox"],
  source: LabelRoomSource,
): { blocked: number[]; frame: LabelFrame } {
  const { width, height } = renderer.getDimensions();
  const nodes: DrawnNode[] = [];
  const at = new Map<number, DrawnNode>();
  for (const key of renderer.getGraph().nodes()) {
    const data = renderer.getNodeDisplayData(key);
    if (data === undefined || data.visibility === "hidden") continue;
    const point = renderer.framedGraphToViewport(data);
    if (
      point.x < -OUTSIDE ||
      point.y < -OUTSIDE ||
      point.x > width + OUTSIDE ||
      point.y > height + OUTSIDE
    ) {
      continue;
    }
    const index = Number(key);
    const drawn = {
      index,
      x: point.x,
      y: point.y,
      radius: renderer.scaleSize(data.size),
      shape: source.shape(index),
    };
    nodes.push(drawn);
    at.set(index, drawn);
  }
  const labels: (WantedLabel & { rank: number })[] = [];
  for (const key of displayed) {
    const index = Number(key);
    const data = renderer.getNodeDisplayData(key);
    const node = at.get(index);
    if (data === undefined || node === undefined) continue;
    const box = labelBox(data, node.radius);
    if (box === null) continue;
    labels.push({
      index,
      box: {
        minX: node.x + box.minX,
        maxX: node.x + box.maxX,
        minY: node.y + box.minY,
        maxY: node.y + box.maxY,
      },
      forced: data.labelVisibility === "visible",
      rank: source.rank(index),
    });
  }
  labels.sort((a, b) => a.rank - b.rank);
  const blocked = blockedLabels(nodes, labels, { minX: 0, minY: 0, maxX: width, maxY: height });
  return {
    blocked: [...blocked],
    frame: {
      nodes,
      labels: labels.filter((l) => !blocked.has(l.index)).map(({ index, box }) => ({ index, box })),
    },
  };
}

/**
 * Hooks the label check into one renderer. Returns what the last frame drew (for the end-to-end
 * tests' hook), or null when Sigma no longer has the label renderer this expects.
 */
export function installLabelRoom(
  renderer: Sigma,
  source: LabelRoomSource,
): { last: () => LabelFrame | null } | null {
  const labels = (renderer as unknown as { labelRenderer?: unknown }).labelRenderer;
  if (!isLabelRenderer(labels)) {
    notice("Sigma has no label renderer with computeDisplayedNodeLabels");
    return null;
  }
  const original = labels.computeDisplayedNodeLabels.bind(labels);
  const box = labels.nodeLabelBox.bind(labels);
  let last: LabelFrame | null = null;
  labels.computeDisplayedNodeLabels = () => {
    original();
    const displayed = labels.displayedNodeLabels;
    if (displayed.size === 0) {
      last = { nodes: [], labels: [] };
      return;
    }
    const { blocked, frame } = collidingLabels(renderer, displayed, box, source);
    for (const index of blocked) displayed.delete(String(index));
    last = frame;
  };
  return { last: () => last };
}
