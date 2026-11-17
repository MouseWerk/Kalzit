import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POINTER_GAP_PX,
  placeTooltip,
  type TooltipAnchor,
  VIEWPORT_MARGIN_PX,
  visibleBox,
} from "./tooltipPlace";

const VIEWPORT = { width: 1000, height: 600 };
const SIZE = { width: 200, height: 100 };

function at(x: number, y: number): TooltipAnchor {
  return { x, y, gapX: POINTER_GAP_PX, gapY: POINTER_GAP_PX };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("tooltip placement", () => {
  it("opens below and after the point when there is room", () => {
    expect(placeTooltip(at(100, 100), SIZE, VIEWPORT)).toEqual({
      left: 100 + POINTER_GAP_PX,
      top: 100 + POINTER_GAP_PX,
    });
  });

  it("flips to the other side at the right and bottom edges", () => {
    const placed = placeTooltip(at(950, 580), SIZE, VIEWPORT);
    expect(placed).toEqual({
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
    const placed = placeTooltip(at(200, 80), SIZE, phone);
    expect(placed.left).toBe(phone.width - VIEWPORT_MARGIN_PX - SIZE.width);
    expect(placed.top).toBe(phone.height - VIEWPORT_MARGIN_PX - SIZE.height);
  });

  it("keeps the start on screen when the tooltip is larger than the viewport", () => {
    const placed = placeTooltip(
      at(50, 50),
      { width: 500, height: 400 },
      { width: 300, height: 200 },
    );
    expect(placed).toEqual({ left: VIEWPORT_MARGIN_PX, top: VIEWPORT_MARGIN_PX });
  });

  it("stays inside the viewport wherever the point is", () => {
    for (let x = -50; x <= VIEWPORT.width + 50; x += 25) {
      for (let y = -50; y <= VIEWPORT.height + 50; y += 25) {
        const { left, top } = placeTooltip(at(x, y), SIZE, VIEWPORT);
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
      const { left, top } = placeTooltip(at(x, y), SIZE, VIEWPORT);
      const covers = x >= left && x <= left + SIZE.width && y >= top && y <= top + SIZE.height;
      expect(covers, `${x},${y}`).toBe(false);
    }
  });
});

describe("the visible part of an element", () => {
  function boxed(element: Element, left: number, top: number, width: number, height: number) {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
      new DOMRect(left, top, width, height),
    );
  }

  it("is cut by scrolling ancestors and by the viewport", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowX = "auto";
    scroller.style.overflowY = "auto";
    const chart = document.createElement("div");
    scroller.append(chart);
    document.body.append(scroller);
    boxed(scroller, 100, 100, 400, 300);
    // Scrolled half out at the top of its scroll box.
    boxed(chart, 120, 20, 300, 200);
    expect(visibleBox(chart)).toEqual({ left: 120, top: 100, right: 420, bottom: 220 });
  });

  it("is nothing when the element is scrolled away", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowX = "hidden";
    scroller.style.overflowY = "hidden";
    const chart = document.createElement("div");
    scroller.append(chart);
    document.body.append(scroller);
    boxed(scroller, 0, 100, 400, 300);
    boxed(chart, 0, -500, 300, 200);
    expect(visibleBox(chart)).toBeNull();
  });
});
