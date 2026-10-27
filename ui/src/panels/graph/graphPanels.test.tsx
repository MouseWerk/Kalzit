import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GraphSet } from "../../api/generated/shapes";
import { cutGraph, FAKE_GRAPH, ID } from "../../features/datasources/test/fakeGraph";
import { setLanguage } from "../../i18n/i18n";
import { openLayerCount } from "../../lib/layers";
import { type PanelHost, PanelHostContext } from "../host";
import { pathSteps } from "../path/PathPanel";
import { getPanel, suggestPanel } from "../registry";
import type { AnyPanelPlugin } from "../types";
import { HIERARCHY_LIMIT } from "./GraphPanel";
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

  it("leaves the shell's shortcuts working after a node is clicked, and Escape to the page once the focus leaves", async () => {
    const user = userEvent.setup();
    render(
      <button type="button" data-testid="outside">
        outside
      </button>,
    );
    await renderGraph("network", FAKE_GRAPH);
    await user.click(screen.getByRole("button", { name: "Ada" }));
    expect(screen.getByRole("region", { name: "Details of Ada" })).toBeTruthy();
    // The shell holds Ctrl+K, ?, / and F6 back only while a blocking layer (a dialog, a menu) is
    // open; a selected node is none.
    expect(openLayerCount()).toBe(0);
    let reached = false;
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") reached = !event.defaultPrevented;
    };
    document.addEventListener("keydown", listener);
    try {
      // With the focus elsewhere, Escape belongs to the page and keeps the selection.
      await user.click(screen.getByTestId("outside"));
      await user.keyboard("{Escape}");
      expect(reached).toBe(true);
      expect(screen.getByRole("region", { name: "Details of Ada" })).toBeTruthy();
      // With the focus back in the panel, Escape clears the selection and stays there.
      reached = false;
      act(() => screen.getByRole("button", { name: "Ada" }).focus());
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("region", { name: "Details of Ada" })).toBeNull();
      expect(reached).toBe(false);
    } finally {
      document.removeEventListener("keydown", listener);
    }
  });

  it("cuts to the node limit with a notice, and shows the source's own notices", async () => {
    await renderGraph("network", cutGraph(FAKE_GRAPH, 4), { nodeLimit: 2 });
    expect(screen.getByText(/Showing the 2 best connected of 4 nodes/)).toBeTruthy();
    expect(screen.getByText("The graph was cut at 4 nodes.")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Nodes of Shop: 2" })).toBeTruthy();
  });

  it("shows the source's limits in the UI's language, also for a cut without its own notice", async () => {
    setLanguage("de");
    // The server's notice (English text) and a cut that names only its reason.
    const edgeCut = { ...FAKE_GRAPH, truncated: { limit: 3, reason: "graph.edge_limit" } };
    const plugin = getPanel("network") as AnyPanelPlugin;
    const { Panel } = plugin;
    render(
      <Panel
        frames={[]}
        graphs={[
          { refId: "A", datasourceId: "ds", graph: cutGraph(FAKE_GRAPH, 4) },
          { refId: "B", datasourceId: "ds", graph: edgeCut as GraphSet },
        ]}
        options={plugin.options({})}
        timeRange={RANGE}
        title="Shop"
      />,
    );
    expect(await screen.findByText("Der Graph wurde bei 4 Knoten abgeschnitten.")).toBeTruthy();
    expect(screen.getByText("Der Graph wurde bei 3 Kanten abgeschnitten.")).toBeTruthy();
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
    // The first purchase's time, in the reader's time zone (a runner west of UTC sees 2025).
    const first = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
    expect(slider.getAttribute("aria-valuetext")).toBe(first.format(Date.UTC(2026, 0, 1)));
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

describe("node sheet and keyboard", () => {
  it("shows typed properties and neighbours by edge type, and selects a neighbour", async () => {
    const user = userEvent.setup();
    await renderGraph("network", FAKE_GRAPH);
    await user.click(screen.getByRole("button", { name: "Ada" }));
    const details = screen.getByRole("region", { name: "Details of Ada" });
    expect(within(details).getByText("Customer")).toBeTruthy();
    expect(within(details).getAllByText("Text").length).toBeGreaterThan(0);
    expect(within(details).getByText("Neighbours 2")).toBeTruthy();
    await user.click(within(details).getByRole("button", { name: "Lamp" }));
    expect(screen.getByRole("region", { name: "Details of Lamp" })).toBeTruthy();
  });

  it("adds nodes with Shift, shows only the selection, and pins with the button", async () => {
    const user = userEvent.setup();
    await renderGraph("network", FAKE_GRAPH);
    await user.click(screen.getByRole("button", { name: "Ada" }));
    await user.keyboard("{Shift>}");
    await user.click(
      within(screen.getByRole("table", { name: /^Nodes of/ })).getByRole("button", {
        name: "Lamp",
      }),
    );
    await user.keyboard("{/Shift}");
    expect(screen.getByRole("status").textContent).toBe("Lamp added, 2 selected");
    await user.click(screen.getByRole("button", { name: "Show only the selection" }));
    expect(screen.getByRole("table", { name: "Nodes of Shop: 2" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Edges of Shop: 1" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByRole("table", { name: "Nodes of Shop: 4" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Pin" }));
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(within(pinned).getByText("query result")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("region", { name: "Selection" })).toBeNull();
  });

  it("hides a label from the legend", async () => {
    const user = userEvent.setup();
    await renderGraph("network", FAKE_GRAPH);
    await user.click(screen.getByRole("button", { name: /^Product/ }));
    expect(screen.getByRole("table", { name: "Nodes of Shop: 2" })).toBeTruthy();
  });
});

describe("hierarchy panel", () => {
  it("offers the network instead of a hierarchy above its limit", async () => {
    const nodes = Array.from({ length: HIERARCHY_LIMIT + 1 }, (_, i) => ({
      id: `n${i}`,
      labels: ["L"],
      properties: {},
    }));
    // Shown where the browser can draw; jsdom cannot, so the tables stay the fallback.
    await renderGraph("hierarchy", { ...FAKE_GRAPH, nodes, edges: [] });
    expect(screen.getByRole("table", { name: "Nodes of Shop: 2,001" })).toBeTruthy();
  });

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

  it("folds every path but the first, with its chain, and shows paths as a table", async () => {
    const user = userEvent.setup();
    const two: GraphSet = {
      ...withPath,
      paths: [...(withPath.paths ?? []), { nodes: [ID.ada, ID.lamp], edges: [ID.b1] }],
    };
    await renderGraph("path", two);
    const details = document.querySelectorAll("details");
    expect([...details].map((d) => d.open)).toEqual([true, false]);
    expect(details[1]?.querySelector(".paths__chain")?.textContent).toBe("Ada → Lamp");
    // Edge properties are listed with the edge.
    expect(screen.getAllByText(/quantity 5/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Show as table" }));
    expect(screen.getByRole("table", { name: "Paths of Shop: 2" })).toBeTruthy();
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
    await user.click(
      screen.getAllByRole("button", { name: "Set $customerId to Ada" })[0] as HTMLElement,
    );
    expect(set).toHaveBeenCalledWith("customerId", ID.ada);
    // Announced, as the network panel does.
    expect(screen.getByRole("status").textContent).toBe(`$customerId is now ${ID.ada}`);
  });
});

describe("option texts", () => {
  // The server refuses control characters in these texts (panel_options); a pasted tab or line
  // break must not end up stored.
  it("drops control characters and trims, for every graph panel", () => {
    for (const type of ["network", "hierarchy", "path"]) {
      const plugin = getPanel(type) as AnyPanelPlugin;
      const options = plugin.options({
        caption: " na\tme \n",
        variable: "$cust\u0000omer",
        variableProperty: "\u007fid\u0085",
      }) as Record<string, unknown>;
      expect([options.caption, options.variable, options.variableProperty], type).toEqual([
        "name",
        "customer",
        "id",
      ]);
    }
    const network = getPanel("network") as AnyPanelPlugin;
    const parsed = network.options({
      sizeBy: "si\tze",
      edgeWidthBy: "\tweight",
      timeProperty: `since${"x".repeat(200)}`,
    }) as Record<string, string>;
    expect(parsed.sizeBy).toBe("size");
    expect(parsed.edgeWidthBy).toBe("weight");
    expect(parsed.timeProperty).toHaveLength(100);
  });

  it("stores the path caption trimmed and without a pasted tab", async () => {
    const plugin = getPanel("path") as AnyPanelPlugin;
    const { Editor } = plugin;
    const onChange = vi.fn();
    render(<Editor options={plugin.options({})} onChange={onChange} />);
    const caption = await screen.findByRole("textbox", { name: "Node name property (optional)" });
    fireEvent.change(caption, { target: { value: "  title\tkey " } });
    expect(onChange).toHaveBeenLastCalledWith({
      caption: "titlekey",
      variable: "",
      variableProperty: "",
    });
  });
});

describe("graph panel editor", () => {
  it("offers colors per label, color by property and the click action", async () => {
    const user = userEvent.setup();
    const plugin = getPanel("network") as AnyPanelPlugin;
    const { Editor } = plugin;
    const onChange = vi.fn();
    const view = render(
      <Editor
        options={plugin.options({})}
        onChange={onChange}
        graphLabels={[{ label: "Customer", count: 2 }]}
      />,
    );
    await user.selectOptions(await screen.findByRole("combobox", { name: /^Customer/ }), "chart-4");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ labelColors: { Customer: "chart-4" } }),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Action" }), "expand");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ clickAction: "expand" }));
    view.rerender(<Editor options={plugin.options({ colorBy: "property" })} onChange={onChange} />);
    expect(screen.getByRole("combobox", { name: "Color scheme" })).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Range" }), "fixed");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ colorRange: "fixed" }));
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
