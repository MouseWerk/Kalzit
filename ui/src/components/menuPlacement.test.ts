import { afterEach, describe, expect, it, vi } from "vitest";
import { placeMenu } from "./menuPlacement";

/** An element whose box is the given rectangle. */
function boxed(x: number, y: number, width: number, height: number): HTMLElement {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => new DOMRect(x, y, width, height);
  return element;
}

function placed(list: HTMLElement) {
  return {
    left: Number.parseFloat(list.style.getPropertyValue("--menu-left")),
    top: Number.parseFloat(list.style.getPropertyValue("--menu-top")),
  };
}

function viewport(width: number, height: number) {
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(height);
}

afterEach(() => vi.restoreAllMocks());

describe("placing a menu next to its button", () => {
  it("puts it under the button, right edges aligned, with room below", () => {
    viewport(1000, 800);
    const list = boxed(0, 0, 200, 100);
    placeMenu(boxed(500, 100, 30, 30), list);
    expect(placed(list)).toEqual({ left: 330, top: 134 });
  });

  it("flips it above the button near the bottom edge", () => {
    viewport(1000, 800);
    const list = boxed(0, 0, 200, 100);
    placeMenu(boxed(500, 740, 30, 30), list);
    expect(placed(list)).toEqual({ left: 330, top: 636 });
  });

  it("puts it beside the button, and flips it to the left near the right edge", () => {
    viewport(1000, 800);
    const list = boxed(0, 0, 200, 100);
    placeMenu(boxed(200, 300, 24, 24), list, "beside");
    expect(placed(list)).toEqual({ left: 228, top: 300 });
    placeMenu(boxed(900, 300, 24, 24), list, "beside");
    expect(placed(list)).toEqual({ left: 696, top: 300 });
  });

  it("flips a menu beside the button up near the bottom edge", () => {
    viewport(1000, 800);
    const list = boxed(0, 0, 200, 100);
    placeMenu(boxed(200, 760, 24, 24), list, "beside");
    expect(placed(list)).toEqual({ left: 228, top: 684 });
  });

  it("clamps it inside the visible width, without the scroll bar", () => {
    viewport(360, 640);
    const list = boxed(0, 0, 200, 100);
    // The button at the left edge: right-aligned, the menu would start off screen.
    placeMenu(boxed(10, 100, 30, 30), list);
    expect(placed(list).left).toBe(8);
    // No room on either side of a button in the middle of a phone: below it instead.
    placeMenu(boxed(160, 600, 30, 30), list, "beside");
    expect(placed(list)).toEqual({ left: 8, top: 496 });
  });
});
