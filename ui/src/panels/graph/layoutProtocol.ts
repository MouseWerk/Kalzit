/** Messages between a graph panel and its layout worker (layout.worker.ts). */

import type { LayoutMode } from "./options";

export type { LayoutMode };

/** Where a hierarchy's edges point. */
export type LayoutDirection = "down" | "right" | "up" | "left";

export interface LayoutRequest {
  type: "start";
  /** Answers carry it, so a superseded run's late messages are dropped. */
  run: number;
  mode: LayoutMode;
  count: number;
  sources: Uint32Array;
  targets: Uint32Array;
  weights: Float32Array;
  sizes: Float32Array;
  /** Estimated label widths in px (layoutEngine.ts, LayoutGraph). */
  labels: Float32Array;
  /** Where nodes start (the previous layout for nodes already placed). */
  start: Float32Array;
  /**
   * The seed of everything a layout decides by chance. The same request with the same seed gives
   * the same positions; "Arrange again" asks with the next one.
   */
  seed?: number;
  /** Per node, 1 for a pinned one: it stays where `start` puts it (pinned.ts). Absent: none. */
  fixed?: Uint8Array;
  /** Hierarchy: where the edges point (default: down). */
  direction?: LayoutDirection;
  /** Radial: the nodes in the middle. Empty or absent: the best connected node. */
  centers?: Uint32Array;
  /** Circular and grid: the nodes in the order they are placed in. Absent: by index. */
  order?: Uint32Array;
  /** Coordinates: `x0, y0, x1, y1, ...` from the nodes' properties; NaN where a node has none. */
  values?: Float64Array;
  /** Coordinates: both axes share one scale (a `point`), instead of each filling its side. */
  uniform?: boolean;
  /** Timeline: per node its time in Unix ms; NaN where a node has none. */
  times?: Float64Array;
  /** Timeline: per node the lane it stands in. Absent: one lane. */
  lanes?: Int32Array;
}

/** Why nodes of a layout stand in the strip beside it instead of at a place of their own. */
export type StripReason = "noValue" | "noTime";

/**
 * Quiet lines behind the graph that say how a layout placed its nodes (Graph081 board, frame 13):
 * the rings of the radial layout, the axes of the coordinates, the lanes of the timeline and the
 * strip of nodes a layout had no place for. In graph units, like the positions.
 */
export type LayoutGuide =
  | { kind: "ring"; x: number; y: number; radius: number }
  | {
      kind: "axis";
      axis: "x" | "y" | "time";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      /** The values at the two ends of the axis (Unix ms on a time axis). */
      min: number;
      max: number;
    }
  | { kind: "lane"; x1: number; x2: number; y: number; lane: number }
  | {
      kind: "strip";
      x: number;
      y: number;
      width: number;
      height: number;
      count: number;
      reason: StripReason;
    };

export interface LayoutProgress {
  type: "positions";
  run: number;
  positions: Float32Array;
  done: boolean;
  /** Hierarchy only: edges reversed to break cycles. */
  reversed?: number;
  /** With the final positions of a layout that draws guides. */
  guides?: LayoutGuide[];
}

/** How far a layout that answers once (all but the force layout) has come, in nodes. */
export interface LayoutWork {
  type: "work";
  run: number;
  done: number;
  total: number;
}

export type LayoutMessage = LayoutProgress | LayoutWork;

/** Iterations per step of the worker; between steps it reads new messages. */
export const ITERATIONS_PER_UPDATE = 5;
/** The worker posts positions at most this often while the layout settles, and once at the end. */
export const UPDATE_INTERVAL_MS = 200;
/** A layout that answers once says how far it is at most this often. */
export const WORK_INTERVAL_MS = 100;
