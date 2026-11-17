import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANCHOR_GAP_PX,
  type Box,
  CONTROL_GAP_PX,
  POINTER_GAP_PX,
  type PointAnchor,
  placeTooltip,
  tooltipRoom,
  VIEWPORT_MARGIN_PX,
  visibleBox,
} from "./tooltipPlace";

const VIEWPORT = { width: 1000, height: 600 };
const SIZE = { width: 200, height: 100 };

function at(x: number, y: number): PointAnchor {
  return { x, y, gapX: POINTER_GAP_PX, gapY: POINTER_GAP_PX };
}

/** Beside a line at `x`, at the top of the chart box it has to stay in. */
function line(x: number, within: Box): PointAnchor {
  return { x, y: within.top, gapX: ANCHOR_GAP_PX, gapY: ANCHOR_GAP_PX, within };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("a tooltip at the pointer", () => {
  it("opens below and after the point when there is room", () => {
    expect(placeTooltip(at(100, 100), SIZE, VIEWPORT)).toEqual({
      left: 100 + POINTER_GAP_PX,
      top: 100 + POINTER_GAP_PX,
    });
  });

  it("flips to the other side at the right and bottom edges", () => {
    expect(placeTooltip(at(950, 580), SIZE, VIEWPORT)).toEqual({
      left: 950 - POINTER_GAP_PX - SIZE.width,
      top: 580 - POINTER_GAP_PX - SIZE.height,
    });
  });

  it("flips each axis on its own", () => {
    expect(placeTooltip(at(950, 100), SIZE, VIEWPORT)).toEqual({
      left: 950 - POINTER_GAP_PX - SIZE.width,
      top: 100 + POINTER_GAP_PX,
    });
    expect(placeTooltip(at(100, 580), SIZE, VIEWPORT)).toEqual({
      left: 100 + POINTER_GAP_PX,
      top: 580 - POINTER_GAP_PX - SIZE.height,
    });
  });

  it("shifts back inside when neither side has the room", () => {
    // A phone: the tooltip is wider than either side of the pointer.
    const phone = { width: 360, height: 150 };
    expect(placeTooltip(at(200, 80), SIZE, phone)).toEqual({
      left: phone.width - VIEWPORT_MARGIN_PX - SIZE.width,
      top: phone.height - VIEWPORT_MARGIN_PX - SIZE.height,
    });
  });

  it("keeps the start on screen when the tooltip is larger than the viewport", () => {
    const large = { width: 500, height: 400 };
    expect(placeTooltip(at(50, 50), large, { width: 300, height: 200 })).toEqual({
      left: VIEWPORT_MARGIN_PX,
      top: VIEWPORT_MARGIN_PX,
    });
  });

  it("stays inside the viewport wherever the point is", () => {
    for (let x = -50; x <= VIEWPORT.width + 50; x += 25) {
      for (let y = -50; y <= VIEWPORT.height + 50; y += 25) {
        const placed = placeTooltip(at(x, y), SIZE, VIEWPORT);
        expect(placed).not.toBeNull();
        const { left, top } = placed ?? { left: Number.NaN, top: Number.NaN };
        expect(left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX);
        expect(top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX);
        expect(left + SIZE.width).toBeLessThanOrEqual(VIEWPORT.width - VIEWPORT_MARGIN_PX);
        expect(top + SIZE.height).toBeLessThanOrEqual(VIEWPORT.height - VIEWPORT_MARGIN_PX);
      }
    }
  });

  it("never covers the point it belongs to when a side has room", () => {
    for (const [x, y] of [
      [10, 10],
      [990, 10],
      [10, 590],
      [990, 590],
      [500, 300],
    ] as const) {
      const placed = placeTooltip(at(x, y), SIZE, VIEWPORT);
      const { left, top } = placed ?? { left: Number.NaN, top: Number.NaN };
      const covers = x >= left && x <= left + SIZE.width && y >= top && y <= top + SIZE.height;
      expect(covers, `${x},${y}`).toBe(false);
    }
  });

  it("is as wide as the tooltip width allows, not held to a chart", () => {
    expect(tooltipRoom(at(10, 10))).toBeNull();
    expect(tooltipRoom(null)).toBeNull();
  });
});

describe("a tooltip beside a line or in a corner of a chart", () => {
  const CHART: Box = { left: 300, top: 200, right: 700, bottom: 400 };

  it("sits beside the line at the top of the chart", () => {
    expect(placeTooltip(line(400, CHART), SIZE, VIEWPORT)).toEqual({
      left: 400 + ANCHOR_GAP_PX,
      top: CHART.top + ANCHOR_GAP_PX,
    });
  });

  it("goes to the line's other side at the chart's edge, not out of the chart", () => {
    expect(placeTooltip(line(650, CHART), SIZE, VIEWPORT)).toEqual({
      left: 650 - ANCHOR_GAP_PX - SIZE.width,
      top: CHART.top + ANCHOR_GAP_PX,
    });
  });

  it("never opens upwards, over the panel in the row above", () => {
    // What shows of the chart ends just under the tooltip's height: the last rows of a window.
    const low: Box = { left: 300, top: 480, right: 700, bottom: 585 };
    const placed = placeTooltip(line(400, low), SIZE, { width: 1000, height: 600 });
    // Pushed up against the bottom of its own chart at most, never above the chart's top.
    expect(placed).toEqual({ left: 400 + ANCHOR_GAP_PX, top: 485 });
    expect(placed?.top).toBeGreaterThanOrEqual(low.top);
  });

  it("is not shown when what shows of the chart is lower than the tooltip", () => {
    // Half under the sticky toolbar, or cut by the window's bottom edge.
    const sliver: Box = { left: 300, top: 520, right: 700, bottom: 600 };
    expect(placeTooltip(line(400, sliver), SIZE, VIEWPORT)).toBeNull();
  });

  it("is not shown when the chart is narrower than the tooltip", () => {
    const narrow: Box = { left: 300, top: 200, right: 450, bottom: 400 };
    expect(placeTooltip(line(350, narrow), SIZE, VIEWPORT)).toBeNull();
  });

  it("stays inside the chart wherever the line is", () => {
    for (let x = CHART.left; x <= CHART.right; x += 10) {
      const placed = placeTooltip(line(x, CHART), SIZE, VIEWPORT);
      expect(placed).not.toBeNull();
      const { left, top } = placed ?? { left: Number.NaN, top: Number.NaN };
      expect(left).toBeGreaterThanOrEqual(CHART.left);
      expect(left + SIZE.width).toBeLessThanOrEqual(CHART.right);
      expect(top).toBeGreaterThanOrEqual(CHART.top);
      expect(top + SIZE.height).toBeLessThanOrEqual(CHART.bottom);
    }
  });

  it("takes the corner itself for the keyboard's readout", () => {
    const corner: PointAnchor = { x: CHART.left, y: CHART.top, gapX: 0, gapY: 0, within: CHART };
    expect(placeTooltip(corner, SIZE, VIEWPORT)).toEqual({ left: CHART.left, top: CHART.top });
  });

  it("is as wide as its chart at most", () => {
    expect(tooltipRoom(line(400, CHART))).toBe(400);
    expect(tooltipRoom(line(310, { ...CHART, right: 420.6 }))).toBe(120);
  });
});

describe("a tooltip of a control", () => {
  const BUTTON: Box = { left: 500, top: 20, right: 532, bottom: 52 };
  const TIP = { width: 120, height: 24 };

  it("sits under the control, lined up with its end", () => {
    const placed = placeTooltip({ control: BUTTON, side: "below", align: "end" }, TIP, VIEWPORT);
    expect(placed).toEqual({ left: BUTTON.right - TIP.width, top: BUTTON.bottom + CONTROL_GAP_PX });
  });

  it("lines up with the control's start when asked", () => {
    const placed = placeTooltip({ control: BUTTON, side: "below", align: "start" }, TIP, VIEWPORT);
    expect(placed).toEqual({ left: BUTTON.left, top: BUTTON.bottom + CONTROL_GAP_PX });
  });

  it("shifts inside at the window's side edges", () => {
    const first: Box = { left: 8, top: 20, right: 40, bottom: 52 };
    const last: Box = { left: 960, top: 20, right: 992, bottom: 52 };
    expect(placeTooltip({ control: first, side: "below", align: "end" }, TIP, VIEWPORT)?.left).toBe(
      VIEWPORT_MARGIN_PX,
    );
    expect(
      placeTooltip({ control: last, side: "below", align: "start" }, TIP, VIEWPORT)?.left,
    ).toBe(VIEWPORT.width - VIEWPORT_MARGIN_PX - TIP.width);
  });

  it("opens above a control at the bottom of the window", () => {
    const low: Box = { left: 500, top: 560, right: 532, bottom: 592 };
    expect(placeTooltip({ control: low, side: "below", align: "end" }, TIP, VIEWPORT)?.top).toBe(
      low.top - CONTROL_GAP_PX - TIP.height,
    );
  });

  it("opens before a control on a rail at the window's edge, level with its middle", () => {
    const rail: Box = { left: 960, top: 100, right: 992, bottom: 132 };
    expect(placeTooltip({ control: rail, side: "before", align: "end" }, TIP, VIEWPORT)).toEqual({
      left: rail.left - ANCHOR_GAP_PX - TIP.width,
      top: 116 - TIP.height / 2,
    });
    // Without room before it, after it.
    const start: Box = { left: 8, top: 100, right: 40, bottom: 132 };
    expect(
      placeTooltip({ control: start, side: "before", align: "end" }, TIP, VIEWPORT)?.left,
    ).toBe(start.right + ANCHOR_GAP_PX);
  });
});

describe("the visible part of an element", () => {
  function boxed(element: Element, left: number, top: number, width: number, height: number) {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
      new DOMRect(left, top, width, height),
    );
  }

  function scrolling(overflow: string) {
    const scroller = document.createElement("div");
    scroller.style.overflowX = overflow;
    scroller.style.overflowY = overflow;
    const chart = document.createElement("div");
    scroller.append(chart);
    document.body.append(scroller);
    return { scroller, chart };
  }

  it("is cut by scrolling ancestors and by the viewport", () => {
    const { scroller, chart } = scrolling("auto");
    boxed(scroller, 100, 100, 400, 300);
    // Scrolled half out at the top of its scroll box.
    boxed(chart, 120, 20, 300, 200);
    expect(visibleBox(chart)).toEqual({ left: 120, top: 100, right: 420, bottom: 220 });
  });

  it("is nothing when the element is scrolled away", () => {
    const { scroller, chart } = scrolling("hidden");
    boxed(scroller, 0, 100, 400, 300);
    boxed(chart, 0, -500, 300, 200);
    expect(visibleBox(chart)).toBeNull();
  });

  it("starts under the sticky bars the element has scrolled under", () => {
    const top = document.createElement("div");
    top.className = "top-bar";
    const toolbar = document.createElement("div");
    toolbar.className = "dash-toolbar";
    const chart = document.createElement("div");
    document.body.append(top, toolbar, chart);
    boxed(top, 0, 0, 1024, 48);
    boxed(toolbar, 0, 48, 1024, 56);
    // Half of the chart is under the two bars.
    boxed(chart, 100, 20, 400, 300);
    expect(visibleBox(chart)).toEqual({ left: 100, top: 104, right: 500, bottom: 320 });
    // Below the bars nothing is cut.
    boxed(chart, 100, 200, 400, 300);
    expect(visibleBox(chart)).toEqual({ left: 100, top: 200, right: 500, bottom: 500 });
    // All of it under the bars: nothing shows.
    boxed(chart, 100, 10, 400, 80);
    expect(visibleBox(chart)).toBeNull();
  });

  it("leaves a control of a bar itself alone", () => {
    const toolbar = document.createElement("div");
    toolbar.className = "dash-toolbar";
    const button = document.createElement("button");
    toolbar.append(button);
    document.body.append(toolbar);
    boxed(toolbar, 0, 48, 1024, 56);
    boxed(button, 900, 60, 32, 32);
    expect(visibleBox(button)).toEqual({ left: 900, top: 60, right: 932, bottom: 92 });
  });

  it("finds the clipping ancestors once per element, not on every move", () => {
    const { scroller, chart } = scrolling("auto");
    boxed(scroller, 0, 0, 400, 300);
    boxed(chart, 0, 0, 300, 200);
    const computed = vi.spyOn(window, "getComputedStyle");
    visibleBox(chart);
    const first = computed.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    for (let move = 0; move < 20; move++) {
      visibleBox(chart);
    }
    expect(computed.mock.calls.length).toBe(first);
    // A resized window may clip differently: they are looked up again.
    window.dispatchEvent(new Event("resize"));
    visibleBox(chart);
    expect(computed.mock.calls.length).toBeGreaterThan(first);
  });
});
