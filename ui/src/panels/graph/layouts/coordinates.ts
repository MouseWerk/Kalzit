import type { LayoutGuide, LayoutRequest } from "../layoutProtocol";
import {
  isFixed,
  keepFixed,
  largestSize,
  NODE_GAP,
  type PlacedLayout,
  placeStrip,
  STRIP_GAP,
} from "./shared";

/** The side of the square the values fill, for a few nodes; it grows with their number. */
export const COORDINATE_SIDE = 360;
/** The room between the nodes and the axes drawn beside them. */
export const AXIS_GAP = 28;

export interface CoordinateLayout extends PlacedLayout {
  /** Nodes placed by their values. */
  placed: number;
  /** Nodes without both values, standing in the strip. */
  unplaced: number;
  side: number;
  /** The values at the ends of the axes; null without a placed node. */
  range: { x: [number, number]; y: [number, number] } | null;
}

/**
 * Each node where two of its values put it: x to the right, y upwards. The values fill a square,
 * each axis on its own scale, or on one shared scale for a `point` (`uniform`), which keeps
 * distances true. Nodes without both values stand in a strip beside the square, with their
 * number, so none disappears.
 */
export function coordinateLayout(request: LayoutRequest): CoordinateLayout {
  const { count } = request;
  const values = request.values ?? new Float64Array(0);
  const positions = new Float32Array(count * 2);
  const without: number[] = [];
  let placed = 0;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const has = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const x = values[2 * i] ?? Number.NaN;
    const y = values[2 * i + 1] ?? Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (!isFixed(request, i)) without.push(i);
      continue;
    }
    has[i] = 1;
    placed++;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const side = Math.max(COORDINATE_SIDE, 48 * Math.sqrt(placed));
  let spanX = maxX - minX;
  let spanY = maxY - minY;
  if (request.uniform === true) {
    spanX = Math.max(spanX, spanY);
    spanY = spanX;
  }
  // A span of zero (one node, or all on one line) stands in the middle of its axis.
  const scale = (value: number, min: number, max: number, span: number) =>
    span > 0 ? ((value - (min + max) / 2) / span + 0.5) * side : side / 2;
  for (let i = 0; i < count; i++) {
    if (has[i] === 0) continue;
    positions[2 * i] = scale(values[2 * i] as number, minX, maxX, spanX);
    positions[2 * i + 1] = scale(values[2 * i + 1] as number, minY, maxY, spanY);
  }

  // The values at the ends of an axis: with one shared scale both axes span the same range,
  // centred on their own values.
  const ends = (axis: 0 | 1) => {
    const [min, max, span] = axis === 0 ? [minX, maxX, spanX] : [minY, maxY, spanY];
    const middle = (min + max) / 2;
    return { min: middle - span / 2, max: middle + span / 2 };
  };
  const guides: LayoutGuide[] = [];
  if (placed > 0) {
    guides.push(
      { kind: "axis", axis: "x", x1: 0, y1: -AXIS_GAP, x2: side, y2: -AXIS_GAP, ...ends(0) },
      { kind: "axis", axis: "y", x1: -AXIS_GAP, y1: 0, x2: -AXIS_GAP, y2: side, ...ends(1) },
    );
  }
  if (without.length > 0) {
    const cell = 2 * largestSize(request.sizes) + NODE_GAP;
    const box = placeStrip(positions, without, side + STRIP_GAP, side, cell);
    guides.push({ kind: "strip", ...box, count: without.length, reason: "noValue" });
  }
  return {
    positions: keepFixed(positions, request),
    guides,
    placed,
    unplaced: without.length,
    side,
    range:
      placed === 0
        ? null
        : {
            x: [minX, maxX],
            y: [minY, maxY],
          },
  };
}
