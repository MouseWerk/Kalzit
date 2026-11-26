import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Frame } from "../../api/generated/shapes";
import { parseFieldConfig } from "../fieldConfig/fieldConfig";
import type { TimeSeriesChartProps } from "./ChartShell";

/** The props each drawing of the chart got, in order. */
const drawn: TimeSeriesChartProps[] = [];

vi.mock("./SvgTimeSeriesChart", () => ({
  SvgTimeSeriesChart: (props: TimeSeriesChartProps) => {
    drawn.push(props);
    return null;
  },
}));

const { timeseriesPanel } = await import(".");

const frame: Frame = {
  fields: [
    { name: "time", type: "time", values: [0, 60_000, 120_000] },
    { name: "sales", type: "number", values: [1, 2, 3] },
  ],
};

/**
 * A new series or axis formatter has uPlot set its data and draw the chart again. A dropped panel
 * renders with a time range equal to the last one but a new object; it must keep both, or every
 * drop draws the charts of the moved panels again (budget.spec.ts, dragging a panel at 4x).
 */
describe("time series panel", () => {
  it("keeps its series and axis formatter for an equal time range in a new object", () => {
    const { Panel } = timeseriesPanel;
    const options = timeseriesPanel.options({});
    // The same results; only the time range is a new object, as after a drop.
    const frames = [frame];
    const view = render(
      <Panel frames={frames} options={options} timeRange={{ from: 0, to: 180_000 }} title="P" />,
    );
    view.rerender(
      <Panel frames={frames} options={options} timeRange={{ from: 0, to: 180_000 }} title="P" />,
    );
    const [first, last] = [drawn.at(0), drawn.at(-1)];
    expect(drawn.length).toBeGreaterThan(1);
    expect(last?.series).toBe(first?.series);
    expect(last?.axisFormat).toBe(first?.axisFormat);
  });

  it("formats each value axis with the unit and decimals of its own first series", () => {
    const { Panel } = timeseriesPanel;
    const options = timeseriesPanel.options({});
    const twoUnits: Frame = {
      fields: [
        { name: "time", type: "time", values: [0, 60_000, 120_000] },
        { name: "sales", type: "number", values: [1, 2, 3] },
        { name: "share", type: "number", values: [10, 20, 30] },
      ],
    };
    const fieldConfig = parseFieldConfig({
      defaults: { unit: "short", decimals: 1 },
      overrides: [{ matcher: { type: "name", value: "share" }, properties: { unit: "percent" } }],
    });
    render(
      <Panel
        frames={[twoUnits]}
        options={options}
        fieldConfig={fieldConfig}
        timeRange={{ from: 0, to: 180_000 }}
        title="P"
      />,
    );
    const last = drawn.at(-1);
    expect(last?.axes?.map((a) => [a.key, a.unit, a.decimals])).toEqual([
      ["y", "short", 1],
      ["y2", "percent", 1],
    ]);
    const ticks = [0, 10, 20];
    // Each axis formats with its own unit: only the right one carries the percent sign.
    expect(last?.axisFormat(10, "y2", ticks)).toContain("%");
    expect(last?.axisFormat(10, "y", ticks)).not.toContain("%");
  });
});
