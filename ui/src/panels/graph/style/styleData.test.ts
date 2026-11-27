import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vendored } from "../../../../scripts/licenses.mjs";
import type { Frame } from "../../../api/generated/shapes";
import type { GraphView } from "../view";
import { evaluateStyle, styleView } from "./apply";
import { ATLAS_SLOTS, iconRect, NO_ICON, resetAtlas } from "./iconAtlas";
import { loadIcons } from "./icons/load";
import data from "./icons/lucide.json";
import {
  ICON_NAME_SET,
  isIconName,
  isNewerStyle,
  parseGraphStyle,
  readableStyle,
  STYLE_VERSION,
} from "./schema";
import { tableLooks } from "./tableStyle";

const ICONS_DIR = resolve(import.meta.dirname, "icons");

/** A view of `nodes` and `edges` model items, one view item each, as the panel builds it. */
function viewOf(nodes: number, edges: number): GraphView {
  return {
    nodes: Array.from({ length: nodes }, (_, i) => ({ node: i, shape: "circle" })),
    edges: Array.from({ length: edges }, (_, i) => ({ edge: i })),
  } as unknown as GraphView;
}

describe("the shipped icon set", () => {
  it("has exactly the names of names.txt, which the server checks too", () => {
    const listed = readFileSync(resolve(ICONS_DIR, "names.txt"), "utf8")
      .split(/\s+/)
      .filter(Boolean);
    expect(Object.keys(data.icons).sort()).toEqual([...new Set(listed)].sort());
    expect([...ICON_NAME_SET].sort()).toEqual(Object.keys(data.icons).sort());
  });

  it("takes only names of the set in a rule", () => {
    expect(isIconName("user")).toBe(true);
    expect(isIconName("not-an-icon")).toBe(false);
    const style = parseGraphStyle({
      nodes: [{ id: "a", when: { kind: "always" }, set: { icon: "not-an-icon", size: 10 } }],
    });
    expect(style.nodes[0]?.set).toEqual({ size: 10 });
  });

  it("is listed with its license among the third-party notices", () => {
    const [entry] = vendored();
    expect(entry).toMatchObject({ name: "lucide-static", license: "ISC", source: "npm" });
    expect(entry?.version).toBe(data.source.split(" ")[1]);
  });
});

describe("the icon atlas", () => {
  afterEach(() => {
    resetAtlas();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("holds every shipped icon, each in a cell of its own, and none for an unknown name", async () => {
    expect(ATLAS_SLOTS).toBeGreaterThanOrEqual(Object.keys(data.icons).length);
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      stroke: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    vi.stubGlobal("Path2D", class {});
    resetAtlas();
    await loadIcons();
    expect(iconRect("not-an-icon")).toBe(NO_ICON);
    const cells = new Set(Object.keys(data.icons).map((name) => iconRect(name).join()));
    expect(cells.size).toBe(Object.keys(data.icons).length);
    expect(cells.has(NO_ICON.join())).toBe(false);
    // Drawn once each: asking again takes the cell already there.
    expect(iconRect("user")).toEqual(iconRect("user"));
    expect(context.stroke).toHaveBeenCalledTimes(Object.keys(data.icons).length);
  });
});

describe("a style of a newer version", () => {
  it("is kept as stored and drawn as far as it can be read", () => {
    const stored = {
      version: STYLE_VERSION + 1,
      nodes: [
        { id: "a", when: { kind: "always" }, set: { color: "good" } },
        { id: "b", when: { kind: "someday" }, set: { color: "good" } },
      ],
      edges: [],
      future: true,
    };
    const style = parseGraphStyle(stored);
    expect(style).toBe(stored);
    expect(isNewerStyle(style)).toBe(true);
    expect(readableStyle(style).nodes.map((rule) => rule.id)).toEqual(["a"]);
    expect(parseGraphStyle(style)).toBe(stored);
  });
});

describe("the looks of a view", () => {
  const model = {
    nodes: Array.from({ length: 10 }, (_, i) => ({
      labels: ["Kunde"],
      properties: { branche: `b${i}` },
    })),
    edges: Array.from({ length: 10 }, (_, i) => ({
      type: "KAUFTE",
      properties: { art: `a${i}`, menge: i },
    })),
  };

  it("gives the ninth and tenth value a second cue: another shape, a dashed line", () => {
    const style = parseGraphStyle({
      nodes: [{ id: "n", when: { kind: "values", property: "branche", colors: [] }, set: {} }],
      edges: [{ id: "e", when: { kind: "values", property: "art", colors: [] }, set: {} }],
    });
    const evaluation = evaluateStyle(model as never, style);
    if (evaluation === null) throw new Error("rules expected");
    const looks = styleView(viewOf(10, 10), evaluation);
    const shifted = looks.nodes.filter((look) => look?.shape === "square");
    expect(shifted).toHaveLength(2);
    expect(looks.nodes.filter((look) => look?.shape === undefined)).toHaveLength(8);
    expect(looks.edges.filter((look) => look?.dash === "dashed")).toHaveLength(2);
    expect(looks.edgeLabels).toBe(false);
  });

  it("turns edge labels on where a rule gives an edge a text, and lists the icons once", () => {
    const style = parseGraphStyle({
      nodes: [
        { id: "a", when: { kind: "always" }, set: { icon: "user" } },
        { id: "b", when: { kind: "always" }, set: { icon: "user" } },
      ],
      edges: [{ id: "e", when: { kind: "always" }, set: { label: "{menge} ×" } }],
    });
    const evaluation = evaluateStyle(model as never, style);
    if (evaluation === null) throw new Error("rules expected");
    const looks = styleView(viewOf(10, 10), evaluation);
    expect(looks.edgeLabels).toBe(true);
    expect(looks.edges[3]?.label).toBe("3 ×");
    expect(looks.icons).toEqual(["user"]);
  });

  it("counts mixed types of one property by their text", () => {
    const mixed = {
      nodes: [10, "10", { $type: "int64", value: "10" }, true, "true"].map((p) => ({
        labels: ["X"],
        properties: { p },
      })),
      edges: [],
    };
    const style = parseGraphStyle({
      nodes: [{ id: "n", when: { kind: "values", property: "p", colors: [] }, set: {} }],
    });
    const report = evaluateStyle(mixed as never, style)?.nodes.rules[0]?.values;
    expect(report?.total).toBe(2);
    expect(report?.shown.map((slot) => [slot.value, slot.count])).toEqual([
      ["10", 3],
      ["true", 2],
    ]);
  });
});

describe("tables and the rules", () => {
  const style = parseGraphStyle({
    nodes: [{ id: "a", when: { kind: "always" }, set: { color: "chart-1" } }],
  });

  it("apply only to a table made from a graph (with @labels or @type)", () => {
    const plain: Frame = { fields: [{ name: "name", type: "string", values: ["Ada"] }] };
    expect(tableLooks(plain, style)).toBeNull();
    const fromGraph: Frame = {
      fields: [
        { name: "@labels", type: "json", values: [["Kunde"]] },
        { name: "name", type: "string", values: ["Ada"] },
      ],
    };
    expect(tableLooks(fromGraph, style)?.cells[0]?.get(1)).toEqual({ dot: "chart-1" });
  });
});
