import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LayoutMessage, LayoutRequest } from "../layoutProtocol";
import { buildGraphModel, edgeWidths, nodeSizes } from "../model";
import { parseGraphOptions } from "../options";
import { generateGraph } from "../test/generate";
import { layoutRequest, setLayoutWorkerFactory, useGraphLayout } from "../useGraphLayout";
import { buildView } from "../view";
import { useLayoutChoice } from "./useLayout";

function viewOf(nodes: number, edges: number) {
  const model = buildGraphModel([generateGraph(nodes, edges)], { nodeLimit: nodes, caption: "" });
  return buildView(model, {
    sizes: nodeSizes(model, "degree"),
    widths: edgeWidths(model, ""),
    groups: Int32Array.from(model.nodes, (n) => n.label),
    cluster: false,
    open: new Set(),
    clusterCaption: (label) => label,
    unlabelled: "",
  });
}

describe("useLayoutChoice", () => {
  const options = (patch: Record<string, unknown> = {}) => parseGraphOptions(patch);

  it("starts with the panel's layout; a hierarchy panel always starts as a hierarchy", () => {
    const network = renderHook(() =>
      useLayoutChoice(options({ layout: "grid" }), "force", undefined),
    );
    expect(network.result.current.settings.mode).toBe("grid");
    const hierarchy = renderHook(() =>
      useLayoutChoice(options({ layout: "grid" }), "hierarchy", undefined),
    );
    expect(hierarchy.result.current.settings.mode).toBe("hierarchy");
  });

  it("keeps a viewer's change to itself, and writes it to the options in the panel editor", () => {
    const edit = vi.fn();
    const viewing = renderHook(() => useLayoutChoice(options(), "force", undefined));
    act(() => viewing.result.current.change({ mode: "circular" }));
    expect(viewing.result.current.settings.mode).toBe("circular");

    const editing = renderHook(() => useLayoutChoice(options(), "force", edit));
    act(() => editing.result.current.change({ mode: "timeline", lanes: "one" }));
    expect(edit).toHaveBeenLastCalledWith(
      expect.objectContaining({ layout: "timeline", layoutLanes: "one" }),
    );
  });

  it("goes back to the layout before the last change of layout, once", () => {
    const { result } = renderHook(() => useLayoutChoice(options(), "force", undefined));
    expect(result.current.canGoBack).toBe(false);
    act(() => result.current.change({ mode: "grid" }));
    expect(result.current.canGoBack).toBe(true);
    act(() => result.current.back());
    expect(result.current.settings.mode).toBe("force");
    expect(result.current.canGoBack).toBe(false);
  });

  it("takes the selection as the radial middle, and another seed on arranging again", () => {
    const { result } = renderHook(() => useLayoutChoice(options(), "force", undefined));
    act(() => result.current.change({ mode: "radial" }, ["n:a"]));
    expect(result.current.centers).toEqual(["n:a"]);
    const seed = result.current.seed;
    act(() => result.current.rearrange(["n:b"]));
    expect(result.current.centers).toEqual(["n:b"]);
    expect(result.current.seed).toBe(seed + 1);
  });

  it("takes new options of the panel over the viewer's choice", () => {
    const { result, rerender } = renderHook(
      ({ layout }) => useLayoutChoice(options({ layout }), "force", undefined),
      { initialProps: { layout: "grid" } },
    );
    act(() => result.current.change({ mode: "circular" }));
    rerender({ layout: "timeline" });
    expect(result.current.settings.mode).toBe("timeline");
  });
});

class FakeWorker {
  static all: FakeWorker[] = [];
  posted: LayoutRequest[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<LayoutMessage>) => void) | null = null;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(request: LayoutRequest) {
    this.posted.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  say(message: LayoutMessage) {
    act(() => this.onmessage?.({ data: message } as MessageEvent<LayoutMessage>));
  }
}

describe("useGraphLayout with the layouts of the menu", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    FakeWorker.all = [];
  });
  const start = () => {
    restore = setLayoutWorkerFactory(() => new FakeWorker() as unknown as Worker);
  };

  it("shows how far a layout has come, then its positions and guides", () => {
    start();
    const view = viewOf(20, 20);
    const { result } = renderHook(() => useGraphLayout(view, "circular"));
    const worker = FakeWorker.all[0] as FakeWorker;
    expect(result.current).toMatchObject({ running: true, work: { done: 0, total: 20 } });
    worker.say({ type: "work", run: 1, done: 8, total: 20 });
    expect(result.current.work).toEqual({ done: 8, total: 20 });
    expect(result.current.running).toBe(true);
    const positions = new Float32Array(40);
    const guides = [{ kind: "ring", x: 0, y: 0, radius: 5 }] as const;
    worker.say({ type: "positions", run: 1, positions, done: true, guides: [...guides] });
    expect(result.current).toMatchObject({ running: false, work: null, guides });
  });

  it("drops the late messages of a run that was replaced", () => {
    start();
    const view = viewOf(10, 10);
    const { result, rerender } = renderHook(({ mode }) => useGraphLayout(view, mode), {
      initialProps: { mode: "circular" as "circular" | "grid" },
    });
    const first = FakeWorker.all[0] as FakeWorker;
    rerender({ mode: "grid" });
    expect(first.terminated).toBe(true);
    first.say({ type: "positions", run: 1, positions: new Float32Array(20), done: true });
    expect(result.current.running).toBe(true);
  });

  it("shows a settled layout again without a new run when it is returned to (cancel)", () => {
    start();
    const view = viewOf(10, 10);
    const { result, rerender } = renderHook(({ mode }) => useGraphLayout(view, mode), {
      initialProps: { mode: "circular" as "circular" | "grid" },
    });
    const circular = new Float32Array(20).fill(1);
    (FakeWorker.all[0] as FakeWorker).say({
      type: "positions",
      run: 1,
      positions: circular,
      done: true,
    });
    rerender({ mode: "grid" });
    expect(FakeWorker.all).toHaveLength(2);
    // Cancelled before the grid finished: back to the circle, which costs no run.
    rerender({ mode: "circular" });
    expect(FakeWorker.all).toHaveLength(2);
    expect(result.current).toMatchObject({ running: false, positions: circular });
  });

  it("asks again for forces and radial, never for the layouts the seed does not change", () => {
    start();
    const view = viewOf(10, 10);
    const { rerender } = renderHook(
      ({ mode, seed }) => useGraphLayout(view, mode, null, { seed }),
      { initialProps: { mode: "circular" as "circular" | "force", seed: 0 } },
    );
    const done = (index: number) =>
      (FakeWorker.all[index] as FakeWorker).say({
        type: "positions",
        run: index + 1,
        positions: new Float32Array(20),
        done: true,
      });
    done(0);
    // Another seed with a layout that ignores it: still the settled layout.
    rerender({ mode: "circular", seed: 1 });
    expect(FakeWorker.all).toHaveLength(1);
    rerender({ mode: "force", seed: 1 });
    expect(FakeWorker.all).toHaveLength(2);
    done(1);
    rerender({ mode: "force", seed: 2 });
    expect(FakeWorker.all).toHaveLength(3);
  });

  it("keeps pinned nodes where they were put", () => {
    const view = viewOf(5, 5);
    const first = view.nodes[0];
    const request = layoutRequest(view, "circular", 1, new Map(), {
      pinned: new Map([[first?.key.slice(2) as string, [7, 9]]]),
    });
    expect(request.fixed?.[0]).toBe(1);
    expect(request.fixed?.[1]).toBe(0);
    expect([request.start[0], request.start[1]]).toEqual([7, 9]);
  });
});

describe("the layout worker's work message", () => {
  it("says how far a layout is while it works, and posts the guides with the end", async () => {
    const posted: LayoutMessage[] = [];
    const spy = vi.spyOn(self, "postMessage").mockImplementation(((message: LayoutMessage) => {
      posted.push(message);
    }) as never);
    let time = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => {
      time += 500;
      return time;
    });
    try {
      await import("../layout.worker");
      const view = viewOf(30, 30);
      const request = layoutRequest(view, "radial", 4, new Map());
      (self.onmessage as unknown as (event: { data: LayoutRequest }) => void)({ data: request });
      const types = posted.map((message) => message.type);
      expect(types.at(-1)).toBe("positions");
      expect(types).toContain("work");
      const work = posted.find((message) => message.type === "work");
      expect(work).toMatchObject({ run: 4, total: 30 });
      expect(posted.at(-1)).toMatchObject({ run: 4, done: true });
      expect((posted.at(-1) as { guides?: unknown[] }).guides?.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      clock.mockRestore();
    }
  });
});
