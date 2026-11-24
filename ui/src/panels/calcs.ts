/**
 * The calculations that reduce a series to one value: the legend's values today, and the table
 * footer, the "Reduzieren" step and overrides by values later (ParityEditors board, frame 3).
 * One name per calculation, the same everywhere. Every calculation reads the values in their
 * order (oldest first); a gap is a null, undefined or NaN. Results are numbers, NaN when there is
 * nothing to compute; `maxTime` is a time in Unix ms.
 */

/** The picker's groups, in the board's order; `more` is folded below the four. */
export const CALC_GROUPS = {
  frequent: ["last", "min", "max", "mean", "sum"],
  history: ["first", "delta", "deltaPercent", "range"],
  distribution: ["median", "percentile", "stddev", "variance"],
  count: ["count", "distinct", "gaps"],
  more: ["lastRow", "firstRow", "maxTime"],
} as const;

export type CalcGroup = keyof typeof CALC_GROUPS;
export const CALC_GROUP_ORDER: readonly CalcGroup[] = [
  "frequent",
  "history",
  "distribution",
  "count",
  "more",
];

/** A calculation with a fixed name; "percentile" stands for the picker entry, never stored. */
export type NamedCalc = Exclude<(typeof CALC_GROUPS)[CalcGroup][number], "percentile">;
/** A percentile, stored as `p` and its number: `p95`. */
export type PercentileCalc = `p${number}`;
export type Calc = NamedCalc | PercentileCalc;

export const NAMED_CALCS: readonly NamedCalc[] = CALC_GROUP_ORDER.flatMap((group) =>
  (CALC_GROUPS[group] as readonly string[]).filter((c): c is NamedCalc => c !== "percentile"),
);

/** Percentiles run from 1 to 99, whole numbers. */
export const PERCENTILE = { min: 1, max: 99 } as const;

/** The most values a legend shows per series (board decision 10). */
export const MAX_CALCS = 6;

const PERCENTILE_PATTERN = /^p([1-9][0-9]?)$/;

/** The number of a percentile calculation (`p95` gives 95), or null for any other. */
export function percentileOf(calc: string): number | null {
  const match = PERCENTILE_PATTERN.exec(calc);
  return match === null ? null : Number(match[1]);
}

/** Older spellings read as today's names. */
const ALIASES: Readonly<Record<string, NamedCalc>> = { stdDev: "stddev" };

/** A stored calculation name, or null when it is none. */
export function parseCalc(value: unknown): Calc | null {
  if (typeof value !== "string") return null;
  const alias = ALIASES[value];
  if (alias !== undefined) return alias;
  if ((NAMED_CALCS as readonly string[]).includes(value)) return value as NamedCalc;
  return percentileOf(value) === null ? null : (value as PercentileCalc);
}

/** Stored calculations: known names, each once, at most `max`, in their order. */
export function parseCalcs(value: unknown, max = MAX_CALCS): Calc[] {
  if (!Array.isArray(value)) return [];
  const calcs: Calc[] = [];
  for (const raw of value) {
    const calc = parseCalc(raw);
    if (calc !== null && !calcs.includes(calc)) calcs.push(calc);
    if (calcs.length >= max) break;
  }
  return calcs;
}

/** The group a calculation belongs to; percentiles are in "distribution". */
export function groupOf(calc: Calc): CalcGroup {
  if (percentileOf(calc) !== null) return "distribution";
  return CALC_GROUP_ORDER.find((g) =>
    (CALC_GROUPS[g] as readonly string[]).includes(calc),
  ) as CalcGroup;
}

/**
 * What a result is, for formatting: in the field's unit (sum, mean, range, percentiles), a plain
 * count (count, distinct, gaps), a percentage (change in %) or a time (time of the max).
 */
export type CalcKind = "value" | "count" | "percent" | "time";

export function calcKind(calc: Calc): CalcKind {
  switch (calc) {
    case "count":
    case "distinct":
    case "gaps":
      return "count";
    case "deltaPercent":
      return "percent";
    case "maxTime":
      return "time";
    default:
      return "value";
  }
}

/** No value: null, undefined, NaN or an infinity (which no chart can place either). */
function isGap(value: number | null | undefined): boolean {
  return value === null || value === undefined || !Number.isFinite(value);
}

/**
 * The p-th percentile of sorted values, interpolated between the two nearest ranks (the method
 * of most spreadsheets): p50 of [1, 2, 3, 4] is 2.5.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const a = sorted[low] as number;
  const b = sorted[high] as number;
  return a + (b - a) * (rank - low);
}

/** What one pass over the values collects; every calculation is read from it. */
interface Summary {
  values: ArrayLike<number | null>;
  times: ArrayLike<number> | undefined;
  present: number;
  gaps: number;
  sum: number;
  min: number;
  max: number;
  maxIndex: number;
  first: number;
  firstPresent: number;
  last: number;
  lastPresent: number;
  /** Sorted present values, made once on the first calculation that needs them. */
  sorted: number[] | null;
}

function summarize(values: ArrayLike<number | null>, times?: ArrayLike<number>): Summary {
  const s: Summary = {
    values,
    times,
    present: 0,
    gaps: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    maxIndex: -1,
    first: Number.NaN,
    firstPresent: Number.NaN,
    last: Number.NaN,
    lastPresent: Number.NaN,
    sorted: null,
  };
  // A loop, not spreads: 100,000 values in Math.min would overflow the call stack.
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    if (isGap(raw)) {
      s.gaps++;
      continue;
    }
    const value = raw as number;
    if (s.present === 0) s.firstPresent = value;
    s.present++;
    s.sum += value;
    if (value < s.min) s.min = value;
    if (value > s.max) {
      s.max = value;
      s.maxIndex = i;
    }
    s.lastPresent = value;
  }
  if (values.length > 0) {
    const first = values[0];
    const last = values[values.length - 1];
    s.first = isGap(first) ? Number.NaN : (first as number);
    s.last = isGap(last) ? Number.NaN : (last as number);
  }
  return s;
}

function sortedOf(s: Summary): number[] {
  if (s.sorted === null) {
    const sorted: number[] = [];
    for (let i = 0; i < s.values.length; i++) {
      const value = s.values[i];
      if (!isGap(value)) sorted.push(value as number);
    }
    s.sorted = sorted.sort((a, b) => a - b);
  }
  return s.sorted;
}

function variance(s: Summary): number {
  // The sample variance (n - 1), as the steps "Gruppieren" and "Pivot" store it: one value has
  // no spread to speak of.
  if (s.present < 2) return Number.NaN;
  const mean = s.sum / s.present;
  let squares = 0;
  for (let i = 0; i < s.values.length; i++) {
    const value = s.values[i];
    if (!isGap(value)) squares += ((value as number) - mean) ** 2;
  }
  return squares / (s.present - 1);
}

function calcOf(s: Summary, calc: Calc): number {
  const none = s.present === 0;
  switch (calc) {
    // "Letzter" and "Erster" skip gaps, as the stat panel's reducer and stored legends always
    // did; the row-exact values have keys of their own.
    case "last":
      return s.lastPresent;
    case "first":
      return s.firstPresent;
    case "lastRow":
      return s.last;
    case "firstRow":
      return s.first;
    case "min":
      return none ? Number.NaN : s.min;
    case "max":
      return none ? Number.NaN : s.max;
    case "mean":
      return none ? Number.NaN : s.sum / s.present;
    case "sum":
      return none ? Number.NaN : s.sum;
    case "delta":
      return none ? Number.NaN : s.lastPresent - s.firstPresent;
    case "deltaPercent":
      // From zero there is no change in percent.
      return none || s.firstPresent === 0
        ? Number.NaN
        : ((s.lastPresent - s.firstPresent) / Math.abs(s.firstPresent)) * 100;
    case "range":
      return none ? Number.NaN : s.max - s.min;
    case "median":
      return percentile(sortedOf(s), 50);
    case "variance":
      return variance(s);
    case "stddev":
      return Math.sqrt(variance(s));
    case "count":
      return s.present;
    case "gaps":
      return s.gaps;
    case "distinct":
      return new Set(sortedOf(s)).size;
    case "maxTime": {
      const time = s.maxIndex === -1 ? undefined : s.times?.[s.maxIndex];
      return time === undefined ? Number.NaN : time;
    }
    default: {
      const p = percentileOf(calc);
      return p === null ? Number.NaN : percentile(sortedOf(s), p);
    }
  }
}

/** One calculation over values (and their times, for `maxTime`). */
export function calculate(
  calc: Calc,
  values: ArrayLike<number | null>,
  times?: ArrayLike<number>,
): number {
  return calcOf(summarize(values, times), calc);
}

/** Several calculations over the same values, in one pass for the shared parts. */
export function calculateAll(
  calcs: readonly Calc[],
  values: ArrayLike<number | null>,
  times?: ArrayLike<number>,
): Partial<Record<Calc, number>> {
  const result: Partial<Record<Calc, number>> = {};
  if (calcs.length === 0) return result;
  const summary = summarize(values, times);
  for (const calc of calcs) {
    result[calc] = calcOf(summary, calc);
  }
  return result;
}
