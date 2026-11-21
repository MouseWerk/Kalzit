import type { LayoutGuide, LayoutRequest } from "../layoutProtocol";
import { AXIS_GAP } from "./coordinates";
import {
  isFixed,
  keepFixed,
  largestSize,
  NODE_GAP,
  type PlacedLayout,
  placeStrip,
  STRIP_GAP,
} from "./shared";

/** The width of the time axis: this much per node, within these bounds. */
export const TIMELINE_NODE_WIDTH = 28;
export const TIMELINE_MIN_WIDTH = 480;
export const TIMELINE_MAX_WIDTH = 4_800;
/** The room between two lanes. */
export const LANE_GAP = 28;

export interface TimelineLayout extends PlacedLayout {
  /** Nodes placed by their time. */
  placed: number;
  /** Nodes without a time, standing in the strip at the end. */
  unplaced: number;
  width: number;
  /** The first and the last time, Unix ms; null without a placed node. */
  range: [number, number] | null;
  /** The lanes from top to bottom: the request's lane and the rows it takes. */
  lanes: { lane: number; rows: number; top: number }[];
}

/** A heap of rows by where each one ends, the row that is free first on top. */
class Rows {
  private readonly ends: number[] = [];
  private readonly rows: number[] = [];

  get size(): number {
    return this.ends.length;
  }

  /** The row for a node from `left` to `right`: the one free first, or a new one. */
  take(left: number, right: number): number {
    if (this.ends.length > 0 && (this.ends[0] as number) <= left) {
      const row = this.rows[0] as number;
      this.ends[0] = right;
      this.sink(0);
      return row;
    }
    const row = this.ends.length;
    this.ends.push(right);
    this.rows.push(row);
    this.rise(row);
    return row;
  }

  private swap(a: number, b: number): void {
    const end = this.ends[a] as number;
    const row = this.rows[a] as number;
    this.ends[a] = this.ends[b] as number;
    this.rows[a] = this.rows[b] as number;
    this.ends[b] = end;
    this.rows[b] = row;
  }

  /** Earlier end first; on a tie the upper row, so the same times always fill the same rows. */
  private before(a: number, b: number): boolean {
    const ea = this.ends[a] as number;
    const eb = this.ends[b] as number;
    return ea < eb || (ea === eb && (this.rows[a] as number) < (this.rows[b] as number));
  }

  private rise(at: number): void {
    let i = at;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!this.before(i, up)) break;
      this.swap(i, up);
      i = up;
    }
  }

  private sink(at: number): void {
    let i = at;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let first = i;
      if (left < this.ends.length && this.before(left, first)) first = left;
      if (right < this.ends.length && this.before(right, first)) first = right;
      if (first === i) return;
      this.swap(i, first);
      i = first;
    }
  }
}

/**
 * Nodes along a time axis, earlier to the left, in one lane per label (or one lane for all). Nodes
 * whose times are too close to stand side by side go into further rows of their lane. Nodes
 * without a time stand in a strip at the end, with their number.
 */
export function timelineLayout(request: LayoutRequest): TimelineLayout {
  const { count, sizes } = request;
  const times = request.times ?? new Float64Array(0);
  const positions = new Float32Array(count * 2);
  const timed: number[] = [];
  const without: number[] = [];
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const time = times[i] ?? Number.NaN;
    if (!Number.isFinite(time)) {
      if (!isFixed(request, i)) without.push(i);
      continue;
    }
    timed.push(i);
    first = Math.min(first, time);
    last = Math.max(last, time);
  }
  const width = Math.min(
    TIMELINE_MAX_WIDTH,
    Math.max(TIMELINE_MIN_WIDTH, timed.length * TIMELINE_NODE_WIDTH),
  );
  const span = last - first;
  const xOf = (node: number) =>
    span > 0 ? (((times[node] as number) - first) / span) * width : width / 2;
  const laneOf = (node: number) => request.lanes?.[node] ?? 0;
  // By lane, then time, then index: the same data always gives the same rows.
  timed.sort(
    (a, b) => laneOf(a) - laneOf(b) || (times[a] as number) - (times[b] as number) || a - b,
  );

  const rowHeight = 2 * largestSize(sizes) + NODE_GAP;
  const lanes: TimelineLayout["lanes"] = [];
  const guides: LayoutGuide[] = [];
  let top = 0;
  let at = 0;
  while (at < timed.length) {
    const lane = laneOf(timed[at] as number);
    const rows = new Rows();
    const start = at;
    const rowOf: number[] = [];
    while (at < timed.length && laneOf(timed[at] as number) === lane) {
      const node = timed[at] as number;
      const x = xOf(node);
      const size = sizes[node] ?? 0;
      rowOf.push(rows.take(x - size - NODE_GAP, x + size));
      at++;
    }
    for (let i = start; i < at; i++) {
      const node = timed[i] as number;
      positions[2 * node] = xOf(node);
      positions[2 * node + 1] = -(top + ((rowOf[i - start] as number) + 0.5) * rowHeight);
    }
    lanes.push({ lane, rows: rows.size, top });
    guides.push({ kind: "lane", lane, x1: 0, x2: width, y: -top + LANE_GAP / 2 });
    top += rows.size * rowHeight + LANE_GAP;
  }
  if (timed.length > 0) {
    guides.unshift({
      kind: "axis",
      axis: "time",
      x1: 0,
      y1: LANE_GAP / 2 + AXIS_GAP,
      x2: width,
      y2: LANE_GAP / 2 + AXIS_GAP,
      min: first,
      max: last,
    });
  }
  if (without.length > 0) {
    const left = (timed.length > 0 ? width : 0) + STRIP_GAP;
    const box = placeStrip(positions, without, left, -rowHeight / 2, rowHeight);
    guides.push({ kind: "strip", ...box, count: without.length, reason: "noTime" });
  }
  return {
    positions: keepFixed(positions, request),
    guides,
    placed: timed.length,
    unplaced: without.length,
    width,
    range: timed.length === 0 ? null : [first, last],
    lanes,
  };
}
