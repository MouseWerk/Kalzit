import { describe, expect, it } from "vitest";
import { diffModels, jsonSections, lineDiff, panelParts } from "./diff";
import { type DashboardModel, emptyModel, type PanelModel } from "./model";

const panel = (id: string, extra: Partial<PanelModel> = {}): PanelModel => ({
  id,
  type: "timeseries",
  title: id,
  grid: { x: 0, y: 0, w: 12, h: 8 },
  targets: [{ refId: "A", datasourceId: "ds", query: "up" }],
  transformations: [],
  options: { legend: { placement: "bottom" } },
  fieldConfig: {},
  ...extra,
});

describe("the save dialog's changes", () => {
  it("name the parts of a panel that changed", () => {
    const before = panel("cpu");
    expect(panelParts(before, { ...before, options: { legend: { placement: "right" } } })).toEqual([
      "options",
    ]);
    expect(
      panelParts(before, {
        ...before,
        title: "CPU",
        maxDataPoints: 500,
        targets: [],
        grid: { x: 1, y: 0, w: 12, h: 8 },
        description: "Last",
      }),
    ).toEqual(["title", "queries", "queryOptions", "other"]);
  });

  it("list variables, settings and panels with their parts", () => {
    const before: DashboardModel = {
      ...emptyModel("Shop"),
      variables: [
        { name: "job", type: "custom", options: ["a"] },
        { name: "old", type: "custom", options: ["x"] },
      ],
      panels: [panel("cpu"), panel("gone")],
    };
    const after: DashboardModel = {
      ...before,
      tags: ["shop"],
      variables: [{ name: "job", type: "custom", options: ["a", "b"] }],
      panels: [{ ...panel("cpu"), timeShift: "1d" }, panel("logs")],
    };
    expect(diffModels(before, after)).toEqual([
      { kind: "variables", names: ["job", "old"] },
      { kind: "settings", part: "tags" },
      { kind: "panelChanged", title: "cpu", parts: ["queryOptions"] },
      { kind: "panelAdded", title: "logs" },
      { kind: "panelRemoved", title: "gone" },
    ]);
  });
});

describe("line by line", () => {
  it("keeps common lines and marks the others", () => {
    expect(lineDiff(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"])).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
      { kind: "same", text: "d" },
      { kind: "added", text: "e" },
    ]);
    expect(lineDiff([], ["a"])).toEqual([{ kind: "added", text: "a" }]);
    expect(lineDiff(["a"], ["a"])).toEqual([{ kind: "same", text: "a" }]);
  });

  it("shows each changed part of the model as JSON with a little context", () => {
    const before = { ...emptyModel("Shop"), panels: [panel("cpu"), panel("mem")] };
    const after = {
      ...before,
      panels: [panel("cpu", { options: { legend: { placement: "right" } } }), panel("mem")],
    };
    const sections = jsonSections(before, after, 1);
    expect(sections.map((s) => s.path)).toEqual(["panels[0]"]);
    const changed = sections[0]?.lines.filter((l) => l.kind !== "same" && l.kind !== "gap");
    expect(changed).toEqual([
      { kind: "removed", text: '      "placement": "bottom"' },
      { kind: "added", text: '      "placement": "right"' },
    ]);
    // Far-away unchanged lines are left out, with a gap in their place.
    expect(sections[0]?.lines.some((l) => l.kind === "gap")).toBe(true);
    expect(sections[0]?.lines.at(-1)?.kind).toBe("gap");
  });

  it("names a removed panel by its old place", () => {
    const before = { ...emptyModel("Shop"), panels: [panel("cpu"), panel("mem")] };
    const after = { ...before, panels: [panel("cpu")] };
    const [section] = jsonSections(before, after);
    expect(section?.path).toBe("panels[1]");
    expect(section?.lines.every((l) => l.kind === "removed" || l.kind === "gap")).toBe(true);
  });
});
