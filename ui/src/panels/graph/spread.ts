import { Grid, LABEL_MARGIN, LABEL_PAD } from "./labelCollisions";

/**
 * Makes room for nodes and their labels in the panel they are drawn in. The force layout works
 * in graph units and knows nothing of pixels, while the renderer draws node sizes and labels in
 * pixels and fits the drawing to the panel: in a short panel the fitted drawing is small, and
 * circles and labels that the layout kept apart lie on top of each other ("UPS A1" over
 * "UPS A2"). Here the layout is stretched towards the panel's shape and framed as the renderer
 * frames it; each node with its label (for the labels that show at the fitted zoom) becomes a
 * box in pixels, and boxes that overlap are pushed apart within the panel until none does.
 *
 * Only as many labels count as fit into the panel's area, the best ranked first: a short panel
 * cannot hold forty names, and the renderer leaves out the rest until zooming gives them room
 * (labelRoom.ts). The result also gives the box the renderer frames (its custom bounding box),
 * which reaches around the nodes and labels, so labels at the edge stay inside the panel.
 * Pure and deterministic, on flat arrays, so it is tested without a renderer.
 */

/** Space kept around the drawing in the panel, in px (the renderer's `stagePadding`). */
export const STAGE_PADDING = 12;
/** Space kept between two boxes, in px. */
const GAP = 4;
/** Share of the panel's area that nodes and labels may take; the rest is room between them. */
const FILL = 0.32;
/** Share of the panel's area the nodes alone may take; beyond it they are drawn smaller. */
const NODE_FILL = 0.2;
/** Nodes are drawn at least this share of their size, however short the panel. */
export const MIN_NODE_SCALE = 0.5;
/** Passes of pushing apart. Each pass resolves every overlap it finds, by half on each side. */
const PASSES = 200;
/** Passes of framing (the fitted box depends on the scale and the scale on the box). */
const FIT_PASSES = 8;
/** A force layout is about round; it is stretched at most this much towards the panel's shape. */
const MAX_STRETCH = 2.5;
/** Above this many nodes nothing is pushed apart: the labels are a few among thousands. */
export const SPREAD_LIMIT = 1_500;

export interface SpreadInput {
  /** Interleaved x, y in graph units. */
  positions: Float32Array;
  /** Per node, how far its shape reaches from its centre, in px. */
  radii: Float32Array;
  /** Per node, its label's width in px when it shows at the fitted zoom; 0 for none. */
  labels: Float32Array;
  /** Per node, the order its label comes in (lower first); labels beyond the area are dropped. */
  ranks: Int32Array;
  /** Height of a label's text in px. */
  labelHeight: number;
  /** The panel's size in px. */
  width: number;
  height: number;
  /** Whether nodes may move (false: only the box is fitted, as for a hierarchy's layers). */
  move?: boolean;
}

export interface BBox {
  x: [number, number];
  y: [number, number];
}

export interface Spread {
  positions: Float32Array;
  /** The box the renderer frames, in graph units: the nodes with their shapes and labels. */
  bbox: BBox;
  /** Nodes whose label counted, in the order of their ranks. */
  labelled: number;
  /**
   * How large the nodes are drawn, as a share of their size (1, or less in a panel too short for
   * them; at least MIN_NODE_SCALE).
   */
  nodeScale: number;
}

/**
 * The share of their size the nodes are drawn at in a panel of this size: 1 while all of them
 * take at most NODE_FILL of its drawing area, smaller beyond (never below MIN_NODE_SCALE).
 */
export function nodeScaleFor(radii: Float32Array, width: number, height: number): number {
  const area = drawingArea(width, height);
  let used = 0;
  for (const r of radii) used += (2 * r + GAP) * (2 * r + GAP);
  if (!(used > 0) || !(area.width > 0 && area.height > 0)) return 1;
  const room = NODE_FILL * area.width * area.height;
  return Math.min(1, Math.max(MIN_NODE_SCALE, Math.sqrt(room / used)));
}

/** A node's box around its centre in px: its shape, and its label to the right. */
interface Reach {
  left: number;
  right: number;
  up: number;
}

function reachOf(radius: number, label: number, labelHeight: number): Reach {
  const half = label > 0 ? Math.max(radius, labelHeight / 2 + LABEL_PAD) : radius;
  return {
    left: radius,
    right: label > 0 ? radius + LABEL_MARGIN - LABEL_PAD + label + 2 * LABEL_PAD : radius,
    up: half,
  };
}

/**
 * The renderer's scale at the default camera: px per graph unit when `bbox` is fitted into a
 * panel of `width` x `height` px with `padding` (Sigma's matrixFromCamera and its correction for
 * the shapes of graph and panel).
 */
export function pixelsPerUnit(bbox: BBox, width: number, height: number, padding: number): number {
  const bw = bbox.x[1] - bbox.x[0] || 1;
  const bh = bbox.y[1] - bbox.y[0] || 1;
  const viewport = height / width;
  const graph = bh / bw;
  const correction =
    (viewport < 1 && graph > 1) || (viewport > 1 && graph < 1)
      ? 1
      : Math.min(Math.max(graph, 1 / graph), Math.max(1 / viewport, viewport));
  const smallest = Math.max(1, Math.min(width, height) - 2 * padding);
  return (smallest * correction) / Math.max(bw, bh);
}

function extentOf(positions: Float32Array): BBox {
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 2) {
    const x = positions[i] as number;
    const y = positions[i + 1] as number;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!Number.isFinite(x0)) return { x: [0, 1], y: [0, 1] };
  return { x: [x0, x1], y: [y0, y1] };
}

/** The fitted box around the nodes with their reach, and its scale. */
function frameOf(
  positions: Float32Array,
  reach: readonly Reach[],
  width: number,
  height: number,
): { bbox: BBox; scale: number } {
  let bbox = extentOf(positions);
  let scale = pixelsPerUnit(bbox, width, height, STAGE_PADDING);
  for (let pass = 0; pass < FIT_PASSES; pass++) {
    let x0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    reach.forEach((r, i) => {
      const x = positions[2 * i] as number;
      const y = positions[2 * i + 1] as number;
      x0 = Math.min(x0, x - r.left / scale);
      x1 = Math.max(x1, x + r.right / scale);
      y0 = Math.min(y0, y - r.up / scale);
      y1 = Math.max(y1, y + r.up / scale);
    });
    if (!Number.isFinite(x0)) break;
    bbox = { x: [x0, x1], y: [y0, y1] };
    const next = pixelsPerUnit(bbox, width, height, STAGE_PADDING);
    const settled = Math.abs(next - scale) < scale * 1e-3;
    scale = next;
    if (settled) break;
  }
  return { bbox, scale };
}

/**
 * Which labels count: in order of rank, as long as nodes and labels together take at most FILL
 * of the panel's area. Returns the label widths with the others set to 0.
 */
function fittingLabels(input: SpreadInput): { labels: Float32Array; count: number } {
  const { radii, labels, ranks, labelHeight, width, height } = input;
  const area = drawingArea(width, height);
  const room = FILL * area.width * area.height;
  let used = 0;
  for (const r of radii) used += (2 * r + GAP) * (2 * r + GAP);
  const order = [...labels.keys()].filter((i) => (labels[i] as number) > 0);
  order.sort((a, b) => (ranks[a] ?? 0) - (ranks[b] ?? 0) || a - b);
  const out = new Float32Array(labels.length);
  let count = 0;
  for (const i of order) {
    const r = radii[i] as number;
    const reach = reachOf(r, labels[i] as number, labelHeight);
    const area = (reach.left + reach.right + GAP) * (2 * reach.up + GAP);
    const own = (2 * r + GAP) * (2 * r + GAP);
    if (used - own + area > room) break;
    used += area - own;
    out[i] = labels[i] as number;
    count++;
  }
  return { labels: out, count };
}

/**
 * Stretches a drawing (in place) along one axis towards the panel's shape: a force layout comes
 * out about round, and in a wide, short panel it would leave most of the width empty while the
 * nodes crowd in the middle.
 */
function stretch(positions: Float32Array, width: number, height: number): void {
  const { x, y } = extentOf(positions);
  const bw = x[1] - x[0];
  const bh = y[1] - y[0];
  if (!(bw > 0 && bh > 0)) return;
  const panel = width / height;
  const drawing = bw / bh;
  const factor = Math.min(MAX_STRETCH, Math.max(panel / drawing, drawing / panel));
  if (factor <= 1.05) return;
  // The wider panel stretches x, the taller one y.
  const axis = panel > drawing ? 0 : 1;
  const centre = axis === 0 ? (x[0] + x[1]) / 2 : (y[0] + y[1]) / 2;
  for (let i = axis; i < positions.length; i += 2) {
    positions[i] = centre + ((positions[i] as number) - centre) * factor;
  }
}

/**
 * The part of a panel of `width` x `height` px the renderer draws into at the default camera: the
 * panel less the padding, which the renderer takes in proportion on the longer side.
 */
export function drawingArea(width: number, height: number): { width: number; height: number } {
  const keep = Math.max(0, 1 - (2 * STAGE_PADDING) / Math.max(1, Math.min(width, height)));
  return { width: width * keep, height: height * keep };
}

/**
 * The positions with nodes and labels apart in a panel of the input's size, and the box the
 * renderer frames. Nodes too large for a short panel are drawn smaller (nodeScaleFor). The
 * layout is stretched towards the panel's shape and framed; in that framing, boxes that overlap
 * are pushed apart in pixels, within the panel's drawing area, and the result goes back to graph
 * units at the same scale. Since it stays within the area, the renderer frames it at that scale or larger, so
 * nothing comes closer again. Positions stay as they are when nothing overlaps, when the input
 * says they may not move, and for graphs above SPREAD_LIMIT nodes (whose box is still fitted).
 */
export function spreadNodes(given: SpreadInput): Spread {
  const { labelHeight, width, height } = given;
  // A large graph keeps its sizes: its nodes are dots among thousands either way.
  const nodeScale =
    given.radii.length > SPREAD_LIMIT ? 1 : nodeScaleFor(given.radii, width, height);
  const radii = given.radii.map((r) => r * nodeScale);
  const input = { ...given, radii };
  const count = radii.length;
  const { labels, count: labelled } = fittingLabels(input);
  const reach = Array.from({ length: count }, (_, i) =>
    reachOf(radii[i] as number, labels[i] as number, labelHeight),
  );
  const positions = input.positions.slice();
  if (input.move === false || count < 2 || count > SPREAD_LIMIT || !(width > 0 && height > 0)) {
    return {
      positions,
      bbox: frameOf(positions, reach, width, height).bbox,
      labelled,
      nodeScale,
    };
  }
  stretch(positions, width, height);
  const { bbox, scale } = frameOf(positions, reach, width, height);
  const area = drawingArea(width, height);
  const cx = ((bbox.x[0] + bbox.x[1]) / 2) * scale;
  const cy = ((bbox.y[0] + bbox.y[1]) / 2) * scale;
  // Where each centre may go so that its box stays in the drawing area (a box larger than the
  // area keeps its centre in the middle).
  const half = GAP / 2;
  const lowX = new Float64Array(count);
  const highX = new Float64Array(count);
  const lowY = new Float64Array(count);
  const highY = new Float64Array(count);
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  reach.forEach((r, i) => {
    lowX[i] = cx - area.width / 2 + r.left;
    highX[i] = Math.max(lowX[i] as number, cx + area.width / 2 - r.right);
    lowY[i] = cy - area.height / 2 + r.up;
    highY[i] = Math.max(lowY[i] as number, cy + area.height / 2 - r.up);
    x[i] = (positions[2 * i] as number) * scale;
    y[i] = (positions[2 * i + 1] as number) * scale;
  });
  const clampX = (i: number, value: number) =>
    Math.min(highX[i] as number, Math.max(lowX[i] as number, value));
  const clampY = (i: number, value: number) =>
    Math.min(highY[i] as number, Math.max(lowY[i] as number, value));
  const boxOf = (i: number) => {
    const r = reach[i] as Reach;
    return {
      minX: (x[i] as number) - r.left - half,
      maxX: (x[i] as number) + r.right + half,
      minY: (y[i] as number) - r.up - half,
      maxY: (y[i] as number) + r.up + half,
    };
  };
  /**
   * Moves node `i` by `by` along an axis as far as the drawing area lets it, and returns how far
   * it went.
   */
  const shift = (i: number, alongX: boolean, by: number) => {
    const pos = alongX ? x : y;
    const before = pos[i] as number;
    pos[i] = alongX ? clampX(i, before + by) : clampY(i, before + by);
    return (pos[i] as number) - before;
  };
  let moved = false;
  // Pairs that overlapped in the pass before: a pair that still does is pushed the other way,
  // since its neighbours keep pushing it back the short way (a chain of labels from the top of
  // the panel to the bottom can only part sideways).
  let before = new Set<number>();
  for (let pass = 0; pass < PASSES; pass++) {
    const now = new Set<number>();
    // Pairs are found from where the nodes stand at the start of the pass, and each overlap is
    // resolved at once, so the next pair sees the moved nodes (pushes do not pile up and
    // overshoot).
    const grid = new Grid<number>(64);
    for (let i = 0; i < count; i++) grid.add(boxOf(i), i);
    let overlaps = 0;
    for (let i = 0; i < count; i++) {
      for (const j of grid.near(boxOf(i))) {
        if (j <= i) continue;
        const a = boxOf(i);
        const b = boxOf(j);
        const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
        if (ox <= 0 || oy <= 0) continue;
        overlaps++;
        const key = i * count + j;
        now.add(key);
        const dx = (x[j] as number) - (x[i] as number);
        const dy = (y[j] as number) - (y[i] as number);
        // Along the axis that needs the shorter way; nodes on the same spot part by index. Half
        // each, and what the area's edge keeps one node from moving the other one takes.
        const sx = dx > 0 || (dx === 0 && j > i) ? 1 : -1;
        const sy = dy > 0 || (dy === 0 && j > i) ? 1 : -1;
        const push = (alongX: boolean) => {
          const p = boxOf(i);
          const q = boxOf(j);
          const way = alongX
            ? Math.min(p.maxX, q.maxX) - Math.max(p.minX, q.minX)
            : Math.min(p.maxY, q.maxY) - Math.max(p.minY, q.minY);
          if (way <= 0) return;
          const sign = alongX ? sx : sy;
          const wentI = Math.abs(shift(i, alongX, (-sign * way) / 2));
          const wentJ = Math.abs(shift(j, alongX, sign * (way - wentI)));
          if (wentI + wentJ < way) shift(i, alongX, -sign * (way - wentI - wentJ));
        };
        const meet = () => {
          const p = boxOf(i);
          const q = boxOf(j);
          return (
            Math.min(p.maxX, q.maxX) - Math.max(p.minX, q.minX) > 1e-6 &&
            Math.min(p.maxY, q.maxY) - Math.max(p.minY, q.minY) > 1e-6
          );
        };
        const short = ox < oy;
        const way = before.has(key) ? !short : short;
        push(way);
        // Held by the area's edge: the other way.
        if (meet()) push(!way);
      }
    }
    if (overlaps === 0) break;
    moved = true;
    before = now;
  }
  if (!moved) return { positions, bbox, labelled, nodeScale };
  for (let i = 0; i < count; i++) {
    positions[2 * i] = (x[i] as number) / scale;
    positions[2 * i + 1] = (y[i] as number) / scale;
  }
  return {
    positions,
    bbox: frameOf(positions, reach, width, height).bbox,
    labelled,
    nodeScale,
  };
}
