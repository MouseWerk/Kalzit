import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type uPlot from "uplot";
import { describe, expect, it, vi } from "vitest";
import { setLanguage } from "../../i18n/i18n";
import type { FieldOptions } from "../fieldConfig/fieldConfig";
import { DEFAULT_LEGEND } from "../fieldConfig/legendOptions";
import { alignSeries } from "./align";
import type { TimeSeriesChartProps } from "./ChartShell";
import { areaPath, SvgTimeSeriesChart } from "./SvgTimeSeriesChart";
import type { Series } from "./series";
import { resolveStyles } from "./styles";
import { UplotTimeSeriesChart } from "./UplotTimeSeriesChart";
import { cached, stackedFill } from "./uplotSeries";

// jsdom has no canvas, so uPlot itself is replaced by a recorder: these tests check what the chart
// hands to uPlot (data, colors from the theme tokens, sizes) and the shared keyboard readout.
const created: {
  options: Record<string, unknown>;
  data: unknown[];
  destroyed: boolean;
  setDataCalls: unknown[][];
}[] = [];
vi.mock("uplot", () => {
  // Path builders are recorded by name, so a test sees which one a style picked.
  const builder = (name: string) => (options?: unknown) =>
    Object.assign(() => null, { builder: name, options });
  class FakeUplot {
    static pxRatio = 1;
    static paths = {
      linear: builder("linear"),
      spline: builder("spline"),
      stepped: builder("stepped"),
      bars: builder("bars"),
    };
    bbox = { left: 50, top: 0, width: 500, height: 200 };
    record: (typeof created)[number];
    constructor(options: Record<string, unknown>, data: unknown[]) {
      this.width = options.width as number;
      this.height = options.height as number;
      this.data = data;
      this.record = { options, data, destroyed: false, setDataCalls: [] };
      Object.assign(this.record, { setSizeCalls: this.setSizeCalls });
      created.push(this.record);
    }
    width: number;
    height: number;
    data: unknown[];
    setSizeCalls: unknown[] = [];
    setData(data: unknown[]) {
      this.data = data;
      this.record.setDataCalls.push(data);
    }
    posToVal(x: number) {
      return x * 200;
    }
    setSize(size: { width: number; height: number }) {
      this.setSizeCalls.push(size);
      this.width = size.width;
      this.height = size.height;
    }
    destroy() {
      this.record.destroyed = true;
    }
  }
  return { default: FakeUplot };
});

/** Legend, tooltip and formatting as the panel passes them, with a plain unit suffix. */
const display = (unit: string, showLegend: boolean) => ({
  legend: showLegend ? DEFAULT_LEGEND : { ...DEFAULT_LEGEND, mode: "hidden" as const },
  tooltip: "all" as const,
  format: (_index: number, value: number) => (unit === "" ? String(value) : `${value} ${unit}`),
  axisFormat: String,
});

const series = (name: string, times: Float64Array, values: number[]): Series => ({
  name,
  times,
  values: Float64Array.from(values),
});

type ChartProps = Omit<TimeSeriesChartProps, "styles">;

/** The charts with the styles the panel resolves for their series. */
function Uplot(props: ChartProps) {
  return <UplotTimeSeriesChart {...props} styles={resolveStyles(props.series)} />;
}

function Svg(props: ChartProps) {
  return <SvgTimeSeriesChart {...props} styles={resolveStyles(props.series)} />;
}

describe("uPlot data", () => {
  it("shares one time array per frame and turns missing values into gaps", () => {
    const times = Float64Array.from([0, 1000, 2000]);
    expect(
      alignSeries([series("a", times, [1, Number.NaN, 3]), series("b", times, [4, 5, 6])]),
    ).toEqual([
      [0, 1000, 2000],
      [1, null, 3],
      [4, 5, 6],
    ]);
  });

  it("merges series of different frames onto the union of their times", () => {
    const a = series("a", Float64Array.from([0, 2000]), [1, 3]);
    const b = series("b", Float64Array.from([1000, 2000]), [5, 6]);
    expect(alignSeries([a, b])).toEqual([
      [0, 1000, 2000],
      [1, null, 3],
      [null, 5, 6],
    ]);
  });
});

describe("uPlot chart sizing and labels", () => {
  it("follows the box width even while the box has no height yet", async () => {
    let report:
      | ((entries: { target: Element; contentRect: { width: number; height: number } }[]) => void)
      | null = null;
    // Entries name the element they measure, as a real observer's do.
    let observed: Element | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: typeof report) {
          report = callback;
        }
        observe(element: Element) {
          observed = element;
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const resized: unknown[] = [];
    created.length = 0;
    const times = Float64Array.from([0, 100_000]);
    render(
      <Uplot
        series={[series("load", times, [1, 2])]}
        timeRange={{ from: 0, to: 100_000 }}
        title="CPU"
        {...display("", false)}
      />,
    );
    const chart = created.at(-1) as unknown as { setSizeCalls: unknown[] };
    expect(chart).toBeDefined();
    resized.push(...chart.setSizeCalls);
    // A phone-width box whose height is still 0: the width must not stay at 640 px.
    act(() => {
      if (observed !== null) {
        report?.([{ target: observed, contentRect: { width: 360, height: 0 } }]);
      }
    });
    expect(chart.setSizeCalls.at(-1)).toEqual({ width: 360, height: 220 });
  });

  it("writes time labels in the UI language", () => {
    setLanguage("de");
    created.length = 0;
    const times = Float64Array.from([0, 100_000]);
    render(
      <Uplot
        series={[series("load", times, [1, 2])]}
        timeRange={{ from: 0, to: 100_000 }}
        title="CPU"
        {...display("", false)}
      />,
    );
    const options = created.at(-1)?.options as
      | {
          axes: {
            values: (u: unknown, splits: number[], a: number, s: number, step: number) => string[];
          }[];
        }
      | undefined;
    const axes = options?.axes ?? [];
    const at = new Date(2026, 9, 21, 4, 0).getTime();
    expect(axes[0]?.values(null, [at], 0, 0, 3_600_000)).toEqual(["04:00"]);
    expect(axes[0]?.values(null, [at], 0, 0, 86_400_000)).toEqual(["21.10."]);
  });

  it("leaves room for the time labels: right of the plot and between them", () => {
    created.length = 0;
    const times = Float64Array.from([0, 100_000]);
    render(
      <Uplot
        series={[series("load", times, [1, 2])]}
        timeRange={{ from: 0, to: 100_000 }}
        title="CPU"
        {...display("", false)}
      />,
    );
    const options = created.at(-1)?.options as {
      padding?: (number | null)[];
      axes: { space?: number }[];
    };
    // The label "04:00 PM" is about 50 px wide at the axis font and centered on the edge.
    expect(options.padding?.[1]).toBeGreaterThanOrEqual(28);
    // And neighboring time labels keep apart (uPlot's default spacing let them touch).
    expect(options.axes[0]?.space).toBeGreaterThanOrEqual(80);
  });

  it("leaves the same room in the SVG chart shown while uPlot loads", () => {
    // Six whole hours, so a time label sits exactly on the right edge of the plot.
    const from = Date.UTC(2026, 9, 20, 10);
    const to = Date.UTC(2026, 9, 20, 16);
    const { container } = render(
      <Svg
        series={[series("load", Float64Array.from([from, to]), [1, 2])]}
        timeRange={{ from, to }}
        title="CPU"
        {...display("", false)}
      />,
    );
    const svg = container.querySelector("svg");
    const width = Number(svg?.getAttribute("width") ?? svg?.getAttribute("viewBox")?.split(" ")[2]);
    const labelX = [...container.querySelectorAll('text[text-anchor="middle"]')].map((t) =>
      Number(t.getAttribute("x")),
    );
    expect(labelX.length).toBeGreaterThan(0);
    expect(Math.max(...labelX)).toBeLessThanOrEqual(width - 28);
  });
});

describe("uPlot chart", () => {
  it("draws with the palette and reads out values by keyboard", async () => {
    const user = userEvent.setup();
    created.length = 0;
    const times = Float64Array.from([0, 50_000, 100_000]);
    const { unmount } = render(
      <Uplot
        series={[series("load", times, [1, 2, 3]), series("rate", times, [7, 8, 9])]}
        timeRange={{ from: 0, to: 100_000 }}
        title="CPU"
        {...display("%", true)}
      />,
    );
    const chart = created.at(-1);
    expect(chart?.data).toEqual([
      [0, 50_000, 100_000],
      [1, 2, 3],
      [7, 8, 9],
    ]);
    const options = chart?.options as {
      ms: number;
      series: { label?: string; width?: number; stroke?: string }[];
      scales: { x: { range: () => number[] } };
    };
    expect(options.ms).toBe(1);
    expect(options.scales.x.range()).toEqual([0, 100_000]);
    // Two series take the palette at the thinner default width.
    expect(options.series.slice(1).map((s) => [s.label, s.width])).toEqual([
      ["load", 1],
      ["rate", 1],
    ]);
    // Each series gets its own palette color, read from the token probes.
    const probes = document.querySelectorAll(".ts__probe.series-1, .ts__probe.series-2");
    expect(probes).toHaveLength(2);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "CPU" }));
    await user.keyboard("{End}");
    // End is the plot's right edge (50 + 500 px); the recorder maps 500 px to 100,000 ms.
    expect(screen.getByRole("status").textContent).toContain("load: 3 %");
    expect(screen.getByRole("status").textContent).toContain("rate: 9 %");
    unmount();
    expect(chart?.destroyed).toBe(true);
  });

  it("puts new data and a new range into the chart that stands instead of building another", () => {
    created.length = 0;
    const times = Float64Array.from([0, 50_000, 100_000]);
    const props = { title: "CPU", ...display("", false) };
    const { rerender } = render(
      <Uplot
        series={[series("load", times, [1, 2, 3])]}
        timeRange={{ from: 0, to: 100_000 }}
        {...props}
      />,
    );
    expect(created).toHaveLength(1);
    const chart = created[0];
    // Building it drew it; nothing more on the first render.
    expect(chart?.setDataCalls).toHaveLength(0);
    rerender(
      <Uplot
        series={[series("load", times, [4, 5, 6])]}
        timeRange={{ from: 0, to: 200_000 }}
        {...props}
      />,
    );
    expect(created).toHaveLength(1);
    expect(chart?.destroyed).toBe(false);
    expect(chart?.setDataCalls.at(-1)).toEqual([
      [0, 50_000, 100_000],
      [4, 5, 6],
    ]);
    const options = chart?.options as { scales: { x: { range: () => number[] } } };
    expect(options.scales.x.range()).toEqual([0, 200_000]);
    // Another series is another chart: its color and legend entry are new.
    rerender(
      <Uplot
        series={[series("load", times, [4, 5, 6]), series("rate", times, [1, 1, 1])]}
        timeRange={{ from: 0, to: 200_000 }}
        {...props}
      />,
    );
    expect(created).toHaveLength(2);
    expect(chart?.destroyed).toBe(true);
  });
});

/** A series with graph style options, as the panel builds it from the field options. */
const styled = (name: string, values: number[], options: FieldOptions): Series => ({
  ...series(name, Float64Array.from(values.map((_, i) => i * 1000)), values),
  options,
});

type Recorded = {
  label?: string;
  width?: number;
  dash?: number[];
  cap?: string;
  fill?: unknown;
  spanGaps?: boolean;
  gaps?: unknown;
  points?: { show?: boolean; size?: number };
  paths?: { builder?: string; options?: Record<string, unknown> } & (() => null);
};

function draw(list: Series[]): {
  series: Recorded[];
  bands: unknown[];
  axes: { grid?: { show?: boolean }; ticks?: { show?: boolean } }[];
  data: unknown[];
} {
  created.length = 0;
  render(
    <Uplot series={list} timeRange={{ from: 0, to: 10_000 }} title="T" {...display("", true)} />,
  );
  const chart = created.at(-1);
  const options = chart?.options as { series: Recorded[]; bands: unknown[]; axes: [] };
  return {
    series: options.series.slice(1),
    bands: options.bands,
    axes: options.axes,
    data: chart?.data ?? [],
  };
}

describe("graph styles", () => {
  it("draws a lone series monochrome: smooth, 2 px, a fading hatch, a horizontal grid only", () => {
    const {
      series: [main],
      axes,
    } = draw([styled("load", [1, 3, 2], {})]);
    expect(main?.paths?.builder).toBe(undefined); // smooth wraps spline and linear
    expect(main?.width).toBe(2);
    expect(main?.fill).toBeTypeOf("function");
    expect(main?.dash).toBeUndefined();
    expect(document.querySelector(".ts__swatch")?.className).toContain("series-mono");
    // No vertical grid lines, no tick marks.
    expect(axes[0]?.grid?.show).toBe(false);
    expect(axes[1]?.grid?.show).not.toBe(false);
    expect(axes.every((axis) => axis.ticks?.show === false)).toBe(true);
  });

  it("draws a comparison series muted and dashed next to the main one", () => {
    const { series: list } = draw([
      styled("this week", [1, 3, 2], {}),
      styled("last week", [2, 2, 1], { comparison: true }),
    ]);
    expect(list[0]?.dash).toBeUndefined();
    expect(list[1]?.dash).toEqual([7, 6]);
    expect(list[1]?.fill).toBeUndefined();
    const swatches = [...document.querySelectorAll(".viz-legend .ts__swatch")].map(
      (s) => s.className,
    );
    expect(swatches).toEqual([
      "ts__swatch series-mono",
      "ts__swatch series-mono-compare ts__swatch--dashed",
    ]);
  });

  it("keeps the palette for several series and no fill by default", () => {
    const { series: list } = draw([styled("a", [1, 2], {}), styled("b", [3, 4], {})]);
    expect(list.map((s) => s.paths?.builder)).toEqual(["linear", "linear"]);
    expect(list.map((s) => s.fill)).toEqual([undefined, undefined]);
    expect(document.querySelectorAll(".viz-legend .series-1, .viz-legend .series-2")).toHaveLength(
      2,
    );
  });

  it("picks the path builder of each interpolation and draw style", () => {
    const pick = (options: FieldOptions) =>
      draw([styled("a", [1, 2], options), styled("b", [1, 2], {})]).series[0];
    expect(pick({ lineInterpolation: "linear" })?.paths?.builder).toBe("linear");
    expect(pick({ lineInterpolation: "stepBefore" })?.paths?.options).toEqual({ align: -1 });
    expect(pick({ lineInterpolation: "stepAfter" })?.paths?.options).toEqual({ align: 1 });
    const bars = pick({ drawStyle: "bars", barAlignment: "after", barWidth: 80 });
    expect(bars?.paths?.builder).toBe("bars");
    expect(bars?.paths?.options).toMatchObject({
      align: 1,
      size: [0.8, Number.POSITIVE_INFINITY, 1],
    });
    expect(bars?.fill).toBeTypeOf("function");
    const points = pick({ drawStyle: "points", pointSize: 8 });
    expect(points?.paths?.()).toBeNull();
    expect(points?.points).toMatchObject({ show: true, size: 8 });
    expect(pick({ showPoints: "never" })?.points?.show).toBe(false);
    expect(pick({ showPoints: "auto" })?.points?.show).toBeUndefined();
  });

  it("draws line styles and widths", () => {
    const pick = (options: FieldOptions) =>
      draw([styled("a", [1, 2], options), styled("b", [1, 2], {})]).series[0];
    expect(pick({ lineStyle: "dashed", lineWidth: 2 })?.dash).toEqual([7, 6]);
    const dotted = pick({ lineStyle: "dotted", lineWidth: 4 });
    expect(dotted?.dash).toEqual([0, 10]);
    expect(dotted?.cap).toBe("round");
    expect(pick({ lineWidth: 0 })?.width).toBe(0);
  });

  it("fills solid, hatched or not at all", () => {
    const pick = (options: FieldOptions) =>
      draw([styled("a", [1, 2], options), styled("b", [1, 2], {})]).series[0];
    expect(pick({ fill: "solid", fillOpacity: 30, gradientMode: "hue" })?.fill).toBeTypeOf(
      "function",
    );
    expect(pick({ fill: "hatch" })?.fill).toBeTypeOf("function");
    expect(draw([styled("a", [1, 2], { fill: "none" })]).series[0]?.fill).toBeUndefined();
  });

  it("connects gaps never, always or below a duration", () => {
    const pick = (options: FieldOptions) =>
      draw([styled("a", [1, 2], options), styled("b", [1, 2], {})]).series[0];
    expect(pick({})).toMatchObject({ spanGaps: false });
    expect(pick({})?.gaps).toBeUndefined();
    expect(pick({ connectGaps: "always" })).toMatchObject({ spanGaps: true });
    expect(pick({ connectGaps: "threshold", connectGapsBelow: 60_000 })?.gaps).toBeTypeOf(
      "function",
    );
    // Break after needs uPlot's gaps even when every null gap is bridged.
    const broken = pick({ connectGaps: "always", breakAfter: 5000 });
    expect(broken?.spanGaps).toBe(false);
    expect(broken?.gaps).toBeTypeOf("function");
  });

  it("stacks lines with bands to the series below and keeps the raw values in the readout", () => {
    const {
      series: list,
      bands,
      data,
    } = draw([
      styled("a", [1, 2, 3], { stack: "normal" }),
      styled("b", [10, 20, 30], { stack: "normal" }),
      styled("c", [5, 5, 5], {}),
    ]);
    expect(data).toEqual([
      [0, 1000, 2000],
      [1, 2, 3],
      [11, 22, 33],
      [5, 5, 5],
    ]);
    // No bands: each stacked line fills to its own baseline through its path builder.
    expect(bands).toBeUndefined();
    expect(list.map((s) => s.paths?.builder)).toEqual([undefined, undefined, "linear"]);
    // Stacked lines fill by default; the unstacked series does not.
    expect(list.map((s) => typeof s.fill)).toEqual(["function", "function", "undefined"]);
  });

  it("keeps the chart when a stacked series changes sides with new data", () => {
    created.length = 0;
    const props = { timeRange: { from: 0, to: 10_000 }, title: "T", ...display("", false) };
    const pair = (a: number[]) => [
      styled("a", a, { stack: "normal" }),
      styled("b", [3, 3], { stack: "normal" }),
    ];
    const { rerender } = render(<Uplot series={pair([5, 5])} {...props} />);
    rerender(<Uplot series={pair([5, -5])} {...props} />);
    expect(created).toHaveLength(1);
    expect(created[0]?.setDataCalls.at(-1)).toEqual([
      [0, 1000],
      [5, -5],
      [8, 3],
    ]);
  });

  it("fills the SVG fallback per run of values, so a gap stays a gap, stacked or not", () => {
    const scale = { x: (t: number) => t, y: (v: number) => 100 - v };
    const xs = [0, 10, 20, 30, 40];
    const ys = [1, 2, null, 3, 4];
    const toZero = areaPath(xs, ys, null, scale, 1000, "linear", 100);
    expect(toZero).toBe("M0.0 99.0L10.0 98.0V100.0H0.0ZM30.0 97.0L40.0 96.0V100.0H30.0Z");
    const stacked = areaPath(
      xs,
      ys,
      Float64Array.from([1, 1, 1, 2, 2]),
      scale,
      1000,
      "linear",
      100,
    );
    expect(stacked).toBe(
      "M0.0 99.0L10.0 98.0L10.0 99.0L0.0 99.0ZM30.0 97.0L40.0 96.0L40.0 98.0L30.0 98.0Z",
    );
  });

  it("fills a stacked line down to its baseline point by point, in steps for stepped lines", () => {
    const calls: string[] = [];
    class Path {
      lineTo(x: number, y: number) {
        calls.push(`L${x},${y}`);
      }
      closePath() {
        calls.push("Z");
      }
    }
    vi.stubGlobal("Path2D", Path);
    // One px per ms and per unit of value, so canvas positions read as the data.
    const u = {
      data: [
        [0, 10, 20],
        [8, 3, null],
      ],
      valToPos: (value: number) => value,
    } as unknown as Parameters<uPlot.Series.PathBuilder>[0];
    const stacked = {
      current: { ys: [], baselines: [null, Float64Array.from([5, 0, 0])], percent: false },
    };
    const line = () => ({ stroke: new Path() as unknown as Path2D });
    const linear = stackedFill(line, 1, "linear", stacked)(u, 1, 0, 2);
    expect(linear?.fill).toBeInstanceOf(Path);
    // From the last value back along the baseline, the missing third point skipped.
    expect(calls).toEqual(["L10,0", "L0,5", "Z"]);
    calls.length = 0;
    stackedFill(line, 1, "stepAfter", stacked)(u, 1, 0, 2);
    expect(calls).toEqual(["L10,0", "L10,5", "L0,5", "Z"]);
    // Not stacked: the line's own paths, untouched.
    calls.length = 0;
    expect(stackedFill(line, 0, "linear", stacked)(u, 1, 0, 2)?.fill).toBeUndefined();

    const walk = (
      xs: number[],
      ys: (number | null)[],
      base: number[],
      interpolation: Parameters<typeof stackedFill>[2],
    ) => {
      calls.length = 0;
      const chart = {
        data: [xs, ys],
        valToPos: (value: number) => value,
      } as unknown as Parameters<uPlot.Series.PathBuilder>[0];
      const data = {
        current: { ys: [], baselines: [null, Float64Array.from(base)], percent: false },
      };
      stackedFill(line, 1, interpolation, data)(chart, 1, 0, xs.length - 1);
      return [...calls];
    };
    // A missing value in the middle is stepped over, straight and in steps before the point.
    const middle = [
      [0, 10, 20, 30],
      [8, null, 3, 5],
      [5, 0, 1, 2],
    ] as const;
    expect(walk([...middle[0]], [...middle[1]], [...middle[2]], "linear")).toEqual([
      "L30,2",
      "L20,1",
      "L0,5",
      "Z",
    ]);
    expect(walk([...middle[0]], [...middle[1]], [...middle[2]], "stepBefore")).toEqual([
      "L30,2",
      "L20,2",
      "L20,1",
      "L0,1",
      "L0,5",
      "Z",
    ]);
    // Five points in one pixel column keep the first, lowest, highest and last (not the 2).
    expect(
      walk([0, 0.1, 0.2, 0.3, 0.4, 10], [1, 1, 1, 1, 1, 1], [1, 4, 0, 2, 3, 3], "linear"),
    ).toEqual(["L10,3", "L0.4,3", "L0.2,0", "L0.1,4", "L0,1", "Z"]);
    // Known limitation: a smooth line's baseline is walked straight, as for a linear one.
    expect(walk([...middle[0]], [...middle[1]], [...middle[2]], "smooth")).toEqual(
      walk([...middle[0]], [...middle[1]], [...middle[2]], "linear"),
    );
  });

  it("makes a hatch or fill once per plot size, the threshold scheme also per value range", () => {
    const counter = { made: 0 };
    const plot = (min: number, height = 200) =>
      ({
        bbox: { top: 10, height },
        ctx: { canvas: { height: 240 } },
        scales: { y: { min, max: 100 } },
      }) as unknown as Parameters<ReturnType<typeof cached>>[0];
    const hatch = cached(() => "pattern", false, counter);
    hatch(plot(0));
    hatch(plot(5));
    hatch(plot(9));
    // New data moved the value axis; the hatch stays.
    expect(counter.made).toBe(1);
    hatch(plot(9, 180));
    expect(counter.made).toBe(2);
    const scheme = { made: 0 };
    const gradient = cached(() => "gradient", true, scheme);
    gradient(plot(0));
    gradient(plot(0));
    gradient(plot(5));
    expect(scheme.made).toBe(2);
  });

  it("builds the chart again only when a style changes, not for new data", () => {
    created.length = 0;
    const props = { timeRange: { from: 0, to: 10_000 }, title: "T", ...display("", false) };
    const { rerender } = render(
      <Uplot series={[styled("a", [1, 2], { fill: "solid" })]} {...props} />,
    );
    rerender(<Uplot series={[styled("a", [3, 4], { fill: "solid" })]} {...props} />);
    expect(created).toHaveLength(1);
    expect(created[0]?.setDataCalls).toHaveLength(1);
    rerender(<Uplot series={[styled("a", [3, 4], { fill: "hatch" })]} {...props} />);
    expect(created).toHaveLength(2);
  });
});
