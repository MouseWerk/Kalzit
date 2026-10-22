import { act, renderHook } from "@testing-library/react";
import Graph from "graphology";
import { describe, expect, it } from "vitest";
import { applyPositionsTo } from "./applyPositions";
import { ForceLayout, seedPositions } from "./layoutEngine";
import type { LayoutProgress, LayoutRequest } from "./layoutProtocol";
import { components } from "./metrics";
import { buildGraphModel, edgeTimes, edgeWidths, nodeSizes } from "./model";
import { bestOf, generateGraph } from "./test/generate";
import { layoutRequest, setLayoutWorkerFactory, useGraphLayout } from "./useGraphLayout";
import { buildView, labelRanks, visibleAt } from "./view";

/**
 * Performance budgets of the network panel (docs/PLAN.md, section 11) for 5,000 nodes and
 * 20,000 edges. The layout runs in a worker; what stays on the main thread is bounded: work done
 * once per result within one long task (LONG_TASK_MS), work done per frame or interaction (a
 * layout update, the time slider, zoom levels) within one frame (FRAME_MS). Each step is timed as
 * the best of a few runs, the cost of the work rather than of whatever else the machine does;
 * CI runners get twice the time, as the other budgets do (quality/performance.md).
 */
const NODES = 5_000;
const EDGES = 20_000;
const CI = process.env.CI !== undefined;
const LONG_TASK_MS = CI ? 100 : 50;
const FRAME_MS = CI ? 32 : 16;
const RUNS = 5;

/** The best of RUNS timings, written to the output so a budget's margin stays visible. */
function timed(name: string, work: () => void): number {
  const ms = bestOf(RUNS, work);
  process.stdout.write(`graph budget: ${name} ${ms.toFixed(1)} ms (best of ${RUNS})\n`);
  return ms;
}

const set = generateGraph(NODES, EDGES);
const model = buildGraphModel([set], { nodeLimit: NODES, caption: "" });
const view = buildView(model, {
  sizes: nodeSizes(model, "degree"),
  widths: edgeWidths(model, ""),
  groups: Int32Array.from(model.nodes, (n) => n.label),
  cluster: false,
  open: new Set(),
  clusterCaption: (label) => label,
  unlabelled: "",
});

describe("budget: 5,000 nodes and 20,000 edges", () => {
  it("has the size it claims", () => {
    expect(model.nodes).toHaveLength(NODES);
    expect(model.edges.length).toBeGreaterThan(EDGES * 0.99);
  });

  it("prepares a result within one long task", () => {
    expect(
      timed("model", () => buildGraphModel([set], { nodeLimit: NODES, caption: "" })),
    ).toBeLessThan(LONG_TASK_MS);
    expect(timed("components", () => components(model))).toBeLessThan(LONG_TASK_MS);
    expect(
      timed("clustered view", () =>
        buildView(model, {
          sizes: nodeSizes(model, "degree"),
          widths: edgeWidths(model, ""),
          groups: Int32Array.from(model.nodes, (n) => n.label),
          cluster: true,
          open: new Set(),
          clusterCaption: (label) => label,
          unlabelled: "",
        }),
      ),
    ).toBeLessThan(LONG_TASK_MS);
    expect(timed("layout request", () => layoutRequest(view, "force", 1, new Map()))).toBeLessThan(
      LONG_TASK_MS,
    );
  });

  it("does per-frame work within one frame", () => {
    const times = edgeTimes(model, "since");
    expect(
      timed("time slider", () => visibleAt(model, view, times, Date.UTC(2026, 5, 1))),
    ).toBeLessThan(FRAME_MS);
    expect(timed("label ranks", () => labelRanks(view))).toBeLessThan(FRAME_MS);
    const graph = new Graph({ type: "directed", multi: true });
    for (let i = 0; i < NODES; i++) graph.addNode(String(i), { x: 0, y: 0 });
    const positions = seedPositions(NODES);
    expect(timed("apply positions", () => applyPositionsTo(graph, positions))).toBeLessThan(
      FRAME_MS,
    );
    expect(graph.getNodeAttribute("7", "x")).toBe(positions[14]);
  });

  it("runs the force layout in a worker and only takes its positions on the main thread", () => {
    const posted: { request: LayoutRequest; transfer: Transferable[] }[] = [];
    const worker = {
      onmessage: null as ((event: MessageEvent<LayoutProgress>) => void) | null,
      postMessage(request: LayoutRequest, transfer: Transferable[]) {
        posted.push({ request, transfer });
      },
      terminate() {},
    };
    const restore = setLayoutWorkerFactory(() => worker as unknown as Worker);
    try {
      const started = performance.now();
      const { result } = renderHook(() => useGraphLayout(view, "force"));
      expect(performance.now() - started).toBeLessThan(LONG_TASK_MS * 4);
      expect(posted).toHaveLength(1);
      const sent = posted[0];
      expect(sent?.request.count).toBe(NODES);
      // The arrays move to the worker instead of being copied.
      expect(sent?.transfer).toContain(sent?.request.sources.buffer);
      expect(result.current).toMatchObject({ running: true, worker: true });

      const settled = seedPositions(NODES);
      const handled = bestOf(1, () =>
        act(() => {
          worker.onmessage?.({
            data: { type: "positions", run: 1, positions: settled, done: true },
          } as MessageEvent<LayoutProgress>);
        }),
      );
      expect(handled).toBeLessThan(LONG_TASK_MS);
      expect(result.current).toMatchObject({ running: false, positions: settled });
    } finally {
      restore();
    }
  });

  it("keeps large graphs at their starting positions where there is no worker", () => {
    const restore = setLayoutWorkerFactory(() => null);
    try {
      const { result } = renderHook(() => useGraphLayout(view, "force"));
      expect(result.current).toMatchObject({ running: false, worker: false });
      expect(result.current.positions).toEqual(seedPositions(NODES));
    } finally {
      restore();
    }
  });

  it("lets the worker settle the layout in reasonable time", () => {
    const request = layoutRequest(view, "force", 1, new Map());
    const layout = new ForceLayout(request, request.start);
    const started = performance.now();
    layout.step(5);
    // One position update of the worker: five iterations. Well within a second even on CI.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect([...layout.positions()].every(Number.isFinite)).toBe(true);
  });
});
