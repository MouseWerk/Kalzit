import { isRecord } from "../../api/client";
import type { Field, FieldType } from "../../api/generated/shapes";
import { isNumeric, toNumber } from "../frame";

/**
 * The table footer's calculations (ParityEditors board, frame 12), by the names the legend, the
 * "Reduzieren" step and overrides by values share: `first` and `last` skip gaps, `firstRow` and
 * `lastRow` take the row, `stddev` and `variance` are the sample measures (n - 1), `pN` is the
 * Nth percentile (1 to 99, interpolated between the nearest ranks).
 *
 * A small adapter until the shared module lands (`panels/calcs.ts` with #415, and
 * `analysis/calculations.ts` with #417): the names and their meaning are the same, so switching
 * to it changes no stored footer.
 */

/** The calculations a footer offers, in the picker's order. */
export const FOOTER_CALCS = [
  "sum",
  "mean",
  "min",
  "max",
  "last",
  "first",
  "count",
  "distinct",
  "gaps",
  "median",
  "range",
  "delta",
  "deltaPercent",
  "stddev",
  "variance",
  "lastRow",
  "firstRow",
] as const;

export type NamedFooterCalc = (typeof FOOTER_CALCS)[number];
export type FooterCalc = NamedFooterCalc | `p${number}`;

/** The percentiles the picker offers; any `p1` to `p99` is read. */
export const FOOTER_PERCENTILES = ["p90", "p95", "p99"] as const;

/** Calculations that make sense for any column; the rest need numbers. */
const ANY_TYPE: ReadonlySet<string> = new Set([
  "count",
  "distinct",
  "gaps",
  "last",
  "first",
  "lastRow",
  "firstRow",
]);

const PERCENTILE = /^p([1-9][0-9]?)$/;

/** The number of a percentile calculation (`p95` gives 95), or null. */
export function percentileOf(calc: string): number | null {
  const match = PERCENTILE.exec(calc);
  return match === null ? null : Number(match[1]);
}

/** A stored calculation name, or null when it is none (`stdDev` reads as `stddev`). */
export function parseFooterCalc(value: unknown): FooterCalc | null {
  if (value === "stdDev") return "stddev";
  if (typeof value !== "string") return null;
  if ((FOOTER_CALCS as readonly string[]).includes(value)) return value as NamedFooterCalc;
  return percentileOf(value) === null ? null : (value as FooterCalc);
}

/** Whether a calculation applies to a column of this type. */
export function calcFits(calc: FooterCalc, type: FieldType): boolean {
  return ANY_TYPE.has(calc) || isNumeric(type);
}

/** What a result is: in the column's unit, a plain count, a percentage, or one of its cells. */
export type CalcResultKind = "value" | "count" | "percent" | "cell";

export function calcResultKind(calc: FooterCalc): CalcResultKind {
  switch (calc) {
    case "count":
    case "distinct":
    case "gaps":
      return "count";
    case "deltaPercent":
      return "percent";
    case "first":
    case "last":
    case "firstRow":
    case "lastRow":
      return "cell";
    default:
      return "value";
  }
}

/** Over which rows the footer calculates. */
export type FooterRows = "all" | "filtered";

export interface FooterColumn {
  /** The column's shown name or field name. */
  column: string;
  calc: FooterCalc;
}

export interface TableFooter {
  show: boolean;
  over: FooterRows;
  /** The calculation of every number column without one of its own. */
  numbers?: FooterCalc;
  columns: FooterColumn[];
}

export const EMPTY_FOOTER: TableFooter = { show: false, over: "all", columns: [] };

/** The server's limits (`dashboards::panel_options`). */
export const MAX_FOOTER_COLUMNS = 100;
const MAX_COLUMN_CHARS = 200;

/** A stored footer, with unknown calculations and doubled columns left out. */
export function parseFooter(value: unknown): TableFooter {
  if (!isRecord(value)) return EMPTY_FOOTER;
  const numbers = parseFooterCalc(value.numbers);
  const columns: FooterColumn[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(value.columns) ? value.columns : []) {
    if (!isRecord(entry) || typeof entry.column !== "string") continue;
    const calc = parseFooterCalc(entry.calc);
    const column = entry.column;
    if (
      calc === null ||
      column === "" ||
      column.length > MAX_COLUMN_CHARS ||
      seen.has(column) ||
      columns.length >= MAX_FOOTER_COLUMNS
    ) {
      continue;
    }
    seen.add(column);
    columns.push({ column, calc });
  }
  return {
    show: value.show === true,
    over: value.over === "filtered" ? "filtered" : "all",
    ...(numbers === null ? {} : { numbers }),
    columns,
  };
}

/** The calculation of one column: its own, else the number columns' one, else none. */
export function calcFor(
  footer: TableFooter,
  field: Field,
  shownName: string,
): FooterCalc | undefined {
  const own =
    footer.columns.find((c) => c.column === shownName) ??
    footer.columns.find((c) => c.column === field.name);
  if (own !== undefined) return calcFits(own.calc, field.type) ? own.calc : undefined;
  return footer.numbers !== undefined && isNumeric(field.type) ? footer.numbers : undefined;
}

/** A gap: no value, or a number that is not finite. */
function isGap(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === "number" && !Number.isFinite(raw));
}

/**
 * The p-th percentile of sorted values, interpolated between the two nearest ranks (the method
 * of most spreadsheets): p50 of [1, 2, 3, 4] is 2.5.
 */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const a = sorted[low] as number;
  const b = sorted[high] as number;
  return a + (b - a) * (rank - low);
}

/** The result of a footer calculation: a number, or one of the column's cells as it is. */
export type CalcResult = { kind: "number"; value: number } | { kind: "cell"; raw: unknown };

/**
 * One calculation over the cells of `field` in `rows` (their order is the table's). Numbers
 * read as numbers (int64 and decimal as text too); cells that are no number are gaps for the
 * number calculations. NaN when there is nothing to calculate.
 */
export function calculate(calc: FooterCalc, field: Field, rows: ArrayLike<number>): CalcResult {
  const cells = field.values;
  const count = rows.length;
  const cellAt = (i: number): unknown => cells[rows[i] as number];
  switch (calc) {
    case "firstRow":
      return { kind: "cell", raw: count === 0 ? null : cellAt(0) };
    case "lastRow":
      return { kind: "cell", raw: count === 0 ? null : cellAt(count - 1) };
    case "first":
    case "last": {
      const forward = calc === "first";
      for (let k = 0; k < count; k++) {
        const raw = cellAt(forward ? k : count - 1 - k);
        if (!isGap(raw)) return { kind: "cell", raw };
      }
      return { kind: "cell", raw: null };
    }
    case "count":
    case "gaps": {
      let present = 0;
      for (let k = 0; k < count; k++) {
        if (!isGap(cellAt(k))) present++;
      }
      return { kind: "number", value: calc === "count" ? present : count - present };
    }
    case "distinct": {
      const seen = new Set<string>();
      for (let k = 0; k < count; k++) {
        const raw = cellAt(k);
        if (!isGap(raw)) seen.add(typeof raw === "string" ? raw : JSON.stringify(raw));
      }
      return { kind: "number", value: seen.size };
    }
    default:
      return { kind: "number", value: numberCalc(calc, numbersOf(field, rows)) };
  }
}

/** The cells of the rows that read as numbers, in order. */
function numbersOf(field: Field, rows: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let k = 0; k < rows.length; k++) {
    const value = toNumber(field.values[rows[k] as number]);
    if (value !== null && Number.isFinite(value)) out.push(value);
  }
  return out;
}

function numberCalc(calc: FooterCalc, values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const first = values[0] as number;
  const last = values[n - 1] as number;
  const variance = () => {
    if (n < 2) return Number.NaN;
    const mean = sum / n;
    let squares = 0;
    for (const v of values) squares += (v - mean) ** 2;
    return squares / (n - 1);
  };
  const sorted = () => [...values].sort((a, b) => a - b);
  switch (calc) {
    case "sum":
      return sum;
    case "mean":
      return sum / n;
    case "min":
      return min;
    case "max":
      return max;
    case "range":
      return max - min;
    case "delta":
      return last - first;
    case "deltaPercent":
      return first === 0 ? Number.NaN : ((last - first) / Math.abs(first)) * 100;
    case "median":
      return percentile(sorted(), 50);
    case "variance":
      return variance();
    case "stddev":
      return Math.sqrt(variance());
    default: {
      const p = percentileOf(calc);
      return p === null ? Number.NaN : percentile(sorted(), p);
    }
  }
}
