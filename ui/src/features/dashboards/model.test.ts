import { describe, expect, it } from "vitest";
import { diffModels } from "./diff";
import { buildTree } from "./FolderTree";
import {
  clampGrid,
  cleanVariable,
  emptyModel,
  nextRefId,
  type PanelModel,
  parseModel,
  placePanel,
  readingOrder,
  refIdAt,
} from "./model";
import { createLimiter } from "./queryQueue";

function panel(id: string, x: number, y: number, w = 12, h = 8): PanelModel {
  return {
    id,
    type: "table",
    title: id,
    grid: { x, y, w, h },
    targets: [],
    transformations: [],
    options: {},
    fieldConfig: {},
  };
}

describe("grid layout", () => {
  it("keeps panels inside the 24 columns and at least the minimum size", () => {
    expect(clampGrid({ x: 20, y: -3, w: 8, h: 0 })).toEqual({ x: 16, y: 0, w: 8, h: 2 });
    expect(clampGrid({ x: -1, y: 0, w: 40, h: 4 })).toEqual({ x: 0, y: 0, w: 24, h: 4 });
    // The server's limits: h at most 200, y at most 10,000.
    expect(clampGrid({ x: 0, y: 20_000, w: 6, h: 500 })).toEqual({ x: 0, y: 10_000, w: 6, h: 200 });
  });

  it("pushes overlapped panels down, repeatedly, and leaves others alone", () => {
    const panels = [panel("a", 0, 0), panel("b", 0, 8), panel("c", 0, 16), panel("d", 12, 0)];
    const moved = placePanel(panels, "a", { x: 0, y: 4, w: 12, h: 8 });
    const at = (id: string) => moved.find((p) => p.id === id)?.grid;
    expect(at("a")).toEqual({ x: 0, y: 4, w: 12, h: 8 });
    expect(at("b")?.y).toBe(12);
    expect(at("c")?.y).toBe(20);
    expect(at("d")).toEqual({ x: 12, y: 0, w: 12, h: 8 });
    // The input is not changed.
    expect(panels[1]?.grid.y).toBe(8);
  });

  it("orders panels for reading: top to bottom, then left to right", () => {
    const order = readingOrder([panel("c", 0, 8), panel("b", 12, 0), panel("a", 0, 0)]);
    expect(order.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});

describe("model", () => {
  it("names targets A to Z, then AA, and fills gaps", () => {
    expect([0, 1, 25, 26, 27].map(refIdAt)).toEqual(["A", "B", "Z", "AA", "AB"]);
    const targets = [
      { refId: "A", datasourceId: "x", query: null },
      { refId: "C", datasourceId: "x", query: null },
    ];
    expect(nextRefId(targets)).toBe("B");
  });

  it("parses odd stored models without failing", () => {
    const model = parseModel(
      {
        panels: [{ grid: { x: 30, w: 6 } }, "nonsense"],
        variables: [{ name: "" }, { name: "region" }],
      },
      "Fallback",
    );
    expect(model.title).toBe("Fallback");
    expect(model.timeRange).toEqual({ from: "now-6h", to: "now" });
    expect(model.panels).toHaveLength(1);
    expect(model.panels[0]?.grid).toEqual({ x: 18, y: 0, w: 6, h: 8 });
    expect(model.variables).toEqual([{ name: "region", type: "textbox" }]);
  });

  it("keeps variables as stored, also what this UI does not edit", () => {
    const stored = [
      { name: "tenant", type: "constant", query: { sql: "SELECT 1" }, current: ["a", "b"] },
      { name: "step", type: "interval", options: [60, "5m", { raw: true }], current: 60 },
      { name: "region", type: "custom", options: ["eu"], label: "" },
    ];
    const model = parseModel({ ...emptyModel("x"), variables: stored }, "x");
    const back = JSON.parse(JSON.stringify(model.variables.map(cleanVariable)));
    expect(back).toEqual([
      { name: "tenant", type: "constant", query: { sql: "SELECT 1" }, current: ["a", "b"] },
      { name: "step", type: "interval", options: [60, "5m", { raw: true }], current: 60 },
      // An empty label is dropped; the server wants none rather than "".
      { name: "region", type: "custom", options: ["eu"] },
    ]);
    // A datasourceId stays only on a query variable.
    expect(cleanVariable({ name: "v", type: "custom", datasourceId: "ds" })).toEqual({
      name: "v",
      type: "custom",
    });
  });

  it("describes the changes between two models", () => {
    const before = { ...emptyModel("Sales"), panels: [panel("a", 0, 0), panel("b", 0, 8)] };
    const after = {
      ...before,
      title: "Revenue",
      panels: [{ ...panel("a", 0, 0), title: "a2" }, panel("c", 12, 0)],
    };
    expect(diffModels(before, after)).toEqual([
      { kind: "title", from: "Sales", to: "Revenue" },
      { kind: "panelChanged", title: "a2" },
      { kind: "panelAdded", title: "c" },
      { kind: "panelRemoved", title: "b" },
    ]);
  });
});

describe("folder tree", () => {
  it("nests folders and shows a folder with a hidden parent at the top", () => {
    const folder = (id: string, parentId: string | null) => ({
      id,
      parentId,
      name: id,
      restricted: false,
      version: 1,
      deletedAt: null,
    });
    const tree = buildTree([folder("b", "a"), folder("a", null), folder("orphan", "hidden")]);
    expect(tree.map((n) => n.folder.id)).toEqual(["a", "orphan"]);
    expect(tree[0]?.children.map((n) => n.folder.id)).toEqual(["b"]);
  });
});

describe("query limiter", () => {
  it("runs at most the limit at once and drops queued work that was cancelled", async () => {
    const limiter = createLimiter(2);
    const releases: (() => void)[] = [];
    const started: number[] = [];
    const task = (n: number) => () =>
      new Promise<number>((resolve) => {
        started.push(n);
        releases.push(() => resolve(n));
      });
    const cancel = new AbortController();
    const results = [
      limiter.run(task(1)),
      limiter.run(task(2)),
      limiter.run(task(3), cancel.signal),
      limiter.run(task(4)),
    ];
    expect(started).toEqual([1, 2]);
    expect(limiter.stats()).toEqual({ active: 2, waiting: 2 });

    cancel.abort();
    await expect(results[2]).rejects.toBeDefined();
    releases[0]?.();
    await results[0];
    await Promise.resolve();
    // The cancelled task never started; the next one took its place.
    expect(started).toEqual([1, 2, 4]);
    releases[1]?.();
    releases[2]?.();
    expect(await Promise.all([results[1], results[3]])).toEqual([2, 4]);
    expect(limiter.stats()).toEqual({ active: 0, waiting: 0 });
  });
});
