import { act, render } from "@testing-library/react";
import Graph from "graphology";
import { createRef } from "react";
import type { CameraState } from "sigma/types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GraphSet } from "../../api/generated/shapes";
import { installWebGLStub } from "../../test/webglStub";
import { DEFAULT_STYLE } from "./drawing";
import { EDGE_CHUNK, handOver } from "./handover";
import { seedPositions } from "./layoutEngine";
import { buildGraphModel, edgeWidths, nodeSizes } from "./model";
import type { CanvasHandle, LiveProps } from "./SigmaCanvas";
import {
  allVisible,
  buildView,
  type GraphView,
  LABEL_BUDGET,
  labelBudgetFor,
  labelRanks,
} from "./view";

/**
 * The real renderer (Sigma 4 with graphology) under a WebGL stand-in: what it does with edges
 * added after the hand-over. Sigma indexes parallel edges for the graph it was constructed with;
 * a graph given to it later with `setGraph` is not indexed, and adding an edge to it throws.
 * The hand-over must therefore build the renderer for its graph and add the later chunks there.
 */
let restore: () => void;
let SigmaClass: typeof import("sigma").default;
let createRenderer: typeof import("./SigmaCanvas").createRenderer;
let collidingLabels: typeof import("./labelRoom").collidingLabels;
let SigmaCanvas: typeof import("./SigmaCanvas").SigmaCanvas;

beforeAll(async () => {
  restore = installWebGLStub();
  // Sigma reads WebGL constants while its module loads, so it loads after the stand-in.
  SigmaClass = (await import("sigma")).default;
  ({ createRenderer, SigmaCanvas } = await import("./SigmaCanvas"));
  ({ collidingLabels } = await import("./labelRoom"));
});

afterAll(() => restore());

function bigView(edgeCount: number) {
  // Mostly distinct node pairs: large groups of parallel edges are slow in the renderer's index.
  const count = 2_000;
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    labels: ["L"],
    properties: {},
  }));
  const edges = Array.from({ length: edgeCount }, (_, i) => ({
    id: `e${i}`,
    type: "T",
    from: `n${i % count}`,
    to: `n${(i * 7 + 1 + Math.floor(i / count)) % count}`,
    properties: {},
  }));
  const set: GraphSet = {
    nodes,
    edges,
    schema: { labels: ["L"], edgeTypes: ["T"], propertyKeys: {} },
  };
  const model = buildGraphModel([set], { nodeLimit: 5_000, caption: "" });
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

function canvasProps(view: GraphView, camera: { current: CameraState | null }) {
  return {
    view,
    positions: seedPositions(view.nodes.length),
    palette: {
      series: ["#111111"],
      dimmed: ["#eeeeee"],
      neutral: "#333333",
      neutralDimmed: "#cccccc",
      edge: "#444444",
      edgeDimmed: "#bbbbbb",
      text: "#000000",
      background: "#ffffff",
      font: "sans-serif",
      boldWeight: "600",
      selection: "#eeeeee",
      ramps: { blues: [], gyr: [], grays: [] },
      dimmedRamps: { blues: [], gyr: [], grays: [] },
    },
    visibility: allVisible(view),
    ranks: labelRanks(view),
    selected: new Set<number>(),
    primary: null,
    neighbours: new Set<number>(),
    drawStyle: DEFAULT_STYLE,
    reducedMotion: true,
    camera,
    onPick: () => undefined,
    onGestureHint: () => undefined,
  };
}

function host(): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

describe("handing a graph to the renderer", () => {
  it("fails in Sigma when edges are added to a graph given with setGraph", () => {
    const first = new Graph({ type: "directed", multi: true });
    first.addNode("a", { x: 0, y: 0, size: 1 });
    first.addNode("b", { x: 1, y: 1, size: 1 });
    const renderer = new SigmaClass(first, host(), { settings: { allowInvalidContainer: true } });
    const second = first.copy();
    renderer.setGraph(second);
    expect(() => second.addEdgeWithKey("e1", "a", "b", { size: 1 })).toThrow(/could not find/);
    renderer.kill();
  });

  it("draws every edge of a view larger than one chunk, added to the renderer's own graph", () => {
    const view = bigView(EDGE_CHUNK * 2 + 10);
    const frames: (() => void)[] = [];
    const live = { current: { ratioBucket: 0, props: canvasProps(view, { current: null }) } };
    const handover = handOver(
      view,
      live.current.props.positions,
      (graph) => createRenderer(graph, host(), live),
      { schedule: (cb) => frames.push(cb), cancel: () => undefined },
    );
    // Every later chunk goes into the graph the renderer was built for, without an error.
    while (frames.length > 0) frames.shift()?.();
    expect(handover.renderer.getGraph()).toBe(handover.graph);
    expect(handover.graph.size).toBe(view.edges.length);
    // The renderer indexed the last edge too: it has its parallel-edge state.
    const last = `e${view.edges.length - 1}`;
    expect(handover.renderer.getEdgeState(last).parallelCount).toBeGreaterThan(0);
    handover.renderer.kill();
  });
});

describe("label picking", () => {
  it("drops the picking pass of the label programs and keeps the one of nodes", () => {
    // Labels are drawn with a picking shader that writes nothing, which Chromium refuses on
    // every frame (labelPicking.ts); nodes and edges keep theirs, so clicks still pick them.
    const view = bigView(10);
    const live = { current: { ratioBucket: 0, props: canvasProps(view, { current: null }) } };
    const handover = handOver(view, live.current.props.positions, (graph) =>
      createRenderer(graph, host(), live),
    );
    const internals = (
      handover.renderer as unknown as {
        internals: Record<string, { pickProgram: unknown } | null>;
      }
    ).internals;
    expect(internals.labelProgram?.pickProgram).toBeNull();
    expect(internals.edgeLabelProgram?.pickProgram ?? null).toBeNull();
    const nodes = (handover.renderer as unknown as { nodeProgram: { pickProgram: unknown } })
      .nodeProgram;
    expect(nodes.pickProgram).not.toBeNull();
    handover.renderer.kill();
  });
});

describe("the camera between views", () => {
  it("keeps zoom and centre when a view with other nodes draws in a new canvas", async () => {
    // jsdom has no layout; the stage reports a size so the renderer starts.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    });
    const camera: { current: CameraState | null } = { current: null };
    const handle = createRef<CanvasHandle>();
    const first = render(<SigmaCanvas {...canvasProps(bigView(10), camera)} ref={handle} />);
    await act(async () => {
      handle.current?.zoom(2);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    first.unmount();
    const zoomed = camera.current;
    expect(zoomed?.ratio).toBeCloseTo(0.5, 2);

    // A loaded neighbourhood: more nodes, so the panel mounts a new canvas.
    const second = render(<SigmaCanvas {...canvasProps(bigView(20), camera)} />);
    second.unmount();
    expect(camera.current?.ratio).toBeCloseTo(0.5, 2);
    expect(camera.current?.x).toBeCloseTo(zoomed?.x ?? Number.NaN, 5);
  });
});

describe("the label budget", () => {
  /** A stage of this size in px, as the browser would lay it out. */
  function sizedHost(width: number, height: number): HTMLElement {
    const element = host();
    Object.defineProperty(element, "offsetWidth", { configurable: true, value: width });
    Object.defineProperty(element, "offsetHeight", { configurable: true, value: height });
    return element;
  }

  function shownLabels(renderer: InstanceType<typeof SigmaClass>): number {
    return renderer
      .getGraph()
      .nodes()
      .filter((key) => {
        const data = renderer.getNodeDisplayData(key);
        return data !== undefined && data.labelVisibility !== "hidden";
      }).length;
  }

  it("shows a small panel no more labels than its budget from the first drawing, without zoom", () => {
    vi.useFakeTimers();
    try {
      const view = bigView(10);
      const live: { current: LiveProps } = {
        current: { ratioBucket: 0, props: canvasProps(view, { current: null }) },
      };
      const handover = handOver(view, live.current.props.positions, (graph) =>
        createRenderer(graph, sizedHost(320, 160), live),
      );
      const budget = labelBudgetFor(320, 160);
      expect(budget).toBeLessThan(LABEL_BUDGET);
      expect(live.current.budget).toBe(budget);
      const first = shownLabels(handover.renderer);
      expect(first).toBeGreaterThan(0);
      expect(first).toBeLessThanOrEqual(budget);
      // Still within it once the drawing has settled.
      vi.advanceTimersByTime(1_000);
      expect(shownLabels(handover.renderer)).toBeLessThanOrEqual(budget);
      handover.renderer.kill();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("labels with room, on every frame", () => {
  /** Two labelled nodes on top of each other, one square, and a third far away. */
  function crowdedView(): GraphView {
    const set: GraphSet = {
      nodes: [
        { id: "a1", labels: ["UPS"], properties: { name: "UPS A1" } },
        { id: "a2", labels: ["UPS"], properties: { name: "UPS A2" } },
        { id: "grid", labels: ["Utility"], properties: { name: "Grid" } },
      ],
      edges: [],
      schema: { labels: ["UPS", "Utility"], edgeTypes: [], propertyKeys: {} },
    };
    const model = buildGraphModel([set], { nodeLimit: 10, caption: "" });
    return buildView(model, {
      sizes: nodeSizes(model, ""),
      widths: edgeWidths(model, ""),
      groups: Int32Array.from(model.nodes, (n) => n.label),
      cluster: false,
      open: new Set(),
      clusterCaption: (label) => label,
      unlabelled: "",
      labelShape: (label) => (label === 1 ? "square" : "circle"),
    });
  }

  it("hooks the check into the renderer's choice of labels and draws each node's shape", () => {
    const view = crowdedView();
    const live: { current: LiveProps } = {
      current: { ratioBucket: 0, props: canvasProps(view, { current: null }) },
    };
    const handover = handOver(view, Float32Array.from([0, 0, 0.1, 0, 50, 50]), (graph) => {
      const element = host();
      Object.defineProperty(element, "offsetWidth", { configurable: true, value: 400 });
      Object.defineProperty(element, "offsetHeight", { configurable: true, value: 300 });
      return createRenderer(graph, element, live);
    });
    const renderer = handover.renderer;
    renderer.refresh();
    const labels = (renderer as unknown as { labelRenderer: Record<string, unknown> })
      .labelRenderer;
    // The renderer's own method is wrapped on the instance, not on its class.
    expect(Object.hasOwn(labels, "computeDisplayedNodeLabels")).toBe(true);
    expect(renderer.getNodeDisplayData("2")?.shape).toBe("square");
    expect(renderer.getNodeDisplayData("0")?.shape).toBe("circle");

    // Labels of 40 x 14 px to the right of their node.
    const box = (_: unknown, radius: number) => ({
      minX: radius + 2,
      maxX: radius + 42,
      minY: -7,
      maxY: 7,
    });
    const { blocked, frame } = collidingLabels(renderer, new Set(["0", "1", "2"]), box, {
      rank: (i) => i,
      shape: (i) => view.nodes[i]?.shape ?? "circle",
    });
    // A1 comes first; A2 lies on it, so its label is left out; the far node keeps its label
    // unless it runs out of the panel.
    expect(blocked).toContain(1);
    expect(blocked).not.toContain(0);
    // The frame holds what stays: every node with its shape, and the labels that kept room.
    expect(frame.nodes.map((n) => n.shape)).toEqual(["circle", "circle", "square"]);
    expect(frame.labels.map((l) => l.index)).not.toContain(1);
    renderer.kill();
  });
});
