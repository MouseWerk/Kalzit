import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { Frame } from "../api/generated/shapes";
import { type FieldConfig, parseFieldConfig, parseFieldOptions } from "./fieldConfig/fieldConfig";
import { LegendTooltipEditor } from "./fieldConfig/LegendTooltipEditor";
import {
  DEFAULT_LEGEND,
  type LegendOptions,
  parseLegend,
  parseTooltip,
  type TooltipOptions,
} from "./fieldConfig/legendOptions";
import { getPanel } from "./registry";
import { chartData } from "./timeseries/align";
import { planAxes, skippedPoints } from "./timeseries/axes";
import { buildSeries } from "./timeseries/series";
import { resolveStyles } from "./timeseries/styles";
import type { AnyPanelPlugin } from "./types";

const RANGE = { from: 0, to: 100_000 };

function renderPanel(type: string, frames: Frame[], options: unknown, fieldConfig: FieldConfig) {
  const plugin = getPanel(type) as AnyPanelPlugin;
  const { Panel } = plugin;
  return render(
    <Panel
      frames={frames}
      options={plugin.options(options)}
      fieldConfig={fieldConfig}
      timeRange={RANGE}
      title="Panel"
    />,
  );
}

const traffic: Frame = {
  fields: [
    { name: "time", type: "time", values: [0, 25_000, 50_000, 75_000, 100_000] },
    { name: "web", type: "number", values: [0, 10, 100, 1000, 0] },
    { name: "api", type: "number", values: [5, 5, -1, 50, 500] },
  ],
};

/** The legend editor with its own state, showing the values it stores. */
function LegendEditor() {
  const [legend, setLegend] = useState<LegendOptions>({ ...DEFAULT_LEGEND, mode: "table" });
  return (
    <>
      <LegendTooltipEditor
        legend={legend}
        tooltip={{ mode: "all" }}
        tooltipDetails
        onChange={(next) => setLegend(next)}
      />
      <output data-testid="stored">{JSON.stringify(legend.values)}</output>
      <output data-testid="mode">{legend.mode}</output>
    </>
  );
}

describe("legend and tooltip options", () => {
  it("keep every new option through a save and a reload", () => {
    const legend: LegendOptions = {
      mode: "table",
      placement: "right",
      values: ["last", "sum", "p95", "stddev"],
      width: 250,
      limit: 5,
    };
    const tooltip: TooltipOptions = {
      mode: "all",
      sort: "desc",
      hideZeros: true,
      maxWidth: 320,
      maxHeight: 400,
    };
    const stored = JSON.parse(JSON.stringify({ legend, tooltip }));
    expect(parseLegend(stored)).toEqual(legend);
    expect(parseTooltip(stored)).toEqual(tooltip);
  });

  it("drop what is out of bounds, unknown or more than six values", () => {
    const legend = parseLegend({
      legend: {
        mode: "list",
        placement: "bottom",
        values: ["sum", "total", "sum", "p0", "p50", "last", "min", "max", "mean", "first"],
        width: 20,
        limit: 0,
      },
    });
    expect(legend).toEqual({
      mode: "list",
      placement: "bottom",
      values: ["sum", "p50", "last", "min", "max", "mean"],
    });
    expect(
      parseTooltip({ tooltip: { mode: "single", sort: "none", hideZeros: "yes", maxWidth: 5 } }),
    ).toEqual({
      mode: "single",
    });
    // Older panels without the options keep their look.
    expect(parseLegend({})).toEqual(DEFAULT_LEGEND);
    expect(parseTooltip({})).toEqual({ mode: "all" });
  });

  it("pick values in the editor from the groups, with Total under Frequent", async () => {
    const user = userEvent.setup();
    render(<LegendEditor />);
    await user.click(screen.getByRole("button", { name: /^Value$/ }));
    const list = screen.getByRole("listbox", { name: "Legend values" });
    const frequent = within(list).getByRole("group", { name: "Frequent" });
    await user.click(within(frequent).getByRole("option", { name: /Total/ }));
    expect(
      within(frequent).getByRole("option", { name: /Total/ }).getAttribute("aria-selected"),
    ).toBe("true");
    // A percentile asks for its number.
    await user.click(within(list).getByRole("option", { name: /Percentile/ }));
    const number = screen.getByLabelText("Percentile (1 to 99)");
    await user.clear(number);
    await user.type(number, "99");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByTestId("stored").textContent).toBe('["sum","p99"]');
    // The chips can be removed one by one.
    await user.click(screen.getByRole("button", { name: "Remove Total" }));
    expect(screen.getByTestId("stored").textContent).toBe('["p99"]');
    // Hiding and showing the legend again keeps it a table.
    await user.click(screen.getByRole("checkbox", { name: "Show legend" }));
    await user.click(screen.getByRole("checkbox", { name: "Show legend" }));
    expect(screen.getByTestId("mode").textContent).toBe("table");
  });
});

describe("axis options", () => {
  it("keep every axis option as field options and in overrides", () => {
    const axis = {
      axisPlacement: "right",
      axisLabel: "Bestellungen",
      axisWidth: 64,
      axisGrid: "off",
      axisColor: "series",
      axisLine: true,
      axisScale: "log",
      axisLogBase: 2,
      axisCenteredZero: true,
      axisSoftMin: 0,
      axisSoftMax: 100,
    };
    expect(parseFieldOptions(JSON.parse(JSON.stringify(axis)))).toEqual(axis);
    const config = parseFieldConfig({
      defaults: { axisScale: "symlog" },
      overrides: [
        { matcher: { type: "name", value: "api" }, properties: { ...axis, axisScale: null } },
      ],
    });
    expect(config.defaults).toEqual({ axisScale: "symlog" });
    expect(config.overrides[0]?.properties.axisScale).toBeNull();
    expect(config.overrides[0]?.properties.axisLabel).toBe("Bestellungen");
    expect(
      parseFieldOptions({ axisPlacement: "top", axisWidth: 5, axisLogBase: 3, axisLabel: " " }),
    ).toEqual({});
  });

  it("puts a second unit on the right axis and an override where it says", () => {
    const twoUnits = parseFieldConfig({
      defaults: { unit: "currency:EUR" },
      overrides: [{ matcher: { type: "name", value: "api" }, properties: { unit: "short" } }],
    });
    const series = buildSeries([traffic], "", twoUnits);
    const { axes, axisOf } = planAxes(series, resolveStyles(series), twoUnits.defaults);
    expect(axisOf).toEqual(["y", "y2"]);
    expect(axes.map((a) => [a.side, a.grid])).toEqual([
      ["left", true],
      ["right", false],
    ]);
    const placed = parseFieldConfig({
      overrides: [
        {
          matcher: { type: "name", value: "web" },
          properties: { axisPlacement: "right", axisLabel: "Web" },
        },
      ],
    });
    const again = buildSeries([traffic], "", placed);
    const plan = planAxes(again, resolveStyles(again), placed.defaults);
    expect(plan.axisOf).toEqual(["y2", "y"]);
    expect(plan.axes.find((a) => a.key === "y2")?.label).toBe("Web");
    // Everything on the right: one axis there, still the first scale, with the grid lines.
    const allRight = parseFieldConfig({ defaults: { axisPlacement: "right" } });
    const right = buildSeries([traffic], "", allRight);
    const single = planAxes(right, resolveStyles(right), allRight.defaults);
    expect(single.axisOf).toEqual(["y", "y"]);
    expect(single.axes.map((a) => [a.key, a.side, a.grid])).toEqual([["y", "right", true]]);
  });

  it("says how many points a log axis leaves out instead of dropping them silently", () => {
    const config = parseFieldConfig({ defaults: { axisScale: "log" } });
    const series = buildSeries([traffic], "", config);
    const { axes, axisOf } = planAxes(series, resolveStyles(series), config.defaults);
    expect(skippedPoints(chartData(series, resolveStyles(series)).stacked.ys, axes, axisOf)).toBe(
      3,
    );
    renderPanel("timeseries", [traffic], {}, config);
    expect(screen.getByText("3 points left out (value ≤ 0). Use “Log around zero”.")).toBeTruthy();
    // Log around zero draws them all.
    const { container } = renderPanel(
      "timeseries",
      [traffic],
      {},
      parseFieldConfig({ defaults: { axisScale: "symlog" } }),
    );
    expect(container.querySelector(".ts__note")).toBeNull();
  });

  it("draws a log axis with ticks on the powers of ten", () => {
    const { container } = renderPanel(
      "timeseries",
      [traffic],
      {},
      parseFieldConfig({ defaults: { axisScale: "log", axisLabel: "Requests" } }),
    );
    const labels = [...container.querySelectorAll(".ts__axis--left .ts__label")].map(
      (l) => l.textContent,
    );
    expect(labels).toContain("Requests");
    expect(labels.filter((l) => l !== "Requests").length).toBeGreaterThan(1);
  });
});

describe("legend values in the chart", () => {
  it("shows Total and a percentile per series, sorts the table and names at most the limit", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(
      "timeseries",
      [traffic],
      { legend: { mode: "table", placement: "bottom", values: ["sum", "p50"], limit: 1 } },
      { defaults: {}, overrides: [] },
    );
    const table = container.querySelector(".viz-legend__table") as HTMLElement;
    expect(within(table).getByRole("columnheader", { name: "Total" })).toBeTruthy();
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("1 of 2 series")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "show all" }));
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    // A click on a heading sorts by its column, largest first.
    await user.click(within(table).getByRole("button", { name: /Total/ }));
    expect(
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((r) => r.querySelector("th")?.textContent),
    ).toEqual(["web", "api"]);
    await user.click(within(table).getByRole("button", { name: /Total/ }));
    expect(
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((r) => r.querySelector("th")?.textContent),
    ).toEqual(["api", "web"]);
  });

  it("shows the first two values in list mode", () => {
    const { container } = renderPanel(
      "timeseries",
      [traffic],
      { legend: { mode: "list", placement: "bottom", values: ["sum", "max", "min"] } },
      { defaults: {}, overrides: [] },
    );
    const first = container.querySelector(".ts__legend-item") as HTMLElement;
    expect(first.querySelectorAll(".viz-legend__value")).toHaveLength(2);
  });
});
