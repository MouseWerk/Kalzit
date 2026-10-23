import { valuesAt } from "./paths";
import { dateMs, isContainer, isTyped, numericValue, typeOf } from "./values";

/**
 * How the values of one field path are distributed over a set of documents: counts, top values,
 * and for numbers and dates the range and a histogram. Paths inside arrays (`items[].price`)
 * count every element. Computed from the documents the result holds; heavy statistics over a
 * whole collection belong in the database as a `$group` stage.
 */

export interface TopValue {
  /** The value as it came, for filtering by it. */
  value: unknown;
  count: number;
}

export interface Bin {
  from: number;
  to: number;
  count: number;
}

export interface Distribution {
  /** Values found at the path, array elements counted one by one. */
  values: number;
  /** Documents that contain the path. */
  documents: number;
  /** Documents without it. */
  missing: number;
  distinct: number;
  top: TopValue[];
  /** Numbers (`number`), dates (`date`), or neither. */
  scale: "number" | "date" | null;
  min?: unknown;
  max?: unknown;
  bins: Bin[];
}

/** A key per distinct value; typed values keep their type, so the ObjectId "1" is not the text "1". */
function keyOf(value: unknown): string {
  if (isTyped(value)) {
    return `${value.$type}:${value.value}`;
  }
  return `${typeOf(value)}:${typeof value === "object" ? JSON.stringify(value) : String(value)}`;
}

/** Equal-width bins between min and max; a single value gets one bin. */
export function histogram(numbers: readonly number[], count: number): Bin[] {
  if (numbers.length === 0) {
    return [];
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const n of numbers) {
    min = Math.min(min, n);
    max = Math.max(max, n);
  }
  if (min === max) {
    return [{ from: min, to: max, count: numbers.length }];
  }
  const width = (max - min) / count;
  const bins: Bin[] = Array.from({ length: count }, (_, i) => ({
    from: min + i * width,
    to: i === count - 1 ? max : min + (i + 1) * width,
    count: 0,
  }));
  for (const n of numbers) {
    const index = Math.min(count - 1, Math.floor((n - min) / width));
    (bins[index] as Bin).count++;
  }
  return bins;
}

export function distribution(
  documents: readonly unknown[],
  path: string,
  options: { bins?: number; top?: number } = {},
): Distribution {
  const counts = new Map<string, TopValue>();
  const numbers: number[] = [];
  const dates: number[] = [];
  const texts: string[] = [];
  let values = 0;
  let withPath = 0;
  for (const document of documents) {
    const found = valuesAt(document, path);
    if (found.length > 0) {
      withPath++;
    }
    for (const value of found) {
      // Objects and arrays are not values to count; their fields and elements have paths.
      if (isContainer(value)) {
        continue;
      }
      values++;
      const key = keyOf(value);
      const entry = counts.get(key);
      if (entry === undefined) {
        counts.set(key, { value, count: 1 });
      } else {
        entry.count++;
      }
      const number = numericValue(value);
      if (number !== null) {
        numbers.push(number);
      } else if (isTyped(value) && value.$type === "date") {
        const ms = dateMs(value);
        if (ms !== null) {
          dates.push(ms);
        }
      } else if (typeof value === "string") {
        texts.push(value);
      }
    }
  }
  const top = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, options.top ?? 10);
  const result: Distribution = {
    values,
    documents: withPath,
    missing: documents.length - withPath,
    distinct: counts.size,
    top,
    scale: null,
    bins: [],
  };
  // The scale follows the most common kind of value, so a few stray strings in a number field
  // still give the numbers' range.
  const bins = options.bins ?? 20;
  if (numbers.length > 0 && numbers.length >= dates.length) {
    result.scale = "number";
    result.min = numbers.reduce((a, b) => Math.min(a, b));
    result.max = numbers.reduce((a, b) => Math.max(a, b));
    result.bins = histogram(numbers, bins);
  } else if (dates.length > 0) {
    result.scale = "date";
    result.min = dates.reduce((a, b) => Math.min(a, b));
    result.max = dates.reduce((a, b) => Math.max(a, b));
    result.bins = histogram(dates, bins);
  } else if (texts.length > 0) {
    const sorted = [...texts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    result.min = sorted[0];
    result.max = sorted.at(-1);
  }
  return result;
}
