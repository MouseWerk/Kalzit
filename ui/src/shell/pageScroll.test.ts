import { afterEach, describe, expect, it, vi } from "vitest";
import { LINE_STEP_PX, scrollPageByKey, scrollStep } from "./pageScroll";

describe("scrollStep", () => {
  it("scrolls a line, a page less one line below the bars, or to an end", () => {
    expect(scrollStep("ArrowDown", false, 600, 100)).toBe(LINE_STEP_PX);
    expect(scrollStep("ArrowUp", false, 600, 100)).toBe(-LINE_STEP_PX);
    expect(scrollStep("PageDown", false, 600, 100)).toBe(460);
    expect(scrollStep("PageUp", false, 600, 100)).toBe(-460);
    expect(scrollStep(" ", false, 600, 100)).toBe(460);
    expect(scrollStep(" ", true, 600, 100)).toBe(-460);
    expect(scrollStep("Home", false, 600, 100)).toBe("start");
    expect(scrollStep("End", false, 600, 100)).toBe("end");
  });

  it("still moves by a line in a window shorter than its bars", () => {
    expect(scrollStep("PageDown", false, 80, 100)).toBe(LINE_STEP_PX);
  });

  it("leaves other keys alone", () => {
    expect(scrollStep("a", false, 600, 0)).toBeNull();
    expect(scrollStep("Enter", false, 600, 0)).toBeNull();
  });
});

describe("scrollPageByKey", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function setup(overflowY: string) {
    const main = document.createElement("main");
    main.style.overflowY = overflowY;
    document.body.append(main);
    Object.defineProperty(main, "clientHeight", { value: 500 });
    const scrollBy = vi.fn();
    const scrollTo = vi.fn();
    main.scrollBy = scrollBy as typeof main.scrollBy;
    main.scrollTo = scrollTo as typeof main.scrollTo;
    return { main, scrollBy, scrollTo };
  }

  function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, "target", { value: target });
    return event;
  }

  it("scrolls the main area when nothing has focus", () => {
    const { main, scrollBy, scrollTo } = setup("auto");
    const down = press(document.body, "PageDown");
    expect(scrollPageByKey(down, main)).toBe(true);
    expect(down.defaultPrevented).toBe(true);
    expect(scrollBy).toHaveBeenCalledWith({ top: 500 - LINE_STEP_PX });
    expect(scrollPageByKey(press(document.body, "End"), main)).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: main.scrollHeight });
  });

  it("scrolls the kiosk dashboard, which covers the main area", () => {
    const { main, scrollBy } = setup("auto");
    const kiosk = document.createElement("div");
    kiosk.className = "dashboard--kiosk";
    kiosk.style.overflowY = "auto";
    const kioskScroll = vi.fn();
    kiosk.scrollBy = kioskScroll as typeof kiosk.scrollBy;
    main.append(kiosk);
    expect(scrollPageByKey(press(document.body, "ArrowDown"), main)).toBe(true);
    expect(kioskScroll).toHaveBeenCalledWith({ top: LINE_STEP_PX });
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("leaves the key to the browser when something has focus, with modifiers, or on a phone", () => {
    const { main, scrollBy } = setup("auto");
    const field = document.createElement("input");
    main.append(field);
    expect(scrollPageByKey(press(field, "PageDown"), main)).toBe(false);
    expect(scrollPageByKey(press(document.body, "End", { ctrlKey: true }), main)).toBe(false);
    const handled = press(document.body, "PageDown");
    handled.preventDefault();
    expect(scrollPageByKey(handled, main)).toBe(false);
    expect(scrollPageByKey(press(document.body, "PageDown"), null)).toBe(false);
    main.style.overflowY = "visible";
    expect(scrollPageByKey(press(document.body, "PageDown"), main)).toBe(false);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
