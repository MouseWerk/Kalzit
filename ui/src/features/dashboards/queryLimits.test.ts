import { describe, expect, it } from "vitest";
import type { PanelModel } from "./model";
import { parseModel } from "./model";
import { fixedDurationMs, queryLimits, queryOptionsProblem } from "./queryLimits";

const panel = (extra: Partial<PanelModel> = {}): PanelModel => ({
  id: "p",
  type: "timeseries",
  title: "Umsatz",
  grid: { x: 0, y: 0, w: 12, h: 8 },
  targets: [],
  transformations: [],
  options: {},
  fieldConfig: {},
  ...extra,
});
const SIX_HOURS = { from: 0, to: 6 * 3_600_000 };

describe("query options", () => {
  it("read fixed lengths up to days", () => {
    expect(fixedDurationMs("30s")).toBe(30_000);
    expect(fixedDurationMs("5m")).toBe(300_000);
    expect(fixedDurationMs("1d")).toBe(86_400_000);
    for (const text of ["0s", "1w", "1M", "30", "1.5h", " 5m"]) {
      expect(fixedDurationMs(text), text).toBeNull();
    }
  });

  it("spread the range over the points, at least a second, raised to the smallest interval", () => {
    expect(queryLimits(panel(), SIX_HOURS)).toEqual({
      maxDataPoints: 1000,
      intervalMs: 21_600,
      raised: false,
    });
    expect(queryLimits(panel({ maxDataPoints: 100 }), SIX_HOURS)).toEqual({
      maxDataPoints: 100,
      intervalMs: 216_000,
      raised: false,
    });
    expect(queryLimits(panel({ minInterval: "1m" }), SIX_HOURS)).toEqual({
      maxDataPoints: 1000,
      intervalMs: 60_000,
      raised: true,
    });
    expect(queryLimits(panel({ minInterval: "10s" }), SIX_HOURS).raised).toBe(false);
    expect(queryLimits(panel(), { from: 0, to: 60_000 }).intervalMs).toBe(1000);
  });

  it("name the first option that is not valid", () => {
    expect(queryOptionsProblem(panel())).toBeNull();
    expect(queryOptionsProblem(panel({ maxDataPoints: 0 }))).toBe("maxDataPoints");
    expect(queryOptionsProblem(panel({ maxDataPoints: 10_001 }))).toBe("maxDataPoints");
    expect(queryOptionsProblem(panel({ minInterval: "2d" }))).toBe("minInterval");
    expect(queryOptionsProblem(panel({ cacheTimeout: "1w" }))).toBe("cacheTimeout");
    expect(queryOptionsProblem(panel({ cacheTimeout: "1d" }))).toBeNull();
  });

  it("are kept when a model is read", () => {
    const model = parseModel(
      {
        schemaVersion: 2,
        title: "T",
        timeRange: { from: "now-6h", to: "now" },
        variables: [],
        panels: [
          {
            ...panel(),
            maxDataPoints: 500,
            minInterval: "30s",
            cacheTimeout: "5m",
            hideTimeNote: true,
          },
          { ...panel({ id: "q" }), maxDataPoints: 1.5, hideTimeNote: "yes" },
        ],
      },
      "T",
    );
    expect(model.panels[0]).toMatchObject({
      maxDataPoints: 500,
      minInterval: "30s",
      cacheTimeout: "5m",
      hideTimeNote: true,
    });
    expect(model.panels[1]?.maxDataPoints).toBeUndefined();
    expect(model.panels[1]?.hideTimeNote).toBeUndefined();
  });
});
