// biome-ignore-all lint/suspicious/noTemplateCurlyInString: link placeholders such as ${__value} are typed by users, not template literals
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import type { DocumentSet, Frame, GraphSet } from "../api/generated/shapes";
import { sampleSchema } from "../documents/schema";
import type { PanelModel } from "../features/dashboards/model";
import { PanelBody } from "../features/dashboards/PanelCard";
import { barSlots } from "./bar";
import { gaugeItems, gaugeRows, MAX_GAUGE_ROWS, valueSize } from "./bargauge";
import { DEFAULT_THRESHOLDS, type FieldConfig } from "./fieldConfig/fieldConfig";
import { loadPatternEngine } from "./fieldConfig/pattern";
import { generateGraph } from "./graph/test/generate";
import { compareBounds, heatLevel, heatmapData } from "./heatmap";
import { histogram } from "./histogram";
import { PanelPicker } from "./picker/PanelPicker";
import { insideLabel, pieSlices } from "./piechart";
import { getPanel, PANELS } from "./registry";
import { mergeNarrow, segments, stateData } from "./state/stateData";
import { filterRows, parseFilter, sortedRows } from "./table";
import { interpolate, markdown } from "./text/markdown";
import type { AnyPanelPlugin } from "./types";

const RANGE = { from: 0, to: 100_000 };

// re2js loads on first use; the table tests use patterns right away.
beforeAll(async () => {
  await loadPatternEngine();
});
const NONE: FieldConfig = { defaults: {}, overrides: [] };

function renderPanel(
  type: string,
  frames: Frame[],
  options: unknown = {},
  fieldConfig: FieldConfig = NONE,
  variables: Record<string, string> = {},
) {
  const plugin = getPanel(type) as AnyPanelPlugin;
  const { Panel } = plugin;
  return render(
    <div>
      <Panel
        frames={frames}
        options={plugin.options(options)}
        fieldConfig={fieldConfig}
        timeRange={RANGE}
        title="Panel"
        variables={variables}
      />
    </div>,
  );
}

const series: Frame = {
  fields: [
    { name: "time", type: "time", values: [0, 25_000, 50_000, 75_000, 100_000] },
    { name: "cpu", type: "number", values: [12, 40, 72, 95, 60] },
    { name: "mem", type: "number", values: [30, 35, 38, 41, 44] },
  ],
};

const states: Frame = {
  fields: [
    { name: "time", type: "time", values: [0, 20_000, 40_000, 60_000, 80_000] },
    { name: "api", type: "string", values: ["up", "up", "down", "up", null] },
    { name: "db", type: "number", values: [1, 1, 1, 0, 1] },
  ],
};

const FRAME_TYPES = [
  "gauge",
  "bargauge",
  "piechart",
  "heatmap",
  "histogram",
  "state-timeline",
  "status-history",
];

function bigSeries(points: number): Frame {
  return {
    fields: [
      { name: "time", type: "time", values: Array.from({ length: points }, (_, i) => i) },
      {
        name: "v",
        type: "number",
        values: Array.from({ length: points }, (_, i) => Math.sin(i / 300) * 50 + 50),
      },
      {
        name: "state",
        type: "string",
        values: Array.from({ length: points }, (_, i) => (i % 1000 < 900 ? "ok" : "slow")),
      },
    ],
  };
}

describe("every new panel", () => {
  it.each(FRAME_TYPES)("%s explains a result without rows", (type) => {
    renderPanel(type, [
      {
        fields: [
          { name: "time", type: "time", values: [] },
          { name: "v", type: "number", values: [] },
        ],
      },
    ]);
    expect(screen.getByText("The query returned no data.")).toBeTruthy();
  });

  it.each(FRAME_TYPES)("%s shows a failed query as an alert, not as no data", (type) => {
    const panel: PanelModel = {
      id: "p",
      type,
      title: "Panel",
      grid: { x: 0, y: 0, w: 6, h: 6 },
      targets: [{ refId: "A", datasourceId: "ds", query: { sql: "SELECT 1" } }],
      transformations: [],
      options: {},
      fieldConfig: {},
    };
    render(
      <PanelBody
        panel={panel}
        title="Panel"
        range={RANGE}
        pending={false}
        error={null}
        outcomes={[{ refId: "A", error: { code: "query_timeout", message: "timeout" } }]}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("The query returned no data.")).toBeNull();
  });

  // About five times the typical time on a developer machine busy with other builds (with an
  // idle one far below); twice that in CI.
  const BUDGETS: Record<string, { ms: number; root: string }> = {
    gauge: { ms: 500, root: ".gauge__value-arc" },
    bargauge: { ms: 300, root: ".bargauge__fill" },
    piechart: { ms: 2500, root: ".pie__slice" },
    heatmap: { ms: 1500, root: ".heatmap__cell" },
    histogram: { ms: 300, root: ".bar__rect" },
    "state-timeline": { ms: 1500, root: ".state__cell" },
    "status-history": { ms: 1200, root: ".state__cell--status" },
  };

  it.each(FRAME_TYPES)("%s draws 100,000 rows within budget", (type) => {
    const frame = bigSeries(100_000);
    const budget = BUDGETS[type] as { ms: number; root: string };
    const start = performance.now();
    const { container, unmount } = renderPanel(type, [frame], {}, NONE);
    const ms = performance.now() - start;
    // The panel's own marks, not just any svg: an empty state would pass that.
    expect(container.querySelector(budget.root), budget.root).not.toBeNull();
    unmount();
    process.stdout.write(`${type}: 100k rows drawn in ${ms.toFixed(0)} ms\n`);
    expect(ms).toBeLessThan(process.env.CI === undefined ? budget.ms : budget.ms * 2);
  });

  it("is reachable by keyboard and reads out what it shows", async () => {
    const user = userEvent.setup();
    renderPanel(
      "gauge",
      [series],
      { reducer: "max" },
      {
        defaults: {
          unit: "percent",
          thresholds: {
            mode: "absolute",
            steps: [
              { value: null, tone: "ok" },
              { value: 90, tone: "critical" },
            ],
          },
        },
        overrides: [],
      },
    );
    await user.tab();
    const group = screen.getByRole("group", { name: "Panel" });
    expect(document.activeElement).toBe(group);
    expect(screen.getByRole("status").textContent).toBe("cpu: 95% (Critical)");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("status").textContent).toBe("mem: 44% (OK)");
  });

  it("has a name, a description and a preview in the picker", () => {
    for (const panel of PANELS) {
      expect(panel.Preview, panel.type).toBeDefined();
      expect(panel.description, panel.type).toBeDefined();
    }
  });
});

/** Each bar's share of its lane, as the bar gauge hands it to CSS. */
const shares = (root: Element) =>
  [...root.querySelectorAll<SVGElement>(".bargauge__lane-bar")].map((bar) =>
    bar.style.getPropertyValue("--share"),
  );

describe("gauge and bar gauge", () => {
  it("fills the arc by the value between min and max, colored by the thresholds", () => {
    const { container } = renderPanel(
      "gauge",
      [series],
      { reducer: "last" },
      {
        defaults: {
          min: 0,
          max: 100,
          thresholds: {
            mode: "absolute",
            steps: [
              { value: null, tone: "ok" },
              { value: 50, tone: "warn" },
            ],
          },
        },
        overrides: [],
      },
    );
    const arcs = container.querySelectorAll(".gauge__value-arc");
    expect([...arcs].map((a) => a.getAttribute("class"))).toEqual([
      "gauge__value-arc tone--warn",
      "gauge__value-arc tone--ok",
    ]);
    // Two bands outside each arc: the threshold markers.
    expect(container.querySelectorAll(".gauge__marker")).toHaveLength(4);
  });

  it("lights LCD cells in the color of the threshold at their place", () => {
    const { container } = renderPanel(
      "bargauge",
      [{ fields: [{ name: "v", type: "number", values: [75] }] }],
      { displayMode: "lcd" },
      {
        defaults: {
          min: 0,
          max: 100,
          thresholds: {
            mode: "absolute",
            steps: [
              { value: null, tone: "ok" },
              { value: 50, tone: "warn" },
            ],
          },
        },
        overrides: [],
      },
    );
    const cells = [...container.querySelectorAll(".bargauge__cell")].map((c) =>
      c.getAttribute("class"),
    );
    expect(cells).toHaveLength(20);
    expect(cells.filter((c) => c?.includes("tone--ok"))).toHaveLength(10);
    expect(cells.filter((c) => c?.includes("tone--warn"))).toHaveLength(5);
    expect(cells.filter((c) => c?.includes("--off"))).toHaveLength(5);
  });

  it("draws one bar per row of a result with names, all on one scale", () => {
    const byRow: Frame = {
      fields: [
        { name: "framework", type: "string", values: ["Alpha", "Beta", "Gamma"] },
        { name: "score", type: "number", values: [50, 100, 25] },
      ],
    };
    const { items, truncated, dropped } = gaugeItems([byRow], NONE, "last", "en", "UTC");
    expect([truncated, dropped]).toEqual([false, false]);
    expect(items.map((item) => [item.name, item.display.text, item.range])).toEqual([
      ["Alpha", "50", { min: 0, max: 100 }],
      ["Beta", "100", { min: 0, max: 100 }],
      ["Gamma", "25", { min: 0, max: 100 }],
    ]);
    const { container } = renderPanel("bargauge", [byRow]);
    const names = [...container.querySelectorAll(".bargauge__item .bargauge__name")].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["Alpha", "Beta", "Gamma"]);
    const fills = shares(container);
    expect(fills).toEqual(["0.5", "1", "0.25"]);
  });

  it("shares one scale between fields, so a reduced value does not fill every bar", () => {
    const fields: Frame = {
      fields: [
        { name: "Nord", type: "number", values: [40] },
        { name: "Süd", type: "number", values: [80] },
      ],
    };
    const { container } = renderPanel("bargauge", [fields], { reducer: "last" });
    const fills = shares(container);
    expect(fills).toEqual(["0.5", "1"]);
    // A field with a range of its own keeps it.
    const own: FieldConfig = {
      defaults: {},
      overrides: [{ matcher: { type: "name", value: "Nord" }, properties: { max: 40 } }],
    };
    const { container: second } = renderPanel("bargauge", [fields], { reducer: "last" }, own);
    expect(shares(second)).toEqual(["1", "1"]);
  });

  it("shares a scale only between fields of one unit; percentages keep 0 to 100", () => {
    const mixed: Frame = {
      fields: [
        { name: "cpu", type: "number", values: [60] },
        { name: "memory", type: "number", values: [6e9] },
        { name: "disk", type: "number", values: [3e9] },
      ],
    };
    const units: FieldConfig = {
      defaults: { unit: "bytes" },
      overrides: [{ matcher: { type: "name", value: "cpu" }, properties: { unit: "percent" } }],
    };
    const { container } = renderPanel("bargauge", [mixed], { reducer: "last" }, units);
    expect(shares(container)).toEqual(["0.6", "1", "0.5"]);
  });

  it("draws at most a hundred rows and says so, and names results it leaves out", () => {
    const many: Frame = {
      fields: [
        { name: "host", type: "string", values: Array.from({ length: 150 }, (_, i) => `h${i}`) },
        { name: "load", type: "number", values: Array.from({ length: 150 }, (_, i) => i) },
      ],
    };
    const gauge = gaugeItems([many], NONE, "last", "en", "UTC");
    expect([gauge.items.length, gauge.truncated]).toEqual([MAX_GAUGE_ROWS, true]);
    renderPanel("bargauge", [many]);
    expect(screen.getByText("Only the first 100 rows are shown as bars.")).toBeTruthy();
    const other: Frame = { fields: [{ name: "v", type: "number", values: [1] }] };
    expect(gaugeItems([many, other], NONE, "last", "en", "UTC").dropped).toBe(true);
  });

  it("lays out its rows once data arrives after an empty first result", () => {
    const plugin = getPanel("bargauge") as AnyPanelPlugin;
    const { Panel } = plugin;
    const draw = (frames: Frame[]) => (
      <Panel frames={frames} options={plugin.options({})} timeRange={RANGE} title="Panel" />
    );
    const { container, rerender } = render(draw([]));
    expect(container.querySelector(".bargauge__list")).toBeNull();
    rerender(draw([{ fields: [{ name: "v", type: "number", values: [5] }] }]));
    const list = container.querySelector<HTMLElement>(".bargauge__list");
    expect(list?.style.getPropertyValue("--bargauge-row")).toMatch(/^\d+px$/);
    expect(
      container.querySelector(".bargauge__box")?.getAttribute("data-value-size"),
    ).not.toBeNull();
  });

  it("shares the height out to its rows and sizes the value to the bar", () => {
    expect(gaugeRows(300, 7, "left")).toEqual({ row: 36, bar: 36 });
    // Few rows stop at the largest height; the name above a bar takes a line of the row.
    expect(gaugeRows(600, 2, "left").row).toBe(40);
    expect(gaugeRows(600, 2, "top")).toEqual({ row: 58, bar: 40 });
    expect(gaugeRows(100, 40, "left").row).toBe(20);
    expect([16, 24, 30, 40].map(valueSize)).toEqual(["sm", "md", "lg", "xl"]);
  });

  it("shows the value in the bar's color or not at all, and the names above or not at all", () => {
    const frame: Frame = { fields: [{ name: "v", type: "number", values: [75] }] };
    const { container } = renderPanel("bargauge", [frame], {
      valueDisplay: "color",
      namePlacement: "top",
    });
    expect(container.querySelector(".bargauge__value--color")).not.toBeNull();
    expect(container.querySelector(".bargauge--name-top")).not.toBeNull();
    const { container: bare } = renderPanel("bargauge", [frame], {
      valueDisplay: "hidden",
      namePlacement: "hidden",
    });
    expect(bare.querySelector(".bargauge__item .bargauge__value")).toBeNull();
    expect(bare.querySelector(".bargauge__item .bargauge__name")).toBeNull();
    // The readout still names the value.
    expect(bare.querySelector("[role=group]")?.getAttribute("aria-label")).toBe("Panel");
  });
});

describe("bar chart", () => {
  const channels: Frame = {
    fields: [
      { name: "framework", type: "string", values: ["Alpha", "Beta"] },
      { name: "online", type: "number", values: [120_000, 200_000] },
      { name: "store", type: "number", values: [80_000, 50_000] },
      { name: "partner", type: "number", values: [25_000, 40_000] },
    ],
  };

  it("groups the series per category with a gap between the bars", () => {
    expect(barSlots(100, 1)).toEqual({ offset: 10, width: 80, step: 80 });
    const grouped = barSlots(120, 3);
    expect(grouped.step).toBeCloseTo(32);
    expect(grouped.width).toBeCloseTo(30);
    // Bars too thin for a gap keep their whole width.
    expect(barSlots(10, 3).width).toBeCloseTo(8 / 3);
    const { container } = renderPanel("bar", [channels], {
      legend: { mode: "list", placement: "right" },
    });
    expect(container.querySelectorAll(".bar__rect")).toHaveLength(6);
    expect(container.querySelector(".viz-layout--right")).not.toBeNull();
    expect([...container.querySelectorAll(".ts__legend-item")].map((i) => i.textContent)).toEqual([
      "online",
      "store",
      "partner",
    ]);
  });

  it("writes the value axis compactly and can hide the category names", () => {
    const { container } = renderPanel("bar", [channels], { categoryLabels: "hidden" });
    const labels = [...container.querySelectorAll(".ts__label")].map((l) => l.textContent);
    expect(labels).toContain("200 k");
    expect(labels).not.toContain("Alpha");
  });
});

describe("pie chart", () => {
  it("takes slices from rows with a name, or one per field, and leaves out negatives", () => {
    const byRow: Frame = {
      fields: [
        { name: "region", type: "string", values: ["Nord", "Süd", "West", "Ost"] },
        { name: "orders", type: "int64", values: ["30", "50", "-2", null] },
      ],
    };
    expect(pieSlices([byRow], NONE, "last", "de").map((s) => [s.name, s.value])).toEqual([
      ["Nord", 30],
      ["Süd", 50],
    ]);
    expect(pieSlices([series], NONE, "max", "de").map((s) => [s.name, s.value])).toEqual([
      ["cpu", 95],
      ["mem", 44],
    ]);
  });

  it("sums the smallest slices into one beyond twenty", () => {
    const frame: Frame = {
      fields: [
        { name: "n", type: "string", values: Array.from({ length: 30 }, (_, i) => `s${i}`) },
        { name: "v", type: "number", values: Array.from({ length: 30 }, (_, i) => i + 1) },
      ],
    };
    const slices = pieSlices([frame], NONE, "last", "en");
    expect(slices).toHaveLength(20);
    expect(slices.at(-1)).toMatchObject({ value: 66, tone: "neutral", other: true });
    // A real category may be named "" without becoming "Other".
    expect(slices.filter((s) => s.other === true)).toHaveLength(1);
    renderPanel("piechart", [frame], { legend: { mode: "table", placement: "right" } });
    expect(screen.getByRole("columnheader", { name: "Percent" })).toBeTruthy();
    expect(screen.getByText("Other")).toBeTruthy();
  });

  it("puts labels on the slices only where they fit", () => {
    // A quarter of a circle of 100 px has room for a short label; a sliver has not.
    expect(insideLabel({ from: 0, to: Math.PI / 2 }, 0, 100, 30)).toEqual({ radius: 64 });
    expect(insideLabel({ from: 0, to: 0.1 }, 0, 100, 30)).toBeNull();
    // A thin ring has no depth for a line of text.
    expect(insideLabel({ from: 0, to: Math.PI }, 92, 100, 10)).toBeNull();
    expect(insideLabel({ from: 0, to: Math.PI }, 50, 100, 10)).toEqual({ radius: 75 });
    // Horizontal text runs along a slice at twelve o'clock but across one at three o'clock.
    expect(insideLabel({ from: -0.8, to: 0.8 }, 0, 100, 80)).toEqual({ radius: 64 });
    expect(insideLabel({ from: Math.PI / 2 - 0.8, to: Math.PI / 2 + 0.8 }, 0, 100, 80)).toBeNull();
  });

  it("lists the legend values chosen, in a table beside the circle", () => {
    const frame: Frame = {
      fields: [
        { name: "region", type: "string", values: ["Nord", "Süd"] },
        { name: "sales", type: "number", values: [184_000, 46_000] },
      ],
    };
    const { container } = renderPanel(
      "piechart",
      [frame],
      { legend: { mode: "table", placement: "right" }, legendValues: ["value"] },
      { defaults: { unit: "short" }, overrides: [] },
    );
    expect(screen.getByRole("columnheader", { name: "Value" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Percent" })).toBeNull();
    expect(screen.getByText("184K")).toBeTruthy();
    expect(container.querySelectorAll(".pie__label--inside").length).toBeGreaterThan(0);
  });
});

describe("heatmap and histogram", () => {
  it("counts values into time and value buckets", () => {
    const data = heatmapData(
      [series],
      { mode: "calculate", xBuckets: 4, yBuckets: 2, scale: "linear", tooltip: { mode: "all" } },
      RANGE,
      NONE,
      "en",
    );
    expect(data?.rows).toHaveLength(2);
    expect(data?.max).toBe(2);
    expect([...(data?.cells ?? [])].reduce((a, b) => a + b, 0)).toBe(10);
    expect(heatLevel(0, 10, "linear")).toBe(0);
    expect(heatLevel(1, 10, "linear")).toBe(1);
    expect(heatLevel(1, 10, "sqrt")).toBe(3);
    expect(heatLevel(10, 10, "linear")).toBe(8);
  });

  it("de-cumulates Prometheus buckets per series and orders them by le, +Inf last", () => {
    const at = (
      le: string,
      instance: string,
      values: (number | null)[],
    ): Frame["fields"][number] => ({
      name: "requests_bucket",
      type: "number",
      values,
      labels: { le, instance },
    });
    const buckets: Frame = {
      fields: [
        { name: "time", type: "time", values: [0, 50_000] },
        at("+Inf", "a", [6, 7]),
        at("0.1", "b", [1, null]),
        at("0.5", "a", [5, 2]),
        at("+Inf", "b", [4, null]),
        at("0.1", "a", [2, 3]),
        at("0.5", "b", [1, null]),
      ],
    };
    const data = heatmapData(
      [buckets],
      { mode: "buckets", xBuckets: 2, yBuckets: 10, scale: "linear", tooltip: { mode: "all" } },
      RANGE,
      NONE,
      "en",
    );
    expect(data?.rows).toEqual(["≤ 0.1", "≤ 0.5", "+Inf"]);
    // Column 0: a gives 2, 3, 1 and b gives 1, 0, 3. Column 1: a's 0.5 bucket fell below its
    // 0.1 bucket (a reset between scrapes), which counts as 0, not as a negative count.
    expect([...(data?.cells ?? [])]).toEqual([3, 3, 4, 3, 0, 5]);
    expect(compareBounds(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(0);
    expect(compareBounds(Number.POSITIVE_INFINITY, 1e300)).toBe(1);
  });

  it("widens the bucket size instead of piling values into the last bucket", () => {
    const frame: Frame = {
      fields: [
        { name: "v", type: "number", values: Array.from({ length: 1000 }, (_, i) => i / 100) },
      ],
    };
    const options = {
      combine: false,
      legend: { mode: "list" as const, placement: "bottom" as const, values: [] },
      tooltip: { mode: "all" as const },
    };
    const data = histogram([frame], { ...options, bucketSize: 0.001 }, NONE);
    const counts = data?.series[0]?.counts ?? [];
    expect(counts.length).toBeLessThanOrEqual(200);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(Math.max(...counts)).toBeLessThan(20);
  });

  it("buckets values by count or by size", () => {
    const frame: Frame = {
      fields: [{ name: "v", type: "number", values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10] }],
    };
    const options = {
      combine: false,
      legend: { mode: "list" as const, placement: "bottom" as const, values: [] },
      tooltip: { mode: "all" as const },
    };
    expect(histogram([frame], { ...options, bucketCount: 5 }, NONE)?.series[0]?.counts).toEqual([
      2, 2, 2, 2, 2,
    ]);
    const bySize = histogram([frame], { ...options, bucketSize: 4 }, NONE);
    expect(bySize?.edges).toEqual([0, 4, 8, 12]);
    expect(bySize?.series[0]?.counts).toEqual([4, 4, 2]);
  });
});

describe("state timeline and status history", () => {
  it("merges equal values into runs and colors them by mapping or by value", () => {
    const config: FieldConfig = {
      defaults: {},
      overrides: [
        {
          matcher: { type: "name", value: "db" },
          properties: {
            mappings: [
              { type: "value", value: "1", text: "online", tone: "ok" },
              { type: "value", value: "0", text: "offline", tone: "critical" },
            ],
          },
        },
      ],
    };
    const data = stateData([states], config, "en");
    expect(data?.rows.map((r) => r.name)).toEqual(["api", "db"]);
    const api = segments(data?.rows[0] as never, data?.times ?? [], 100_000);
    expect(api.map((s) => [s.value.text, s.from, s.to])).toEqual([
      ["up", 0, 40_000],
      ["down", 40_000, 60_000],
      ["up", 60_000, 80_000],
    ]);
    const db = segments(data?.rows[1] as never, data?.times ?? [], 100_000);
    expect(db.map((s) => [s.value.text, s.value.colorClass])).toEqual([
      ["online", "tone--ok"],
      ["offline", "tone--critical"],
      ["online", "tone--ok"],
    ]);
    // The same text keeps its palette color in every row.
    expect(api[0]?.value.colorClass).toBe(api[2]?.value.colorClass);
    expect(api[0]?.value.colorClass).not.toBe(api[1]?.value.colorClass);
  });

  it("folds runs narrower than a pixel into the run before them", () => {
    const value = (text: string) => ({ text, colorClass: "series-1" });
    const runs = [
      { value: value("up"), from: 0, to: 100 },
      { value: value("down"), from: 100, to: 100.5 },
      { value: value("up"), from: 100.5, to: 200 },
      { value: value("down"), from: 200, to: 260 },
    ];
    expect(mergeNarrow(runs, 1).map((r) => [r.value.text, r.from, r.to])).toEqual([
      ["up", 0, 100.5],
      ["up", 100.5, 200],
      ["down", 200, 260],
    ]);
  });

  it("thins long results and names at most 24 values in the legend", () => {
    const n = 5_000;
    const frame: Frame = {
      fields: [
        { name: "time", type: "time", values: Array.from({ length: n }, (_, i) => i) },
        { name: "v", type: "number", values: Array.from({ length: n }, (_, i) => i) },
      ],
    };
    const data = stateData([frame], NONE, "en");
    expect(data?.times).toHaveLength(500);
    // Each stretch keeps its last point, so the end of the data is never lost.
    expect(data?.times.at(-1)).toBe(n - 1);
    expect(data?.legend).toHaveLength(24);
  });

  it("draws one cell per time point in the status history, with a legend", () => {
    const { container } = renderPanel("status-history", [states]);
    // 4 values of api (one missing) and 5 of db.
    expect(container.querySelectorAll(".state__cell")).toHaveLength(9);
    expect(screen.getByText("down")).toBeTruthy();
  });
});

describe("text panel", () => {
  it("renders Markdown as elements and raw HTML as text", () => {
    const { container } = render(
      <div>
        {markdown(
          '# Title\n\nSome **bold** and *soft* `code` [docs](https://kalzit.dev) [bad](javascript:alert(1))\n\n- a\n- b\n\n<img src=x onerror="alert(1)"><script>alert(1)</script>\n\n| A | B |\n|---|---|\n| 1 | 2 |',
        )}
      </div>,
    );
    expect(container.querySelector("h3")?.textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("soft");
    expect(container.querySelector("code")?.textContent).toBe("code");
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://kalzit.dev"]);
    expect(container.textContent).toContain("bad");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("fills variables into text only, so a value cannot add a link", () => {
    const { container } = render(
      <div>
        {markdown("Hallo $name, see [docs](https://kalzit.dev/a_(b)) and [x](/\\evil.example)", {
          name: "[Login](https://evil.example)",
        })}
      </div>,
    );
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://kalzit.dev/a_(b)"]);
    expect(container.textContent).toContain("Hallo [Login](https://evil.example), see docs and x");
  });

  it("parses long runs of unclosed marks in linear time", () => {
    const start = performance.now();
    const { container } = render(
      <div>{markdown(`${"[".repeat(20_000)} ${"*".repeat(20_000)} ${"`".repeat(5_000)}`)}</div>,
    );
    expect(container.textContent?.length).toBeGreaterThan(40_000);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("fills in dashboard variables and needs no query", () => {
    expect(
      interpolate("$region / ${env} / [[region]] / $unknown", { region: "Nord", env: "prod" }),
    ).toBe("Nord / prod / Nord / $unknown");
    renderPanel("text", [], { content: "Region **$region**" }, NONE, { region: "<b>Süd</b>" });
    expect(screen.getByText("<b>Süd</b>").tagName).toBe("STRONG");
    const panel: PanelModel = {
      id: "t",
      type: "text",
      title: "Notes",
      grid: { x: 0, y: 0, w: 6, h: 4 },
      targets: [],
      transformations: [],
      options: { content: "Hallo $name" },
      fieldConfig: {},
    };
    render(
      <PanelBody
        panel={panel}
        title="Notes"
        range={RANGE}
        pending={false}
        error={null}
        outcomes={[]}
        variables={{ name: "Ada" }}
      />,
    );
    expect(screen.getByText("Hallo Ada")).toBeTruthy();
  });
});

describe("stat panel", () => {
  it("colors the value or the background by the thresholds and names the state", () => {
    const config: FieldConfig = {
      defaults: {
        unit: "percent",
        thresholds: {
          mode: "absolute",
          steps: [
            { value: null, tone: "ok" },
            { value: 50, tone: "critical" },
          ],
        },
      },
      overrides: [],
    };
    const { container, unmount } = renderPanel(
      "stat",
      [series],
      { colorMode: "background", reducer: "last", textMode: "valueAndName" },
      config,
    );
    const items = [...container.querySelectorAll(".stat__item")];
    expect(items.map((i) => i.className)).toEqual([
      "stat__item tone--critical stat__item--background ",
      "stat__item tone--ok stat__item--background ",
    ]);
    expect(items[0]?.textContent).toContain("cpu60%");
    expect(items[0]?.textContent).toContain("(Critical)");
    unmount();
    const plain = renderPanel("stat", [series], { colorMode: "none", graphMode: "none" }, config);
    expect(plain.container.querySelector(".tone--critical")).toBeNull();
    expect(plain.container.querySelector(".stat__sparkline")).toBeNull();
  });
});

describe("table extras", () => {
  const frame: Frame = {
    fields: [
      { name: "host", type: "string", values: ["web-1", "web-2", "db-1", "db-2"] },
      { name: "load", type: "number", values: [0.5, 2.5, 7, null] },
      { name: "status", type: "int64", values: ["200", "500", "200", "404"] },
    ],
  };
  const config: FieldConfig = {
    defaults: {},
    overrides: [
      {
        matcher: { type: "name", value: "load" },
        properties: {
          cellDisplay: "gauge",
          decimals: 1,
          min: 0,
          max: 10,
          thresholds: {
            mode: "absolute",
            steps: [
              { value: null, tone: "ok" },
              { value: 5, tone: "critical" },
            ],
          },
          noValue: "–",
        },
      },
      {
        matcher: { type: "name", value: "status" },
        properties: {
          cellDisplay: "color-background",
          mappings: [
            { type: "range", from: 200, to: 299, text: "OK", tone: "ok" },
            { type: "range", from: 500, to: 599, text: "Fehler", tone: "critical" },
          ],
        },
      },
      {
        matcher: { type: "name", value: "host" },
        properties: { cellDisplay: "link", link: "/d/hosts?var-host=${__value}", width: 120 },
      },
    ],
  };

  it("formats columns by their options and draws cells in their mode", () => {
    const { container } = renderPanel("table", [frame], {}, config);
    const rows = screen.getAllByRole("row");
    const cells = within(rows[1] as HTMLElement).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual(["web-1", "0.5 (OK)", "OK (OK)"]);
    expect(
      within(cells[0] as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toBe("/d/hosts?var-host=web-1");
    expect(cells[2]?.className).toContain("vt__cell--fill tone--ok");
    expect(container.querySelector(".vt__gauge-bar")?.getAttribute("width")).toBe("5.00%");
    const last = within(rows[4] as HTMLElement).getAllByRole("cell");
    expect(last[1]?.textContent).toBe("–");
    expect(last[2]?.textContent).toBe("404");
  });

  it("filters columns by text and number comparisons", async () => {
    const user = userEvent.setup();
    renderPanel("table", [frame], { columnFilters: true }, config);
    await user.type(screen.getByLabelText("Filter load"), ">1");
    expect(screen.getAllByRole("row")).toHaveLength(2 + 2);
    await user.type(screen.getByLabelText("Filter host"), "db");
    const rows = screen.getAllByRole("row").slice(2);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]?.textContent)).toEqual(["db-1"]);
    await user.clear(screen.getByLabelText("Filter load"));
    await user.clear(screen.getByLabelText("Filter host"));
    // Mapped text is found too.
    await user.type(screen.getByLabelText("Filter status"), "fehler");
    expect(screen.getAllByRole("row")).toHaveLength(3);
    const status = frame.fields[2] as Frame["fields"][number];
    expect(parseFilter("", status, {})).toBeNull();
    expect(parseFilter("!=200", status, {})?.("404")).toBe(true);
  });

  it("shows pages and moves between them", async () => {
    const user = userEvent.setup();
    const long: Frame = {
      fields: [{ name: "n", type: "number", values: Array.from({ length: 23 }, (_, i) => i) }],
    };
    renderPanel("table", [long], { pagination: true, pageSize: 10 });
    expect(screen.getAllByRole("row")).toHaveLength(11);
    expect(screen.getByText("Page 1 of 3")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Page 3 of 3")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", true);
  });
});

describe("panel picker", () => {
  it("offers what fits the result first and the rest on request", async () => {
    const user = userEvent.setup();
    let picked = "";
    render(
      <PanelPicker value="timeseries" shapes={["documents"]} onChange={(t) => (picked = t)} />,
    );
    // The document panels fit documents, text fits anything, the current type stays shown.
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("value"))).toEqual([
      "documents",
      "schema",
      "distribution",
      "document",
      "text",
      "timeseries",
    ]);
    await user.click(
      screen.getByRole("checkbox", { name: new RegExp(`Show ${PANELS.length - 5} more`) }),
    );
    expect(screen.getAllByRole("radio")).toHaveLength(PANELS.length);
    await user.click(screen.getByRole("radio", { name: "Heatmap" }));
    expect(picked).toBe("heatmap");
    expect(
      screen.getByRole("radio", { name: "Gauge" }).getAttribute("aria-describedby"),
    ).toBeTruthy();
  });
});

describe("performance budget", () => {
  const CI = process.env.CI !== undefined;
  /** A graph result of a realistic panel size, with a few paths for the path panel. */
  const graph: GraphSet = (() => {
    const set = generateGraph(100, 200);
    const paths = set.edges.slice(0, 10).map((edge) => ({
      nodes: [edge.from, edge.to],
      edges: [edge.id],
    }));
    return { ...set, paths };
  })();
  const isGraphPanel = (plugin: AnyPanelPlugin) => plugin.shapes.includes("graph");

  // The graph panels load their code with the first use (lazy.tsx); one render each loads it, so
  // the timed dashboard below measures drawing, not loading modules.
  beforeAll(async () => {
    for (const plugin of PANELS.filter(isGraphPanel)) {
      const { Panel } = plugin;
      const { unmount } = render(
        <Panel
          frames={[]}
          graphs={[{ refId: "A", datasourceId: "ds", graph }]}
          options={plugin.options({})}
          timeRange={RANGE}
          title="Preload"
        />,
      );
      await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull(), { timeout: 10_000 });
      unmount();
    }
  }, 30_000);

  it("filters and sorts 100,000 cells and renders only the rows in view", () => {
    const rows = 10_000;
    const frame: Frame = {
      fields: Array.from({ length: 10 }, (_, c) => ({
        name: `c${c}`,
        type: "number" as const,
        values: Array.from({ length: rows }, (_, r) => (r * (c + 7)) % 1000),
      })),
    };
    const start = performance.now();
    const order = sortedRows(frame, { column: 3, direction: "descending" });
    const kept = filterRows(frame, order, [
      parseFilter(">500", frame.fields[0] as never, {}),
      null,
      parseFilter("<900", frame.fields[2] as never, {}),
    ]);
    const filtered = performance.now() - start;
    expect(kept.length).toBeGreaterThan(0);
    const renderStart = performance.now();
    const config: FieldConfig = { defaults: { unit: "ms", decimals: 1 }, overrides: [] };
    const { unmount } = renderPanel("table", [frame], { columnFilters: true }, config);
    const rendered = performance.now() - renderStart;
    const shown = screen.getAllByRole("row").length;
    unmount();
    process.stdout.write(
      `table: 100k cells sorted and filtered in ${filtered.toFixed(0)} ms, rendered in ${rendered.toFixed(0)} ms (${shown} rows)\n`,
    );
    expect(shown).toBeLessThan(80);
    expect(filtered).toBeLessThan(CI ? 600 : 300);
    expect(rendered).toBeLessThan(CI ? 1500 : 800);
  });

  it("runs mappings, patterns and the text filter over 100,000 cells within budget", async () => {
    const user = userEvent.setup();
    const rows = 30_000;
    const hosts = ["web-1", "web-2", "db-1", "cache-1", "error-gateway"];
    const frame: Frame = {
      fields: [
        {
          name: "host",
          type: "string",
          values: Array.from({ length: rows }, (_, r) => hosts[r % 5]),
        },
        {
          name: "status",
          type: "int64",
          values: Array.from({ length: rows }, (_, r) => String([200, 404, 500][r % 3])),
        },
        {
          name: "latency",
          type: "number",
          values: Array.from({ length: rows }, (_, r) => (r * 37) % 2000),
        },
        {
          name: "note",
          type: "string",
          values: Array.from({ length: rows }, (_, r) => `${"a".repeat(r % 40)}b`),
        },
      ],
    };
    const config: FieldConfig = {
      defaults: {},
      overrides: [
        {
          matcher: { type: "regex", value: "^(host|note)$" },
          properties: {
            cellDisplay: "color-text",
            mappings: [
              { type: "regex", pattern: "^error", text: "Fehler", tone: "critical" },
              // Catastrophic for a backtracking engine; linear here.
              { type: "regex", pattern: "(a+)+$", text: "nur a", tone: "warn" },
            ],
          },
        },
        {
          matcher: { type: "name", value: "status" },
          properties: {
            cellDisplay: "color-background",
            mappings: [
              { type: "range", from: 200, to: 299, text: "OK", tone: "ok" },
              { type: "range", from: 500, to: 599, text: "Server", tone: "critical" },
            ],
          },
        },
        {
          matcher: { type: "name", value: "latency" },
          properties: {
            unit: "ms",
            cellDisplay: "gauge",
            min: 0,
            max: 2000,
            thresholds: DEFAULT_THRESHOLDS,
          },
        },
      ],
    };
    const start = performance.now();
    renderPanel("table", [frame], { columnFilters: true }, config);
    await user.type(screen.getByLabelText("Filter host"), "fehler");
    await user.type(screen.getByLabelText("Filter status"), "server");
    const ms = performance.now() - start;
    const shown = screen.getAllByRole("row").slice(2);
    // Every fifth row is the gateway, every third a 500; both hold every fifteenth.
    expect(screen.getByRole("table").getAttribute("aria-rowcount")).toBe(String(rows / 15 + 2));
    expect(within(shown[0] as HTMLElement).getAllByRole("cell")[0]?.textContent).toContain(
      "Fehler",
    );
    process.stdout.write(
      `table: 100k cells with mappings, patterns and filters in ${ms.toFixed(0)} ms\n`,
    );
    expect(ms).toBeLessThan(CI ? 12_000 : 6_000);
  });

  it("renders a dashboard of 50 panels of every type within budget", () => {
    const types = PANELS.map((p) => p.type);
    // A realistic dashboard: a few hundred rows per panel, with field options in use.
    const frame = bigSeries(500);
    // The document panels get a few hundred documents of their own.
    const isDocumentPanel = (plugin: AnyPanelPlugin) => plugin.shapes.includes("documents");
    const docs = Array.from({ length: 500 }, (_, i) => ({
      _id: `d${i}`,
      at: { $type: "date", value: String(1_790_000_000_000 + i * 60_000) },
      total: i * 1.5,
      status: i % 3 === 0 ? "open" : "paid",
    }));
    const documents: DocumentSet = { documents: docs, schema: sampleSchema(docs), notices: [] };
    const options: FieldConfig = {
      defaults: { unit: "percent", decimals: 1, thresholds: DEFAULT_THRESHOLDS, min: 0, max: 100 },
      overrides: [
        {
          matcher: { type: "name", value: "state" },
          properties: {
            mappings: [{ type: "value", value: "slow", text: "langsam", tone: "warn" }],
          },
        },
      ],
    };
    const start = performance.now();
    const { container, unmount } = render(
      <div>
        {Array.from({ length: 50 }, (_, i) => {
          const plugin = getPanel(types[i % types.length] as string) as AnyPanelPlugin;
          const { Panel } = plugin;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of panels
            <div key={i}>
              <Panel
                frames={isGraphPanel(plugin) ? [] : [frame]}
                documents={isDocumentPanel(plugin) ? [documents] : undefined}
                graphs={
                  isGraphPanel(plugin) ? [{ refId: "A", datasourceId: "ds", graph }] : undefined
                }
                options={plugin.options(
                  plugin.type === "text" ? { content: "# Notes\n\nAll **fine**." } : {},
                )}
                fieldConfig={options}
                timeRange={{ from: 0, to: 500 }}
                title={`Panel ${i}`}
              />
            </div>
          );
        })}
      </div>,
    );
    const ms = performance.now() - start;
    // Every panel drew its own content, none fell back to an empty or error state.
    expect(container.querySelectorAll(".panel-empty")).toHaveLength(0);
    expect(container.querySelectorAll(".gauge__value-arc").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("table[aria-rowcount]").length).toBeGreaterThan(0);
    // The graph panels drew too: the network and hierarchy as tables here (no WebGL), the paths.
    expect(screen.getAllByRole("table", { name: /^Nodes of Panel/ }).length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".path").length).toBeGreaterThan(0);
    unmount();
    process.stdout.write(`dashboard: 50 panels rendered in ${ms.toFixed(0)} ms\n`);
    // About five times the measured time on a busy machine.
    expect(ms).toBeLessThan(CI ? 6000 : 3000);
  });
});
