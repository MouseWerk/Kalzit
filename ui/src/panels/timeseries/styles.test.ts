import { describe, expect, it } from "vitest";
import type { FieldOptions } from "../fieldConfig/fieldConfig";
import { parseFieldConfig } from "../fieldConfig/fieldConfig";
import {
  formatDuration,
  parseDuration,
  parseGraphStyle,
  stackGroupOf,
} from "../fieldConfig/graphStyle";
import { legacyLineWidth, upgradePanel } from "../fieldConfig/upgrade";
import { parseColor, shiftHue, withAlpha } from "./canvasColor";
import type { Series } from "./series";
import {
  dashFor,
  isMonochrome,
  refineGaps,
  resolveStyles,
  type SeriesStyle,
  spansGaps,
  stackData,
} from "./styles";

const series = (options: FieldOptions = {}): Series => ({
  name: "s",
  times: new Float64Array(),
  values: new Float64Array(),
  options,
});

describe("graph style defaults", () => {
  it("draws a lone series monochrome: smooth, 2 px, a fading hatch", () => {
    const [style] = resolveStyles([series()]);
    expect(style).toMatchObject({
      colorClass: "series-mono",
      swatchClass: "series-mono",
      drawStyle: "line",
      interpolation: "smooth",
      lineWidth: 2,
      lineStyle: "solid",
      dash: [],
      fill: "hatch",
      fillOpacity: 1,
      gradient: "opacity",
      showPoints: "auto",
      stack: "none",
    });
  });

  it("draws a comparison series muted and dashed, without fill, beside a monochrome main one", () => {
    const styles = resolveStyles([series(), series({ comparison: true })]);
    expect(isMonochrome([series(), series({ comparison: true })])).toBe(true);
    expect(styles[0]?.colorClass).toBe("series-mono");
    expect(styles[1]).toMatchObject({
      colorClass: "series-mono-compare",
      swatchClass: "series-mono-compare ts__swatch--dashed",
      lineStyle: "dashed",
      fill: "none",
      interpolation: "linear",
    });
  });

  it("gives several series the palette, 1 px and no fill", () => {
    const styles = resolveStyles([series(), series(), series()]);
    expect(styles.map((s) => s.colorClass)).toEqual(["series-1", "series-2", "series-3"]);
    expect(styles.map((s) => [s.lineWidth, s.fill, s.interpolation])).toEqual([
      [1, "none", "linear"],
      [1, "none", "linear"],
      [1, "none", "linear"],
    ]);
  });

  it("keeps a fixed color and leaves the monochrome look then", () => {
    const styles = resolveStyles([series({ color: "chart-4" })]);
    expect(styles[0]?.colorClass).toBe("tone--chart-4");
    expect(styles[0]?.fill).toBe("none");
  });

  it("fills bars at full strength and stacked lines solid", () => {
    expect(resolveStyles([series({ drawStyle: "bars" })])[0]).toMatchObject({
      fill: "solid",
      fillOpacity: 1,
      colorClass: "series-mono",
      barAlignment: 0,
      barWidth: 0.6,
    });
    const stacked = resolveStyles([series({ stack: "normal" }), series({ stack: "normal" })]);
    expect(stacked.map((s) => [s.fill, s.fillOpacity])).toEqual([
      ["solid", 0.4],
      ["solid", 0.4],
    ]);
    expect(resolveStyles([series({ drawStyle: "points" })])[0]).toMatchObject({
      fill: "none",
      showPoints: "always",
    });
  });

  it("takes every option as set", () => {
    const [style] = resolveStyles([
      series({
        drawStyle: "bars",
        lineWidth: 3,
        fill: "hatch",
        fillOpacity: 40,
        gradientMode: "scheme",
        showPoints: "never",
        pointSize: 9,
        connectGaps: "threshold",
        connectGapsBelow: 60_000,
        breakAfter: 300_000,
        stack: "percent",
        stackGroup: "B",
        barAlignment: "before",
        barWidth: 90,
      }),
    ]);
    expect(style).toMatchObject({
      drawStyle: "bars",
      lineWidth: 3,
      fill: "hatch",
      fillOpacity: 0.4,
      gradient: "scheme",
      showPoints: "never",
      pointSize: 9,
      connectGaps: "threshold",
      connectGapsBelow: 60_000,
      breakAfter: 300_000,
      stack: "percent",
      stackGroup: "B",
      barAlignment: -1,
      barWidth: 0.9,
    });
  });

  it("draws dashes and dots that grow with the line", () => {
    expect(dashFor("solid", 2)).toEqual([]);
    expect(dashFor("dashed", 1)).toEqual([5.25, 4.5]);
    expect(dashFor("dashed", 2)).toEqual([7, 6]);
    expect(dashFor("dotted", 2)).toEqual([0, 5]);
  });
});

describe("stacking", () => {
  const styles = (options: FieldOptions[]) => resolveStyles(options.map((o) => series(o)));

  it("sums only aligned points and leaves gaps as gaps", () => {
    const result = stackData(
      [
        [1, null, 3, 4],
        [10, 20, null, 40],
        [100, 200, 300, null],
      ],
      styles([{ stack: "normal" }, { stack: "normal" }, { stack: "normal" }]),
    );
    expect(result.ys).toEqual([
      [1, null, 3, 4],
      [11, 20, null, 44],
      [111, 220, 303, null],
    ]);
    expect([...(result.baselines[2] ?? [])]).toEqual([11, 20, 3, 44]);
    expect(result.percent).toBe(false);
  });

  it("stacks to 100 % of the values present at each time", () => {
    const result = stackData(
      [
        [1, 3, null],
        [3, 1, 2],
      ],
      styles([{ stack: "percent" }, { stack: "percent" }]),
    );
    expect(result.ys).toEqual([
      [25, 75, null],
      [100, 100, 100],
    ]);
    expect(result.percent).toBe(true);
  });

  it("stacks positive values up and negative values down from zero, each on its own sum", () => {
    const result = stackData(
      [
        [10, 10, -4],
        [-5, -5, -5],
        [3, -2, 1],
        [-1, -1, -1],
      ],
      styles([{ stack: "normal" }, { stack: "normal" }, { stack: "normal" }, { stack: "normal" }]),
    );
    expect(result.ys).toEqual([
      [10, 10, -4],
      [-5, -5, -9],
      [13, -7, 1],
      [-6, -8, -10],
    ]);
    // Bars stand and fills end on the sum of their own side, point by point.
    expect([...(result.baselines[2] ?? [])]).toEqual([10, -5, 0]);
    expect([...(result.baselines[3] ?? [])]).toEqual([-5, -7, -9]);
  });

  it("fills a series above one that changes sides from zero, never across it", () => {
    const result = stackData(
      [
        [5, -5],
        [3, 3],
      ],
      styles([{ stack: "normal" }, { stack: "normal" }]),
    );
    expect(result.ys).toEqual([
      [5, -5],
      [8, 3],
    ]);
    // At the second point the first series went below zero, so the second stands on zero.
    expect([...(result.baselines[1] ?? [])]).toEqual([5, 0]);
  });

  it("stacks over a series without any value as if it were not there", () => {
    const result = stackData(
      [
        [null, null],
        [2, 4],
      ],
      styles([{ stack: "normal" }, { stack: "normal" }]),
    );
    expect(result.ys).toEqual([
      [null, null],
      [2, 4],
    ]);
    expect([...(result.baselines[1] ?? [])]).toEqual([0, 0]);
  });

  it("stacks to 100 % of the absolute values, so +5 and -5 are +50 % and -50 %", () => {
    const result = stackData(
      [
        [5, -3, 0],
        [-5, -1, 0],
      ],
      styles([{ stack: "percent" }, { stack: "percent" }]),
    );
    // A negative total stays below zero and reaches -100 %; all zero is 0 % (0/0 is 0).
    expect(result.ys).toEqual([
      [50, -75, 0],
      [-50, -100, 0],
    ]);
  });

  it("keeps groups apart and leaves unstacked series alone", () => {
    const result = stackData(
      [[1], [2], [3], [4]],
      styles([
        { stack: "normal", stackGroup: "A" },
        { stack: "normal", stackGroup: "B" },
        {},
        { stack: "normal", stackGroup: "A" },
      ]),
    );
    expect(result.ys).toEqual([[1], [2], [3], [5]]);
    expect(result.baselines[2]).toBeNull();
  });
});

describe("gaps", () => {
  const style = (options: FieldOptions): SeriesStyle =>
    resolveStyles([series(options), series()])[0] as SeriesStyle;
  // One canvas px per ms, so pixels read as times.
  const pixelOf = (time: number) => time;
  const xs = [0, 10, 20, 30, 100, 110];
  const ys = [1, null, 1, 1, 1, 1];
  const nullGaps: [number, number][] = [[0, 20]];

  it("keeps every gap by default and bridges all with always", () => {
    expect(refineGaps(style({}), xs, ys, 0, 5, nullGaps, 1, pixelOf)).toEqual([[0, 20]]);
    expect(
      refineGaps(style({ connectGaps: "always" }), xs, ys, 0, 5, nullGaps, 1, pixelOf),
    ).toEqual([]);
    expect(spansGaps(style({ connectGaps: "always" }))).toBe(true);
    expect(spansGaps(style({ connectGaps: "always", breakAfter: 50 }))).toBe(false);
  });

  it("bridges gaps shorter than the threshold only", () => {
    const below = (ms: number) =>
      refineGaps(
        style({ connectGaps: "threshold", connectGapsBelow: ms }),
        xs,
        ys,
        0,
        5,
        nullGaps,
        1,
        pixelOf,
      );
    expect(below(30)).toEqual([]);
    expect(below(20)).toEqual([[0, 20]]);
  });

  it("breaks the line between points further apart than break after", () => {
    expect(refineGaps(style({ breakAfter: 50 }), xs, ys, 0, 5, nullGaps, 1, pixelOf)).toEqual([
      [0, 20],
      [30, 100],
    ]);
    // Overlapping gaps merge, so uPlot's clip stays in order.
    expect(
      refineGaps(style({ breakAfter: 5 }), [0, 10, 20], [1, 1, 1], 0, 2, [[5, 15]], 1, pixelOf),
    ).toEqual([[0, 20]]);
  });
});

describe("graph style options", () => {
  it("are read with their bounds; wrong values are dropped", () => {
    expect(
      parseGraphStyle({
        drawStyle: "bars",
        lineInterpolation: "stepAfter",
        lineWidth: 10,
        lineStyle: "dotted",
        fill: "hatch",
        fillOpacity: 0,
        gradientMode: "hue",
        showPoints: "always",
        pointSize: 40,
        connectGaps: "threshold",
        connectGapsBelow: 1,
        breakAfter: 365 * 86_400_000,
        stack: "percent",
        stackGroup: "x".repeat(60),
        barAlignment: "after",
        barWidth: 10,
        comparison: true,
      }),
    ).toEqual({
      drawStyle: "bars",
      lineInterpolation: "stepAfter",
      lineWidth: 10,
      lineStyle: "dotted",
      fill: "hatch",
      fillOpacity: 0,
      gradientMode: "hue",
      showPoints: "always",
      pointSize: 40,
      connectGaps: "threshold",
      connectGapsBelow: 1,
      breakAfter: 365 * 86_400_000,
      stack: "percent",
      stackGroup: "x".repeat(50),
      barAlignment: "after",
      barWidth: 10,
      comparison: true,
    });
    expect(
      parseGraphStyle({
        drawStyle: "area",
        lineWidth: 11,
        fillOpacity: 50.5,
        pointSize: 0,
        breakAfter: 0,
        barWidth: 101,
        stackGroup: "",
        comparison: "yes",
      }),
    ).toEqual({});
  });

  it("drop control characters from a stack group, as the server refuses them", () => {
    expect(parseGraphStyle({ stackGroup: "in\u0000\tbound\u007f\u0085" })).toEqual({
      stackGroup: "inbound",
    });
    expect(parseGraphStyle({ stackGroup: "\n\r" })).toEqual({});
    expect(stackGroupOf("ä".repeat(60))).toBe("ä".repeat(50));
  });

  it("are field options, so an override sets them per series", () => {
    const config = parseFieldConfig({
      defaults: { drawStyle: "line", fill: "none" },
      overrides: [
        {
          matcher: { type: "name", value: "previous" },
          properties: { comparison: true, lineStyle: null },
        },
      ],
    });
    expect(config.defaults).toEqual({ drawStyle: "line", fill: "none" });
    expect(config.overrides[0]?.properties).toEqual({ comparison: true, lineStyle: null });
  });

  it("read and write durations", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("1h 30m")).toBe(5_400_000);
    expect(parseDuration("250")).toBe(250);
    expect(parseDuration(" 2d ")).toBe(172_800_000);
    for (const bad of ["", "5x", "-1m", "0", "400d"]) {
      expect(parseDuration(bad), bad).toBeNull();
    }
    expect(formatDuration(90_000)).toBe("90s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(1500)).toBe("1500ms");
    expect(parseDuration(formatDuration(5_400_000))).toBe(5_400_000);
  });
});

describe("older time series", () => {
  it("move their line width into the field options; 1 was the default and is dropped", () => {
    expect(upgradePanel({ options: { lineWidth: 3 }, fieldConfig: {} })).toEqual({
      options: {},
      fieldConfig: { defaults: { lineWidth: 3 } },
    });
    expect(upgradePanel({ options: { lineWidth: 1 }, fieldConfig: {} })).toEqual({
      options: {},
      fieldConfig: { defaults: {} },
    });
    const empty = { defaults: {}, overrides: [] };
    expect(legacyLineWidth(empty, 2).defaults.lineWidth).toBe(2);
    expect(legacyLineWidth(empty, 1)).toBe(empty);
    expect(
      legacyLineWidth({ defaults: { lineWidth: 4 }, overrides: [] }, 2).defaults.lineWidth,
    ).toBe(4);
  });
});

describe("canvas colors", () => {
  it("read computed colors and write them with an alpha", () => {
    expect(withAlpha("oklch(0.744 0.114 262)", 0.5)).toBe("oklch(0.744 0.114 262 / 0.5)");
    expect(withAlpha("oklch(74.4% 0.114 262 / 0.5)", 0.5)).toBe("oklch(0.744 0.114 262 / 0.25)");
    expect(withAlpha("rgb(255, 255, 255)", 1)).toBe("oklch(1 0 0 / 1)");
    expect(withAlpha("rgba(0, 0, 0, 0.5)", 1)).toBe("oklch(0 0 0 / 0.5)");
    expect(parseColor("#ffffff80")?.a).toBeCloseTo(0.502, 2);
    expect(parseColor("#000")?.l).toBe(0);
    // What cannot be read is passed on unchanged, rather than drawn wrong.
    expect(withAlpha("", 0.5)).toBe("");
    expect(withAlpha("color(display-p3 1 0 0)", 0.5)).toBe("color(display-p3 1 0 0)");
  });

  it("turn the hue for the hue gradient", () => {
    expect(shiftHue("oklch(0.6 0.1 340)", 50, 0.5)).toBe("oklch(0.6 0.1 30 / 0.5)");
    const red = parseColor("rgb(255 0 0)");
    expect(red?.h).toBeCloseTo(29.2, 0);
  });
});
