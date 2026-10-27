/** Messages between a graph panel and its layout worker (layout.worker.ts). */

export type LayoutMode = "force" | "hierarchy";

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
}

export interface LayoutProgress {
  type: "positions";
  run: number;
  positions: Float32Array;
  done: boolean;
  /** Hierarchy only: edges reversed to break cycles. */
  reversed?: number;
}

/** Iterations per step of the worker; between steps it reads new messages. */
export const ITERATIONS_PER_UPDATE = 5;
/** The worker posts positions at most this often while the layout settles, and once at the end. */
export const UPDATE_INTERVAL_MS = 200;
