import { describe, expect, it, vi } from "vitest";
import type { PanelModel } from "./model";
import { panelDistribution, windowIdentity } from "./usePanelResults";

const panel: PanelModel = {
  id: "p1",
  type: "distribution",
  title: "",
  grid: { x: 0, y: 0, w: 12, h: 8 },
  targets: [{ refId: "A", datasourceId: "ds", query: { collection: "orders" } }],
  transformations: [],
  options: {},
  fieldConfig: {},
};

function source(over: { from: number; to: number; run: number; manual: number }) {
  return panelDistribution(
    {
      orgId: "o1",
      dashboardId: "d1",
      panel,
      range: { from: over.from, to: over.to },
      variables: {},
      source: "stored",
      manual: over.manual,
      live: { moving: true },
    },
    () => "mongodb",
  );
}

describe("field distributions of a dashboard panel", () => {
  it("keep one question across refreshes and live results, and ask again only when asked to", () => {
    const now = Date.now();
    const first = source({ from: now - 3_600_000, to: now, run: 0, manual: 0 });
    // An auto refresh or a live result resolves the same relative window to a later moment.
    const later = source({ from: now - 3_540_000, to: now + 60_000, run: 7, manual: 0 });
    expect(later.identity).toBe(first.identity);
    expect(later.manual).toBe(first.manual);
    // The Refresh button is the only thing that counts as asking again.
    expect(source({ from: now - 3_600_000, to: now, run: 7, manual: 1 }).manual).toBe(1);
    // Another window length, or a window in the past, is another question.
    expect(source({ from: now - 7_200_000, to: now, run: 0, manual: 0 }).identity).not.toBe(
      first.identity,
    );
    expect(windowIdentity({ from: 0, to: 1000 }, now)).toBe("0:1000");
  });
});

describe("field distributions of a saved analysis", () => {
  it("ask the analysis route, without variables", async () => {
    const answer = {
      total: 1,
      documents: 1,
      missing: 0,
      values: 1,
      nulls: 0,
      distinct: 1,
      distinctCapped: false,
      types: [],
      top: [],
      bins: [],
    };
    const sent = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(answer), { status: 200 }));
    try {
      const now = Date.now();
      const asked = panelDistribution(
        {
          orgId: "o1",
          dashboardId: "",
          panel,
          range: { from: now - 3_600_000, to: now },
          variables: { land: "AT" },
          source: "stored",
          manual: 0,
          route: { kind: "analysis", analysisId: "a1" },
        },
        () => "mongodb",
      );
      const signal = new AbortController().signal;
      expect(await asked.run("A", { path: ["status"] }, signal)).toEqual(answer);
      const [url, init] = sent.mock.calls[0] ?? [];
      expect(String(url)).toBe("/api/orgs/o1/analyses/a1/distribution");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        refId: "A",
        path: ["status"],
        variables: {},
      });
    } finally {
      sent.mockRestore();
    }
  });
});
