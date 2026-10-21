import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Field, Frame } from "../api/generated/shapes";
import { formatValue } from "./frame";
import { getPanel, panelsForShapes, suggestPanel } from "./registry";
import { reduceField } from "./stat";
import { sortedRows } from "./table";
import { buildSeries, seriesPath } from "./timeseries/series";
import type { AnyPanelPlugin } from "./types";

const RANGE = { from: 0, to: 100_000 };
/** Above 2^53: a double would print 9007199254740992. */
const BIG = "9007199254740993";

function renderPanel(type: string, frames: Frame[], options: unknown = {}) {
  const plugin = getPanel(type) as AnyPanelPlugin;
  const { Panel } = plugin;
  return render(
    <div>
      <Panel frames={frames} options={plugin.options(options)} timeRange={RANGE} title="Panel" />
    </div>,
  );
}

const tableFrame: Frame = {
  fields: [
    { name: "id", type: "int64", values: [BIG, "2", null, "-5"] },
    { name: "name", type: "string", values: ["Ada", null, "Grace", "Linus"] },
    { name: "score", type: "number", values: [1.5, null, 3, 0] },
  ],
};

describe("registry", () => {
  it("lists every M1 panel for frames and suggests one from the data", () => {
    expect(panelsForShapes(["frame"]).map((e) => [e.panel.type, e.accepts])).toEqual([
      ["timeseries", true],
      ["stat", true],
      ["bar", true],
      ["table", true],
    ]);
    // Documents are not accepted by any M1 panel: all are offered, none as fitting.
    expect(panelsForShapes(["documents"]).every((e) => !e.accepts)).toBe(true);
    expect(suggestPanel([{ shape: "frame", frame: tableFrame }])).toBe("table");
    const series: Frame = {
      fields: [
        { name: "time", type: "time", values: [1, 2] },
        { name: "v", type: "number", values: [1, 2] },
      ],
    };
    expect(suggestPanel([{ shape: "frame", frame: series }])).toBe("timeseries");
  });
});

describe("table panel", () => {
  it("shows int64 exactly and nulls as empty cells", () => {
    renderPanel("table", [tableFrame]);
    const rows = screen.getAllByRole("row");
    const cells = (row: number) =>
      within(rows[row] as HTMLElement)
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
    expect(cells(1)).toEqual([BIG, "Ada", "1.5"]);
    expect(cells(2)).toEqual(["2", "", ""]);
    expect(cells(3)).toEqual(["", "Grace", "3"]);
    expect(formatValue("int64", "123456789012345678901234567890", "en")).toBe(
      "123456789012345678901234567890",
    );
  });

  it("sorts int64 by value, not as text or doubles, with nulls last both ways", async () => {
    const user = userEvent.setup();
    renderPanel("table", [tableFrame]);
    const header = screen.getByRole("columnheader", { name: /id/ });
    await user.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    const firstColumn = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0]?.textContent);
    expect(firstColumn()).toEqual(["-5", "2", BIG, ""]);
    await user.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(firstColumn()).toEqual([BIG, "2", "-5", ""]);
    // Values one apart above 2^53 still sort apart.
    const close: Frame = {
      fields: [{ name: "n", type: "int64", values: [BIG, "9007199254740992"] }],
    };
    expect([...sortedRows(close, { column: 0, direction: "ascending" })]).toEqual([1, 0]);
  });

  it("renders only the rows in view of a long result", () => {
    const count = 10_000;
    const frame: Frame = {
      fields: [
        { name: "n", type: "int64", values: Array.from({ length: count }, (_, i) => String(i)) },
      ],
    };
    renderPanel("table", [frame]);
    const table = screen.getByRole("table");
    expect(table.getAttribute("aria-rowcount")).toBe(String(count + 1));
    const rendered = within(table).getAllByRole("row").length;
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(60);
  });
});

describe("stat panel", () => {
  const field: Field = { name: "bytes", type: "int64", values: [BIG, null, "7"] };

  it("reduces int64 exactly", () => {
    expect(reduceField(field, "last")).toEqual({ value: "7", type: "int64" });
    expect(reduceField(field, "max")).toEqual({ value: BIG, type: "int64" });
    expect(reduceField(field, "sum")).toEqual({ value: "9007199254741000", type: "int64" });
    expect(
      reduceField({ name: "x", type: "number", values: [null, null] }, "mean").value,
    ).toBeNull();
  });

  it("shows the value with its unit and a dash when there is none", () => {
    const frame: Frame = { fields: [field] };
    const { unmount } = renderPanel("stat", [frame], { reducer: "max", unit: "B" });
    expect(screen.getByText(BIG).textContent).toBe(`${BIG} B`);
    unmount();
    renderPanel("stat", [{ fields: [{ name: "x", type: "number", values: [null] }] }]);
    expect(screen.getByText("–")).toBeTruthy();
  });
});

describe("bar and time series panels", () => {
  it("draws one bar per row and explains a result without numbers", () => {
    const { container, unmount } = renderPanel("bar", [tableFrame]);
    // Two number fields (id, score) with three values each; null values draw no bar.
    expect(container.querySelectorAll("rect")).toHaveLength(6);
    unmount();
    renderPanel("bar", [{ fields: [{ name: "s", type: "string", values: ["a"] }] }]);
    expect(screen.getByText("No number fields in the result.")).toBeTruthy();
  });

  it("draws a line per series and breaks it at missing values", () => {
    const frame: Frame = {
      fields: [
        { name: "time", type: "time", values: [0, 25_000, 50_000, 75_000, 100_000] },
        { name: "a", type: "number", values: [1, 2, null, 4, 5] },
        { name: "b", type: "int64", values: ["1", "2", "3", "4", "5"], labels: { host: "x" } },
      ],
    };
    const { container } = renderPanel("timeseries", [frame]);
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(2);
    // A gap starts a new subpath: two "M" in the first series.
    expect(paths[0]?.getAttribute("d")?.match(/M/g)).toHaveLength(2);
    expect(screen.getByText('b{host="x"}')).toBeTruthy();
    expect(screen.getByRole("img", { name: "Panel" })).toBeTruthy();
  });

  it("explains a result without time", () => {
    renderPanel("timeseries", [tableFrame]);
    expect(screen.getByText(/No time series in the result/)).toBeTruthy();
  });
});

describe("performance budget", () => {
  // design: quality/performance.md. Minimum of several runs; CI runners get more time.
  const CI = process.env.CI !== undefined;
  const POINTS = 100_000;

  function bigFrame(): Frame {
    const times = Array.from({ length: POINTS }, (_, i) => i);
    const values = Array.from({ length: POINTS }, (_, i) => Math.sin(i / 500) * 100 + (i % 7));
    return {
      fields: [
        { name: "time", type: "time", values: times },
        { name: "v", type: "number", values },
      ],
    };
  }

  function minOf(runs: number, work: () => void): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      work();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }

  it("turns 100,000 points into a short path quickly", () => {
    const frame = bigFrame();
    let points = 0;
    const ms = minOf(5, () => {
      const [series] = buildSeries([frame]);
      const d = seriesPath(
        series as NonNullable<typeof series>,
        { x: (t) => (t / POINTS) * 1000, y: (v) => 100 - v },
        1000,
      );
      points = d.split(/[ML]/).length - 1;
    });
    process.stdout.write(
      `time series: 100k points to path in ${ms.toFixed(1)} ms (${points} points)\n`,
    );
    expect(points).toBeLessThanOrEqual(4 * 1002);
    expect(ms).toBeLessThan(CI ? 150 : 60);
  });

  it("renders a 100,000 point time series panel within budget", () => {
    const frame = bigFrame();
    const ms = minOf(3, () => {
      const { unmount } = renderPanel("timeseries", [frame]);
      unmount();
    });
    process.stdout.write(`time series: 100k point panel rendered in ${ms.toFixed(1)} ms\n`);
    expect(ms).toBeLessThan(CI ? 400 : 200);
  });
});
