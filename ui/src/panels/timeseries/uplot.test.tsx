import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { setLanguage } from "../../i18n/i18n";
import { alignSeries } from "./align";
import type { Series } from "./series";
import { UplotTimeSeriesChart } from "./UplotTimeSeriesChart";

// jsdom has no canvas, so uPlot itself is replaced by a recorder: these tests check what the chart
// hands to uPlot (data, colors from the theme tokens, sizes) and the shared keyboard readout.
const created: { options: Record<string, unknown>; data: unknown[]; destroyed: boolean }[] = [];
vi.mock("uplot", () => {
  class FakeUplot {
    static pxRatio = 1;
    bbox = { left: 50, top: 0, width: 500, height: 200 };
    record: (typeof created)[number];
    constructor(options: Record<string, unknown>, data: unknown[]) {
      this.width = options.width as number;
      this.height = options.height as number;
      this.record = { options, data, destroyed: false };
      Object.assign(this.record, { setSizeCalls: this.setSizeCalls });
      created.push(this.record);
    }
    width: number;
    height: number;
    setSizeCalls: unknown[] = [];
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

const series = (name: string, times: Float64Array, values: number[]): Series => ({
  name,
  times,
  values: Float64Array.from(values),
});

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
    let report: ((entries: { contentRect: { width: number; height: number } }[]) => void) | null =
      null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: typeof report) {
          report = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const resized: unknown[] = [];
    created.length = 0;
    const times = Float64Array.from([0, 100_000]);
    render(
      <UplotTimeSeriesChart
        series={[series("load", times, [1, 2])]}
        timeRange={{ from: 0, to: 100_000 }}
        title="CPU"
        unit=""
        lineWidth={1}
        showLegend={false}
      />,
    );
    const chart = created.at(-1) as unknown as { setSizeCalls: unknown[] };
    expect(chart).toBeDefined();
    resized.push(...chart.setSizeCalls);
    // A phone-width box whose height is still 0: the width must not stay at 640 px.
    act(() => report?.([{ contentRect: { width: 360, height: 0 } }]));
    expect(chart.setSizeCalls.at(-1)).toEqual({ width: 360, height: 220 });
  });

  it("writes time labels in the UI language", () => {
    setLanguage("de");
    created.length = 0;
    const times = Float64Array.from([0, 100_000]);
    render(
      <UplotTimeSeriesChart
        series={[series("load", times, [1, 2])]}
        timeRange={{ from: 0, to: 100_000 }}
        title="CPU"
        unit=""
        lineWidth={1}
        showLegend={false}
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
});

describe("uPlot chart", () => {
  it("draws with the palette and reads out values by keyboard", async () => {
    const user = userEvent.setup();
    created.length = 0;
    const times = Float64Array.from([0, 50_000, 100_000]);
    const { unmount } = render(
      <UplotTimeSeriesChart
        series={[series("load", times, [1, 2, 3]), series("rate", times, [7, 8, 9])]}
        timeRange={{ from: 0, to: 100_000 }}
        title="CPU"
        unit="%"
        lineWidth={2}
        showLegend
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
      scales: { x: { min: number; max: number } };
    };
    expect(options.ms).toBe(1);
    expect(options.scales.x).toMatchObject({ min: 0, max: 100_000 });
    expect(options.series.slice(1).map((s) => [s.label, s.width])).toEqual([
      ["load", 2],
      ["rate", 2],
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
});
