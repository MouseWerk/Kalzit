import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GraphSet } from "../../api/generated/shapes";
import { FAKE_GRAPH } from "../../features/datasources/test/fakeGraph";
import { type PanelHost, PanelHostContext } from "../host";
import { pathSteps } from "../path";
import { getPanel, suggestPanel } from "../registry";
import type { AnyPanelPlugin } from "../types";
import { buildGraphModel } from "./model";

const RANGE = { from: 0, to: 1 };

function renderGraph(type: string, graph: GraphSet, options: unknown = {}, host: PanelHost = {}) {
  const plugin = getPanel(type) as AnyPanelPlugin;
  const { Panel } = plugin;
  return render(
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
}

describe("network panel", () => {
  it("shows the graph as tables where it cannot draw, with the reason", () => {
    renderGraph("network", FAKE_GRAPH);
    expect(screen.getByText(/WebGL 2 is missing/)).toBeTruthy();
    const nodes = screen.getByRole("table", { name: "Nodes of Shop: 4" });
    expect(within(nodes).getByRole("button", { name: "Ada" })).toBeTruthy();
    const edges = screen.getByRole("table", { name: "Edges of Shop: 3" });
    expect(within(edges).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText(/4 nodes, 3 edges, 1 components/)).toBeTruthy();
  });

  it("selects a node, shows its metrics and properties, and Escape clears it", async () => {
    const user = userEvent.setup();
    renderGraph("network", FAKE_GRAPH);
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

  it("cuts to the node limit with a notice, and shows the source's own notices", () => {
    renderGraph(
      "network",
      {
        ...FAKE_GRAPH,
        truncated: { limit: 4, reason: "graph.node_limit" },
        notices: [{ severity: "warning", code: "graph.node_limit", text: "Cut at 4 nodes." }],
      },
      { nodeLimit: 2 },
    );
    expect(screen.getByText(/Showing the 2 best connected of 4 nodes/)).toBeTruthy();
    // A notice code this UI has no text for shows the server's English text.
    expect(screen.getByText("Cut at 4 nodes.")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Nodes of Shop: 2" })).toBeTruthy();
  });

  it("sets the dashboard variable a click names, to the chosen property", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    renderGraph(
      "network",
      FAKE_GRAPH,
      { variable: "customerId", variableProperty: "customerId" },
      { variables: { names: ["customerId"], set } },
    );
    await user.click(screen.getByRole("button", { name: "Grace" }));
    expect(set).toHaveBeenCalledWith("customerId", "43");
    expect(screen.getByRole("status").textContent).toBe("$customerId is now 43");
  });

  it("does not set a variable the dashboard does not define", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    renderGraph("network", FAKE_GRAPH, { variable: "gone" }, { variables: { names: ["x"], set } });
    await user.click(screen.getByRole("button", { name: "Grace" }));
    expect(set).not.toHaveBeenCalled();
  });

  it("shows the graph at a point in time with the time slider", () => {
    renderGraph("network", FAKE_GRAPH, { timeProperty: "at" });
    const slider = screen.getByRole("slider", { name: "Graph at" });
    expect(screen.getByRole("table", { name: "Edges of Shop: 3" })).toBeTruthy();
    fireEvent.change(slider, { target: { value: "0" } });
    // Only the first purchase: Grace and the desk come later.
    expect(screen.getByRole("table", { name: "Edges of Shop: 1" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Nodes of Shop: 2" })).toBeTruthy();
    expect(slider.getAttribute("aria-valuetext")).toMatch(/2026/);
  });
});

describe("hierarchy panel", () => {
  it("never groups nodes", () => {
    const plugin = getPanel("hierarchy") as AnyPanelPlugin;
    expect(plugin.options({ cluster: "label" }).cluster).toBe("off");
    renderGraph("hierarchy", FAKE_GRAPH);
    expect(screen.getByRole("table", { name: "Nodes of Shop: 4" })).toBeTruthy();
  });
});

describe("path panel", () => {
  const withPath: GraphSet = {
    ...FAKE_GRAPH,
    paths: [{ nodes: ["c2", "p1", "c1", "p2"], edges: ["b3", "b1", "b2"] }],
  };

  it("reads each path as node, edge, node with each edge's direction", () => {
    const steps = pathSteps(buildGraphModel([withPath], { nodeLimit: 100, caption: "" }), {
      nodes: ["c2", "p1", "c1"],
      edges: ["b3", "b1"],
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

  it("lists the paths readably, also for screen readers", () => {
    renderGraph("path", withPath);
    const list = screen.getByRole("list", { name: "Shop" });
    expect(within(list).getByRole("heading", { name: "Path 1, 3 steps" })).toBeTruthy();
    expect(within(list).getAllByText("comes from")).toHaveLength(1);
    expect(within(list).getAllByText("leads to")).toHaveLength(2);
  });

  it("says when the result has no paths", () => {
    renderGraph("path", FAKE_GRAPH);
    expect(screen.getByText(/The result has no paths/)).toBeTruthy();
  });

  it("sets a variable from a node of a path", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    renderGraph(
      "path",
      withPath,
      { variable: "customerId" },
      { variables: { names: ["customerId"], set } },
    );
    await user.click(screen.getAllByRole("button", { name: "Ada" })[0] as HTMLElement);
    expect(set).toHaveBeenCalledWith("customerId", "c1");
  });
});

describe("registry", () => {
  it("suggests the network for graphs and the path panel when every graph is paths", () => {
    expect(suggestPanel([{ shape: "graph", graph: FAKE_GRAPH }])).toBe("network");
    expect(
      suggestPanel([
        { shape: "graph", graph: { ...FAKE_GRAPH, paths: [{ nodes: ["c1"], edges: [] }] } },
      ]),
    ).toBe("path");
  });
});
