// biome-ignore-all lint/suspicious/noTemplateCurlyInString: link placeholders such as ${__value} are typed by users, not template literals
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Frame } from "../api/generated/shapes";
import type { PanelModel } from "../features/dashboards/model";
import { PanelBody } from "../features/dashboards/PanelCard";
import type { FieldConfig } from "./fieldConfig/fieldConfig";
import { heatLevel, heatmapData } from "./heatmap";
import { histogram } from "./histogram";
import { PanelPicker } from "./picker/PanelPicker";
import { pieSlices } from "./piechart";
import { getPanel, PANELS } from "./registry";
import { segments, stateData } from "./state/stateData";
import { filterRows, parseFilter, sortedRows } from "./table";
import { interpolate, markdown } from "./text/markdown";
import type { AnyPanelPlugin } from "./types";

const RANGE = { from: 0, to: 100_000 };
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

  it.each(FRAME_TYPES)("%s draws 100,000 rows within budget", (type) => {
    const frame = bigSeries(100_000);
    const start = performance.now();
    const { container, unmount } = renderPanel(type, [frame], {}, NONE);
    const ms = performance.now() - start;
    expect(container.querySelector("svg")).not.toBeNull();
    unmount();
    process.stdout.write(`${type}: 100k rows drawn in ${ms.toFixed(0)} ms\n`);
    expect(ms).toBeLessThan(process.env.CI === undefined ? 3000 : 6000);
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
    expect(slices.at(-1)).toMatchObject({ name: "", value: 66, tone: "neutral" });
    renderPanel("piechart", [frame], { legend: { mode: "table", placement: "right" } });
    expect(screen.getByRole("columnheader", { name: "Percent" })).toBeTruthy();
    expect(screen.getByText("Other")).toBeTruthy();
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

  it("orders prepared buckets by their upper bound", () => {
    const buckets: Frame = {
      fields: [
        { name: "time", type: "time", values: [0, 50_000] },
        { name: "b", type: "number", values: [1, 2], labels: { le: "+Inf" } },
        { name: "a", type: "number", values: [3, 4], labels: { le: "0.5" } },
      ],
    };
    const data = heatmapData(
      [buckets],
      { mode: "buckets", xBuckets: 2, yBuckets: 10, scale: "linear", tooltip: { mode: "all" } },
      RANGE,
      NONE,
      "en",
    );
    expect(data?.rows).toEqual(['a{le="0.5"}', 'b{le="+Inf"}']);
    expect([...(data?.cells ?? [])]).toEqual([3, 1, 4, 2]);
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
    // Nothing for frames fits documents: text fits anything, the current type stays shown.
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("value"))).toEqual([
      "text",
      "timeseries",
    ]);
    await user.click(screen.getByRole("checkbox", { name: /Show 11 more/ }));
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

  it("renders a dashboard of 50 panels of every type within budget", () => {
    const types = PANELS.map((p) => p.type);
    const frame = bigSeries(2_000);
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
                frames={[frame]}
                options={plugin.options(
                  plugin.type === "text" ? { content: "# Notes\n\nAll **fine**." } : {},
                )}
                fieldConfig={NONE}
                timeRange={{ from: 0, to: 2_000 }}
                title={`Panel ${i}`}
              />
            </div>
          );
        })}
      </div>,
    );
    const ms = performance.now() - start;
    expect(container.querySelectorAll("svg, table, section").length).toBeGreaterThanOrEqual(50);
    unmount();
    process.stdout.write(`dashboard: 50 panels rendered in ${ms.toFixed(0)} ms\n`);
    expect(ms).toBeLessThan(CI ? 8000 : 4000);
  });
});
