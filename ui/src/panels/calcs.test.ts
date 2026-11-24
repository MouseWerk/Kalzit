import { describe, expect, it } from "vitest";
import {
  CALC_GROUPS,
  calcKind,
  calculate,
  calculateAll,
  groupOf,
  MAX_CALCS,
  NAMED_CALCS,
  parseCalc,
  parseCalcs,
  percentile,
} from "./calcs";

// Oldest first; a gap is null or NaN. The last row is a gap, the first is not.
const values = [4, null, 1, 7, Number.NaN, 1, 3, null];
const times = [0, 10, 20, 30, 40, 50, 60, 70];

describe("the shared calculations", () => {
  it("has the board's 19 entries in four groups and three more", () => {
    const entries = Object.values(CALC_GROUPS).flat();
    expect(entries).toHaveLength(19);
    expect(CALC_GROUPS.frequent).toEqual(["last", "min", "max", "mean", "sum"]);
    // Every entry but the percentile picker is a stored name.
    expect(NAMED_CALCS).toHaveLength(18);
    expect(groupOf("p95")).toBe("distribution");
    expect(groupOf("sum")).toBe("frequent");
    expect(groupOf("maxTime")).toBe("more");
  });

  it("reduces values with gaps the way each name says", () => {
    const all = calculateAll([...NAMED_CALCS, "p50", "p90"], values, times);
    expect(all).toMatchObject({
      // The last row is a gap: "Letzter" has nothing, "Letzter ohne Lücke" skips it.
      last: Number.NaN,
      lastNotNull: 3,
      first: 4,
      firstNotNull: 4,
      min: 1,
      max: 7,
      sum: 16,
      mean: 16 / 5,
      delta: 3 - 4,
      deltaPercent: -25,
      range: 6,
      median: 3,
      p50: 3,
      count: 5,
      gaps: 3,
      distinct: 4,
      maxTime: 30,
    });
    // Population variance of 4, 1, 7, 1, 3 around 3.2.
    expect(all.variance).toBeCloseTo(4.96);
    expect(all.stdDev).toBeCloseTo(Math.sqrt(4.96));
    expect(all.p90).toBeCloseTo(5.8);
  });

  it("interpolates percentiles between the nearest ranks", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 1)).toBeCloseTo(1.03);
    expect(percentile([1, 2, 3, 4], 99)).toBeCloseTo(3.97);
    expect(percentile([], 50)).toBeNaN();
    expect(calculate("p95", Float64Array.from([10]))).toBe(10);
  });

  it("has nothing to say about no values, and no change in percent from zero", () => {
    for (const calc of ["last", "min", "max", "mean", "sum", "median", "delta", "p95"] as const) {
      expect(calculate(calc, [null, Number.NaN])).toBeNaN();
    }
    expect(calculate("count", [])).toBe(0);
    expect(calculate("gaps", [null, Number.NaN])).toBe(2);
    expect(calculate("deltaPercent", [0, 5])).toBeNaN();
    expect(calculate("deltaPercent", [-4, -2])).toBe(50);
    // The time of the max needs times.
    expect(calculate("maxTime", [1, 2])).toBeNaN();
  });

  it("stays fast and stack-safe with many values", () => {
    const many = Float64Array.from({ length: 200_000 }, (_, i) => i % 1000);
    expect(calculate("max", many)).toBe(999);
    expect(calculate("sum", many)).toBe(200 * 499_500);
  });

  it("formats sums and percentiles in the field's unit, counts as plain numbers", () => {
    expect(calcKind("sum")).toBe("value");
    expect(calcKind("p99")).toBe("value");
    expect(calcKind("range")).toBe("value");
    expect(calcKind("count")).toBe("count");
    expect(calcKind("distinct")).toBe("count");
    expect(calcKind("gaps")).toBe("count");
    expect(calcKind("deltaPercent")).toBe("percent");
    expect(calcKind("maxTime")).toBe("time");
  });

  it("reads stored names defensively: known ones, each once, at most six", () => {
    expect(parseCalc("sum")).toBe("sum");
    expect(parseCalc("p95")).toBe("p95");
    for (const wrong of ["total", "p0", "p100", "p095", "p9.5", "percentile", 3, null]) {
      expect(parseCalc(wrong)).toBeNull();
    }
    expect(parseCalcs(["sum", "sum", "nope", "p95", "last"])).toEqual(["sum", "p95", "last"]);
    expect(
      parseCalcs(["last", "min", "max", "mean", "sum", "first", "range", "count"]),
    ).toHaveLength(MAX_CALCS);
    expect(parseCalcs("sum")).toEqual([]);
  });
});
