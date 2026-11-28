import { describe, expect, it } from "vitest";
import type { GraphSet } from "../../../api/generated/shapes";
import { buildGraphModel, edgeWidths, nodeSizes } from "../model";
import { buildView } from "../view";
import {
  coordinateChoice,
  HIERARCHY_NODE_LIMIT,
  type LayoutSettings,
  layoutProperties,
  mapChoice,
  nodeOrder,
  planLayout,
  readPoint,
  timeChoice,
} from "./inputs";

type Props = Record<string, unknown>;

function resultOf(
  nodes: { name: string; label: string; properties?: Props }[],
  edges: [string, string][] = [],
) {
  const set: GraphSet = {
    nodes: nodes.map((n) => ({
      id: n.name,
      labels: [n.label],
      properties: { name: n.name, ...n.properties },
    })),
    edges: edges.map(([from, to], i) => ({ id: `e${i}`, type: "T", from, to, properties: {} })),
    schema: { labels: [], edgeTypes: [], propertyKeys: {} },
  };
  const model = buildGraphModel([set], { nodeLimit: 100, caption: "name" });
  const view = buildView(model, {
    sizes: nodeSizes(model, "degree"),
    widths: edgeWidths(model, ""),
    groups: Int32Array.from(model.nodes, (n) => n.label),
    cluster: false,
    open: new Set(),
    clusterCaption: (label) => label,
    unlabelled: "",
  });
  return { model, view, properties: layoutProperties(model) };
}

const SETTINGS: LayoutSettings = {
  mode: "force",
  order: "label",
  descending: false,
  x: "",
  y: "",
  point: "",
  axes: true,
  time: {},
  lanes: "label",
};

const point = (x: number, y: number) => ({ $type: "point", x, y });

describe("readPoint", () => {
  it("reads a point value and nothing else", () => {
    expect(readPoint(point(1, 2))).toEqual([1, 2]);
    expect(readPoint({ x: 1, y: 2 })).toBeNull();
    expect(readPoint({ $type: "point", x: "a", y: 2 })).toBeNull();
    expect(readPoint(7)).toBeNull();
    expect(readPoint(null)).toBeNull();
  });
});

describe("coordinateChoice", () => {
  const data = resultOf([
    { name: "a", label: "L", properties: { umsatz: 1, bestellungen: 5, ort: point(1, 1) } },
    { name: "b", label: "L", properties: { umsatz: 2, bestellungen: 6, rang: 3 } },
    { name: "c", label: "L", properties: { umsatz: 3, rang: 4 } },
  ]);
  const choose = (settings: Partial<LayoutSettings>) =>
    coordinateChoice(data.model, data.properties, { ...SETTINGS, ...settings });

  it("prefers the panel's point, then its two numbers", () => {
    expect(choose({ point: "ort", x: "umsatz", y: "rang" })).toEqual({
      kind: "point",
      point: "ort",
    });
    expect(choose({ x: "umsatz", y: "rang" })).toEqual({ kind: "xy", x: "umsatz", y: "rang" });
  });

  it("falls back to the pair most nodes carry both of, with one property fixed if given", () => {
    const pair = choose({});
    expect(pair).toMatchObject({ kind: "xy" });
    expect(choose({ x: "umsatz" })).toMatchObject({ kind: "xy", x: "umsatz" });
  });

  it("takes the most used point when there are no two numbers, and null without anything", () => {
    const onlyPoint = resultOf([{ name: "a", label: "L", properties: { ort: point(1, 1) } }]);
    expect(coordinateChoice(onlyPoint.model, onlyPoint.properties, SETTINGS)).toEqual({
      kind: "point",
      point: "ort",
    });
    const none = resultOf([{ name: "a", label: "L" }]);
    expect(coordinateChoice(none.model, none.properties, SETTINGS)).toBeNull();
  });
});

describe("timeChoice", () => {
  const data = resultOf([
    { name: "a", label: "Kunde", properties: { seit: "2021-03-14", letzte: "2024-01-01" } },
    { name: "b", label: "Kunde", properties: { seit: "2022-01-01" } },
    { name: "p", label: "Produkt", properties: { eingefuehrt: "2019-05-05" } },
  ]);

  it("takes the label's most used time property, or the one the panel names for it", () => {
    const own = timeChoice(data.model, data.properties, { time: {} });
    expect([...own.values()].sort()).toEqual(["eingefuehrt", "seit"]);
    const named = timeChoice(data.model, data.properties, { time: { Kunde: "letzte" } });
    expect([...named.values()].sort()).toEqual(["eingefuehrt", "letzte"]);
  });

  it("ignores a named property the label does not carry", () => {
    const wrong = timeChoice(data.model, data.properties, { time: { Kunde: "gibt-es-nicht" } });
    expect([...wrong.values()].sort()).toEqual(["eingefuehrt", "seit"]);
  });
});

describe("nodeOrder", () => {
  const data = resultOf(
    [
      { name: "b", label: "Zeta" },
      { name: "a", label: "Zeta" },
      { name: "c", label: "Alpha" },
    ],
    [
      ["a", "b"],
      ["a", "c"],
    ],
  );
  const names = (order: Uint32Array) => [...order].map((i) => data.view.nodes[i]?.caption);

  it("orders by label then name, by name, or by edges", () => {
    // Labels are ordered by their index in the result (first seen first).
    expect(names(nodeOrder(data.model, data.view, "label", false, "en"))).toEqual(["a", "b", "c"]);
    expect(names(nodeOrder(data.model, data.view, "name", false, "en"))).toEqual(["a", "b", "c"]);
    expect(names(nodeOrder(data.model, data.view, "degree", true, "en"))).toEqual(["a", "c", "b"]);
  });

  it("reverses with descending", () => {
    expect(names(nodeOrder(data.model, data.view, "name", true, "en"))).toEqual(["c", "b", "a"]);
  });

  it("keeps the result's order on ties, so the same data gives the same places", () => {
    const ties = resultOf([
      { name: "x", label: "L" },
      { name: "y", label: "L" },
      { name: "z", label: "L" },
    ]);
    expect([...nodeOrder(ties.model, ties.view, "degree", false, "en")].length).toBe(3);
    expect([...nodeOrder(ties.model, ties.view, "degree", true, "en")]).toEqual([
      ...nodeOrder(ties.model, ties.view, "degree", true, "en"),
    ]);
  });
});

describe("planLayout", () => {
  const plan = (
    data: ReturnType<typeof resultOf>,
    patch: Partial<LayoutSettings>,
    centers: string[] = [],
  ) => planLayout(data.model, data.view, data.properties, { ...SETTINGS, ...patch }, centers, "en");

  it("applies force, hierarchy and the ordered layouts to every node", () => {
    const data = resultOf([
      { name: "a", label: "L" },
      { name: "b", label: "L" },
    ]);
    for (const mode of ["force", "hierarchy", "circular", "grid"] as const) {
      expect(plan(data, { mode })).toMatchObject({ reason: null, placed: 2, total: 2 });
    }
    expect(plan(data, { mode: "circular" }).input.order).toHaveLength(2);
  });

  it("refuses a hierarchy above the limit", () => {
    expect(HIERARCHY_NODE_LIMIT).toBe(10_000);
    const data = resultOf([{ name: "a", label: "L" }]);
    const nodes = Array(HIERARCHY_NODE_LIMIT + 1).fill(data.view.nodes[0]);
    const big = { ...data, view: { ...data.view, nodes } };
    expect(plan(big, { mode: "hierarchy" }).reason).toBe("tooLarge");
  });

  it("maps radial centers from view keys", () => {
    const data = resultOf([
      { name: "a", label: "L" },
      { name: "b", label: "L" },
    ]);
    const keys = [data.view.nodes[1]?.key as string];
    expect([...(plan(data, { mode: "radial" }, keys).input.centers ?? [])]).toEqual([1]);
    expect(plan(data, { mode: "radial" }).input.centers).toHaveLength(0);
  });

  it("reads coordinates, counts the nodes without a value and says why none can be placed", () => {
    const data = resultOf([
      { name: "a", label: "L", properties: { ort: point(1, 2) } },
      { name: "b", label: "L" },
    ]);
    const some = plan(data, { mode: "coordinates" });
    expect(some).toMatchObject({ reason: null, placed: 1, total: 2 });
    expect(some.input.uniform).toBe(true);
    expect(Number.isNaN(some.input.values?.[2])).toBe(true);
    const none = resultOf([{ name: "a", label: "L" }]);
    expect(plan(none, { mode: "coordinates" }).reason).toBe("noCoordinates");
  });

  it("reads places for the map by their usual names, longitude first, and says when none is there", () => {
    const data = resultOf([
      { name: "a", label: "Lager", properties: { breite: 53.55, laenge: 9.99, umsatz: 5 } },
      { name: "b", label: "Lager", properties: { breite: 48.14, laenge: 11.58 } },
      { name: "c", label: "Lager", properties: { umsatz: 3 } },
    ]);
    const some = plan(data, { mode: "map" });
    expect(some).toMatchObject({ reason: null, placed: 2, total: 3 });
    expect([...(some.input.values ?? [])].slice(0, 4)).toEqual([9.99, 53.55, 11.58, 48.14]);
    expect(mapChoice(data.model, data.properties, SETTINGS)).toEqual({
      kind: "latLon",
      lat: "breite",
      lon: "laenge",
    });
    const none = resultOf([{ name: "a", label: "L", properties: { umsatz: 1, kosten: 2 } }]);
    expect(plan(none, { mode: "map" }).reason).toBe("noPlace");
  });

  it("takes the panel's point or its two numbers for the map, but not numbers off the earth", () => {
    const data = resultOf([
      { name: "a", label: "L", properties: { ort: point(9.99, 53.55), lat: 1, lon: 2, n: 500 } },
      { name: "b", label: "L", properties: { lat: 3, lon: 4, n: 7 } },
    ]);
    expect(mapChoice(data.model, data.properties, { ...SETTINGS, point: "ort" })).toEqual({
      kind: "point",
      point: "ort",
    });
    // The coordinates' x and y read as longitude and latitude when they fit.
    expect(mapChoice(data.model, data.properties, { ...SETTINGS, x: "lon", y: "n" })).toEqual({
      kind: "latLon",
      lat: "lat",
      lon: "lon",
    });
    expect(plan(data, { mode: "map", point: "ort" })).toMatchObject({ placed: 1, total: 2 });
  });

  it("reads times per label and says why none can be placed; bare numbers are no time", () => {
    const data = resultOf([
      { name: "a", label: "K", properties: { seit: "2021-03-14" } },
      { name: "b", label: "K" },
    ]);
    const some = plan(data, { mode: "timeline" });
    expect(some).toMatchObject({ reason: null, placed: 1, total: 2 });
    // A date alone is read as UTC midnight.
    expect(some.input.times?.[0]).toBe(Date.UTC(2021, 2, 14));
    expect(plan(data, { mode: "timeline", lanes: "one" }).input.lanes).toBeUndefined();
    const numbers = resultOf([{ name: "a", label: "K", properties: { n: 1_700_000_000 } }]);
    expect(plan(numbers, { mode: "timeline" }).reason).toBe("noTime");
  });
});
