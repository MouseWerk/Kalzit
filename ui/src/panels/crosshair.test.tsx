import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CrosshairContext, createCrosshair, type SharedCursorMode } from "./crosshair";
import { DEFAULT_LEGEND } from "./fieldConfig/legendOptions";
import type { Series } from "./timeseries/series";
import { resolveStyles } from "./timeseries/styles";
import { UplotTimeSeriesChart } from "./timeseries/UplotTimeSeriesChart";

// jsdom has no canvas: uPlot is a stand-in with a plot from 50 to 550 px for 0 to 100,000 ms.
vi.mock("uplot", () => {
  const builder = () => () => Object.assign(() => null, {});
  class FakeUplot {
    static pxRatio = 1;
    static paths = { linear: builder(), spline: builder(), stepped: builder(), bars: builder() };
    bbox = { left: 50, top: 0, width: 500, height: 200 };
    width: number;
    height: number;
    data: unknown[];
    constructor(options: Record<string, unknown>, data: unknown[]) {
      this.width = options.width as number;
      this.height = options.height as number;
      this.data = data;
    }
    setData(data: unknown[]) {
      this.data = data;
    }
    posToVal(x: number) {
      return x * 200;
    }
    setSize(size: { width: number; height: number }) {
      this.width = size.width;
      this.height = size.height;
    }
    destroy() {}
  }
  return { default: FakeUplot };
});

const times = Float64Array.from([0, 50_000, 100_000]);
const series = (name: string, values: number[]): Series => ({
  name,
  times,
  values: Float64Array.from(values),
});

function Chart({ title, name }: { title: string; name: string }) {
  const drawn = [series(name, [1, 2, 3])];
  return (
    <UplotTimeSeriesChart
      series={drawn}
      styles={resolveStyles(drawn)}
      timeRange={{ from: 0, to: 100_000 }}
      title={title}
      legend={{ ...DEFAULT_LEGEND, mode: "hidden" }}
      tooltip="all"
      format={(_index, value) => String(value)}
      axisFormat={String}
    />
  );
}

function renderPair(mode: SharedCursorMode | null) {
  const charts = (
    <>
      <Chart title="Orders" name="orders" />
      <Chart title="Revenue" name="revenue" />
    </>
  );
  const { unmount } = render(
    mode === null ? (
      charts
    ) : (
      <CrosshairContext value={createCrosshair(mode)}>{charts}</CrosshairContext>
    ),
  );
  return {
    orders: screen.getByRole("group", { name: "Orders" }),
    revenue: screen.getByRole("group", { name: "Revenue" }),
    unmount,
  };
}

describe("shared cursor", () => {
  it("draws the time under the pointer in the other time panels in the same render", () => {
    const { orders, revenue } = renderPair("crosshair");
    fireEvent.pointerMove(orders, { clientX: 300, clientY: 50 });
    // The middle of the plot is 50,000 ms in both; the other chart draws its line there.
    const line = revenue.querySelector<HTMLElement>(".ts__cursor-line");
    expect(line).not.toBeNull();
    expect(line?.style.getPropertyValue("--cursor-x")).toBe("300px");
    // A crosshair alone: no values in the other panel.
    expect(revenue.querySelector(".ts__tooltip")).toBeNull();
    expect(orders.querySelector(".ts__tooltip")).not.toBeNull();
    fireEvent.pointerLeave(orders);
    expect(revenue.querySelector(".ts__cursor-line")).toBeNull();
  });

  it("shows the values too with the tooltip setting", () => {
    const { orders, revenue } = renderPair("tooltip");
    fireEvent.pointerMove(orders, { clientX: 300, clientY: 50 });
    const tooltip = revenue.querySelector(".ts__tooltip");
    expect(tooltip?.textContent).toContain("revenue");
    expect(tooltip?.textContent).toContain("2");
  });

  it("keeps every panel to itself when the dashboard does not share the cursor", () => {
    for (const mode of ["off", null] as const) {
      const { orders, revenue, unmount } = renderPair(mode);
      fireEvent.pointerMove(orders, { clientX: 300, clientY: 50 });
      expect(orders.querySelector(".ts__cursor-line")).not.toBeNull();
      expect(revenue.querySelector(".ts__cursor-line")).toBeNull();
      unmount();
    }
  });

  it("clears only what the leaving panel published", () => {
    const store = createCrosshair("crosshair");
    const seen: (number | null)[] = [];
    store.subscribe(() => seen.push(store.get().time));
    store.set("a", 10);
    store.set("b", null);
    expect(store.get()).toEqual({ time: 10, source: "a" });
    store.set("b", 20);
    store.set("a", null);
    expect(store.get()).toEqual({ time: 20, source: "b" });
    store.set("b", null);
    expect(store.get()).toEqual({ time: null, source: null });
    expect(seen).toEqual([10, 20, null]);
  });
});
