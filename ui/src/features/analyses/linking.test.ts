import { describe, expect, it } from "vitest";
import { type LinkedAnalysis, storedModel } from "../dashboards/api";
import { buildExport, inlineAnalyses, missingAnalyses } from "../dashboards/exportImport";
import { emptyModel, type PanelModel } from "../dashboards/model";
import { parseAnalysisModel } from "./api";

const target = { refId: "A", datasourceId: "pg", query: { sql: "SELECT 1" } };

function panel(id: string, extra: Partial<PanelModel> = {}): PanelModel {
  return {
    id,
    type: "table",
    title: id,
    grid: { x: 0, y: 0, w: 12, h: 8 },
    targets: [target],
    transformations: [],
    options: {},
    fieldConfig: {},
    ...extra,
  };
}

const analysis: LinkedAnalysis = {
  id: "an1",
  title: "Customers",
  version: 3,
  model: parseAnalysisModel({
    schemaVersion: 1,
    title: "Customers",
    timeRange: null,
    targets: [{ refId: "A", datasourceId: "pg", query: { sql: "SELECT * FROM customers" } }],
    steps: [{ type: "limit", count: 5 }],
    visualization: { type: "barchart" },
  }),
};

describe("linked panels in the model", () => {
  it("stores a linked panel as a slot without queries or steps, others as they are", () => {
    const model = {
      ...emptyModel("Main"),
      panels: [
        panel("p1"),
        panel("p2", { analysisId: "an1", transformations: [{ type: "limit" }] }),
      ],
    };
    const stored = storedModel(model);
    expect(stored.panels[0]).toBe(model.panels[0]);
    expect(stored.panels[1]).toMatchObject({
      analysisId: "an1",
      targets: [],
      transformations: [],
      type: "table",
      title: "p2",
    });
    // Without links the model is passed on unchanged.
    const plain = { ...emptyModel("Plain"), panels: [panel("p1")] };
    expect(storedModel(plain)).toBe(plain);
  });

  it("writes linked analyses into an export as plain panels with their own look", () => {
    const model = {
      ...emptyModel("Main"),
      panels: [panel("p2", { analysisId: "an1", targets: [], title: "Buyers" })],
    };
    const [inlined] = inlineAnalyses(model, { an1: analysis }).panels;
    expect(inlined?.analysisId).toBeUndefined();
    expect(inlined?.targets).toEqual(analysis.model.targets);
    expect(inlined?.transformations).toEqual(analysis.model.steps);
    // Type and title stay the panel's.
    expect(inlined?.type).toBe("table");
    expect(inlined?.title).toBe("Buyers");
    const exported = buildExport(model, {}, [{ id: "pg", kind: "postgres", name: "Sales" }], {
      an1: analysis,
    });
    expect(exported.datasources).toEqual([{ id: "pg", kind: "postgres", name: "Sales" }]);
  });

  it("keeps the link of an analysis it cannot read and counts it", () => {
    const linked = panel("p2", { analysisId: "gone", targets: [] });
    const model = { ...emptyModel("Main"), panels: [panel("p1"), linked] };
    expect(inlineAnalyses(model, {}).panels[1]).toBe(linked);
    expect(missingAnalyses(model, {})).toBe(1);
    expect(missingAnalyses(model, { gone: { ...analysis, id: "gone" } })).toBe(0);
  });
});
