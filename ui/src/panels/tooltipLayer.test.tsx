import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANCHOR_GAP_PX, POINTER_GAP_PX, VIEWPORT_MARGIN_PX } from "../lib/tooltipPlace";
import { parseCss } from "../test/cssParse";
import { CrosshairContext, createCrosshair } from "./crosshair";
import { DEFAULT_LEGEND } from "./fieldConfig/legendOptions";
import { Readout, type ReadoutItem } from "./readout";
import type { Series } from "./timeseries/series";
import { resolveStyles } from "./timeseries/styles";
import { UplotTimeSeriesChart } from "./timeseries/UplotTimeSeriesChart";

/**
 * Hover tooltips lie above everything (issue 321): a panel's tooltip is not part of the panel,
 * so the panel's edge cannot clip it and no neighbour, sticky heading or bar can cover it. The
 * tooltip at the pointer floats freely; a tooltip that belongs to a line or corner of a chart
 * (the keyboard's readout, the time another panel points at) stays inside what shows of that
 * chart. The scenes are a dashboard in small; jsdom lays nothing out, so the boxes are given.
 */

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

const VIEWPORT = { width: 1024, height: 768 };
const TOP_BAR = new DOMRect(0, 0, 1024, 48);
const TOOLBAR = new DOMRect(0, 48, 1024, 56);
const BARS_END = TOOLBAR.bottom;
const PANEL = new DOMRect(16, 120, 400, 300);
const TABLE = new DOMRect(424, 120, 400, 300);
const TIP = { width: 180, height: 80 };

/** The box of every part of a scene, by what the element is; anything else fills the window. */
function layOut(boxOf: (element: HTMLElement) => DOMRect | undefined) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.matches(".floating-tooltip")) {
      const left = Number.parseFloat(this.style.left) || 0;
      const top = Number.parseFloat(this.style.top) || 0;
      return new DOMRect(left, top, TIP.width, TIP.height);
    }
    if (this.matches(".top-bar")) return TOP_BAR;
    if (this.matches(".dash-toolbar")) return TOOLBAR;
    return boxOf(this) ?? new DOMRect(0, 0, VIEWPORT.width, VIEWPORT.height);
  });
}

/** Tooltips are placed together right after what asked for it; the next turn has them. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

function box(tip: Element | null | undefined) {
  const style = (tip as HTMLElement | null | undefined)?.style;
  const left = Number.parseFloat(style?.left ?? "");
  const top = Number.parseFloat(style?.top ?? "");
  return { left, top, right: left + TIP.width, bottom: top + TIP.height };
}

function insideViewport(tip: Element | null | undefined) {
  const { left, top, right, bottom } = box(tip);
  expect(left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX);
  expect(top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX);
  expect(right).toBeLessThanOrEqual(VIEWPORT.width - VIEWPORT_MARGIN_PX);
  expect(bottom).toBeLessThanOrEqual(VIEWPORT.height - VIEWPORT_MARGIN_PX);
}

function insideBox(tip: Element | null | undefined, within: DOMRect) {
  const { left, top, right, bottom } = box(tip);
  expect(left).toBeGreaterThanOrEqual(within.left);
  expect(top).toBeGreaterThanOrEqual(within.top);
  expect(right).toBeLessThanOrEqual(within.right);
  expect(bottom).toBeLessThanOrEqual(within.bottom);
}

const shown = (tip: Element | null | undefined) => tip?.hasAttribute("data-placed") === true;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a panel's hover tooltip", () => {
  const ITEMS: ReadoutItem[] = [
    { label: "North", rows: [{ name: "Sales", value: "12", colorClass: "series-1" }] },
    { label: "South", rows: [{ name: "Sales", value: "7", colorClass: "series-2" }] },
  ];

  /** The bars, a chart panel that clips what sticks out, and a table with a sticky heading. */
  function scene(chart: DOMRect = PANEL) {
    layOut((element) => {
      if (element.matches(".vt__head, table, .table-card")) return TABLE;
      if (element.matches(".panel-card, .readout")) return chart;
      return undefined;
    });
    const rendered = render(
      <>
        <div className="top-bar">Top bar</div>
        <div className="dash-toolbar">Toolbar</div>
        <article className="panel-card">
          <Readout title="Sales by region" items={ITEMS} tooltip="all">
            {(_active, hover) => (
              <button
                type="button"
                onPointerEnter={() => hover(0)}
                onPointerLeave={() => hover(null)}
              >
                North
              </button>
            )}
          </Readout>
        </article>
        <article className="panel-card table-card">
          <table>
            <thead>
              <tr>
                <th className="vt__head">Region</th>
              </tr>
            </thead>
          </table>
        </article>
      </>,
    );
    const chartBox = screen.getByRole("group", { name: "Sales by region" });
    const panel = chartBox.closest(".panel-card") as HTMLElement;
    // The chart panel clips what sticks out of it, as the dashboard's cards do.
    panel.style.overflowX = "hidden";
    panel.style.overflowY = "hidden";
    const tip = () => document.querySelector<HTMLElement>(".readout__tooltip");
    const hoverAt = async (x: number, y: number) => {
      fireEvent.pointerEnter(screen.getByRole("button", { name: "North" }));
      fireEvent.pointerMove(chartBox, { clientX: x, clientY: y });
      await settle();
      return tip();
    };
    const byKeyboard = async () => {
      chartBox.focus();
      fireEvent.keyDown(chartBox, { key: "ArrowRight" });
      await settle();
      return tip();
    };
    return { ...rendered, chartBox, panel, hoverAt, byKeyboard, tip };
  }

  it("is not part of the panel, so the panel cannot clip it at its edge", async () => {
    const { panel, hoverAt } = scene();
    // The right edge of the chart panel, next to the table's sticky heading.
    const tip = await hoverAt(PANEL.right - 6, 200);
    expect(tip?.textContent).toContain("North");
    expect(panel.contains(tip)).toBe(false);
    // At the end of the body: no clipping box and no stacking context of the page around it.
    expect(tip?.parentElement).toBe(document.body);
    expect(tip?.classList.contains("floating-tooltip")).toBe(true);
    expect(shown(tip)).toBe(true);
    // Beside the pointer, reaching out of the panel over the neighbouring table: all of it shows.
    const placed = box(tip);
    expect(placed.left).toBe(PANEL.right - 6 + POINTER_GAP_PX);
    expect(placed.top).toBe(200 + POINTER_GAP_PX);
    expect(placed.right).toBeGreaterThan(TABLE.left);
    // The pointer's tooltip is not held to its chart's width.
    expect(tip?.style.getPropertyValue("--tooltip-room")).toBe("");
    insideViewport(tip);
  });

  it("stays whole at the top of a panel right under the toolbar", async () => {
    const { panel, hoverAt } = scene();
    const tip = await hoverAt(PANEL.left + 4, PANEL.top + 2);
    expect(panel.contains(tip)).toBe(false);
    expect(box(tip)).toMatchObject({
      left: PANEL.left + 4 + POINTER_GAP_PX,
      top: PANEL.top + 2 + POINTER_GAP_PX,
    });
    insideViewport(tip);
  });

  it("flips at the viewport's right and bottom edges instead of leaving it", async () => {
    // A panel in the bottom right corner of the window.
    const corner = new DOMRect(VIEWPORT.width - 416, VIEWPORT.height - 316, 400, 300);
    const { hoverAt } = scene(corner);
    const x = corner.right - 10;
    const y = corner.bottom - 10;
    const tip = await hoverAt(x, y);
    expect(box(tip)).toMatchObject({ right: x - POINTER_GAP_PX, bottom: y - POINTER_GAP_PX });
    insideViewport(tip);
  });

  it("follows the pointer without the chart drawing again", async () => {
    const { chartBox, hoverAt, tip } = scene();
    const first = await hoverAt(100, 200);
    expect(box(first).left).toBe(100 + POINTER_GAP_PX);
    fireEvent.pointerMove(chartBox, { clientX: 300, clientY: 250 });
    await settle();
    expect(tip()).toBe(first);
    expect(box(first)).toMatchObject({ left: 300 + POINTER_GAP_PX, top: 250 + POINTER_GAP_PX });
  });

  it("sits in the corner of the chart for the keyboard and goes with the focus", async () => {
    const { chartBox, byKeyboard, tip } = scene();
    const placed = await byKeyboard();
    expect(placed?.parentElement).toBe(document.body);
    expect(shown(placed)).toBe(true);
    expect(box(placed)).toMatchObject({ left: PANEL.left, top: PANEL.top });
    insideBox(placed, PANEL);
    fireEvent.blur(chartBox);
    expect(tip()).toBeNull();
  });

  it("starts below the sticky bars for the keyboard when the chart is half under them", async () => {
    const under = new DOMRect(16, 20, 400, 300);
    const { byKeyboard } = scene(under);
    const placed = await byKeyboard();
    expect(shown(placed)).toBe(true);
    // Not in the chart's own corner, which is under the toolbar, but right below the bars.
    expect(box(placed)).toMatchObject({ left: under.left, top: BARS_END });
  });

  it("is not shown for the keyboard where it would have to leave what shows of the chart", async () => {
    // Only a strip of the chart shows below the bars: lower than the tooltip.
    const strip = new DOMRect(16, BARS_END + 40 - 300, 400, 300);
    expect(shown(await scene(strip).byKeyboard())).toBe(false);
  });

  it("does not open upwards for the keyboard at the bottom of the window", async () => {
    // The chart's last 60 px are in the window: the tooltip would only fit above the chart.
    const low = new DOMRect(16, VIEWPORT.height - 60, 400, 300);
    const { byKeyboard } = scene(low);
    const placed = await byKeyboard();
    expect(shown(placed)).toBe(false);
  });

  it("is gone with the pointer and with the panel", async () => {
    const { chartBox, hoverAt, tip, unmount } = scene();
    expect(await hoverAt(100, 200)).not.toBeNull();
    fireEvent.pointerLeave(chartBox);
    expect(tip()).toBeNull();
    expect(await hoverAt(100, 200)).not.toBeNull();
    unmount();
    expect(tip()).toBeNull();
  });
});

/** A time series panel's chart with one series, named after the panel. */
function Chart({ title }: { title: string }) {
  const drawn: Series[] = [
    {
      name: title.toLowerCase(),
      times: Float64Array.from([0, 50_000, 100_000]),
      values: Float64Array.from([1, 2, 3]),
    },
  ];
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

describe("the tooltips of a shared cursor", () => {
  const ORDERS = new DOMRect(16, 120, 600, 250);

  /**
   * Two time series panels with a shared cursor that shows values; "Orders" is hovered at
   * x = 300 px of its plot, which is the same time 300 px into the plot of "Revenue".
   */
  async function scene(revenue: DOMRect) {
    layOut((element) => {
      if (!element.matches(".ts__plot")) return undefined;
      return element.getAttribute("aria-label") === "Revenue" ? revenue : ORDERS;
    });
    const store = createCrosshair("tooltip");
    render(
      <CrosshairContext value={store}>
        <div className="top-bar">Top bar</div>
        <div className="dash-toolbar">Toolbar</div>
        <Chart title="Orders" />
        <Chart title="Revenue" />
      </CrosshairContext>,
    );
    const orders = screen.getByRole("group", { name: "Orders" });
    const pointer = { x: ORDERS.left + 300, y: ORDERS.top + 100 };
    fireEvent.pointerMove(orders, { clientX: pointer.x, clientY: pointer.y });
    act(() => store.flush());
    await settle();
    const tips = [...document.querySelectorAll<HTMLElement>(".ts__tooltip")];
    expect(tips).toHaveLength(2);
    return {
      pointer,
      own: tips.find((tip) => tip.textContent?.includes("orders")),
      other: tips.find((tip) => tip.textContent?.includes("revenue")),
    };
  }

  it("lets only the hovered chart's tooltip float freely, at the pointer", async () => {
    const { own, other, pointer } = await scene(new DOMRect(16, 400, 600, 250));
    expect(shown(own)).toBe(true);
    expect(box(own)).toMatchObject({
      left: pointer.x + POINTER_GAP_PX,
      top: pointer.y + POINTER_GAP_PX,
    });
    expect(own?.style.getPropertyValue("--tooltip-room")).toBe("");
    // The other panel's stands beside its cursor line at the top of its plot, inside the plot.
    const revenue = new DOMRect(16, 400, 600, 250);
    expect(shown(other)).toBe(true);
    expect(box(other)).toMatchObject({
      left: revenue.left + 300 + ANCHOR_GAP_PX,
      top: revenue.top + ANCHOR_GAP_PX,
    });
    insideBox(other, revenue);
  });

  it("keeps the other panel's tooltip below the sticky bars the panel is half under", async () => {
    const under = new DOMRect(16, 20, 600, 250);
    const { other } = await scene(under);
    expect(shown(other)).toBe(true);
    // Beside the part of the cursor line that shows, never over the toolbar or the top bar.
    expect(box(other).top).toBe(BARS_END + ANCHOR_GAP_PX);
    expect(box(other).top).toBeGreaterThanOrEqual(TOOLBAR.bottom);
    insideBox(other, new DOMRect(under.left, BARS_END, under.width, under.bottom - BARS_END));
  });

  it("shows no tooltip where the cursor line shows less than the tooltip's height", async () => {
    // 50 px of the plot show below the bars.
    const strip = new DOMRect(16, BARS_END + 50 - 250, 600, 250);
    const { own, other } = await scene(strip);
    expect(shown(other)).toBe(false);
    // The hovered chart's own tooltip is not affected.
    expect(shown(own)).toBe(true);
  });

  it("does not flip above its plot at the bottom of the window, onto the panel above", async () => {
    // The plot's first 120 px are in the window: room for the tooltip, pushed down at most.
    const low = new DOMRect(16, VIEWPORT.height - 120, 600, 250);
    const fits = await scene(low);
    expect(shown(fits.other)).toBe(true);
    expect(box(fits.other).top).toBe(low.top + ANCHOR_GAP_PX);
    expect(box(fits.other).bottom).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it("is not shown at the bottom of the window when it only fits above its plot", async () => {
    const cut = new DOMRect(16, VIEWPORT.height - 60, 600, 250);
    const { other } = await scene(cut);
    expect(shown(other)).toBe(false);
  });

  it("stays inside a narrow panel and is as wide as the panel at most", async () => {
    // The cursor line is 300 px into a plot of which 320 px show: a tooltip opening after the
    // line would reach over the neighbouring panel.
    const narrow = new DOMRect(400, 400, 320, 250);
    const { other } = await scene(narrow);
    expect(shown(other)).toBe(true);
    expect(other?.style.getPropertyValue("--tooltip-room")).toBe("320px");
    expect(box(other).right).toBe(narrow.left + 300 - ANCHOR_GAP_PX);
    insideBox(other, narrow);
  });

  it("is not shown in a panel narrower than the tooltip can get", async () => {
    // The stand-in tooltip keeps its 180 px however narrow the room is.
    const { other } = await scene(new DOMRect(400, 400, 150, 250));
    expect(shown(other)).toBe(false);
  });
});

describe("the tooltip layer", () => {
  const src = resolve(import.meta.dirname, "..");
  const rules = (file: string) => parseCss(readFileSync(resolve(src, file), "utf8"));
  const declared = (file: string, selector: string) =>
    rules(file)
      .filter((rule) => rule.selector.split(",").some((part) => part.trim() === selector))
      .flatMap((rule) => rule.declarations);
  const layer = (name: string) => {
    const found = declared("styles/tokens.css", ":root").find((d) => d.property === `--z-${name}`);
    return Number(found?.value);
  };

  it("lies above panels, sticky parts, bars, menus, dialogs and open lists, below toasts", () => {
    const tooltip = layer("tooltip");
    for (const below of [
      "base",
      "sticky-column",
      "sticky",
      "sticky-corner",
      "bar",
      "kiosk",
      "menu",
      "dialog",
      "popover",
    ]) {
      expect(tooltip, below).toBeGreaterThan(layer(below));
    }
    expect(tooltip).toBeLessThan(layer("toast"));
  });

  it("holds every floating tooltip: fixed in the viewport, never in the pointer's way", () => {
    const base = declared("components/floatingTooltip.css", ".floating-tooltip");
    const value = (property: string) => base.find((d) => d.property === property)?.value;
    expect(value("position")).toBe("fixed");
    expect(value("z-index")).toBe("var(--z-tooltip)");
    expect(value("pointer-events")).toBe("none");
    // As wide as the tooltip width, or as the chart it has to stay in.
    expect(value("max-width")).toBe("min(var(--size-tooltip-max), var(--tooltip-room, 100vw))");
  });

  it("leaves place, layer and width of every tooltip to the floating tooltip", () => {
    const placing = ["position", "z-index", "transform", "translate", "max-width", "top", "left"];
    for (const [file, selector] of [
      ["panels/viz.css", ".readout__tooltip"],
      ["panels/panels.css", ".ts__tooltip"],
      ["components/iconButton.css", ".tip"],
    ] as const) {
      const properties = declared(file, selector).map((d) => d.property);
      expect(properties.length, selector).toBeGreaterThan(0);
      for (const property of properties) {
        expect(
          placing.includes(property) || property.startsWith("inset"),
          `${selector} ${property}`,
        ).toBe(false);
      }
    }
    // No rule anywhere places one of them relative to its chart or control any more.
    const placed = [
      "panels/viz.css",
      "panels/panels.css",
      "components/iconButton.css",
      "features/dashboards/toolbar.css",
    ].flatMap((file) =>
      rules(file)
        .filter(
          (rule) =>
            /(__tooltip|\.tip)(?![\w-])/.test(rule.selector) &&
            rule.declarations.some((d) => placing.includes(d.property)),
        )
        .map((rule) => `${file}: ${rule.selector}`),
    );
    expect(placed).toEqual([]);
  });

  it("puts the rail's tooltip on the same layer", () => {
    const z = declared("styles/components.css", ".rail-tooltip").find(
      (d) => d.property === "z-index",
    );
    expect(z?.value).toBe("var(--z-tooltip)");
  });
});
