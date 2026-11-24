import { niceTicks } from "./timeseries/series";

/**
 * The math of a value axis with a linear, logarithmic or "log around zero" (symmetric log) scale,
 * soft limits and a centered zero (ParityEditors board, frame 2). The time series (SVG and
 * uPlot), the bar chart and the histogram share it, so every chart places the same values alike.
 */

export const AXIS_SCALES = ["linear", "log", "symlog"] as const;
export type AxisScale = (typeof AXIS_SCALES)[number];
export const LOG_BASES = [2, 10] as const;
export type LogBase = (typeof LOG_BASES)[number];

export interface ScaleSpec {
  scale: AxisScale;
  base: LogBase;
  /** The axis reaches at least this far and grows when values lie beyond. */
  softMin?: number | undefined;
  softMax?: number | undefined;
  /** Fixed ends (the field options' min and max): kept exactly. */
  min?: number | undefined;
  max?: number | undefined;
  /** The same room above and below zero. */
  centeredZero?: boolean | undefined;
}

export const LINEAR: ScaleSpec = { scale: "linear", base: 10 };

/**
 * A value in scale space: itself on a linear scale, its logarithm on a log scale (NaN for zero and
 * negative values, which a log scale cannot draw) and sign(v) * log(1 + |v|) around zero, which is
 * nearly linear close to zero and logarithmic further out, and draws negative values too.
 */
export function forward(scale: AxisScale, base: LogBase, value: number): number {
  if (scale === "linear") return value;
  const ln = Math.log(base);
  if (scale === "log") return value > 0 ? Math.log(value) / ln : Number.NaN;
  return (Math.sign(value) * Math.log1p(Math.abs(value))) / ln;
}

/** The value of a point in scale space; the inverse of `forward`. */
export function backward(scale: AxisScale, base: LogBase, position: number): number {
  if (scale === "linear") return position;
  if (scale === "log") return base ** position;
  return Math.sign(position) * Math.expm1(Math.abs(position) * Math.log(base));
}

/** Whether a scale can draw a value: a log scale leaves out zero and negative values. */
export function drawable(scale: AxisScale, value: number): boolean {
  return Number.isFinite(value) && (scale !== "log" || value > 0);
}

/** How many finite values a scale leaves out: those ≤ 0 on a log scale, none otherwise. */
export function skippedCount(scale: AxisScale, values: Iterable<number | null>): number {
  if (scale !== "log") return 0;
  let skipped = 0;
  for (const value of values) {
    if (value !== null && Number.isFinite(value) && value <= 0) skipped++;
  }
  return skipped;
}

/** Smallest and largest value the scale can draw, or null when there is none. */
export function drawableExtent(
  scale: AxisScale,
  values: Iterable<number | null>,
): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value === null || !drawable(scale, value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? { min, max } : null;
}

/**
 * The data range widened by the soft limits and made symmetric around zero where asked; fixed
 * ends are applied by the caller after rounding. A soft limit a log scale cannot draw (≤ 0) is
 * ignored there.
 */
export function softRange(
  extent: { min: number; max: number } | null,
  spec: ScaleSpec,
): { min: number; max: number } | null {
  const usable = (v: number | undefined) =>
    v !== undefined && Number.isFinite(v) && drawable(spec.scale, v) ? v : undefined;
  const softMin = usable(spec.softMin);
  const softMax = usable(spec.softMax);
  let min = extent?.min;
  let max = extent?.max;
  if (softMin !== undefined) min = min === undefined ? softMin : Math.min(min, softMin);
  if (softMax !== undefined) max = max === undefined ? softMax : Math.max(max, softMax);
  if (min === undefined || max === undefined) return null;
  if (spec.centeredZero === true && spec.scale !== "log") {
    const reach = Math.max(Math.abs(min), Math.abs(max));
    return { min: -reach, max: reach };
  }
  return { min, max };
}

/** The power of the base at or below (`floor`) or at or above a positive value. */
function power(base: LogBase, value: number, round: (x: number) => number): number {
  const exponent = round(Math.log(value) / Math.log(base) - (round === Math.ceil ? 1e-9 : -1e-9));
  // Huge values (near Number.MAX_VALUE) would round up to Infinity.
  return Math.min(base ** exponent, Number.MAX_VALUE);
}

/** A value on the symmetric log scale rounded outward to 0 or ± a power of the base. */
function symlogOutward(base: LogBase, value: number, up: boolean): number {
  if (value === 0) return 0;
  const magnitude = Math.abs(value);
  // Away from zero for the end that points away from zero, else toward it.
  const away = value > 0 === up;
  if (!away && magnitude < 1) return 0;
  const rounded = power(base, Math.max(magnitude, 1), away ? Math.ceil : Math.floor);
  return Math.sign(value) * rounded;
}

export interface ValueScale {
  min: number;
  max: number;
  /** The values with a tick, from min to max. */
  ticks: number[];
  /** Where a value lies between min (0) and max (1); NaN for values the scale cannot draw. */
  fraction: (value: number) => number;
}

/**
 * Ticks for a log scale: the powers of the base inside the range, thinned to about `count`; less
 * than two powers inside, the round values between (as on a linear scale) instead.
 */
export function logTicks(base: LogBase, min: number, max: number, count: number): number[] {
  if (!(min > 0) || !(max > min)) return [min];
  const from = Math.ceil(Math.log(min) / Math.log(base) - 1e-9);
  const to = Math.floor(Math.log(max) / Math.log(base) + 1e-9);
  if (to - from < 1) return niceTicks(min, max, count).filter((t) => t > 0);
  const every = Math.max(1, Math.ceil((to - from + 1) / Math.max(count, 2)));
  const ticks: number[] = [];
  for (let e = from; e <= to; e += every) ticks.push(Number((base ** e).toPrecision(12)));
  return ticks;
}

/** Ticks for "log around zero": zero and ± the powers of the base inside the range. */
export function symlogTicks(base: LogBase, min: number, max: number, count: number): number[] {
  const reach = Math.max(Math.abs(min), Math.abs(max), 1);
  const top = Math.floor(Math.log(reach) / Math.log(base) + 1e-9);
  const powers: number[] = [];
  for (let e = 0; e <= top; e++) powers.push(base ** e);
  const candidates = [...powers.map((p) => -p).reverse(), 0, ...powers].filter(
    (v) => v >= min - 1e-9 && v <= max + 1e-9,
  );
  if (candidates.length <= Math.max(count, 2)) return candidates;
  // Thinned evenly in scale space, keeping zero.
  const every = Math.ceil(candidates.length / Math.max(count, 2));
  const zero = candidates.indexOf(0);
  return candidates.filter((_, i) => (i - (zero === -1 ? 0 : zero)) % every === 0);
}

/**
 * The scale of a value axis over values from `low` to `high` (already widened as the chart
 * needs, such as from zero for bars), about `count` ticks. Open ends round outward: to the next
 * tick on a linear scale, to the next power of the base on a log scale and to 0 or ± a power
 * around zero. Fixed ends stay exactly.
 */
export function valueScale(
  extent: { min: number; max: number } | null,
  spec: ScaleSpec,
  count: number,
): ValueScale {
  const range = softRange(extent, spec);
  const { scale, base } = spec;
  let min: number;
  let max: number;
  let ticks: number[];
  if (scale === "log") {
    const low = range?.min ?? 1;
    const high = range?.max ?? base;
    min = spec.min !== undefined && spec.min > 0 ? spec.min : power(base, low, Math.floor);
    max = spec.max !== undefined && spec.max > min ? spec.max : power(base, high, Math.ceil);
    if (!(max > min)) max = min * base;
    ticks = logTicks(base, min, max, count);
  } else if (scale === "symlog") {
    const low = range?.min ?? 0;
    const high = range?.max ?? 1;
    min = spec.min ?? symlogOutward(base, low, false);
    max = spec.max ?? symlogOutward(base, high, true);
    if (!(max > min)) max = min + 1;
    ticks = symlogTicks(base, min, max, count);
  } else {
    const low = spec.min ?? range?.min ?? 0;
    const high = spec.max ?? range?.max ?? 1;
    const padding = high === low ? Math.abs(high) * 0.1 || 1 : 0;
    const rough = niceTicks(low - padding, high + padding, count);
    min = spec.min ?? Math.min(rough[0] ?? low, low - padding);
    max = spec.max ?? Math.max(rough.at(-1) ?? high, high + padding);
    if (spec.centeredZero === true && spec.min === undefined && spec.max === undefined) {
      const reach = Math.max(Math.abs(min), Math.abs(max));
      min = -reach;
      max = reach;
    }
    if (!(max > min)) max = min + 1;
    ticks = niceTicks(min, max, count);
  }
  ticks = ticks.filter((tick) => tick >= min - 1e-9 && tick <= max + 1e-9);
  const from = forward(scale, base, min);
  const span = forward(scale, base, max) - from || 1;
  return {
    min,
    max,
    ticks,
    fraction: (value) => (forward(scale, base, value) - from) / span,
  };
}
