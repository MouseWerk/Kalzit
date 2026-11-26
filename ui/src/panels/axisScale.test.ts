import { describe, expect, it } from "vitest";
import {
  backward,
  drawable,
  drawableExtent,
  forward,
  logTicks,
  type ScaleSpec,
  skippedCount,
  softRange,
  symlogTicks,
  valueScale,
} from "./axisScale";

const LOG10: ScaleSpec = { scale: "log", base: 10 };
const SYMLOG: ScaleSpec = { scale: "symlog", base: 10 };

describe("axis scale math", () => {
  it("maps values into scale space and back", () => {
    expect(forward("linear", 10, 42)).toBe(42);
    expect(forward("log", 10, 1000)).toBeCloseTo(3);
    expect(forward("log", 2, 8)).toBeCloseTo(3);
    for (const v of [0.5, 1, 99, 12_345]) {
      expect(backward("log", 10, forward("log", 10, v))).toBeCloseTo(v);
    }
    for (const v of [-5000, -1, -0.25, 0, 0.25, 1, 5000]) {
      expect(backward("symlog", 10, forward("symlog", 10, v))).toBeCloseTo(v);
      expect(backward("symlog", 2, forward("symlog", 2, v))).toBeCloseTo(v);
    }
  });

  it("cannot draw zero or negative values on a log scale, and counts them", () => {
    expect(forward("log", 10, 0)).toBeNaN();
    expect(forward("log", 10, -3)).toBeNaN();
    expect(drawable("log", 0)).toBe(false);
    expect(drawable("symlog", -3)).toBe(true);
    const values = [0, -2, 5, null, Number.NaN, 50, 0];
    expect(skippedCount("log", values)).toBe(3);
    expect(skippedCount("symlog", values)).toBe(0);
    expect(skippedCount("linear", values)).toBe(0);
    expect(drawableExtent("log", values)).toEqual({ min: 5, max: 50 });
    expect(drawableExtent("log", [0, -1])).toBeNull();
  });

  it("is nearly linear close to zero around zero, symmetric and monotonic", () => {
    expect(forward("symlog", 10, 0)).toBe(0);
    expect(forward("symlog", 10, -7)).toBeCloseTo(-forward("symlog", 10, 7));
    const near = forward("symlog", 10, 0.01) / forward("symlog", 10, 0.02);
    expect(near).toBeCloseTo(0.5, 2);
    let last = Number.NEGATIVE_INFINITY;
    for (const v of [-1e6, -100, -1, 0, 1, 100, 1e6]) {
      const at = forward("symlog", 10, v);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  it("rounds a log axis out to powers of the base, ticks on the powers", () => {
    const scale = valueScale({ min: 3, max: 4200 }, LOG10, 5);
    expect(scale.min).toBe(1);
    expect(scale.max).toBe(10_000);
    expect(scale.ticks).toEqual([1, 10, 100, 1000, 10_000]);
    expect(scale.fraction(100)).toBeCloseTo(0.5);
    expect(scale.fraction(0)).toBeNaN();
    expect(valueScale({ min: 3, max: 40 }, { scale: "log", base: 2 }, 8).ticks).toEqual([
      2, 4, 8, 16, 32, 64,
    ]);
    // Within one decade the round values between stand in.
    expect(logTicks(10, 20, 80, 4).length).toBeGreaterThan(1);
    // Thinned to about the count asked.
    expect(logTicks(10, 1, 1e12, 4).length).toBeLessThanOrEqual(5);
  });

  it("keeps fixed ends and ignores a soft limit a log axis cannot draw", () => {
    expect(valueScale({ min: 3, max: 400 }, { ...LOG10, min: 2, max: 500 }, 5)).toMatchObject({
      min: 2,
      max: 500,
    });
    expect(valueScale({ min: 3, max: 400 }, { ...LOG10, softMin: -5 }, 5).min).toBe(1);
    expect(valueScale({ min: 30, max: 400 }, { ...LOG10, softMin: 2 }, 5).min).toBe(1);
    // No positive value at all: one decade from 1.
    expect(valueScale(null, LOG10, 5)).toMatchObject({ min: 1, max: 10 });
  });

  it("draws negative values around zero, with zero and the powers as ticks", () => {
    const scale = valueScale({ min: -250, max: 4000 }, SYMLOG, 12);
    expect(scale.min).toBe(-1000);
    expect(scale.max).toBe(10_000);
    expect(scale.ticks).toEqual([-1000, -100, -10, -1, 0, 1, 10, 100, 1000, 10_000]);
    expect(scale.fraction(0)).toBeGreaterThan(0);
    expect(scale.fraction(0)).toBeLessThan(1);
    expect(symlogTicks(10, -1000, 1000, 3)).toContain(0);
    expect(valueScale({ min: 0.2, max: 0.6 }, SYMLOG, 5)).toMatchObject({ min: 0, max: 1 });
  });

  it("widens by soft limits only as far as the data does not reach", () => {
    const linear: ScaleSpec = { scale: "linear", base: 10, softMax: 100 };
    expect(softRange({ min: 2, max: 40 }, linear)).toEqual({ min: 2, max: 100 });
    expect(softRange({ min: 2, max: 140 }, linear)).toEqual({ min: 2, max: 140 });
    expect(softRange(null, linear)).toBeNull();
    expect(softRange(null, { ...linear, softMin: 0 })).toEqual({ min: 0, max: 100 });
    expect(valueScale({ min: 2, max: 40 }, linear, 4).max).toBe(100);
  });

  it("centers zero on a linear axis", () => {
    const centered = valueScale(
      { min: -10, max: 35 },
      { scale: "linear", base: 10, centeredZero: true },
      4,
    );
    expect(centered.min).toBe(-centered.max);
    expect(centered.max).toBeGreaterThanOrEqual(35);
    expect(centered.fraction(0)).toBeCloseTo(0.5);
  });
});
