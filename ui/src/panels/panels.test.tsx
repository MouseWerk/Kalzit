import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Field, Frame } from "../api/generated/shapes";
import { Dialog } from "../features/dashboards/ui/Dialog";
import { formatValue } from "./frame";
import { getPanel, panelsForShapes, suggestPanel } from "./registry";
import { reduceField } from "./stat";
import { sortedRows } from "./table";
import { buildSeries, seriesPath } from "./timeseries/series";
import type { AnyPanelPlugin } from "./types";

const RANGE = { from: 0, to: 100_000 };
/** Above 2^53: a double would print 9007199254740992. */
const BIG = "9007199254740993";
/** BIG as English groups it: still every digit. */
const BIG_SHOWN = "9,007,199,254,740,993";

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
      ["documents", false],
      ["schema", false],
      ["distribution", false],
      ["document", false],
    ]);
    // Documents: the document panels first, then the frame panels, which need a projection.
    expect(panelsForShapes(["documents"]).map((e) => [e.panel.type, e.accepts])).toEqual([
      ["documents", true],
      ["schema", true],
      ["distribution", true],
      ["document", true],
      ["timeseries", false],
      ["stat", false],
      ["bar", false],
      ["table", false],
    ]);
    expect(
      suggestPanel([
        { shape: "documents", documents: { documents: [{ a: 1 }], schema: [], notices: [] } },
      ]),
    ).toBe("documents");
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
    expect(cells(1)).toEqual([BIG_SHOWN, "Ada", "1.5"]);
    expect(cells(2)).toEqual(["2", "", ""]);
    expect(cells(3)).toEqual(["", "Grace", "3"]);
    expect(formatValue("int64", "123456789012345678901234567890", "en")).toBe(
      "123,456,789,012,345,678,901,234,567,890",
    );
    expect(formatValue("int64", "-1234567", "de")).toBe("-1.234.567");
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
    expect(firstColumn()).toEqual(["-5", "2", BIG_SHOWN, ""]);
    await user.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(firstColumn()).toEqual([BIG_SHOWN, "2", "-5", ""]);
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
    expect(screen.getByText(BIG_SHOWN).textContent).toBe(`${BIG_SHOWN} B`);
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
    expect(screen.getByRole("group", { name: "Panel" })).toBeTruthy();
  });

  it("names series from a legend template, and keeps Prometheus field names as they are", () => {
    const frame: Frame = {
      fields: [
        { name: "time", type: "time", values: [0, 100_000] },
        {
          name: 'up{job="api"}',
          type: "number",
          values: [1, 1],
          labels: { job: "api", instance: "a:9" },
        },
      ],
    };
    const { unmount } = renderPanel("timeseries", [frame]);
    expect(screen.getByText('up{job="api"}')).toBeTruthy();
    unmount();
    renderPanel("timeseries", [frame], { legend: "{{job}} on {{instance}}" });
    expect(screen.getByText("api on a:9")).toBeTruthy();
  });

  it("clears the keyboard readout on Escape before a dialog around it closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const plugin = getPanel("timeseries") as AnyPanelPlugin;
    const { Panel } = plugin;
    const frame: Frame = {
      fields: [
        { name: "time", type: "time", values: [0, 100_000] },
        { name: "load", type: "number", values: [1, 3] },
      ],
    };
    render(
      <Dialog title="Edit panel" onClose={onClose}>
        <Panel frames={[frame]} options={plugin.options({})} timeRange={RANGE} title="Panel" />
      </Dialog>,
    );
    const plot = screen.getByRole("group", { name: "Panel" });
    plot.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("status").textContent).toContain("load:");
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not fill the live region while the pointer hovers", () => {
    const frame: Frame = {
      fields: [
        { name: "time", type: "time", values: [0, 100_000] },
        { name: "load", type: "number", values: [1, 3] },
      ],
    };
    renderPanel("timeseries", [frame]);
    const plot = screen.getByRole("group", { name: "Panel" });
    fireEvent.pointerMove(plot, { clientX: 200 });
    // The tooltip shows the values; the screen reader is not told about every hover.
    expect(document.querySelector(".ts__tooltip")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("reads out the values at the cursor by keyboard", async () => {
    const user = userEvent.setup();
    const frame: Frame = {
      fields: [
        { name: "time", type: "time", values: [0, 50_000, 100_000] },
        { name: "load", type: "number", values: [1, 2, 3] },
      ],
    };
    renderPanel("timeseries", [frame], { unit: "%" });
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Panel" }));
    // Focus puts the cursor in the middle of the range.
    expect(screen.getByRole("status").textContent).toContain("load: 2 %");
    await user.keyboard("{End}");
    expect(screen.getByRole("status").textContent).toContain("load: 3 %");
  });

  it("explains a result without time", () => {
    renderPanel("timeseries", [tableFrame]);
    expect(screen.getByText(/No time series in the result/)).toBeTruthy();
  });

  it.each(["timeseries", "bar", "stat"])(
    "says a %s panel got no rows rather than blaming the field types",
    (type) => {
      // An empty SQLite result has no value to tell a REAL column's type by; it arrives as text.
      renderPanel(type, [
        {
          fields: [
            { name: "time", type: "time", values: [] },
            { name: "amount", type: "string", values: [] },
          ],
        },
      ]);
      expect(screen.getByText("The query returned no data.")).toBeTruthy();
    },
  );
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

  it("reduces 100,000 values for a stat without spreading them into arguments", () => {
    const values = Array.from({ length: POINTS }, (_, i) => (i * 7919) % 100_003);
    const field: Field = { name: "v", type: "number", values };
    let max: unknown;
    const ms = minOf(5, () => {
      max = reduceField(field, "max").value;
    });
    process.stdout.write(`stat: 100k values reduced in ${ms.toFixed(1)} ms\n`);
    expect(max).toBe(values.reduce((a, b) => (b > a ? b : a), 0));
    expect(ms).toBeLessThan(CI ? 60 : 25);
  });

  it("sorts 100,000 int64 rows within budget", () => {
    const frame: Frame = {
      fields: [
        {
          name: "n",
          type: "int64",
          values: Array.from({ length: POINTS }, (_, i) =>
            String(BigInt(i * 7919) * 10_000_000_000n),
          ),
        },
      ],
    };
    let order: Uint32Array = new Uint32Array();
    const ms = minOf(3, () => {
      order = sortedRows(frame, { column: 0, direction: "descending" });
    });
    process.stdout.write(`table: 100k int64 rows sorted in ${ms.toFixed(1)} ms\n`);
    expect(order[0]).toBe(POINTS - 1);
    expect(ms).toBeLessThan(CI ? 600 : 250);
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
