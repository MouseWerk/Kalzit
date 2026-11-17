import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POINTER_GAP_PX, VIEWPORT_MARGIN_PX } from "../lib/tooltipPlace";
import { parseCss } from "../test/cssParse";
import { Readout, type ReadoutItem } from "./readout";

/**
 * Hover tooltips lie above everything (issue 321): a panel's tooltip is not part of the panel,
 * so the panel's edge cannot clip it and no neighbour, sticky heading or bar can cover it. The
 * scene is a dashboard in small: the toolbar, a chart panel that clips what sticks out, and a
 * table with a sticky heading beside it. jsdom lays nothing out, so the boxes are given.
 */

const VIEWPORT = { width: 1024, height: 768 };
const TOOLBAR = new DOMRect(0, 0, 1024, 56);
const PANEL = new DOMRect(16, 60, 400, 300);
const TABLE = new DOMRect(424, 60, 400, 300);
const TIP = { width: 180, height: 80 };

const ITEMS: ReadoutItem[] = [
  { label: "North", rows: [{ name: "Sales", value: "12", colorClass: "series-1" }] },
  { label: "South", rows: [{ name: "Sales", value: "7", colorClass: "series-2" }] },
];

function scene(chart: DOMRect = PANEL) {
  // Every element reports the box of the part of the scene it stands for.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.matches(".readout__tooltip")) {
      const left = Number.parseFloat(this.style.left) || 0;
      const top = Number.parseFloat(this.style.top) || 0;
      return new DOMRect(left, top, TIP.width, TIP.height);
    }
    if (this.matches(".dash-toolbar")) return TOOLBAR;
    if (this.matches(".vt__head, table, .table-card")) return TABLE;
    if (this.matches(".panel-card, .readout")) return chart;
    return new DOMRect(0, 0, VIEWPORT.width, VIEWPORT.height);
  });
  const rendered = render(
    <>
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
  const hoverAt = (x: number, y: number) => {
    fireEvent.pointerEnter(screen.getByRole("button", { name: "North" }));
    fireEvent.pointerMove(chartBox, { clientX: x, clientY: y });
    return document.querySelector<HTMLElement>(".readout__tooltip");
  };
  return { ...rendered, chartBox, panel, hoverAt };
}

function box(tip: HTMLElement | null) {
  const left = Number.parseFloat(tip?.style.left ?? "");
  const top = Number.parseFloat(tip?.style.top ?? "");
  return { left, top, right: left + TIP.width, bottom: top + TIP.height };
}

function insideViewport(tip: HTMLElement | null) {
  const { left, top, right, bottom } = box(tip);
  expect(left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX);
  expect(top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX);
  expect(right).toBeLessThanOrEqual(VIEWPORT.width - VIEWPORT_MARGIN_PX);
  expect(bottom).toBeLessThanOrEqual(VIEWPORT.height - VIEWPORT_MARGIN_PX);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a panel's hover tooltip", () => {
  it("is not part of the panel, so the panel cannot clip it at its edge", () => {
    const { panel, hoverAt } = scene();
    // The right edge of the chart panel, next to the table's sticky heading.
    const tip = hoverAt(PANEL.right - 6, 200);
    expect(tip).not.toBeNull();
    expect(tip?.textContent).toContain("North");
    expect(panel.contains(tip)).toBe(false);
    // At the end of the body: no clipping box and no stacking context of the page around it.
    expect(tip?.parentElement).toBe(document.body);
    expect(tip?.classList.contains("floating-tooltip")).toBe(true);
    expect(tip?.hasAttribute("data-placed")).toBe(true);
    // Beside the pointer, reaching out of the panel over the neighbouring table: all of it shows.
    const placed = box(tip);
    expect(placed.left).toBe(PANEL.right - 6 + POINTER_GAP_PX);
    expect(placed.top).toBe(200 + POINTER_GAP_PX);
    expect(placed.right).toBeGreaterThan(PANEL.right);
    expect(placed.right).toBeGreaterThan(TABLE.left);
    insideViewport(tip);
  });

  it("stays whole at the top of a panel right under the toolbar", () => {
    const { panel, hoverAt } = scene();
    const tip = hoverAt(PANEL.left + 4, PANEL.top + 2);
    expect(panel.contains(tip)).toBe(false);
    const placed = box(tip);
    expect(placed.left).toBe(PANEL.left + 4 + POINTER_GAP_PX);
    expect(placed.top).toBe(PANEL.top + 2 + POINTER_GAP_PX);
    insideViewport(tip);
  });

  it("flips at the viewport's right and bottom edges instead of leaving it", () => {
    // A panel in the bottom right corner of the window.
    const corner = new DOMRect(VIEWPORT.width - 416, VIEWPORT.height - 316, 400, 300);
    const { hoverAt } = scene(corner);
    const x = corner.right - 10;
    const y = corner.bottom - 10;
    const tip = hoverAt(x, y);
    const placed = box(tip);
    expect(placed.right).toBe(x - POINTER_GAP_PX);
    expect(placed.bottom).toBe(y - POINTER_GAP_PX);
    insideViewport(tip);
  });

  it("follows the pointer without the chart drawing again", () => {
    const { chartBox, hoverAt } = scene();
    const tip = hoverAt(100, 100);
    expect(box(tip).left).toBe(100 + POINTER_GAP_PX);
    fireEvent.pointerMove(chartBox, { clientX: 300, clientY: 250 });
    expect(document.querySelector(".readout__tooltip")).toBe(tip);
    expect(box(tip)).toMatchObject({ left: 300 + POINTER_GAP_PX, top: 250 + POINTER_GAP_PX });
  });

  it("sits in the corner of the chart for the keyboard and goes with the pointer", () => {
    const { chartBox } = scene();
    chartBox.focus();
    fireEvent.keyDown(chartBox, { key: "ArrowRight" });
    const tip = document.querySelector<HTMLElement>(".readout__tooltip");
    expect(tip?.parentElement).toBe(document.body);
    expect(box(tip)).toMatchObject({ left: PANEL.left, top: PANEL.top });
    fireEvent.blur(chartBox);
    expect(document.querySelector(".readout__tooltip")).toBeNull();
  });

  it("is gone with the pointer and with the panel", () => {
    const { chartBox, hoverAt, unmount } = scene();
    expect(hoverAt(100, 100)).not.toBeNull();
    fireEvent.pointerLeave(chartBox);
    expect(document.querySelector(".readout__tooltip")).toBeNull();
    expect(hoverAt(100, 100)).not.toBeNull();
    unmount();
    expect(document.querySelector(".readout__tooltip")).toBeNull();
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
  });

  it("leaves place and layer of the panel tooltips to the floating tooltip", () => {
    for (const [file, selector] of [
      ["panels/viz.css", ".readout__tooltip"],
      ["panels/panels.css", ".ts__tooltip"],
    ] as const) {
      const properties = declared(file, selector).map((d) => d.property);
      expect(properties.length, selector).toBeGreaterThan(0);
      for (const property of ["position", "z-index", "transform", "inset-block-start", "top"]) {
        expect(properties, `${selector} ${property}`).not.toContain(property);
      }
    }
    // No rule places a tooltip relative to its chart any more.
    for (const file of ["panels/viz.css", "panels/panels.css"]) {
      const placedInside = rules(file).filter(
        (rule) =>
          /__tooltip(?![\w-])/.test(rule.selector) &&
          rule.declarations.some((d) => d.property === "position" || d.property === "z-index"),
      );
      expect(placedInside.map((rule) => rule.selector)).toEqual([]);
    }
  });

  it("puts the other tooltips on the same layer", () => {
    const z = (file: string, selector: string) =>
      declared(file, selector).find((d) => d.property === "z-index")?.value;
    expect(z("styles/components.css", ".rail-tooltip")).toBe("var(--z-tooltip)");
    expect(z("components/iconButton.css", ".tip")).toBe("var(--z-tooltip)");
  });
});
