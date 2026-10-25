import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalciteCrystal } from "./CalciteCrystal";

// The crystal against a recording context and controllable browser hooks, since jsdom has no
// canvas: what matters here is when it draws, pauses and reads its colors again.

type Listener = () => void;

function mediaQueries(reduced = false) {
  const listeners = new Map<string, Set<Listener>>();
  const queries: string[] = [];
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      queries.push(query);
      const set = listeners.get(query) ?? new Set<Listener>();
      listeners.set(query, set);
      return {
        matches: query.includes("reduced-motion") ? reduced : false,
        media: query,
        addEventListener: (_type: string, listener: Listener) => set.add(listener),
        removeEventListener: (_type: string, listener: Listener) => set.delete(listener),
      };
    }),
  );
  return {
    queries,
    fire: (match: string) => {
      for (const [query, set] of listeners) {
        if (query.includes(match)) {
          for (const listener of [...set]) {
            listener();
          }
        }
      }
    },
  };
}

let drawn: number;
let requested: number[];
let cancelled: number[];

beforeEach(() => {
  drawn = 0;
  requested = [];
  cancelled = [];
  const ctx = new Proxy(
    {},
    {
      get: (target, name) =>
        name === "clearRect" ? () => (drawn += 1) : ((target as never)[name] ?? (() => undefined)),
      set: () => true,
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 300,
    height: 200,
  } as DOMRect);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => {
      requested.push(requested.length + 1);
      return requested.length;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => cancelled.push(id)),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("calcite crystal", () => {
  it("is decoration: hidden from assistive technology", () => {
    mediaQueries();
    const { container } = render(<CalciteCrystal />);
    expect(container.querySelector('[aria-hidden="true"] canvas')).not.toBeNull();
  });

  it("animates, pauses while the tab is hidden and goes on when it is shown", () => {
    mediaQueries();
    render(<CalciteCrystal />);
    expect(requested).toHaveLength(1);
    setHidden(true);
    expect(cancelled).toEqual([1]);
    const frames = requested.length;
    setHidden(false);
    expect(requested.length).toBe(frames + 1);
  });

  it("cancels its frame when it goes away", () => {
    mediaQueries();
    const { unmount } = render(<CalciteCrystal />);
    unmount();
    expect(cancelled).toEqual([1]);
  });

  it("draws one still picture and no frames with reduced motion", () => {
    mediaQueries(true);
    render(<CalciteCrystal />);
    expect(requested).toHaveLength(0);
    expect(drawn).toBeGreaterThan(0);
  });

  it("reads its colors again when the theme changes", () => {
    mediaQueries();
    const read = vi.spyOn(window, "getComputedStyle");
    render(<CalciteCrystal />);
    const before = read.mock.calls.length;
    document.documentElement.setAttribute("data-theme", "dark");
    return vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
  });

  it("sizes itself again when the pixel ratio changes", () => {
    const media = mediaQueries();
    const { container } = render(<CalciteCrystal />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas.width).toBe(300);
    vi.stubGlobal("devicePixelRatio", 2);
    media.fire("resolution");
    expect(canvas.width).toBe(600);
    // And it listens for the next change at the new ratio.
    expect(media.queries.at(-1)).toBe("(resolution: 2dppx)");
  });
});
