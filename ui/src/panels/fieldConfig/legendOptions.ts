import { isRecord } from "../../api/client";

/**
 * Legend and tooltip options, stored in a panel's `options` (`legend`, `tooltip`) by every panel
 * that draws series. The server checks the same values (`panel_options.rs`).
 */

export const LEGEND_MODES = ["list", "table", "hidden"] as const;
export type LegendMode = (typeof LEGEND_MODES)[number];
export const LEGEND_PLACEMENTS = ["bottom", "right"] as const;
export type LegendPlacement = (typeof LEGEND_PLACEMENTS)[number];
export const LEGEND_VALUES = ["last", "min", "max", "mean"] as const;
export type LegendValue = (typeof LEGEND_VALUES)[number];

export interface LegendOptions {
  mode: LegendMode;
  placement: LegendPlacement;
  /** Values shown per series, in this order. */
  values: LegendValue[];
}

export const TOOLTIP_MODES = ["single", "all", "hidden"] as const;
export type TooltipMode = (typeof TOOLTIP_MODES)[number];

export interface TooltipOptions {
  mode: TooltipMode;
}

export const DEFAULT_LEGEND: LegendOptions = { mode: "list", placement: "bottom", values: [] };
export const DEFAULT_TOOLTIP: TooltipOptions = { mode: "all" };

/**
 * Reads `options.legend`. Before the legend options existed, a time series stored its series
 * name template under `legend` and `showLegend: false` to hide it; both are still understood.
 */
export function parseLegend(stored: Record<string, unknown>): LegendOptions {
  const value = stored.legend;
  if (!isRecord(value)) {
    return { ...DEFAULT_LEGEND, mode: stored.showLegend === false ? "hidden" : "list" };
  }
  const values = Array.isArray(value.values)
    ? LEGEND_VALUES.filter((v) => (value.values as unknown[]).includes(v))
    : [];
  return {
    mode: LEGEND_MODES.find((m) => m === value.mode) ?? "list",
    placement: LEGEND_PLACEMENTS.find((p) => p === value.placement) ?? "bottom",
    values,
  };
}

export function parseTooltip(stored: Record<string, unknown>): TooltipOptions {
  const value = stored.tooltip;
  const mode = isRecord(value) ? TOOLTIP_MODES.find((m) => m === value.mode) : undefined;
  return { mode: mode ?? "all" };
}

export interface SeriesStats {
  last: number;
  min: number;
  max: number;
  mean: number;
}

/** Last, min, max and mean of the finite values, NaN for each when there is none. */
export function seriesStats(values: ArrayLike<number>): SeriesStats {
  let count = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let last = Number.NaN;
  for (let i = 0; i < values.length; i++) {
    const value = values[i] as number;
    if (!Number.isFinite(value)) continue;
    count++;
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
    last = value;
  }
  if (count === 0) {
    return { last: Number.NaN, min: Number.NaN, max: Number.NaN, mean: Number.NaN };
  }
  return { last, min, max, mean: sum / count };
}
