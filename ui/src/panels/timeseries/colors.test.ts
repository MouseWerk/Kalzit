import { describe, expect, it } from "vitest";
import { contrastRatio, MIN_MARK_CONTRAST } from "../fieldConfig/contrast";
import {
  type FieldOptions,
  parseFieldConfig,
  parseFieldOptions,
  type Thresholds,
  thresholdStep,
} from "../fieldConfig/fieldConfig";
import type { Series } from "./series";
import { FREE_CLASS, isMonochrome, rampClass, resolveStyles, seriesColor } from "./styles";
import { shownThresholds, thresholdBands, thresholdLines } from "./thresholdBands";

const series = (options: FieldOptions = {}): Series => ({
  name: "s",
  times: new Float64Array(),
  values: new Float64Array(),
  options,
});

const STEPS: Thresholds = {
  mode: "absolute",
  steps: [
    { value: null, tone: "neutral", color: "#8a8a93" },
    { value: 80, tone: "warn" },
    { value: 95, tone: "critical", color: "#e0115f" },
  ],
};

describe("stored colour options", () => {
  it("read tones and free colours, and drop anything else", () => {
    expect(parseFieldOptions({ color: "chart-3" }).color).toBe("chart-3");
    expect(parseFieldOptions({ color: "#6AA3D8" }).color).toBe("#6aa3d8");
    for (const color of ["#6aa3d", "red", "#6aa3d8ff", 5]) {
      expect(parseFieldOptions({ color }).color, String(color)).toBeUndefined();
    }
  });

  it("read the scheme, the opacity and the threshold display within bounds", () => {
    expect(
      parseFieldOptions({ colorScheme: "blues", opacity: 85, thresholdDisplay: "areas" }),
    ).toMatchObject({ colorScheme: "blues", opacity: 85, thresholdDisplay: "areas" });
    expect(
      parseFieldOptions({ colorScheme: "rainbow", opacity: 101, thresholdDisplay: "dots" }),
    ).toEqual({});
    expect(parseFieldOptions({ opacity: 12.5 }).opacity).toBeUndefined();
  });

  it("keep a step's free colour next to its tone, and clear-only overrides", () => {
    const options = parseFieldOptions({ thresholds: STEPS });
    expect(options.thresholds?.steps.map((s) => s.color)).toEqual([
      "#8a8a93",
      undefined,
      "#e0115f",
    ]);
    const config = parseFieldConfig({
      overrides: [{ matcher: { type: "name", value: "a" }, properties: { opacity: null } }],
    });
    expect(config.overrides[0]?.properties).toEqual({ opacity: null });
  });

  it("find the step of a value with its colour", () => {
    expect(thresholdStep(90, STEPS)).toEqual({ value: 80, tone: "warn" });
    expect(thresholdStep(99, STEPS).color).toBe("#e0115f");
    expect(thresholdStep(10, STEPS).color).toBe("#8a8a93");
  });
});

describe("series colours", () => {
  it("give a series its own colour, a tone or a free one", () => {
    expect(seriesColor({ color: "chart-2" }, 0, 2, false)).toEqual({
      colorClass: "tone--chart-2",
      freeColor: null,
    });
    expect(seriesColor({ color: "#4fb3a9" }, 0, 2, false)).toEqual({
      colorClass: FREE_CLASS,
      freeColor: "#4fb3a9",
    });
  });

  it("follow the scheme: one colour, ramps spread from end to end, thresholds' base step", () => {
    expect(seriesColor({ colorScheme: "single" }, 3, 4, false).colorClass).toBe("tone--chart-1");
    expect([0, 1, 2].map((i) => seriesColor({ colorScheme: "blues" }, i, 3, false))).toEqual([
      { colorClass: "ramp-blues-1", freeColor: null },
      { colorClass: "ramp-blues-3", freeColor: null },
      { colorClass: "ramp-blues-5", freeColor: null },
    ]);
    expect(rampClass("greenYellowRed", 0, 1)).toBe("ramp-gyr-1");
    expect(seriesColor({ colorScheme: "thresholds", thresholds: STEPS }, 0, 1, false)).toEqual({
      colorClass: FREE_CLASS,
      freeColor: "#8a8a93",
    });
    // Without thresholds the scheme falls back to the palette.
    expect(seriesColor({ colorScheme: "thresholds" }, 1, 2, false).colorClass).toBe("series-2");
  });

  it("keep the monochrome look and the palette for panels stored before schemes", () => {
    expect(resolveStyles([series()])[0]?.colorClass).toBe("series-mono");
    expect(resolveStyles([series(), series()]).map((s) => s.colorClass)).toEqual([
      "series-1",
      "series-2",
    ]);
    expect(isMonochrome([series({ colorScheme: "palette" })])).toBe(true);
    expect(isMonochrome([series({ colorScheme: "grays" })])).toBe(false);
  });

  it("resolve opacity, the threshold display and the threshold gradient", () => {
    const [plain] = resolveStyles([series()]);
    expect(plain).toMatchObject({ opacity: 1, thresholdDisplay: "off", freeColor: null });
    const [style] = resolveStyles([
      series({
        colorScheme: "thresholds",
        thresholds: STEPS,
        opacity: 40,
        thresholdDisplay: "lines",
      }),
    ]);
    expect(style).toMatchObject({ opacity: 0.4, thresholdDisplay: "lines", gradient: "scheme" });
    // A gradient the user set stays.
    const [kept] = resolveStyles([
      series({ colorScheme: "thresholds", thresholds: STEPS, gradientMode: "none" }),
    ]);
    expect(kept?.gradient).toBe("none");
  });
});

describe("thresholds in the chart", () => {
  it("come from the first series that shows them", () => {
    const styles = resolveStyles([
      series(),
      series({ thresholds: STEPS, thresholdDisplay: "linesAndAreas" }),
    ]);
    expect(shownThresholds(styles)?.display).toBe("linesAndAreas");
    expect(shownThresholds(resolveStyles([series({ thresholds: STEPS })]))).toBeNull();
  });

  it("cut the axis into bands and lines, clipped to it", () => {
    expect(thresholdBands(STEPS, 0, 100).map((b) => [b.from, b.to, b.step.tone])).toEqual([
      [0, 80, "neutral"],
      [80, 95, "warn"],
      [95, 100, "critical"],
    ]);
    expect(thresholdBands(STEPS, 85, 90).map((b) => [b.from, b.to, b.step.tone])).toEqual([
      [85, 90, "warn"],
    ]);
    expect(thresholdLines(STEPS, 0, 90).map((l) => l.value)).toEqual([80]);
    const percent: Thresholds = { ...STEPS, mode: "percentage" };
    expect(thresholdLines(percent, 0, 200).map((l) => l.value)).toEqual([160, 190]);
  });
});

describe("contrast of free colours", () => {
  it("measures WCAG contrast of hex and computed colours", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
    expect(contrastRatio("#ffff00", "oklch(1 0 0)")).toBeLessThan(MIN_MARK_CONTRAST);
    expect(contrastRatio("not a colour", "#ffffff")).toBeNull();
  });
});
