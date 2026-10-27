import { describe, expect, it } from "vitest";
import { FAKE_GRAPH, ID } from "../../features/datasources/test/fakeGraph";
import {
  capValues,
  edgeSummary,
  labelCounts,
  MAX_SELECTION_VALUES,
  neighbourGroups,
  nodeIds,
  onlySelection,
  pinnedGraph,
  pinOf,
  propertyType,
  selectionValues,
  withoutLabels,
} from "./inspect";
import { buildGraphModel, edgeWidths, nodeSizes } from "./model";
import { parseGraphOptions } from "./options";
import { labelGroupOf, propertyPaint } from "./paint";
import { allVisible, buildView, rampGroup } from "./view";

const model = buildGraphModel([FAKE_GRAPH], { nodeLimit: 100, caption: "" });
const view = buildView(model, {
  sizes: nodeSizes(model, "degree"),
  widths: edgeWidths(model, ""),
  groups: Int32Array.from(model.nodes, (n) => n.label),
  cluster: false,
  open: new Set(),
  clusterCaption: (label) => label,
  unlabelled: "",
});
const at = (id: string) => model.index.get(id) as number;

describe("the node inspector", () => {
  it("names property types from JSON and from typed values", () => {
    expect(propertyType("x")).toBe("text");
    expect(propertyType(3)).toBe("integer");
    expect(propertyType(3.5)).toBe("float");
    expect(propertyType(true)).toBe("boolean");
    expect(propertyType({ $type: "int64", value: "9007199254740993" })).toBe("integer");
    expect(propertyType({ $type: "date", value: "2026-03-14" })).toBe("date");
    expect(propertyType({ $type: "localDateTime", value: "2026-03-14T10:00" })).toBe("dateTime");
    expect(propertyType([1, 2])).toBe("list");
    expect(propertyType({ a: 1 })).toBe("map");
    expect(propertyType(null)).toBe("null");
  });

  it("groups neighbours by edge type, direction and label, the largest group first", () => {
    const groups = neighbourGroups(model, at(ID.lamp));
    expect(groups.map((g) => [g.type, g.outgoing, g.label, g.items.length])).toEqual([
      ["BOUGHT", false, "Customer", 2],
    ]);
    const ada = neighbourGroups(model, at(ID.ada));
    expect(ada[0]?.outgoing).toBe(true);
    expect(ada[0]?.items.map((i) => model.nodes[i.node]?.caption)).toEqual(["Lamp", "Desk"]);
    expect(edgeSummary({ quantity: 2, at: 1 })).toBe("quantity 2");
    expect(edgeSummary({})).toBe("");
  });

  it("counts nodes per label in the order of the labels", () => {
    expect(labelCounts(model).map((l) => [l.label, l.count])).toEqual([
      ["Customer", 2],
      ["Product", 2],
    ]);
  });
});

describe("selection and pins", () => {
  it("shows only the selection and the edges between selected nodes", () => {
    const selected = new Set([
      view.nodeOf[at(ID.ada)] as number,
      view.nodeOf[at(ID.lamp)] as number,
    ]);
    const shown = onlySelection(view, allVisible(view), selected);
    expect([...shown.nodes].reduce((a, b) => a + b, 0)).toBe(2);
    expect([...shown.edges].reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("hides the nodes of a label and their edges", () => {
    const shown = withoutLabels(model, view, allVisible(view), new Set(["Product"]));
    expect([...shown.nodes].reduce((a, b) => a + b, 0)).toBe(2);
    expect([...shown.edges].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("gives a multi-value variable each selected node's value once, leaving out nodes without it", () => {
    const nodes = [at(ID.grace), at(ID.lamp), at(ID.ada), at(ID.grace)];
    expect(selectionValues(model, nodes, "customerId")).toEqual(["43", "42"]);
    expect(selectionValues(model, [at(ID.lamp)], "")).toEqual([ID.lamp]);
  });

  it("caps the values a selection gives a variable, and says so", () => {
    const many = Array.from({ length: MAX_SELECTION_VALUES + 5 }, (_, i) => `v${i}`);
    expect(capValues(many).values).toHaveLength(MAX_SELECTION_VALUES);
    expect(capValues(many).capped).toBe(true);
    expect(capValues(["a", "b"])).toEqual({ values: ["a", "b"], capped: false });
  });

  it("keeps a pinned node with the edges whose other end is still there", () => {
    const pin = pinOf(model, at(ID.desk));
    expect(pin?.edges.map((e) => e.id)).toEqual([ID.b2]);
    const pins = new Map([[ID.desk, pin as NonNullable<typeof pin>]]);
    expect(pinnedGraph(pins, new Set([ID.ada]))?.edges).toHaveLength(1);
    // Ada is gone too: the node stays, its edge does not dangle.
    const alone = pinnedGraph(pins, new Set());
    expect(alone?.nodes.map((n) => n.id)).toEqual([ID.desk]);
    expect(alone?.edges).toEqual([]);
    expect(pinnedGraph(new Map(), new Set())).toBeNull();
    expect(nodeIds([FAKE_GRAPH]).size).toBe(4);
  });
});

describe("node colors", () => {
  it("takes a label's own palette color, else its order", () => {
    const group = labelGroupOf(model, { Product: "chart-6" });
    expect(group(0)).toBe(0);
    expect(group(1)).toBe(5);
    expect(group(-1)).toBe(-1);
  });

  it("puts numbers on the ramp's five steps and leaves nodes without the property neutral", () => {
    const options = parseGraphOptions({ colorBy: "property", colorProperty: "price" });
    const paint = propertyPaint(model, options);
    expect(paint.min).toBe(30);
    expect(paint.max).toBe(250);
    expect(paint.missing).toBe(2);
    expect(paint.groups[at(ID.lamp)]).toBe(rampGroup(0));
    expect(paint.groups[at(ID.desk)]).toBe(rampGroup(4));
    expect(paint.groups[at(ID.ada)]).toBe(-1);
    // A fixed range places the values inside it.
    const fixed = propertyPaint(model, { ...options, colorRange: "fixed", colorMax: 1_000 });
    expect(fixed.groups[at(ID.desk)]).toBe(rampGroup(1));
  });

  it("gives text values palette colors in order", () => {
    const paint = propertyPaint(
      model,
      parseGraphOptions({ colorBy: "property", colorProperty: "name", colorScheme: "values" }),
    );
    expect(paint.values).toEqual(["Ada", "Grace", "Lamp", "Desk"]);
    expect([...paint.groups]).toEqual([0, 1, 2, 3]);
  });

  it("reads stored options with their defaults and bounds", () => {
    const legacy = parseGraphOptions({ variable: "kunde" });
    expect(legacy.clickAction).toBe("variable");
    expect(parseGraphOptions({ explorer: true }).clickAction).toBe("expand");
    expect(parseGraphOptions({}).clickAction).toBe("details");
    const odd = parseGraphOptions({
      sizeMin: 30,
      sizeMax: 3,
      labelTop: 999,
      labelColors: { Kunde: "chart-2", Other: "#ff0000" },
    });
    expect([odd.sizeMin, odd.sizeMax, odd.labelTop]).toEqual([3, 30, 200]);
    expect(odd.labelColors).toEqual({ Kunde: "chart-2" });
  });
});
