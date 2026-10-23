import type { Field } from "../../api/generated/shapes";
import { toNumber } from "../frame";

export const REDUCERS = ["last", "mean", "min", "max", "sum"] as const;
export type Reducer = (typeof REDUCERS)[number];

export function parseReducer(value: unknown): Reducer {
  return REDUCERS.find((r) => r === value) ?? "last";
}

/**
 * Reduces a field to one value. int64 stays exact through BigInt for every reducer but the mean,
 * so a counter like 9007199254740993 is not shown rounded.
 */
export function reduceField(
  field: Field,
  reducer: Reducer,
): { value: unknown; type: Field["type"] } {
  const present = field.values.filter((v) => v !== null && v !== undefined);
  if (present.length === 0) {
    return { value: null, type: field.type };
  }
  if (reducer === "last") {
    return { value: present.at(-1), type: field.type };
  }
  if (field.type === "int64" && reducer !== "mean") {
    try {
      const values = present.map((v) => BigInt(String(v)));
      let result = values[0] as bigint;
      for (const v of values.slice(1)) {
        if (reducer === "sum") result += v;
        if (reducer === "min" && v < result) result = v;
        if (reducer === "max" && v > result) result = v;
      }
      return { value: result.toString(), type: "int64" };
    } catch {
      // Not a decimal string after all; fall through to numbers.
    }
  }
  // One pass in a loop: spreading 100,000 values into Math.min would overflow the call stack.
  let count = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const raw of present) {
    const value = toNumber(raw);
    if (value === null) {
      continue;
    }
    count++;
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (count === 0) {
    return { value: null, type: "number" };
  }
  const result =
    reducer === "min" ? min : reducer === "max" ? max : reducer === "sum" ? sum : sum / count;
  return { value: result, type: "number" };
}
