import { describe, expect, it } from "vitest";
import type { GraphSet } from "../../../api/generated/shapes";
import { edgeDisplay, nodeDisplay, nodeLit, singlesOut } from "../drawing";
import { buildGraphModel } from "../model";
import { allVisible, buildView } from "../view";
import {
  adopted,
  connectSteps,
  edgeWeights,
  emphasisOf,
  loadedGraph,
  pathDetails,
  pathStep,
  ranking,
  topProperty,
  topStep,
  unconnected,
} from "./quickSteps";
import { DIAMOND, diamondAt } from "./suggestions";

const GRAPH: GraphSet = {
  nodes: [
    { id: "a", labels: ["Kunde"], properties: { name: "Anna" } },
    { id: "b", labels: ["Kunde"], properties: { name: "Ben" } },
    { id: "c", labels: ["Produkt"], properties: { name: "Abo" } },
    { id: "d", labels: ["Produkt"], properties: { name: "Dock" } },
  ],
  edges: [
    { id: "e1", type: "KAUFT", from: "a", to: "c", properties: { aufwand: 2 } },
    { id: "e2", type: "KAUFT", from: "b", to: "c", properties: { aufwand: 1 } },
    { id: "e3", type: "KAUFT", from: "b", to: "d", properties: {} },
  ],
  suggested: [{ id: "s1", type: "SUGGESTED", from: "a", to: "b", properties: { score: 1.5 } }],
  schema: { labels: ["Kunde", "Produkt"], edgeTypes: ["KAUFT"], propertyKeys: {} },
};

function setup() {
  const model = buildGraphModel([GRAPH], { nodeLimit: 100, caption: "name" });
  const n = model.nodes.length;
  const view = buildView(model, {
    sizes: new Float32Array(n).fill(10),
    widths: new Float32Array(model.edges.length).fill(1),
    groups: new Int32Array(n),
    cluster: false,
    open: new Set(),
    clusterCaption: (label) => label,
    unlabelled: "",
  });
  return { model, view, visibility: allVisible(view) };
}

describe("quick actions", () => {
  it("send what the canvas holds, without suggestions, and only number weights", () => {
    const { model, view, visibility } = setup();
    const graph = loadedGraph(model, view, visibility);
    expect(graph.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
    expect(graph.edges.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(graph.suggested).toBeUndefined();
    expect(model.suggested).toEqual([
      { id: "s1", type: "SUGGESTED", source: 0, target: 1, score: 1.5 },
    ]);
    expect(model.edges).toHaveLength(3);
    expect(edgeWeights(model)).toEqual(["aufwand"]);
  });

  it("leave hidden edges out of what they send", () => {
    const { model, view, visibility } = setup();
    const edges = visibility.edges.slice();
    edges[view.edgeOf[1] ?? 0] = 0;
    const graph = loadedGraph(model, view, { nodes: visibility.nodes, edges });
    expect(graph.edges.map((e) => e.id)).toEqual(["e1", "e3"]);
  });

  it("list a path's edges with their weights and the sum; missing weights count 1", () => {
    const { model } = setup();
    const details = pathDetails(
      model,
      { nodes: ["a", "c", "b", "d"], edges: ["e1", "e2", "e3"] },
      "aufwand",
    );
    expect(details.edges.map((e) => [e.from, e.to, e.weight])).toEqual([
      ["Anna", "Abo", 2],
      ["Ben", "Abo", 1],
      ["Ben", "Dock", null],
    ]);
    expect(details.sum).toBe(4);
    expect(pathDetails(model, { nodes: [], edges: ["e1"] }, undefined).sum).toBeNull();
  });

  it("are taken over as steps of the panel with the measure's own property name", () => {
    expect(topStep("pageRank", false)).not.toHaveProperty("name");
    expect(topProperty("pageRank")).toBe("pagerank");
    expect(topProperty("betweenness")).toBe("betweenness");
    expect(adopted(topStep("degree", false), "Q")).toEqual({ type: "degree", frame: "Q" });
    expect(pathStep("kShortest", "a", "d", false, "aufwand")).toMatchObject({
      k: 3,
      weight: "aufwand",
    });
    expect(connectSteps(Array.from({ length: 20 }, (_, i) => `n${i}`))).toHaveLength(190);
  });

  it("ask without direction unless the person wants it", () => {
    expect(pathStep("shortest", "a", "d", false)).toMatchObject({ direction: "both" });
    expect(pathStep("weighted", "a", "d", true, "aufwand")).toMatchObject({
      direction: "out",
      weight: "aufwand",
      mode: "weighted",
    });
    expect(connectSteps(["a", "b", "c"]).map((s) => [s.from, s.to])).toEqual([
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
    expect(topStep("degree")).toMatchObject({ type: "degree", name: "score" });
    expect(topStep("pageRank")).toMatchObject({ type: "centrality", measure: "pageRank" });
  });

  it("rank with ties sharing a rank, so the list may grow", () => {
    const ranked = ranking({ a: 3, b: 5, c: 5, d: 1, e: 2, f: 1, g: 0, h: "x" });
    expect(ranked.map((r) => [r.id, r.rank])).toEqual([
      ["b", 1],
      ["c", 1],
      ["a", 3],
      ["e", 4],
      ["d", 5],
      ["f", 5],
    ]);
  });

  it("name the chosen nodes no path reaches", () => {
    expect(
      unconnected(
        ["a", "b", "x"],
        [{ id: "p", ranIn: "server", paths: [{ nodes: ["a", "c", "b"], edges: [] }] }],
      ),
    ).toEqual(["x"]);
  });

  it("hold up a path neutrally: its nodes lit, its edges strong, the rest dimmed", () => {
    const { model, view, visibility } = setup();
    const path = { nodes: ["a", "c", "b"], edges: ["e1", "e2"] };
    const emphasis = emphasisOf(model, view, { nodes: ["a", "b"], paths: [path], strong: [path] });
    expect([...emphasis.nodes].sort()).toEqual([0, 1, 2]);
    expect([...emphasis.strong].sort()).toEqual([0, 1]);
    const palette = {
      text: "#111",
      edge: "#888",
      edgeDimmed: "#ddd",
      neutral: "#777",
      neutralDimmed: "#eee",
      background: "#fff",
      selection: "#f4f4f4",
      series: ["#00f"],
      dimmed: ["#ccf"],
      ramps: {},
      dimmedRamps: {},
      font: "sans-serif",
      boldWeight: 600,
    } as never;
    const state = {
      view,
      palette,
      visibility,
      ranks: new Int32Array(view.nodes.length),
      selected: new Set<number>(),
      neighbours: new Set<number>(),
      drawStyle: {
        arrows: "always",
        edgeLabels: "never",
        labels: "zoom",
        labelTop: 0,
        ramp: "blues",
      },
      emphasis,
    } as never;
    expect(singlesOut(state)).toBe(true);
    expect(nodeLit(0, state)).toBe(true);
    expect(nodeLit(3, state)).toBe(false);
    const strong = edgeDisplay(0, { size: 1 } as never, state);
    expect(strong.color).toBe("#111");
    const rest = edgeDisplay(2, { size: 1 } as never, state);
    expect(rest.color).toBe("#ddd");
    expect(nodeDisplay(3, { size: 10, label: "Dock" } as never, state, 1).label).toBeNull();
  });
});

describe("suggested edges", () => {
  it("carry an open diamond in their middle", () => {
    const corners = diamondAt({ x: 0, y: 0 }, { x: 20, y: 10 });
    expect(corners).toEqual([
      [10, 5 - DIAMOND],
      [10 + DIAMOND, 5],
      [10, 5 + DIAMOND],
      [10 - DIAMOND, 5],
    ]);
  });
});
