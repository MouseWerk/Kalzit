import { act, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TooltipAnchor } from "../lib/tooltipPlace";

/**
 * What placing tooltips costs. A dashboard with a shared cursor moves the tooltip of every time
 * panel on each pointer move; measuring and moving them one by one would lay the page out once
 * per tooltip. They are placed together instead (every read before the first write), their size
 * is measured once and then reported by the browser, and a place that did not change is not
 * written again.
 */

type Observe = (changes: { target: Element; borderBoxSize: ResizeObserverSize[] }[]) => void;

/** The browser's size reports, by hand: jsdom has none. */
const observers: { report: Observe; targets: Set<Element> }[] = [];

/** Elements that started being observed while another observer's callback ran. */
const observedDuringReport: Element[] = [];
let reporting = false;

class FakeResizeObserver {
  private readonly entry: { report: Observe; targets: Set<Element> };
  constructor(report: Observe) {
    this.entry = { report, targets: new Set() };
    observers.push(this.entry);
  }
  observe(target: Element) {
    if (reporting) {
      observedDuringReport.push(target);
    }
    this.entry.targets.add(target);
  }
  unobserve(target: Element) {
    this.entry.targets.delete(target);
  }
  disconnect() {
    this.entry.targets.clear();
  }
}

/** Another observer's delivery (a panel taking its new size), running `work` in its callback. */
function duringReport(work: () => void) {
  reporting = true;
  try {
    work();
  } finally {
    reporting = false;
  }
}

/** Animation frames, by hand: they run when a test settles. */
let frames = new Map<number, FrameRequestCallback>();
let lastFrame = 0;

function runFrames() {
  const due = frames;
  frames = new Map();
  for (const callback of due.values()) {
    callback(performance.now());
  }
}

function reportSize(target: Element, width: number, height: number) {
  for (const { report, targets } of observers) {
    if (targets.has(target)) {
      report([{ target, borderBoxSize: [{ inlineSize: width, blockSize: height }] }]);
    }
  }
}

let FloatingTooltip: typeof import("./FloatingTooltip").FloatingTooltip;

beforeAll(async () => {
  // Before the module loads: it takes the observer it finds.
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  ({ FloatingTooltip } = await import("./FloatingTooltip"));
});

beforeEach(() => {
  // Per test: stubbed globals are restored after each one.
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    lastFrame += 1;
    frames.set(lastFrame, callback);
    return lastFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => {
    frames.delete(frame);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    runFrames();
    await Promise.resolve();
  });
}

const SIZE = { width: 100, height: 40 };

/** Counts how often tooltips are measured; every tooltip is 100 x 40. */
function countMeasures() {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return new DOMRect(0, 0, SIZE.width, SIZE.height);
  });
}

const at = (x: number, y: number): TooltipAnchor => ({ x, y, gapX: 10, gapY: 10 });

describe("placing floating tooltips", () => {
  it("measures a tooltip once, however often the pointer moves", async () => {
    const measures = countMeasures();
    const point = { x: 100, y: 100 };
    const handle = { current: null as { place: () => void } | null };
    render(
      <FloatingTooltip ref={handle} className="t" anchor={() => at(point.x, point.y)}>
        Value
      </FloatingTooltip>,
    );
    await settle();
    const tip = document.querySelector<HTMLElement>(".floating-tooltip");
    expect(tip?.style.left).toBe("110px");
    expect(measures).toHaveBeenCalledTimes(1);
    for (let move = 1; move <= 50; move++) {
      point.x = 100 + move;
      handle.current?.place();
      await settle();
    }
    expect(tip?.style.left).toBe("160px");
    // No layout was read for any of the moves.
    expect(measures).toHaveBeenCalledTimes(1);
  });

  it("takes a new size from the browser's report instead of measuring", async () => {
    const measures = countMeasures();
    // Near the right edge of the 1024 px window: a wider tooltip has to go to the other side.
    render(
      <FloatingTooltip className="t" anchor={() => at(900, 100)}>
        Value
      </FloatingTooltip>,
    );
    await settle();
    const tip = document.querySelector<HTMLElement>(".floating-tooltip") as HTMLElement;
    expect(tip.style.left).toBe("910px");
    reportSize(tip, 300, 40);
    await settle();
    expect(tip.style.left).toBe(`${900 - 10 - 300}px`);
    // The same size reported again places nothing.
    const moved = vi.spyOn(tip.style, "left", "set");
    reportSize(tip, 300, 40);
    await settle();
    expect(moved).not.toHaveBeenCalled();
    expect(measures).toHaveBeenCalledTimes(1);
  });

  it("places many tooltips together: every read before the first write", async () => {
    const count = 40;
    const log: string[] = [];
    const wrote = () => document.querySelectorAll(".floating-tooltip[data-placed]").length;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      log.push(`measure after ${wrote()} writes`);
      return new DOMRect(0, 0, SIZE.width, SIZE.height);
    });
    render(
      <div>
        {Array.from({ length: count }, (_, index) => (
          <FloatingTooltip
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
            key={index}
            className="t"
            anchor={() => {
              log.push(`anchor after ${wrote()} writes`);
              return at(10 * index, 100);
            }}
          >
            Value {index}
          </FloatingTooltip>
        ))}
      </div>,
    );
    await settle();
    // Each anchor is read once and each tooltip measured once, all before anything is placed.
    expect(log.filter((entry) => entry.startsWith("anchor"))).toHaveLength(count);
    expect(log.filter((entry) => entry.startsWith("measure"))).toHaveLength(count);
    expect(new Set(log.map((entry) => entry.replace(/^\w+ /, "")))).toEqual(
      new Set(["after 0 writes"]),
    );
    expect(wrote()).toBe(count);
  });

  it("asks an anchor once when a render and a pointer move come in the same turn", async () => {
    countMeasures();
    const asked = vi.fn(() => at(100, 100));
    const handle = { current: null as { place: () => void } | null };
    const view = (text: string) => (
      <FloatingTooltip ref={handle} className="t" anchor={asked}>
        {text}
      </FloatingTooltip>
    );
    const { rerender } = render(view("1"));
    await settle();
    asked.mockClear();
    // The hovered chart: the pointer handler asks for a place and the chart renders again.
    act(() => {
      handle.current?.place();
      rerender(view("2"));
      handle.current?.place();
    });
    await settle();
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("writes a place only when it changed", async () => {
    countMeasures();
    const handle = { current: null as { place: () => void } | null };
    render(
      <FloatingTooltip ref={handle} className="t" anchor={() => at(100, 100)}>
        Value
      </FloatingTooltip>,
    );
    await settle();
    const tip = document.querySelector<HTMLElement>(".floating-tooltip") as HTMLElement;
    const moved = vi.spyOn(tip.style, "left", "set");
    handle.current?.place();
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("scroll"));
    await settle();
    expect(moved).not.toHaveBeenCalled();
  });

  it("starts observing a tooltip in the next frame, not inside another observer's callback", async () => {
    countMeasures();
    observedDuringReport.length = 0;
    // A panel's new size renders in its observer's callback (flushSync), the render mounts a
    // tooltip, and its effects run right there.
    duringReport(() => {
      act(() => {
        render(
          <FloatingTooltip className="t" anchor={() => at(900, 100)}>
            Value
          </FloatingTooltip>,
        );
      });
    });
    expect(observedDuringReport).toEqual([]);
    await settle();
    const tip = document.querySelector<HTMLElement>(".floating-tooltip") as HTMLElement;
    // Placed from a measurement until the browser reports its size.
    expect(tip.style.left).toBe("910px");
    // Observed from the next frame on: a wider tooltip goes to the other side.
    reportSize(tip, 300, 40);
    await settle();
    expect(tip.style.left).toBe(`${900 - 10 - 300}px`);
    expect(observedDuringReport).toEqual([]);
  });

  it("holds a tooltip to the width of the chart it has to stay in, then measures it again", async () => {
    const measures = countMeasures();
    const chart = { left: 200, top: 100, right: 500, bottom: 400 };
    const anchor = { current: at(100, 100) };
    const handle = { current: null as { place: () => void } | null };
    render(
      <FloatingTooltip ref={handle} className="t" anchor={() => anchor.current}>
        Value
      </FloatingTooltip>,
    );
    await settle();
    const tip = document.querySelector<HTMLElement>(".floating-tooltip") as HTMLElement;
    expect(tip.style.getPropertyValue("--tooltip-room")).toBe("");
    anchor.current = { x: 250, y: 100, gapX: 8, gapY: 8, within: chart };
    handle.current?.place();
    await settle();
    expect(tip.style.getPropertyValue("--tooltip-room")).toBe("300px");
    expect(tip.style.left).toBe("258px");
    // The new width may have changed its size: measured once more, not on later moves.
    expect(measures).toHaveBeenCalledTimes(2);
    anchor.current = { x: 300, y: 100, gapX: 8, gapY: 8, within: chart };
    handle.current?.place();
    await settle();
    expect(tip.style.left).toBe("308px");
    expect(measures).toHaveBeenCalledTimes(2);
  });
});
