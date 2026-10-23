import { describe, expect, it } from "vitest";
import {
  annotationRanges,
  type DashboardMark,
  MAX_ANNOTATION_RANGES,
  mergeQueryMarks,
} from "./annotations";
import {
  buildExport,
  readImport,
  referencedSources,
  remapSources,
  suggestMapping,
} from "./exportImport";
import { layoutSections, moveRow, panelValues, placeInSection, sectionBottom } from "./layout";
import { fillVariables, isAllowedUrl, linkHref } from "./links";
import {
  type DashboardModel,
  emptyModel,
  type PanelModel,
  parseModel,
  SCHEMA_VERSION,
} from "./model";
import { isTimeFrom, isTimeShift, panelRange, timeNote } from "./panelTime";

/** `${name}` as a link writes it. */
const ref = (name: string) => ["$", "{", name, "}"].join("");

function panel(id: string, extra: Partial<PanelModel> = {}): PanelModel {
  return {
    id,
    type: "table",
    title: id,
    grid: { x: 0, y: 0, w: 12, h: 4 },
    targets: [{ refId: "A", datasourceId: "ds-1", query: {} }],
    transformations: [],
    options: {},
    fieldConfig: {},
    ...extra,
  };
}

describe("model version 2", () => {
  it("keeps the new parts and leaves them out when empty", () => {
    const parsed = parseModel(
      {
        schemaVersion: 1,
        title: "T",
        tags: ["a", 3],
        rows: [{ id: "r", title: "R", collapsed: true, repeat: { variable: "v" } }],
        variables: [{ name: "v", type: "custom", multi: true }],
        panels: [
          { id: "p", rowId: "r", timeFrom: "now-1h", repeat: { variable: "v", direction: "x" } },
        ],
        links: [{ type: "url", title: "W", url: "https://x" }, { type: "bogus" }],
        annotations: [{ id: "a", datasourceId: "ds", query: 1, enabled: false }],
      },
      "",
    );
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.tags).toEqual(["a"]);
    expect(parsed.rows?.[0]).toEqual({
      id: "r",
      title: "R",
      collapsed: true,
      repeat: { variable: "v" },
    });
    expect(parsed.variables[0]?.multi).toBe(true);
    expect(parsed.panels[0]).toMatchObject({
      rowId: "r",
      timeFrom: "now-1h",
      repeat: { direction: "horizontal" },
    });
    expect(parsed.links).toEqual([{ type: "url", title: "W", url: "https://x" }]);
    expect(parsed.annotations?.[0]?.enabled).toBe(false);
    const plain = parseModel(emptyModel("x"), "");
    expect(Object.keys(plain).sort()).toEqual([
      "panels",
      "schemaVersion",
      "timeRange",
      "title",
      "variables",
    ]);
  });
});

describe("layout", () => {
  it("puts panels into sections and expands repeats only for viewing", () => {
    const panels = [
      panel("top"),
      panel("rep", {
        grid: { x: 0, y: 4, w: 12, h: 4 },
        repeat: { variable: "v", direction: "horizontal", maxPerRow: 2 },
      }),
      panel("below", { grid: { x: 0, y: 8, w: 24, h: 4 } }),
      panel("inrow", { rowId: "r" }),
    ];
    const rows = [{ id: "r", title: "R", collapsed: false, repeat: { variable: "v" } }];
    const values = { v: ["a", "b", "c"] };
    const view = layoutSections(panels, rows, values, true);
    expect(view.map((s) => s.key)).toEqual(["top", "r", "r\u0000b", "r\u0000c"]);
    const top = view[0]?.panels ?? [];
    expect(
      top.filter((p) => p.panel.id === "rep").map((p) => [p.grid.x, p.grid.y, p.grid.w]),
    ).toEqual([
      [0, 4, 12],
      [12, 4, 12],
      [0, 8, 12],
    ]);
    // What the third copy now covers moved down.
    expect(top.find((p) => p.key === "below")?.grid.y).toBe(12);
    expect(panelValues(values, top[2] ?? {}, view[0])).toMatchObject({ v: "b" });
    expect(view[2]?.panels[0]?.repeat).toEqual({ variable: "v", value: "b" });
    expect(view[2]?.first).toBe(false);
    const edit = layoutSections(panels, rows, values, false);
    expect(edit.map((s) => s.key)).toEqual(["top", "r"]);
    expect(edit[0]?.panels.map((p) => p.key)).toEqual(["top", "rep", "below"]);
    // Shown once, a repeated panel or row queries with its first value, never the whole list.
    expect(edit[0]?.panels[1]?.repeat).toEqual({ variable: "v", value: "a" });
    expect(edit[1]?.repeat).toEqual({ variable: "v", value: "a" });
  });

  it("moves panels within their section and rows within the list", () => {
    const panels = [
      panel("a"),
      panel("b", { grid: { x: 0, y: 4, w: 12, h: 4 } }),
      panel("c", { rowId: "r" }),
    ];
    const rows = [{ id: "r", title: "", collapsed: false }];
    const moved = placeInSection(panels, "a", { x: 0, y: 2, w: 12, h: 4 }, rows);
    expect(moved.find((p) => p.id === "b")?.grid.y).toBe(6);
    // A panel of another section is never pushed.
    expect(moved.find((p) => p.id === "c")?.grid.y).toBe(0);
    expect(sectionBottom(panels, null, rows)).toBe(8);
    expect(sectionBottom(panels, "r", rows)).toBe(4);
    const three = [1, 2, 3].map((n) => ({ id: `r${n}`, title: "", collapsed: false }));
    expect(moveRow(three, 0, 2).map((r) => r.id)).toEqual(["r2", "r3", "r1"]);
    expect(moveRow(three, 2, -5).map((r) => r.id)).toEqual(["r3", "r1", "r2"]);
  });
});

describe("links", () => {
  it("allows web, mail and local addresses only, like the server", () => {
    for (const ok of ["https://x.de/a", "HTTP://x", "mailto:a@b.de", "/dashboards/1"]) {
      expect(isAllowedUrl(ok), ok).toBe(true);
    }
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:x",
      " https://x",
      "//evil",
      "/\\evil",
      "data:x",
      "https:x",
      "x",
      "",
      "https://x\u0000",
    ]) {
      expect(isAllowedUrl(bad), bad).toBe(false);
    }
  });

  it("fills variables encoded, and checks the result again", () => {
    expect(
      fillVariables(`https://x/${ref("a")}?b=$b&c=${ref("c")}`, { a: "ä b", b: ["1", "2"] }),
    ).toBe(`https://x/%C3%A4%20b?b=1,2&c=${ref("c")}`);
    expect(linkHref(ref("target"), { target: "javascript:alert(1)" })).toBeNull();
    // A scheme made of a variable passes only when the filled-in address is allowed: the check
    // after filling in is what refuses it.
    const scheme = `${ref("scheme")}://intranet.example/`;
    expect(linkHref(scheme, { scheme: "https" })).toBe("https://intranet.example/");
    expect(fillVariables(scheme, { scheme: "javascript" })).toBe("javascript://intranet.example/");
    expect(linkHref(scheme, { scheme: "javascript" })).toBeNull();
    expect(linkHref(scheme, { scheme: "data" })).toBeNull();
    expect(linkHref(`/d/${ref("id")}`, { id: "//evil" })).toBe("/d/%2F%2Fevil");
  });
});

describe("panel time options", () => {
  it("replaces the range with its own and shifts it back by calendar units", () => {
    const now = new Date(2026, 9, 21, 12, 0, 0).getTime();
    const range = { from: now - 6 * 3_600_000, to: now };
    expect(panelRange(panel("p", { timeFrom: "now-24h" }), range, now)).toEqual({
      from: now - 24 * 3_600_000,
      to: now,
    });
    const shifted = panelRange(panel("p", { timeShift: "1d" }), range, now);
    expect(new Date(shifted.to).getDate()).toBe(20);
    expect(shifted.to - shifted.from).toBe(6 * 3_600_000);
    expect(panelRange(panel("p", { timeFrom: "nonsense" }), range, now)).toEqual(range);
    expect(timeNote(panel("p", { timeFrom: "now-7d/d", timeShift: "1w" }))).toEqual({
      last: "7d",
      shift: "1w",
    });
    expect([isTimeFrom("now-24h"), isTimeFrom("now"), isTimeFrom("2026-01-01")]).toEqual([
      true,
      false,
      false,
    ]);
    expect([
      isTimeShift("1d"),
      isTimeShift("0d"),
      isTimeShift("1x"),
      isTimeShift("123456s"),
    ]).toEqual([true, false, false, false]);
  });
});

describe("annotation ranges and marks", () => {
  const mark = (time: number, text: string): DashboardMark => ({
    key: "",
    time,
    timeEnd: null,
    text,
    tags: [],
    panelId: null,
  });

  it("counts a row seen in overlapping ranges once, and keeps rows that really repeat", () => {
    const first = [mark(10, "A"), mark(20, "B"), mark(20, "B")];
    const second = [mark(20, "B"), mark(30, "C")];
    const merged = mergeQueryMarks([first, second]);
    expect(merged.map((m) => `${m.time}${m.text}`).sort()).toEqual(["10A", "20B", "20B", "30C"]);
    expect(new Set(merged.map((m) => m.key)).size).toBe(4);
  });

  it("reads the dashboard's range first, then drawn time panels' own, at most eight", () => {
    const now = 1_000_000_000_000;
    const range = { from: now - 6 * 3_600_000, to: now };
    const rows = [{ id: "closed", title: "", collapsed: true }];
    const panels = [
      panel("t", { type: "timeseries", timeFrom: "now-24h" }),
      panel("table", { type: "table", timeFrom: "now-7d" }),
      panel("hidden", { type: "timeseries", timeFrom: "now-30d", rowId: "closed" }),
      ...Array.from({ length: 12 }, (_, i) =>
        panel(`s${i}`, { type: "timeseries", timeShift: `${i + 1}d` }),
      ),
    ];
    const ranges = annotationRanges(panels, rows, (r) => r.collapsed, range, now);
    expect(ranges).toHaveLength(MAX_ANNOTATION_RANGES);
    expect(ranges[0]).toEqual(range);
    expect(ranges[1]).toEqual({ from: now - 24 * 3_600_000, to: now });
    const lengths = ranges.map((r) => r.to - r.from);
    expect(lengths).not.toContain(7 * 24 * 3_600_000);
    expect(lengths).not.toContain(30 * 24 * 3_600_000);
    // The first seven own ranges are read; panels past them (shifts of 7 to 12 days) are not.
    const shiftedBy = (days: number) => ({
      from: range.from - days * 24 * 3_600_000,
      to: range.to - days * 24 * 3_600_000,
    });
    expect(ranges).toContainEqual(shiftedBy(6));
    expect(ranges).not.toContainEqual(shiftedBy(7));
    expect(ranges).not.toContainEqual(shiftedBy(12));
    // An opened row's panels count again.
    expect(annotationRanges(panels, rows, () => false, range, now)[2]?.to).toBe(now);
  });
});

describe("import and export", () => {
  const model: DashboardModel = {
    ...emptyModel("E"),
    variables: [{ name: "v", type: "query", datasourceId: "ds-2" }],
    annotations: [{ id: "a", name: "A", datasourceId: "ds-3", query: null, enabled: true }],
    panels: [panel("p"), { ...panel("lib", { targets: [] }), libraryPanelId: "L" }],
  };

  it("writes library panels in and names each source by kind and name", () => {
    const exported = buildExport(
      model,
      {
        L: {
          id: "L",
          name: "Lib",
          version: 1,
          model: panel("x", {
            title: "From library",
            targets: [{ refId: "A", datasourceId: "ds-4", query: {} }],
          }),
        },
      },
      [{ id: "ds-1", kind: "postgres", name: "Shop" }],
    );
    expect(exported.model.panels[1]).toMatchObject({ id: "lib", title: "From library" });
    expect(exported.model.panels[1]).not.toHaveProperty("libraryPanelId");
    expect(exported.datasources).toEqual([
      { id: "ds-1", kind: "postgres", name: "Shop" },
      { id: "ds-4" },
      { id: "ds-2" },
      { id: "ds-3" },
    ]);
  });

  it("reads an export or a bare model, suggests a mapping and applies it", () => {
    expect(readImport("{")).toBeNull();
    expect(readImport("[1]")).toBeNull();
    expect(readImport(JSON.stringify(model))?.sources).toEqual([]);
    const read = readImport(
      JSON.stringify({
        kalzit: "dashboard",
        model,
        datasources: [{ id: "ds-1", kind: "postgres", name: "Shop" }],
      }),
    );
    expect(read?.sources).toEqual([{ id: "ds-1", kind: "postgres", name: "Shop" }]);
    const here = [
      { id: "mine", kind: "postgres", name: "Shop" },
      { id: "ds-2", kind: "mysql", name: "Other" },
    ];
    expect(
      suggestMapping(
        [
          { id: "ds-1", kind: "postgres", name: "Shop" },
          { id: "ds-2" },
          { id: "ds-9", kind: "x", name: "y" },
        ],
        here,
      ),
    ).toEqual({
      "ds-1": "mine",
      "ds-2": "ds-2",
      "ds-9": "",
    });
    const mapped = remapSources(model, { "ds-1": "mine", "ds-2": "two", "ds-3": "three" });
    expect(referencedSources(mapped)).toEqual(["mine", "two", "three"]);
  });
});
