import { AXIS_SCALES, type AxisScale, LOG_BASES, type LogBase } from "../axisScale";

/**
 * The value axis of a chart (ParityEditors board, frame 2, group "Achsen"): field options, so the
 * defaults set them for every field and an override for one field (such as a second unit on the
 * right). The time series draws a left and a right axis; the bar chart and the histogram read the
 * defaults for their one value axis. The server checks the same names and bounds
 * (`panel_options.rs`). Unset means automatic.
 */

/** `auto`: left, and fields with a second unit go to the right axis. */
export const AXIS_PLACEMENTS = ["auto", "left", "right", "hidden"] as const;
export type AxisPlacement = (typeof AXIS_PLACEMENTS)[number];

/** `auto`: only the left axis draws grid lines (two grids would be restless). */
export const AXIS_GRIDS = ["auto", "on", "off"] as const;
export type AxisGrid = (typeof AXIS_GRIDS)[number];

/** The axis' labels and line in the text colour or in the colour of its first series. */
export const AXIS_COLORS = ["text", "series"] as const;
export type AxisColor = (typeof AXIS_COLORS)[number];

export const AXIS_LIMITS = {
  labelChars: 200,
  /** Fixed axis width in px. */
  minWidth: 20,
  maxWidth: 400,
} as const;

export interface AxisOptions {
  axisPlacement?: AxisPlacement;
  /** Written along the axis; empty: none, the unit stands at the values. */
  axisLabel?: string;
  /** Width in px; unset: as wide as the longest value. */
  axisWidth?: number;
  axisGrid?: AxisGrid;
  axisColor?: AxisColor;
  /** Draws the axis line along the plot. */
  axisLine?: boolean;
  axisScale?: AxisScale;
  /** Base of the logarithmic scales; unset is 10. */
  axisLogBase?: LogBase;
  /** The same room above and below zero. */
  axisCenteredZero?: boolean;
  /** The axis reaches at least this far; values beyond still widen it. */
  axisSoftMin?: number;
  axisSoftMax?: number;
}

/** The axis option names, in the order the editor shows them. */
export const AXIS_KEYS = [
  "axisPlacement",
  "axisLabel",
  "axisWidth",
  "axisGrid",
  "axisColor",
  "axisLine",
  "axisScale",
  "axisLogBase",
  "axisCenteredZero",
  "axisSoftMin",
  "axisSoftMax",
] as const satisfies readonly (keyof AxisOptions)[];

function choice<T extends string | number>(choices: readonly T[], value: unknown): T | undefined {
  return choices.find((c) => c === value);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Control characters, as Rust's `char::is_control` sees them (C0, DEL and C1). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Reads the axis keys of stored field options; wrong types and bounds are dropped. */
export function parseAxisOptions(value: Record<string, unknown>): AxisOptions {
  const options: AxisOptions = {};
  const placement = choice(AXIS_PLACEMENTS, value.axisPlacement);
  if (placement !== undefined) options.axisPlacement = placement;
  if (typeof value.axisLabel === "string") {
    const label = [...value.axisLabel.replace(CONTROL, "")]
      .slice(0, AXIS_LIMITS.labelChars)
      .join("");
    if (label.trim() !== "") options.axisLabel = label;
  }
  const width = finite(value.axisWidth);
  if (
    width !== undefined &&
    Number.isInteger(width) &&
    width >= AXIS_LIMITS.minWidth &&
    width <= AXIS_LIMITS.maxWidth
  ) {
    options.axisWidth = width;
  }
  const grid = choice(AXIS_GRIDS, value.axisGrid);
  if (grid !== undefined) options.axisGrid = grid;
  const color = choice(AXIS_COLORS, value.axisColor);
  if (color !== undefined) options.axisColor = color;
  if (typeof value.axisLine === "boolean") options.axisLine = value.axisLine;
  const scale = choice(AXIS_SCALES, value.axisScale);
  if (scale !== undefined) options.axisScale = scale;
  const base = choice(LOG_BASES, value.axisLogBase);
  if (base !== undefined) options.axisLogBase = base;
  if (typeof value.axisCenteredZero === "boolean") {
    options.axisCenteredZero = value.axisCenteredZero;
  }
  const softMin = finite(value.axisSoftMin);
  if (softMin !== undefined) options.axisSoftMin = softMin;
  const softMax = finite(value.axisSoftMax);
  if (softMax !== undefined) options.axisSoftMax = softMax;
  return options;
}

/** The scale an axis with these options draws, with the field options' fixed ends. */
export function scaleSpecOf(options: AxisOptions & { min?: number; max?: number }) {
  return {
    scale: options.axisScale ?? "linear",
    base: options.axisLogBase ?? 10,
    softMin: options.axisSoftMin,
    softMax: options.axisSoftMax,
    min: options.min,
    max: options.max,
    centeredZero: options.axisCenteredZero,
  } as const;
}
