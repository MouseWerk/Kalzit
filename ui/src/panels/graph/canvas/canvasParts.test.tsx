import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GraphSet } from "../../../api/generated/shapes";
import { GraphTable } from "../GraphTable";
import { buildGraphModel, edgeWidths, nodeSizes } from "../model";
import { allVisible, buildView } from "../view";
import { ContextMenu } from "./ContextMenu";
import { EMPTY_HISTORY, pushStep } from "./history";
import { ToolStrip, type ToolStripProps } from "./ToolStrip";

const GRAPH: GraphSet = {
  nodes: [
    { id: "a", labels: ["Kunde"], properties: { name: "Anna Weber" } },
    { id: "b", labels: ["Produkt"], properties: { name: "Abo Pro" } },
  ],
  edges: [{ id: "ab", type: "KAUFTE", from: "a", to: "b", properties: {} }],
  schema: { labels: [], edgeTypes: [], propertyKeys: {} },
};

function strip(patch: Partial<ToolStripProps> = {}) {
  const props: ToolStripProps = {
    title: "Shop",
    tool: "pointer",
    locked: false,
    onTool: vi.fn(),
    searching: false,
    onSearch: vi.fn(),
    history: EMPTY_HISTORY,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onGoTo: vi.fn(),
    onZoom: vi.fn(),
    onFit: vi.fn(),
    narrow: false,
    ...patch,
  };
  render(<ToolStrip {...props} />);
  return props;
}

describe("canvas tool strip", () => {
  it("has the selection tools, the search, undo and redo, and zoom; the pressed tool is marked", async () => {
    const user = userEvent.setup();
    const props = strip({ tool: "rect" });
    const tools = screen.getByRole("group", { name: "Canvas tools: Shop" });
    expect(
      within(tools).getByRole("button", { name: "Rectangle" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(within(tools).getByRole("button", { name: "Lasso" }));
    expect(props.onTool).toHaveBeenLastCalledWith("lasso", false);
    await user.dblClick(within(tools).getByRole("button", { name: "Lasso" }));
    expect(props.onTool).toHaveBeenLastCalledWith("lasso", true);
    await user.click(within(tools).getByRole("button", { name: "Zoom in" }));
    expect(props.onZoom).toHaveBeenLastCalledWith(1.5);
    await user.click(within(tools).getByRole("button", { name: "Show all" }));
    expect(props.onFit).toHaveBeenCalled();
    // Nothing to undo yet.
    expect(within(tools).getByRole("button", { name: "Undo" })).toHaveProperty("disabled", true);
  });

  it("lists the history newest first and goes to a step", async () => {
    const user = userEvent.setup();
    const step = (id: number, label: string) => ({
      id,
      label,
      at: Date.now(),
      undo: vi.fn(),
      redo: vi.fn(),
    });
    const history = pushStep(
      pushStep(EMPTY_HISTORY, step(1, "Hidden: Anna")),
      step(2, "Node moved: Abo"),
    );
    const props = strip({ history });
    await user.click(screen.getByRole("button", { name: "Open the history" }));
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent ?? "");
    expect(items[0]).toContain("Node moved: Abo");
    expect(items[1]).toContain("Hidden: Anna");
    await user.click(screen.getByRole("menuitem", { name: /Hidden: Anna/ }));
    expect(props.onGoTo).toHaveBeenLastCalledWith(1);
  });

  it("moves rectangle, lasso, redo and zoom into More on a narrow canvas", () => {
    strip({ narrow: true });
    expect(screen.queryByRole("button", { name: "Lasso" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    expect(screen.getByRole("button", { name: "More tools" })).toBeTruthy();
  });
});

describe("canvas context menu", () => {
  it("focuses the first entry, keeps an unavailable one with its reason, and closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const hide = vi.fn();
    render(
      <ContextMenu
        title="Anna Weber · Kunde"
        at={{ x: 10, y: 10 }}
        host={null}
        onClose={onClose}
        entries={[
          { key: "hide", label: "Hide", shortcut: "graph.hide", onSelect: hide },
          { kind: "separator", key: "s" },
          {
            key: "release",
            label: "Release all",
            unavailable: "Nothing is pinned.",
            onSelect: vi.fn(),
          },
        ]}
      />,
    );
    const menu = screen.getByRole("menu", { name: "Anna Weber · Kunde" });
    const hideItem = within(menu).getByRole("menuitem", { name: /Hide/ });
    expect(document.activeElement).toBe(hideItem);
    // The entry's keys come from the shortcut registry.
    expect(hideItem.getAttribute("aria-keyshortcuts")).toBe("H");
    const release = within(menu).getByRole("menuitem", { name: /Release all/ });
    expect(release.getAttribute("aria-disabled")).toBe("true");
    expect(release.getAttribute("title")).toBe("Nothing is pinned.");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(release);
    await user.click(release);
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledWith(true);
  });
});

describe("graph table view", () => {
  it("pins from a row, selects an edge, lists what is hidden and filters by the search", async () => {
    const user = userEvent.setup();
    const model = buildGraphModel([GRAPH], { nodeLimit: 100, caption: "name" });
    const view = buildView(model, {
      sizes: nodeSizes(model, "degree"),
      widths: edgeWidths(model, ""),
      groups: Int32Array.from(model.nodes, (n) => n.label),
      cluster: false,
      open: new Set(),
      clusterCaption: (label) => label,
      unlabelled: "none",
    });
    const onTogglePin = vi.fn();
    const onSelectEdge = vi.fn();
    const onShow = vi.fn();
    render(
      <GraphTable
        model={model}
        view={view}
        visibility={allVisible(view)}
        selected={new Set()}
        onSelect={vi.fn()}
        title="Shop"
        pinned={["a"]}
        onTogglePin={onTogglePin}
        selectedEdges={new Set()}
        onSelectEdge={onSelectEdge}
        hidden={[{ id: "c", caption: "Gateway G1" }]}
        onShow={onShow}
      />,
    );
    expect(screen.getByRole("button", { name: "Unpin Anna Weber" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Pin Abo Pro" }));
    expect(onTogglePin).toHaveBeenLastCalledWith("b");
    await user.click(screen.getByRole("button", { name: "KAUFTE" }));
    expect(onSelectEdge).toHaveBeenLastCalledWith(0, false);
    await user.click(screen.getByRole("button", { name: "Show Gateway G1" }));
    expect(onShow).toHaveBeenLastCalledWith("c");
    await user.type(screen.getByRole("searchbox", { name: "Search in the table" }), "abo");
    expect(screen.queryByRole("button", { name: "Anna Weber" })).toBeNull();
    expect(screen.getByRole("button", { name: "Abo Pro" })).toBeTruthy();
  });
});
