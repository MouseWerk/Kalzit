import type { Field, FieldType } from "../api/generated/shapes";
import { compareText, parseNumber } from "./expr";
import * as stats from "./stats";

/**
 * The calculations that reduce many cells to one value, shared by the steps that summarize:
 * group, pivot and reduce. Empty cells are left out of every calculation. The server computes the
 * same in `server/src/analysis/calculations.rs`.
 */

/**
 * A calculation that reduces many cells to one: `first` and `last` are the first and last value
 * that is not empty, `firstRow` and `lastRow` the cell of the first and the last row; `stddev` and
 * `variance` are the sample measures (n - 1); `pN` is the Nth percentile (0 to 100, as Excel's
 * PERCENTILE.INC). The server reads `stdDev` as `stddev` too.
 */
export type Agg =
  | "count"
  | "sum"
  | "mean"
  | "median"
  | "min"
  | "max"
  | "stddev"
  | "variance"
  | "first"
  | "last"
  | "firstRow"
  | "lastRow"
  | `p${number}`;

/** The calculations the forms offer, in their order. */
export const AGGS: readonly Agg[] = [
  "sum",
  "mean",
  "median",
  "min",
  "max",
  "count",
  "stddev",
  "variance",
  "first",
  "last",
  "firstRow",
  "lastRow",
  "p90",
  "p95",
  "p99",
];

/** A calculation's key as the server writes it in field names: `stdDev` as `stddev`. */
export const aggName = (op: Agg): string => ((op as string) === "stdDev" ? "stddev" : op);

/** The percentile a `pN` key names, or null for any other key. */
export function percentileOf(op: string): number | null {
  const m = /^p(0|[1-9][0-9]{0,2})$/.exec(op);
  const n = m === null ? null : Number(m[1]);
  return n !== null && n <= 100 ? n : null;
}

/**
 * A cell as a number: numbers, int64 text (by the shared number grammar, `parseNumber`) and
 * times; anything else is empty.
 */
export function numberAt(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return parseNumber(value);
  return null;
}

const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);

/**
 * An int64 cell as an exact integer: an optional sign and digits, spaces around allowed, within
 * the range of i128 (as the server reads it).
 */
export function intOf(value: unknown): bigint | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value !== "string") return null;
  const t = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = BigInt(t);
  return n > I128_MAX || n < I128_MIN ? null : n;
}

/** A number as a cell: empty when it is not finite, and never negative zero. */
export const numCell = (x: number | null) =>
  x === null || !Number.isFinite(x) ? null : x === 0 ? 0 : x;

const isNumeric = (t: FieldType) => t === "number" || t === "int64" || t === "decimal";

/**
 * The type of `op` over a field of type `t`, or null when `op` cannot read it: `count` any field
 * (a number), `first`, `last`, `firstRow` and `lastRow` any field (its own type), `min` and `max`
 * numbers, times and text (their own type), the others numbers only (a number).
 */
export function resultType(op: Agg, t: FieldType): FieldType | null {
  if (op === "count") return "number";
  if (op === "first" || op === "last" || op === "firstRow" || op === "lastRow") return t;
  if (op === "min" || op === "max") {
    return isNumeric(t) || t === "time" || t === "date" || t === "string" ? t : null;
  }
  const known = ["sum", "mean", "median", "stddev", "stdDev", "variance"].includes(op);
  return isNumeric(t) && (known || percentileOf(op) !== null) ? "number" : null;
}

/** Reduces the cells of `rows` of `field` by `op`; empty cells are left out. */
export function aggregate(field: Field, key: Agg, rows: readonly number[]): unknown {
  const op = (key as string) === "stdDev" ? "stddev" : key;
  const cells = rows.map((r) => field.values[r]).filter((v) => v !== null && v !== undefined);
  const nums = () =>
    rows.map((r) => numberAt(field.values[r])).filter((v): v is number => v !== null);
  switch (op) {
    case "count":
      return cells.length;
    case "first":
      return cells[0] ?? null;
    case "last":
      return cells.at(-1) ?? null;
    case "firstRow":
      return rows.length === 0 ? null : (field.values[rows[0] as number] ?? null);
    case "lastRow":
      return rows.length === 0 ? null : (field.values[rows.at(-1) as number] ?? null);
    case "variance":
      return numCell(stats.variance(nums()));
    case "sum": {
      const v = nums();
      return numCell(v.length === 0 ? null : stats.sum(v));
    }
    case "mean":
      return numCell(stats.mean(nums()));
    case "median":
      return numCell(stats.percentile(stats.sorted(nums()), 50));
    case "stddev":
      return numCell(stats.stddev(nums()));
    default: {
      const p = percentileOf(op);
      if (p !== null) return numCell(stats.percentile(stats.sorted(nums()), p));
      const less = (a: unknown, b: unknown): boolean => {
        if (field.type === "int64") {
          const x = intOf(a);
          const y = intOf(b);
          if (x !== null && y !== null) return x < y;
          return (numberAt(a) as number) < (numberAt(b) as number);
        }
        if (field.type === "string") return compareText(String(a), String(b)) < 0;
        return (numberAt(a) as number) < (numberAt(b) as number);
      };
      let best: unknown = null;
      for (const v of cells) {
        if (field.type !== "string" && numberAt(v) === null) continue;
        if (best === null || (op === "min" ? less(v, best) : less(best, v))) best = v;
      }
      return best;
    }
  }
}
