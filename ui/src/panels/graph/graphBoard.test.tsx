import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GraphSet } from "../../api/generated/shapes";
import { FAKE_GRAPH, ID } from "../../features/datasources/test/fakeGraph";
import { optionLabels, pickOption } from "../../test/select";
import { type PanelHost, PanelHostContext } from "../host";
import { pathWeight } from "../path/PathPanel";
import { getPanel } from "../registry";
import type { AnyPanelPlugin } from "../types";
import { hierarchyElk, useViewDirection } from "./direction";
import { GraphToolbar, type GraphToolbarProps } from "./GraphToolbar";
import { buildGraphModel } from "./model";
import { ELK_NODE_SPACING, type ElkDirection, parseGraphOptions } from "./options";

/** The graph panels as the Graph board has them: toolbar, states, legend footer, paths. */

const RANGE = { from: 0, to: 1 };

async function renderGraph(type: string, graph: GraphSet | null, host: PanelHost = {}) {
  const plugin = getPanel(type) as AnyPanelPlugin;
  const { Panel } = plugin;
  render(
    <PanelHostContext value={host}>
      <Panel
        frames={[]}
        graphs={graph === null ? [] : [{ refId: "A", datasourceId: "ds", graph }]}
        options={plugin.options({})}
        timeRange={RANGE}
        title="Shop"
      />
    </PanelHostContext>,
  );
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull(), { timeout: 4_000 });
}

function toolbar(patch: Partial<GraphToolbarProps> = {}) {
  const props: GraphToolbarProps = {
    title: "Shop",
    drawn: true,
    drawable: true,
    layout: { value: "force", onChange: vi.fn() },
    direction: null,
    display: "graph",
    onDisplay: vi.fn(),
    explorer: { on: false, disabled: false, note: null, onToggle: vi.fn() },
    onCloseGroups: null,
    onZoom: vi.fn(),
    onFit: vi.fn(),
    ...patch,
  };
  render(<GraphToolbar {...props} />);
  return props;
}

describe("graph toolbar", () => {
  it("has zoom icons, Show all, the layout, Graph and Table as one choice, and the explorer", async () => {
    const user = userEvent.setup();
    const props = toolbar();
    const tools = screen.getByRole("group", { name: "Graph tools for Shop" });
    await user.click(within(tools).getByRole("button", { name: "Zoom in" }));
    expect(props.onZoom).toHaveBeenLastCalledWith(1.5);
    await user.click(within(tools).getByRole("button", { name: "Show all" }));
    expect(props.onFit).toHaveBeenCalled();
    expect(within(tools).getByRole("combobox", { name: "Layout" })).toBeTruthy();
    const view = within(tools).getByRole("group", { name: "View" });
    const graph = within(view).getByRole("button", { name: "Graph" });
    const table = within(view).getByRole("button", { name: "Table" });
    expect(graph.getAttribute("aria-pressed")).toBe("true");
    expect(table.getAttribute("aria-pressed")).toBe("false");
    await user.click(table);
    expect(props.onDisplay).toHaveBeenLastCalledWith("table");
    await user.click(within(tools).getByRole("button", { name: "Explorer" }));
    expect(props.explorer?.onToggle).toHaveBeenCalled();
    // A hierarchy has no direction until it shows one.
    expect(within(tools).queryByRole("combobox", { name: "Direction" })).toBeNull();
  });

  it("offers a hierarchy's direction instead of the layout", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    toolbar({
      layout: null,
      direction: { value: "down", choices: ["down", "right"], onChange },
    });
    expect(screen.queryByRole("combobox", { name: "Layout" })).toBeNull();
    const direction = screen.getByRole("combobox", { name: "Direction" });
    expect(optionLabels(direction)).toEqual(["Top to bottom", "Left to right"]);
    await pickOption(user, direction, "right");
    expect(onChange).toHaveBeenLastCalledWith("right");
  });

  it("leaves out zoom without a drawing and the choices where nothing can be drawn", () => {
    toolbar({ drawn: false, drawable: false });
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    expect(screen.queryByRole("group", { name: "View" })).toBeNull();
    expect(screen.getByRole("button", { name: "Explorer" })).toBeTruthy();
  });
});

describe("graph panel states", () => {
  it("offers Edit query on an empty result to those who may edit the panel", async () => {
    const user = userEvent.setup();
    const editQuery = vi.fn();
    await renderGraph("network", null, { editQuery });
    expect(screen.getByText("The query returned no data.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Edit query" }));
    expect(editQuery).toHaveBeenCalled();
  });

  it("offers no Edit query without the right to edit", async () => {
    await renderGraph("path", FAKE_GRAPH);
    expect(screen.getByText(/The result has no paths/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit query" })).toBeNull();
  });

  it("offers Edit query when a result has no paths", async () => {
    await renderGraph("path", FAKE_GRAPH, { editQuery: vi.fn() });
    expect(screen.getByRole("button", { name: "Edit query" })).toBeTruthy();
  });
});

describe("graph footer and summary", () => {
  it("says what the node sizes stand for under the legend", async () => {
    await renderGraph("network", FAKE_GRAPH);
    expect(screen.getByText("Size by number of edges")).toBeTruthy();
  });

  it("names the selection with Escape as the key that clears it", async () => {
    const user = userEvent.setup();
    await renderGraph("network", FAKE_GRAPH);
    await user.click(screen.getByRole("button", { name: "Ada" }));
    const hint = document.querySelector(".graph__summary-hint");
    expect(hint?.textContent?.replace(/\s+/g, " ").trim()).toBe("Selected: Ada · Esc clears it");
  });
});

describe("path weight", () => {
  const weighted: GraphSet = {
    ...FAKE_GRAPH,
    edges: FAKE_GRAPH.edges.map((edge, i) => ({
      ...edge,
      properties: { ...edge.properties, weight: i + 1.5 },
    })),
    paths: [{ nodes: [ID.grace, ID.lamp, ID.ada], edges: [ID.b3, ID.b1] }],
  };

  it("sums the first weight property every edge of the path has", () => {
    const model = buildGraphModel([weighted], { nodeLimit: 100, caption: "" });
    const b1 = weighted.edges.findIndex((e) => e.id === ID.b1) + 1.5;
    const b3 = weighted.edges.findIndex((e) => e.id === ID.b3) + 1.5;
    expect(pathWeight(model, { edges: [ID.b3, ID.b1] })).toBe(b1 + b3);
    // No weight on any edge: no total.
    const plain = buildGraphModel([FAKE_GRAPH], { nodeLimit: 100, caption: "" });
    expect(pathWeight(plain, { edges: [ID.b3, ID.b1] })).toBeNull();
    expect(pathWeight(model, { edges: [] })).toBeNull();
  });

  it("shows the total weight with the path and in the table", async () => {
    const user = userEvent.setup();
    await renderGraph("path", weighted);
    const list = screen.getByRole("list", { name: "Shop" });
    expect(within(list).getByText(/^· total weight \d/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show as table" }));
    expect(screen.getByRole("columnheader", { name: "Total weight" })).toBeTruthy();
  });
});

describe("hierarchy direction", () => {
  it("lays out with ELK for any direction but down, and keeps Kalzit's layers for down", () => {
    const kalzit = parseGraphOptions({});
    expect(hierarchyElk(kalzit, "down")).toBeNull();
    expect(hierarchyElk(kalzit, "right")).toMatchObject({
      direction: "right",
      nodeSpacing: ELK_NODE_SPACING.default,
    });
    const elk = parseGraphOptions({ hierarchyLayout: "elk", elkNodeSpacing: 45 });
    expect(hierarchyElk(elk, "down")).toMatchObject({ direction: "down", nodeSpacing: 45 });
  });

  it("keeps the direction chosen in the view until the options set another", () => {
    const { result, rerender } = renderHook(
      ({ from }: { from: ElkDirection }) => useViewDirection(from),
      { initialProps: { from: "down" as ElkDirection } },
    );
    act(() => result.current[1]("right"));
    rerender({ from: "down" });
    expect(result.current[0]).toBe("right");
    rerender({ from: "up" });
    expect(result.current[0]).toBe("up");
  });

  it("offers the legend footer for one label when the sizes stand for something", async () => {
    const one: GraphSet = {
      ...FAKE_GRAPH,
      nodes: FAKE_GRAPH.nodes.map((node) => ({ ...node, labels: ["Thing"] })),
    };
    await renderGraph("network", one);
    expect(screen.getByText("Size by number of edges")).toBeTruthy();
  });
});
