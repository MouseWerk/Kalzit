import { describe, expect, it } from "vitest";
import type { GraphSet } from "../../api/generated/shapes";
import { buildGraphModel, edgeWidths, nodeSizes } from "./model";
import { NODE_SHAPES, parseGraphOptions, withEntry } from "./options";
import { labelGroupOf } from "./paint";
import { labelShapeOf, shapeByPlace } from "./shapes";
import { buildView } from "./view";

function graph(labels: string[]): GraphSet {
  return {
    nodes: labels.map((label, i) => ({ id: `n${i}`, labels: [label], properties: {} })),
    edges: [],
    schema: { labels: [...new Set(labels)], edgeTypes: [], propertyKeys: {} },
  };
}

describe("a node shape per label", () => {
  it("gives the first labels circle, square and diamond, and a circle without a label", () => {
    const model = buildGraphModel([graph(["A", "B", "C", "D"])], { nodeLimit: 100, caption: "" });
    const shape = labelShapeOf(model, {});
    expect([0, 1, 2].map(shape)).toEqual(["circle", "square", "diamond"]);
    expect(shape(-1)).toBe("circle");
  });

  it("keeps color and shape apart: 24 labels, and 8 with the three system colors", () => {
    // Palette colors repeat after eight labels; each label has a pair of its own up to 24.
    const pairs = new Set(Array.from({ length: 24 }, (_, i) => `${i % 8}:${shapeByPlace(i)}`));
    expect(pairs.size).toBe(24);
    // Forced colors: palette colors 1, 4, 7 / 2, 5, 8 / 3, 6 share a system color (graph.css).
    const forced = new Set(Array.from({ length: 8 }, (_, i) => `${i % 3}:${shapeByPlace(i)}`));
    expect(forced.size).toBe(8);
  });

  it("keeps a label's shape when the explorer adds labels after it", () => {
    const before = buildGraphModel([graph(["Customer", "Order"])], { nodeLimit: 100, caption: "" });
    const after = buildGraphModel([graph(["Customer", "Order"]), graph(["Product", "Customer"])], {
      nodeLimit: 100,
      caption: "",
    });
    const of = (model: typeof before, label: string) =>
      labelShapeOf(model, {})(model.labels.indexOf(label));
    for (const label of ["Customer", "Order"]) expect(of(after, label)).toBe(of(before, label));
  });

  it("takes the panel's own shape for a label, for its nodes and its cluster", () => {
    const model = buildGraphModel([graph(["A", "A", "B"])], { nodeLimit: 100, caption: "" });
    const labelShape = labelShapeOf(model, { A: "diamond" });
    const input = {
      sizes: nodeSizes(model, ""),
      widths: edgeWidths(model, ""),
      groups: Int32Array.from(model.nodes, (n) => n.label),
      open: new Set<number>(),
      clusterCaption: (label: string) => label,
      unlabelled: "",
      labelShape,
    };
    const nodes = buildView(model, { ...input, cluster: false }).nodes;
    expect(nodes.map((n) => n.shape)).toEqual(["diamond", "diamond", "square"]);
    const clusters = buildView(model, { ...input, cluster: true }).nodes;
    expect(clusters.map((n) => n.shape)).toEqual(["diamond", "square"]);
  });

  it("never takes an object's own keys for a label's shape or color", () => {
    const model = buildGraphModel([graph(["constructor", "toString", "__proto__", "A"])], {
      nodeLimit: 100,
      caption: "",
    });
    const shape = labelShapeOf(model, {});
    for (const i of [0, 1, 2]) expect(NODE_SHAPES).toContain(shape(i));
    expect(labelGroupOf(model, {})(0)).toBe(0);
    // Stored per-label options keep such labels as labels.
    const stored = JSON.parse('{"__proto__": "diamond", "constructor": "square"}');
    const options = parseGraphOptions({
      labelShapes: stored,
      labelColors: { toString: "chart-3" },
    });
    expect(Object.hasOwn(options.labelShapes, "__proto__")).toBe(true);
    const own = labelShapeOf(model, options.labelShapes);
    expect([own(0), own(2)]).toEqual(["square", "diamond"]);
    expect(labelGroupOf(model, options.labelColors)(1)).toBe(2);
    // Setting and clearing a label's entry in the editor.
    const set = withEntry({}, "__proto__", "circle");
    expect(Object.hasOwn(set, "__proto__")).toBe(true);
    expect(withEntry<string>(set, "__proto__", undefined)).toEqual({});
  });

  it("keeps only known shapes from stored options, at most fifty", () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`L${i}`, "square"]));
    expect(
      parseGraphOptions({ labelShapes: { A: "diamond", B: "star", "": "circle" } }).labelShapes,
    ).toEqual({ A: "diamond" });
    expect(Object.keys(parseGraphOptions({ labelShapes: many }).labelShapes)).toHaveLength(50);
    expect(parseGraphOptions({}).labelShapes).toEqual({});
  });
});
