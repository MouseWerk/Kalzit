import { isRecord } from "../../api/client";
import { type Calc, calcKind, calculateAll, MAX_CALCS, parseCalcs } from "../calcs";

/**
 * Legend and tooltip options, stored in a panel's `options` (`legend`, `tooltip`) by every panel
 * that draws series. The server checks the same values (`panel_options.rs`).
 */

export const LEGEND_MODES = ["list", "table", "hidden"] as const;
export type LegendMode = (typeof LEGEND_MODES)[number];
export const LEGEND_PLACEMENTS = ["bottom", "right"] as const;
export type LegendPlacement = (typeof LEGEND_PLACEMENTS)[number];
/** A legend value: a calculation over the visible range (`calcs.ts`), at most six. */
export type LegendValue = Calc;

export const LEGEND_LIMITS = {
  values: MAX_CALCS,
  /** Legend width beside the drawing, in px. */
  minWidth: 80,
  maxWidth: 1000,
  /** Series named in the legend; the drawing still shows all. */
  minLimit: 1,
  maxLimit: 1000,
} as const;

export interface LegendOptions {
  mode: LegendMode;
  placement: LegendPlacement;
  /** Values shown per series, in this order; the list shows the first two, the table all. */
  values: LegendValue[];
  /** Width in px beside the drawing (placement right); unset: as wide as needed. */
  width?: number;
  /** At most this many series named; unset: all. */
  limit?: number;
}

export const TOOLTIP_MODES = ["single", "all", "hidden"] as const;
export type TooltipMode = (typeof TOOLTIP_MODES)[number];
export const TOOLTIP_SORTS = ["none", "asc", "desc"] as const;
export type TooltipSort = (typeof TOOLTIP_SORTS)[number];

export const TOOLTIP_LIMITS = { minSize: 100, maxSize: 2000 } as const;

export interface TooltipOptions {
  mode: TooltipMode;
  /** Rows sorted by the value at the pointer; unset is none. */
  sort?: TooltipSort;
  /** Leaves out series whose value at the pointer is zero, and says how many. */
  hideZeros?: boolean;
  /** Largest size in px; unset: the width of the content, at most half the window high. */
  maxWidth?: number;
  maxHeight?: number;
}

export const DEFAULT_LEGEND: LegendOptions = { mode: "list", placement: "bottom", values: [] };
export const DEFAULT_TOOLTIP: TooltipOptions = { mode: "all" };

function wholeIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

/**
 * Reads `options.legend`. Before the legend options existed, a time series stored its series
 * name template under `legend` and `showLegend: false` to hide it; both are still understood.
 */
export function parseLegend(stored: Record<string, unknown>): LegendOptions {
  const value = stored.legend;
  if (!isRecord(value)) {
    return { ...DEFAULT_LEGEND, mode: stored.showLegend === false ? "hidden" : "list" };
  }
  const legend: LegendOptions = {
    mode: LEGEND_MODES.find((m) => m === value.mode) ?? "list",
    placement: LEGEND_PLACEMENTS.find((p) => p === value.placement) ?? "bottom",
    values: parseCalcs(value.values, LEGEND_LIMITS.values),
  };
  const width = wholeIn(value.width, LEGEND_LIMITS.minWidth, LEGEND_LIMITS.maxWidth);
  if (width !== undefined) legend.width = width;
  const limit = wholeIn(value.limit, LEGEND_LIMITS.minLimit, LEGEND_LIMITS.maxLimit);
  if (limit !== undefined) legend.limit = limit;
  return legend;
}

export function parseTooltip(stored: Record<string, unknown>): TooltipOptions {
  const value = stored.tooltip;
  if (!isRecord(value)) return { mode: "all" };
  const tooltip: TooltipOptions = { mode: TOOLTIP_MODES.find((m) => m === value.mode) ?? "all" };
  const sort = TOOLTIP_SORTS.find((s) => s === value.sort);
  if (sort !== undefined && sort !== "none") tooltip.sort = sort;
  if (value.hideZeros === true) tooltip.hideZeros = true;
  const maxWidth = wholeIn(value.maxWidth, TOOLTIP_LIMITS.minSize, TOOLTIP_LIMITS.maxSize);
  if (maxWidth !== undefined) tooltip.maxWidth = maxWidth;
  const maxHeight = wholeIn(value.maxHeight, TOOLTIP_LIMITS.minSize, TOOLTIP_LIMITS.maxSize);
  if (maxHeight !== undefined) tooltip.maxHeight = maxHeight;
  return tooltip;
}

/**
 * The legend values of one series as text: values in the field's unit through `format`, counts
 * as plain numbers, the change in percent with a percent sign, the time of the max as a time.
 * Nothing to compute is empty. The numbers come along for sorting the legend table.
 */
export function legendTexts(
  calcs: readonly LegendValue[],
  values: ArrayLike<number | null>,
  times: ArrayLike<number> | undefined,
  format: (value: number) => string,
  language: string,
  timeZone: string | null,
): { texts: Record<string, string>; numbers: Record<string, number> } {
  const results = calculateAll(calcs, values, times);
  const texts: Record<string, string> = {};
  const numbers: Record<string, number> = {};
  for (const calc of calcs) {
    const value = results[calc] ?? Number.NaN;
    numbers[calc] = value;
    if (Number.isNaN(value)) {
      texts[calc] = "";
      continue;
    }
    switch (calcKind(calc)) {
      case "count":
        texts[calc] = new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(value);
        break;
      case "percent":
        texts[calc] = new Intl.NumberFormat(language, {
          style: "percent",
          maximumFractionDigits: 1,
        }).format(value / 100);
        break;
      case "time":
        texts[calc] = new Date(value).toLocaleString(language, {
          dateStyle: "short",
          timeStyle: "short",
          ...(timeZone === null ? {} : { timeZone }),
        });
        break;
      default:
        texts[calc] = format(value);
    }
  }
  return { texts, numbers };
}
