import { describe, expect, it, vi } from "vitest";
import type { GraphSet } from "../../../api/generated/shapes";
import { buildGraphModel, edgeWidths, nodeSizes } from "../model";
import { parseGraphOptions } from "../options";
import { type SpreadInput, spreadNodes } from "../spread";
import { allVisible, buildView, type GraphView } from "../view";
import { EMPTY_VIEW_STATE, readViewState, writeViewState } from "../viewState";
import { menuPlace } from "./ContextMenu";
import { edgeCard, nodeCard } from "./cardContent";
import { parallelEdges } from "./EdgeSheet";
import {
  editsFromPanel,
  editsFromState,
  hide,
  NO_EDITS,
  panelFromEdits,
  pin,
  pinnedIds,
  pinnedPlaces,
  release,
  sameEdits,
  show,
  stateFromEdits,
} from "./edits";
import {
  dropSteps,
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  moveTo,
  pushStep,
  redoable,
  undoable,
} from "./history";
import { cardNames } from "./InfoCardOptions";
import {
  edgeIdOf,
  fixedIndexes,
  hiddenIndexes,
  idsOf,
  nodeIndexOf,
  pinnedForLayouts,
} from "./indexes";
import { fromMini, miniFrame, toMini } from "./Minimap";
import { DEFAULT_SCOPE, nextHit, searchGraph, snippet } from "./search";
import {
  allNodes,
  applyArea,
  edgesOfType,
  edgesWithin,
  inArea,
  inverted,
  neighboursOf,
  nodesInArea,
  shownCounts,
  withoutHidden,
} from "./selection";

/** a -> b -> c, a -> c (two types), d alone. */
const SMALL: GraphSet = {
  nodes: [
    {
      id: "a",
      labels: ["Kunde"],
      properties: { name: "Anna Weber", stadt: "Bremen", umsatz: 7940 },
    },
    {
      id: "b",
      labels: ["Kunde"],
      properties: { name: "Tom Becker", bemerkung: "wechselt ins Jahresabo" },
    },
    { id: "c", labels: ["Produkt"], properties: { name: "Abo Pro" } },
    { id: "d", labels: [], properties: {} },
  ],
  edges: [
    { id: "ab", type: "KENNT", from: "a", to: "b", properties: {} },
    { id: "bc", type: "KAUFTE", from: "b", to: "c", properties: { betrag: 349 } },
    { id: "ac", type: "KAUFTE", from: "a", to: "c", properties: { betrag: 329, kanal: "Web" } },
    { id: "ca", type: "EMPFIEHLT", from: "c", to: "a", properties: {} },
  ],
  schema: { labels: ["Kunde", "Produkt"], edgeTypes: [], propertyKeys: {} },
};

function model() {
  return buildGraphModel([SMALL], { nodeLimit: 100, caption: "name" });
}

function view(m = model(), cluster = false): GraphView {
  return buildView(m, {
    sizes: nodeSizes(m, "degree"),
    widths: edgeWidths(m, ""),
    groups: Int32Array.from(m.nodes, (n) => n.label),
    cluster,
    open: new Set(),
    clusterCaption: (label, members) => `${label} (${members})`,
    unlabelled: "none",
  });
}

describe("view edits", () => {
  it("pins with places, releases the panel's pins as released, and hides and shows", () => {
    const panel = [{ id: "p", x: 1, y: 2 }];
    let edits = pin(NO_EDITS, ["a", "b"], new Map([["a", [10, 20] as const]]));
    expect(edits.pins).toEqual(["a", "b"]);
    expect(pinnedPlaces(edits, panel)).toEqual(
      new Map([
        ["p", [1, 2]],
        ["a", [10, 20]],
      ]),
    );
    expect(pinnedIds(edits, panel)).toEqual(["p", "a", "b"]);
    edits = release(edits, ["a", "p"], panel);
    expect(edits.pins).toEqual(["b"]);
    expect(edits.released).toEqual(["p"]);
    expect(pinnedIds(edits, panel)).toEqual(["b"]);
    // Pinned again, the panel's node is no longer released.
    expect(pin(edits, ["p"]).released).toEqual([]);
    edits = hide(edits, ["c"], ["ab"]);
    expect(show(edits, ["ab"]).hiddenEdges).toEqual([]);
    expect(show(edits)).toMatchObject({ hidden: [], hiddenEdges: [] });
    expect(sameEdits(edits, { ...edits, places: new Map(edits.places) })).toBe(true);
    expect(sameEdits(edits, hide(edits, ["d"]))).toBe(false);
  });

  it("goes to the kept state and back, keeping a place only with its pin", () => {
    const state = {
      ...EMPTY_VIEW_STATE,
      pinned: ["a"],
      selected: ["b"],
      positions: [
        { id: "a", x: 1.5, y: -2 },
        { id: "z", x: 0, y: 0 },
      ],
      hidden: ["c"],
    };
    const edits = editsFromState(state);
    expect([...edits.places.keys()]).toEqual(["a"]);
    expect(stateFromEdits(edits, ["b"])).toEqual({
      ...state,
      positions: [{ id: "a", x: 1.5, y: -2 }],
    });
  });

  it("works on the panel's own pins in the editor", () => {
    const panel = [{ id: "p", x: 1, y: 2 }];
    const edits = editsFromPanel(panel, hide(NO_EDITS, ["c"]));
    expect(edits.pins).toEqual(["p"]);
    expect(edits.hidden).toEqual(["c"]);
    expect(panelFromEdits(pin(edits, ["q"], new Map([["q", [3, 4] as const]])))).toEqual([
      { id: "p", x: 1, y: 2 },
      { id: "q", x: 3, y: 4 },
    ]);
    // A pin without a place is not one the panel can keep.
    expect(panelFromEdits(pin(edits, ["r"]))).toHaveLength(1);
  });
});

describe("panel view state", () => {
  it("sends the new lists only while they hold something, as the server answers", () => {
    expect(writeViewState({ ...EMPTY_VIEW_STATE, pinned: ["a"] })).toEqual({
      pinned: ["a"],
      selected: [],
    });
    expect(
      writeViewState({
        ...EMPTY_VIEW_STATE,
        positions: [{ id: "a", x: 1.234, y: 2 }],
        hiddenEdges: ["e"],
      }),
    ).toEqual({
      pinned: [],
      selected: [],
      positions: [{ id: "a", x: 1.23, y: 2 }],
      hiddenEdges: ["e"],
    });
  });

  it("reads only what the server keeps", () => {
    const read = readViewState({
      pinned: ["a", 3],
      positions: [
        { id: "a", x: 1, y: 2 },
        { id: "a", x: 3, y: 4 },
        { id: "b", x: Number.NaN, y: 0 },
        { id: "c", x: 2e9, y: 0 },
        { id: "d", x: "1", y: 0 },
      ],
      hidden: "x",
    });
    expect(read).toEqual({
      ...EMPTY_VIEW_STATE,
      pinned: ["a"],
      positions: [{ id: "a", x: 1, y: 2 }],
    });
    expect(readViewState(null)).toEqual(EMPTY_VIEW_STATE);
  });

  it("parses the panel's pinned nodes and info card choices within the server's bounds", () => {
    const options = parseGraphOptions({
      pinned: [
        { id: "a", x: 1, y: 2 },
        { id: "a", x: 5, y: 5 },
        { id: "b\u0007", x: 0, y: 0 },
        { id: "c", x: 1e12, y: 0 },
      ],
      infoCard: {
        Kunde: ["stadt", "stadt", "umsatz", "seit", "name", "extra"],
        "": ["x"],
        Produkt: "name",
      },
    });
    expect(options.pinned).toEqual([{ id: "a", x: 1, y: 2 }]);
    expect(options.infoCard).toEqual({ Kunde: ["stadt", "umsatz", "seit", "name"] });
    expect(cardNames(" stadt, umsatz,, stadt , seit, name, extra")).toEqual([
      "stadt",
      "umsatz",
      "seit",
      "name",
    ]);
  });
});

describe("view history", () => {
  const step = (id: number) => ({ id, label: `step ${id}`, at: 0, undo: vi.fn(), redo: vi.fn() });

  it("keeps at most 50 steps and forgets what was undone when a new step comes", () => {
    let history = EMPTY_HISTORY;
    for (let i = 1; i <= HISTORY_LIMIT + 5; i++) history = pushStep(history, step(i));
    expect(history.steps).toHaveLength(HISTORY_LIMIT);
    expect(history.steps[0]?.id).toBe(6);
    expect(undoable(history)?.id).toBe(HISTORY_LIMIT + 5);
    expect(redoable(history)).toBeNull();
    history = { ...history, done: history.done - 2 };
    expect(redoable(history)?.id).toBe(HISTORY_LIMIT + 4);
    history = pushStep(history, step(100));
    expect(history.steps.at(-1)?.id).toBe(100);
    expect(redoable(history)).toBeNull();
  });

  it("goes to a step: undoes newest first, redoes oldest first", () => {
    let history = EMPTY_HISTORY;
    for (let i = 1; i <= 4; i++) history = pushStep(history, step(i));
    const back = moveTo(history, 1);
    expect(back.run.map(({ step, way }) => `${way}${step.id}`)).toEqual([
      "undo4",
      "undo3",
      "undo2",
    ]);
    const forth = moveTo(back.history, 3);
    expect(forth.run.map(({ step, way }) => `${way}${step.id}`)).toEqual(["redo2", "redo3"]);
    expect(moveTo(history, 99).history.done).toBe(4);
  });

  it("drops steps that went away on their own and counts the applied ones again", () => {
    let history = EMPTY_HISTORY;
    for (let i = 1; i <= 4; i++) history = pushStep(history, { ...step(i), tag: `explorer:${i}` });
    history = { ...history, done: 3 };
    const dropped = dropSteps(history, (s) => s.id === 2 || s.id === 4);
    expect(dropped.steps.map((s) => s.id)).toEqual([1, 3]);
    expect(dropped.done).toBe(2);
    expect(dropSteps(dropped, () => false)).toBe(dropped);
  });
});

describe("selection", () => {
  const m = model();
  const v = view(m);
  const shown = allVisible(v);
  const at = (id: string) => nodeIndexOf(m, v, id) as number;

  it("takes nodes in a rectangle or a lasso, never ones that are not drawn", () => {
    const points = Float32Array.from([0, 0, 10, 10, 50, 50, Number.NaN, Number.NaN]);
    expect(nodesInArea(points, { kind: "rect", from: [20, 20], to: [-5, -5] })).toEqual([0, 1]);
    const lasso = {
      kind: "lasso" as const,
      points: [
        [40, 40],
        [60, 40],
        [60, 60],
        [40, 60],
      ] as const,
    };
    expect(nodesInArea(points, lasso)).toEqual([2]);
    expect(
      inArea(5, 5, {
        kind: "lasso",
        points: [
          [0, 0],
          [10, 10],
        ],
      }),
    ).toBe(false);
  });

  it("replaces, adds to and takes out of the selection", () => {
    expect(applyArea(["x", "y"], ["y", "z"], "replace")).toEqual(["y", "z"]);
    expect(applyArea(["x", "y"], ["y", "z"], "add")).toEqual(["x", "y", "z"]);
    expect(applyArea(["x", "y"], ["y", "z"], "remove")).toEqual(["x"]);
  });

  it("inverts, selects all, adds neighbours and counts the edges within", () => {
    const selected = new Set([at("a")]);
    expect(inverted(v, shown, selected).sort()).toEqual([at("b"), at("c"), at("d")].sort());
    expect(allNodes(v, shown)).toHaveLength(4);
    expect(neighboursOf(v, shown, selected).sort()).toEqual([at("b"), at("c")].sort());
    expect(edgesWithin(v, shown, new Set([at("a"), at("c")]))).toHaveLength(2);
    expect(edgesOfType(v, shown, "KAUFTE")).toHaveLength(2);
  });

  it("hides from the view only, with the edges that lost an end", () => {
    const hidden = hiddenIndexes(m, v, ["a"], ["bc"]);
    const visible = withoutHidden(v, shown, hidden.nodes, hidden.edges);
    expect(shownCounts(visible)).toEqual({ nodes: 3, edges: 0 });
    expect(shownCounts(shown)).toEqual({ nodes: 4, edges: 4 });
    expect(withoutHidden(v, shown, new Set(), new Set())).toBe(shown);
  });
});

describe("ids and view indexes", () => {
  it("maps nodes, edges and groups both ways", () => {
    const m = model();
    const grouped = view(m, true);
    const group = grouped.nodes.findIndex((n) => n.node < 0 && n.members === 2);
    expect(idsOf(m, grouped, group).sort()).toEqual(["a", "b"]);
    expect(nodeIndexOf(m, grouped, "a")).toBeNull();
    // A group is hidden once all its members are.
    expect(hiddenIndexes(m, grouped, ["a"], []).nodes.has(group)).toBe(false);
    expect(hiddenIndexes(m, grouped, ["a", "b"], []).nodes.has(group)).toBe(true);
    const v = view(m);
    const edge = v.edges.findIndex((e) => e.edge >= 0 && m.edges[e.edge]?.id === "ac");
    expect(edgeIdOf(m, v, edge)).toBe("ac");
    const places = new Map([
      ["c", [5, 6] as const],
      ["gone", [0, 0] as const],
    ]);
    expect(fixedIndexes(m, v, places)).toEqual(new Map([[nodeIndexOf(m, v, "c"), [5, 6]]]));
  });

  it("hands the layouts the pinned places and a release only when there is one", () => {
    const release = vi.fn();
    expect(pinnedForLayouts(new Map(), release).release).toBeUndefined();
    const pinned = pinnedForLayouts(new Map([["a", [1, 2] as const]]), release);
    pinned.release?.();
    expect(release).toHaveBeenCalledOnce();
    expect(pinned.positions.get("a")).toEqual([1, 2]);
  });
});

describe("search on the canvas", () => {
  const m = model();

  it("finds captions before properties, without regard to case, and edges when asked", () => {
    const hits = searchGraph(m, "ABO", DEFAULT_SCOPE);
    expect(hits.map((h) => [h.caption, h.property])).toEqual([
      ["Tom Becker", "bemerkung"],
      ["Abo Pro", null],
    ]);
    expect(searchGraph(m, "349", DEFAULT_SCOPE)).toHaveLength(0);
    expect(searchGraph(m, "349", { ...DEFAULT_SCOPE, edges: true })[0]?.kind).toBe("edge");
    expect(searchGraph(m, "  ", DEFAULT_SCOPE)).toEqual([]);
  });

  it("cuts the text around the match and goes round at the ends", () => {
    const part = snippet({ text: `${"x".repeat(40)}abo${"y".repeat(40)}`, start: 40, end: 43 }, 5);
    expect(part).toMatchObject({ before: "xxxxx", match: "abo", after: "yyyyy", cutBefore: true });
    expect(nextHit(3, 2, 1)).toBe(0);
    expect(nextHit(3, 0, -1)).toBe(2);
    expect(nextHit(0, 0, 1)).toBe(-1);
  });
});

describe("info card and edge sheet", () => {
  const m = model();

  it("shows the caption's property first, or the panel's choice per label", () => {
    const anna = m.nodes[m.index.get("a") as number];
    if (anna === undefined) throw new Error("no node");
    expect(nodeCard(anna, {}, "name").properties.map((p) => p.key)).toEqual([
      "name",
      "stadt",
      "umsatz",
    ]);
    expect(nodeCard(anna, { Kunde: ["umsatz", "missing"] }, "name")).toMatchObject({
      properties: [{ key: "umsatz", text: "7940" }],
      total: 3,
    });
    const ac = m.edges.find((e) => e.id === "ac");
    if (ac === undefined) throw new Error("no edge");
    expect(edgeCard(ac).total).toBe(2);
    expect(parallelEdges(m, m.edges.indexOf(ac)).map((i) => m.edges[i]?.id)).toEqual(["ac", "ca"]);
  });
});

describe("minimap and menus", () => {
  it("fits the overview into the minimap, both ways", () => {
    const frame = miniFrame(
      { points: Float32Array.from([0, 0, 10, 5]), view: { from: [2, 4], to: [6, 1] } },
      132,
      88,
    );
    const [px, py] = toMini(frame, 10, 5);
    const [x, y] = fromMini(frame, px, py);
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(5);
    // The renderer's y grows upwards: the top of the drawing is the top of the minimap.
    expect(toMini(frame, 0, 5)[1]).toBeLessThan(toMini(frame, 0, 0)[1]);
  });

  it("keeps a menu inside the window", () => {
    const view = { width: 400, height: 300 };
    const size = { width: 200, height: 150 };
    expect(menuPlace({ x: 10, y: 10 }, size, view)).toEqual({ left: 10, top: 10 });
    expect(menuPlace({ x: 390, y: 290 }, size, view)).toEqual({ left: 190, top: 140 });
  });
});

describe("spreading around pinned nodes", () => {
  function input(): SpreadInput {
    const count = 12;
    const positions = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      positions[2 * i] = (i % 4) * 0.2;
      positions[2 * i + 1] = Math.floor(i / 4) * 0.2;
    }
    positions[0] = -10;
    positions[1] = 6;
    return {
      positions,
      radii: new Float32Array(count).fill(6),
      labels: new Float32Array(count),
      ranks: Int32Array.from({ length: count }, (_, i) => i),
      labelHeight: 14,
      width: 600,
      height: 300,
    };
  }

  it("holds pinned nodes exactly where they are pinned, also far outside the drawing", () => {
    const placed = spreadNodes({
      ...input(),
      fixed: new Map([
        [3, [0.1, 0.1]],
        [5, [500, -500]],
      ]),
    });
    expect([placed.positions[6], placed.positions[7]]).toEqual([
      Math.fround(0.1),
      Math.fround(0.1),
    ]);
    expect([placed.positions[10], placed.positions[11]]).toEqual([500, -500]);
    expect(placed.bbox.x[1]).toBeGreaterThanOrEqual(500);
  });

  it("keeps the corners under the canvas tools free", () => {
    const base = input();
    const placed = spreadNodes({
      ...base,
      keepOut: [{ corner: "topLeft", width: 200, height: 60 }],
    });
    // The far node sat in the top left corner: it is moved out of it.
    expect(placed.positions[0]).not.toBe(base.positions[0]);
  });
});
