import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GraphSet } from "../../api/generated/shapes";
import { cutGraph, FAKE_GRAPH, ID } from "../../features/datasources/test/fakeGraph";
import { type PanelHost, PanelHostContext } from "../host";
import { pathSteps } from "../path/PathPanel";
import { getPanel, suggestPanel } from "../registry";
import type { AnyPanelPlugin } from "../types";
import { buildGraphModel } from "./model";

const RANGE = { from: 0, to: 1 };

/** Renders a graph panel and waits for its code, which loads with the first use. */
async function renderGraph(
  type: string,
  graph: GraphSet,
  options: unknown = {},
  host: PanelHost = {},
) {
  const plugin = getPanel(type) as AnyPanelPlugin;
  const { Panel } = plugin;
  const view = render(
    <PanelHostContext value={host}>
      <Panel
        frames={[]}
        graphs={[{ refId: "A", datasourceId: "ds", graph }]}
        options={plugin.options(options)}
        timeRange={RANGE}
        title="Shop"
      />
    </PanelHostContext>,
  );
  // The first render of a file loads the panel's module, which takes a moment on a busy machine.
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull(), { timeout: 4_000 });
  return view;
}

describe("network panel", () => {
  it("shows the graph as tables where it cannot draw, with the reason", async () => {
    await renderGraph("network", FAKE_GRAPH);
    expect(screen.getByText(/WebGL 2 is missing/)).toBeTruthy();
    const nodes = screen.getByRole("table", { name: "Nodes of Shop: 4" });
    expect(within(nodes).getByRole("button", { name: "Ada" })).toBeTruthy();
    const edges = screen.getByRole("table", { name: "Edges of Shop: 3" });
    expect(within(edges).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText(/4 nodes, 3 edges, 1 component\./)).toBeTruthy();
  });

  it("selects a node, shows its metrics and properties, and Escape clears it", async () => {
    const user = userEvent.setup();
    await renderGraph("network", FAKE_GRAPH);
    await user.click(screen.getByRole("button", { name: "Ada" }));
    const details = screen.getByRole("region", { name: "Details of Ada" });
    expect(within(details).getByText("2 (0 in, 2 out)")).toBeTruthy();
    expect(within(details).getByText("1, 4 nodes")).toBeTruthy();
    expect(within(details).getByText("42")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Ada, Customer, 2 edges");
    expect(screen.getByRole("button", { name: "Ada" }).getAttribute("aria-pressed")).toBe("true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Details of Ada" })).toBeNull();
  });

  it("cuts to the node limit with a notice, and shows the source's own notices", async () => {
    await renderGraph("network", cutGraph(FAKE_GRAPH, 4), { nodeLimit: 2 });
    expect(screen.getByText(/Showing the 2 best connected of 4 nodes/)).toBeTruthy();
    // A notice code this UI has no text for shows the server's English text.
    expect(screen.getByText("The graph was cut at 4 nodes.")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Nodes of Shop: 2" })).toBeTruthy();
  });

  it("sets the dashboard variable a click names, to the chosen property", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    await renderGraph(
      "network",
      FAKE_GRAPH,
      { variable: "customerId", variableProperty: "customerId" },
      { variables: { names: ["customerId"], accepts: () => true, set } },
    );
    await user.click(screen.getByRole("button", { name: "Grace" }));
    expect(set).toHaveBeenCalledWith("customerId", "43");
    expect(screen.getByRole("status").textContent).toBe("$customerId is now 43");
  });

  it("does not set a variable the dashboard does not define", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    await renderGraph(
      "network",
      FAKE_GRAPH,
      { variable: "gone" },
      { variables: { names: ["x"], accepts: () => true, set } },
    );
    await user.click(screen.getByRole("button", { name: "Grace" }));
    expect(set).not.toHaveBeenCalled();
  });

  it("shows the graph at a point in time with the time slider", async () => {
    await renderGraph("network", FAKE_GRAPH, { timeProperty: "at" });
    const slider = screen.getByRole("slider", { name: "Graph at" });
    expect(screen.getByRole("table", { name: "Edges of Shop: 3" })).toBeTruthy();
    // Dragging: the slider follows each step, the graph only once it rests.
    fireEvent.change(slider, { target: { value: "1" } });
    fireEvent.change(slider, { target: { value: "0" } });
    expect(slider.getAttribute("aria-valuetext")).toMatch(/2026/);
    expect(screen.getByRole("table", { name: "Edges of Shop: 3" })).toBeTruthy();
    // Only the first purchase: Grace and the desk come later.
    expect(await screen.findByRole("table", { name: "Edges of Shop: 1" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Nodes of Shop: 2" })).toBeTruthy();
  });

  it("refuses a value a custom variable does not offer, and says so", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    await renderGraph(
      "network",
      FAKE_GRAPH,
      { variable: "region", variableProperty: "customerId" },
      { variables: { names: ["region"], accepts: (_, value) => value === "42", set } },
    );
    await user.click(screen.getByRole("button", { name: "Grace" }));
    expect(set).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(
      "$region has no value 43, so it stays as it is.",
    );
    await user.click(screen.getByRole("button", { name: "Ada" }));
    expect(set).toHaveBeenCalledWith("region", "42");
  });
});

describe("hierarchy panel", () => {
  it("never groups nodes", async () => {
    const plugin = getPanel("hierarchy") as AnyPanelPlugin;
    expect(plugin.options({ cluster: "label" }).cluster).toBe("off");
    await renderGraph("hierarchy", FAKE_GRAPH);
    expect(screen.getByRole("table", { name: "Nodes of Shop: 4" })).toBeTruthy();
  });
});

describe("path panel", () => {
  const withPath: GraphSet = {
    ...FAKE_GRAPH,
    paths: [{ nodes: [ID.grace, ID.lamp, ID.ada, ID.desk], edges: [ID.b3, ID.b1, ID.b2] }],
  };

  it("reads each path as node, edge, node with each edge's direction", async () => {
    const steps = pathSteps(buildGraphModel([withPath], { nodeLimit: 100, caption: "" }), {
      nodes: [ID.grace, ID.lamp, ID.ada],
      edges: [ID.b3, ID.b1],
    });
    expect(steps.map((s) => [s.text, s.forward])).toEqual([
      ["Grace", undefined],
      ["BOUGHT", true],
      ["Lamp", undefined],
      // Walked from the lamp back to Ada, against the edge Ada -> lamp.
      ["BOUGHT", false],
      ["Ada", undefined],
    ]);
  });

  it("lists the paths readably, also for screen readers", async () => {
    await renderGraph("path", withPath);
    const list = screen.getByRole("list", { name: "Shop" });
    expect(within(list).getByRole("heading", { name: "Path 1, 3 steps" })).toBeTruthy();
    expect(within(list).getAllByText("comes from")).toHaveLength(1);
    expect(within(list).getAllByText("leads to")).toHaveLength(2);
  });

  it("says when the result has no paths", async () => {
    await renderGraph("path", FAKE_GRAPH);
    expect(screen.getByText(/The result has no paths/)).toBeTruthy();
  });

  it("sets a variable from a node of a path", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    await renderGraph(
      "path",
      withPath,
      { variable: "customerId" },
      { variables: { names: ["customerId"], accepts: () => true, set } },
    );
    await user.click(screen.getAllByRole("button", { name: "Ada" })[0] as HTMLElement);
    expect(set).toHaveBeenCalledWith("customerId", ID.ada);
    // Announced, as the network panel does.
    expect(screen.getByRole("status").textContent).toBe(`$customerId is now ${ID.ada}`);
  });
});

describe("registry", () => {
  it("suggests the network for graphs and the path panel when every graph is paths", async () => {
    expect(suggestPanel([{ shape: "graph", graph: FAKE_GRAPH }])).toBe("network");
    expect(
      suggestPanel([
        { shape: "graph", graph: { ...FAKE_GRAPH, paths: [{ nodes: [ID.ada], edges: [] }] } },
      ]),
    ).toBe("path");
  });
});
