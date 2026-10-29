import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ElkNode } from "elkjs/lib/elk-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPanel } from "../registry";
import type { AnyPanelPlugin } from "../types";
import { elkInput, elkPositions } from "./elkGraph";
import { type ElkRunner, elkLayout, MAIN_THREAD_ELK_LIMIT, setElkLoader } from "./elkLayout";
import { hierarchyLayout, type LayoutGraph } from "./layoutEngine";
import { buildGraphModel, edgeWidths, nodeSizes } from "./model";
import { type ElkSettings, elkSettings, parseGraphOptions } from "./options";
import { generateGraph } from "./test/generate";
import { layoutRequest, setLayoutWorkerFactory, useGraphLayout } from "./useGraphLayout";
import { buildView, type GraphView } from "./view";

const SETTINGS: ElkSettings = {
  direction: "down",
  nodeSpacing: 30,
  layerSpacing: 80,
  edgeRouting: "orthogonal",
};

/** A root with two children and a grandchild: 0 -> 1, 0 -> 2, 1 -> 3, and a self-loop on 2. */
function tree(): LayoutGraph {
  return {
    count: 4,
    sources: Uint32Array.from([0, 0, 1, 2]),
    targets: Uint32Array.from([1, 2, 3, 2]),
    weights: new Float32Array(4).fill(1),
    sizes: new Float32Array(4).fill(7),
    labels: Float32Array.from([40, 0, 24, 8]),
  };
}

function viewOf(nodes: number, edges: number): GraphView {
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

/** A runner that places node i at (10 i, 20 i), as ELK would answer, and counts its calls. */
function fakeRunner() {
  const answer = async (graph: Parameters<ElkRunner["layoutOnMainThread"]>[0]) => ({
    ...graph,
    children: (graph.children ?? []).map((child, i) => ({ ...child, x: 10 * i, y: 20 * i })),
  });
  return {
    layoutInWorker: vi.fn((graph: Parameters<ElkRunner["layoutInWorker"]>[0]) => answer(graph)),
    layoutOnMainThread: vi.fn(answer),
  };
}

let restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores) restore();
  restores = [];
});

describe("hierarchy layout options", () => {
  it("keep Kalzit's layout by default, with ELK's settings at their defaults", () => {
    const options = parseGraphOptions({});
    expect(options).toMatchObject({
      hierarchyLayout: "kalzit",
      elkDirection: "down",
      elkNodeSpacing: 30,
      elkLayerSpacing: 80,
      elkEdgeRouting: "orthogonal",
    });
    expect(elkSettings(options)).toBeNull();
  });

  it("take ELK with its settings, and bound or drop what is out of range or unknown", () => {
    const options = parseGraphOptions({
      hierarchyLayout: "elk",
      elkDirection: "left",
      elkNodeSpacing: 1,
      elkLayerSpacing: 10_000,
      elkEdgeRouting: "polyline",
    });
    expect(elkSettings(options)).toEqual({
      direction: "left",
      nodeSpacing: 5,
      layerSpacing: 400,
      edgeRouting: "polyline",
    });
    expect(
      parseGraphOptions({
        hierarchyLayout: "radial",
        elkDirection: "diagonal",
        elkNodeSpacing: "wide",
        elkEdgeRouting: "splines",
      }),
    ).toMatchObject({
      hierarchyLayout: "kalzit",
      elkDirection: "down",
      elkNodeSpacing: 30,
      elkEdgeRouting: "orthogonal",
    });
  });
});

describe("ELK graph", () => {
  it("gives ELK boxes with room for labels, its settings and a fixed seed, without self-loops", () => {
    const input = elkInput(tree(), { ...SETTINGS, direction: "right", edgeRouting: "polyline" });
    expect(input.layoutOptions).toMatchObject({
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "30",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.edgeRouting": "POLYLINE",
      "elk.randomSeed": "1",
    });
    expect(input.children?.[0]).toEqual({ id: "n0", width: 14 + 12 + 40, height: 14 });
    expect(input.children?.[1]).toEqual({ id: "n1", width: 14, height: 14 });
    expect(input.edges?.map((edge) => edge.id)).toEqual(["e0", "e1", "e2"]);
  });

  it("reads node centres in graph coordinates and counts edges against the direction", () => {
    const graph = tree();
    const children = [
      { id: "n0", x: 0, y: 0 },
      { id: "n1", x: 0, y: 100 },
      { id: "n2", x: 50, y: 100 },
      // Placed above its parent: the edge 1 -> 3 points upwards.
      { id: "n3", x: 0, y: -100 },
    ];
    const { positions, reversed } = elkPositions({ id: "root", children }, graph, "down");
    expect([...positions]).toEqual([7, -7, 7, -107, 57, -107, 7, 93]);
    expect(reversed).toBe(1);
    expect(() =>
      elkPositions({ id: "root", children: children.slice(1) }, graph, "down"),
    ).toThrow();
  });

  it("lays out the same graph the same way every time, roots on top", async () => {
    const signal = new AbortController().signal;
    const first = await elkLayout(tree(), SETTINGS, signal, false);
    const second = await elkLayout(tree(), SETTINGS, signal, false);
    expect([...first.positions]).toEqual([...second.positions]);
    expect(first.reversed).toBe(0);
    const y = (node: number) => first.positions[2 * node + 1] as number;
    expect(y(0)).toBeGreaterThan(y(1));
    expect(y(1)).toBeGreaterThan(y(3));
    expect(y(1)).toBe(y(2));
  });
});

describe("ELK in the hierarchy panel", () => {
  it("does not load ELK while the panel keeps Kalzit's layout", () => {
    const loader = vi.fn(async () => fakeRunner());
    restores.push(
      setElkLoader(loader),
      setLayoutWorkerFactory(() => null),
    );
    const view = viewOf(40, 60);
    const { result } = renderHook(() => useGraphLayout(view, "hierarchy"));
    expect(loader).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ engine: "kalzit", notice: null, running: false });
    const kalzit = hierarchyLayout(layoutRequest(view, "hierarchy", 1, new Map()));
    expect(result.current.positions).toEqual(kalzit.positions);
  });

  it("loads ELK on first use, in a worker where there is one, and shows its positions", async () => {
    const runner = fakeRunner();
    const loader = vi.fn(async () => runner);
    restores.push(setElkLoader(loader));
    vi.stubGlobal("Worker", class {});
    const view = viewOf(40, 60);
    const { result } = renderHook(() => useGraphLayout(view, "hierarchy", SETTINGS));
    expect(result.current).toMatchObject({ engine: "elk", running: true });
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(runner.layoutInWorker).toHaveBeenCalledTimes(1);
    expect(runner.layoutOnMainThread).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ engine: "elk", notice: null, worker: true });
    expect(result.current.positions?.[2]).toBe(10 + (view.nodes[1]?.size ?? 0));
  });

  it("falls back to Kalzit's layout with a notice when ELK fails to load", async () => {
    restores.push(
      setElkLoader(async () => {
        throw new Error("chunk failed");
      }),
      setLayoutWorkerFactory(() => null),
    );
    const view = viewOf(40, 60);
    const { result } = renderHook(() => useGraphLayout(view, "hierarchy", SETTINGS));
    await waitFor(() => expect(result.current.notice).toBe("elkFailed"));
    const kalzit = hierarchyLayout(layoutRequest(view, "hierarchy", 1, new Map()));
    expect(result.current).toMatchObject({ engine: "kalzit", running: false });
    expect(result.current.positions).toEqual(kalzit.positions);
  });

  it("keeps Kalzit's layout for large graphs when ELK would run on the page", async () => {
    const loader = vi.fn(async () => fakeRunner());
    restores.push(
      setElkLoader(loader),
      setLayoutWorkerFactory(() => null),
    );
    const view = viewOf(MAIN_THREAD_ELK_LIMIT + 1, MAIN_THREAD_ELK_LIMIT);
    const { result } = renderHook(() => useGraphLayout(view, "hierarchy", SETTINGS));
    await waitFor(() => expect(result.current.notice).toBe("elkTooLarge"));
    expect(loader).not.toHaveBeenCalled();
    expect(result.current.engine).toBe("kalzit");
  });

  it("runs small graphs on the page without a worker", async () => {
    const runner = fakeRunner();
    restores.push(setElkLoader(async () => runner));
    const view = viewOf(20, 30);
    const { result } = renderHook(() => useGraphLayout(view, "hierarchy", SETTINGS));
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(runner.layoutOnMainThread).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ engine: "elk", worker: false });
  });

  it("starts no new layout for the same settings in a new object, and drops a stale answer", async () => {
    let finish: (() => void) | undefined;
    const runner = fakeRunner();
    const slow: ElkRunner = {
      layoutInWorker: runner.layoutInWorker,
      layoutOnMainThread: vi.fn(
        (graph: ElkNode) =>
          new Promise<ElkNode>((resolve) => {
            finish = () => resolve(runner.layoutOnMainThread(graph));
          }),
      ),
    };
    restores.push(
      setElkLoader(async () => slow),
      setLayoutWorkerFactory(() => null),
    );
    const view = viewOf(20, 30);
    const { result, rerender } = renderHook(
      ({ elk }: { elk: ElkSettings | null }) => useGraphLayout(view, "hierarchy", elk),
      { initialProps: { elk: { ...SETTINGS } as ElkSettings | null } },
    );
    rerender({ elk: { ...SETTINGS } });
    await waitFor(() => expect(slow.layoutOnMainThread).toHaveBeenCalledTimes(1));
    // Back to Kalzit's layout before ELK answers: the late answer is not shown.
    rerender({ elk: null });
    await act(async () => finish?.());
    expect(result.current).toMatchObject({ engine: "kalzit", notice: null });
  });
});

describe("hierarchy editor", () => {
  it("offers the layout, and ELK's settings once ELK is picked", async () => {
    const user = userEvent.setup();
    const plugin = getPanel("hierarchy") as AnyPanelPlugin;
    const { Editor } = plugin;
    const onChange = vi.fn();
    const view = render(<Editor options={plugin.options({})} onChange={onChange} />);
    const layout = await screen.findByRole("combobox", { name: "Layout" }, { timeout: 4_000 });
    expect(screen.queryByRole("combobox", { name: "Direction" })).toBeNull();
    await user.selectOptions(layout, "elk");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ hierarchyLayout: "elk" }));

    view.rerender(
      <Editor options={plugin.options({ hierarchyLayout: "elk" })} onChange={onChange} />,
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Direction" }), "right");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ hierarchyLayout: "elk", elkDirection: "right" }),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Edge routing" }), "polyline");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ elkEdgeRouting: "polyline" }),
    );
    const spacing = screen.getByRole("textbox", { name: "Node spacing (px)" });
    await user.clear(spacing);
    await user.type(spacing, "45");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ elkNodeSpacing: 45 }));
    const layers = screen.getByRole("textbox", { name: "Layer spacing (px)" });
    await user.clear(layers);
    await user.type(layers, "5");
    expect(layers.getAttribute("aria-invalid")).toBe("true");
  });

  it("has no layout choice in the network editor", async () => {
    const plugin = getPanel("network") as AnyPanelPlugin;
    const { Editor } = plugin;
    render(<Editor options={plugin.options({})} onChange={vi.fn()} />);
    await screen.findByRole("combobox", { name: "Action" }, { timeout: 4_000 });
    expect(screen.queryByRole("group", { name: "Layout" })).toBeNull();
  });
});
