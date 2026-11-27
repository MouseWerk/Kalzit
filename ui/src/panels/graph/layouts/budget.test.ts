import { describe, expect, it } from "vitest";
import type { LayoutMode, LayoutRequest } from "../layoutProtocol";
import { buildGraphModel, edgeWidths, nodeSizes } from "../model";
import { bestOf, generateGraph } from "../test/generate";
import { layoutRequest } from "../useGraphLayout";
import { buildView } from "../view";
import { HIERARCHY_NODE_LIMIT, type LayoutSettings, layoutProperties, planLayout } from "./inputs";
import { placeLayout } from "./place";

/**
 * Budgets of the layouts (docs/PLAN.md, section 15, stage 0.8.1). A hierarchy of 10,000 drawn
 * nodes is laid out in the layout worker, so its own time holds no one up; it still has to end
 * while the person waits (WORKER_MS). What stays on the page is bounded like the rest of the
 * graph panel (budget.test.tsx): reading the result for a layout and building its request, each
 * within one long task. The other layouts place up to the panel's hard limit of 20,000 nodes.
 * Timed as the best of a few runs; CI runners get twice the time.
 */
const CI = process.env.CI !== undefined;
const LONG_TASK_MS = CI ? 100 : 50;
const WORKER_MS = CI ? 2_000 : 1_000;
const RUNS = 3;
const PANEL_LIMIT = 20_000;

function timed(name: string, work: () => void): number {
  const ms = bestOf(RUNS, work);
  process.stdout.write(`layout budget: ${name} ${ms.toFixed(1)} ms (best of ${RUNS})\n`);
  return ms;
}

function drawn(nodes: number, edges: number) {
  const set = generateGraph(nodes, edges);
  // The generator's nodes carry a score; the timeline reads a date beside it.
  set.nodes.forEach((node, i) => {
    node.properties.rank = i % 97;
    if (i % 5 !== 0)
      node.properties.since = new Date(Date.UTC(2020, 0, 1 + (i % 2_000))).toISOString();
  });
  const model = buildGraphModel([set], { nodeLimit: nodes, caption: "" });
  const view = buildView(model, {
    sizes: nodeSizes(model, "degree"),
    widths: edgeWidths(model, ""),
    groups: Int32Array.from(model.nodes, (n) => n.label),
    cluster: false,
    open: new Set(),
    clusterCaption: (label) => label,
    unlabelled: "",
  });
  return { model, view };
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

describe("budget: a hierarchy of 10,000 drawn nodes", () => {
  const { model, view } = drawn(HIERARCHY_NODE_LIMIT, 20_000);
  const build = (): LayoutRequest => layoutRequest(view, "hierarchy", 1, new Map());

  it("has the size it claims and is within the limit", () => {
    expect(view.nodes).toHaveLength(HIERARCHY_NODE_LIMIT);
    const plan = planLayout(
      model,
      view,
      layoutProperties(model),
      { ...SETTINGS, mode: "hierarchy" },
      [],
      "en",
    );
    expect(plan.reason).toBeNull();
  });

  it("builds its request on the page within one long task", () => {
    expect(timed("hierarchy request, 10,000 nodes", build)).toBeLessThan(LONG_TASK_MS);
  });

  it("is laid out in the worker while the person waits", () => {
    const request = build();
    let said = 0;
    const ms = timed("hierarchy layout, 10,000 nodes and 20,000 edges", () => {
      const result = placeLayout(request, () => {
        said++;
      });
      expect(result.positions).toHaveLength(HIERARCHY_NODE_LIMIT * 2);
    });
    expect(ms).toBeLessThan(WORKER_MS);
    // It says how far it is on the way, for the note over the drawing.
    expect(said).toBeGreaterThan(3);
  });

  it("refuses one node more, with the reason", () => {
    const larger = drawn(HIERARCHY_NODE_LIMIT + 1, 100);
    const plan = planLayout(
      larger.model,
      larger.view,
      layoutProperties(larger.model),
      { ...SETTINGS, mode: "hierarchy" },
      [],
      "en",
    );
    expect(plan.reason).toBe("tooLarge");
    expect(plan.total).toBe(HIERARCHY_NODE_LIMIT + 1);
  });
});

describe("budget: the other layouts at the panel's limit of 20,000 nodes", () => {
  const { model, view } = drawn(PANEL_LIMIT, 40_000);
  const properties = layoutProperties(model);
  const MODES: readonly LayoutMode[] = ["radial", "circular", "grid", "coordinates", "timeline"];

  it("reads the result's properties within one long task", () => {
    expect(timed("layout properties, 20,000 nodes", () => layoutProperties(model))).toBeLessThan(
      LONG_TASK_MS,
    );
    expect(properties.numbers.map((p) => p.key)).toEqual(expect.arrayContaining(["score", "rank"]));
    expect(properties.times.map((p) => p.key)).toEqual(["since"]);
  });

  it.each(MODES)("plans and lays out a %s layout", (mode) => {
    const settings = { ...SETTINGS, mode };
    const plan = planLayout(model, view, properties, settings, [], "en");
    expect(plan.reason).toBeNull();
    // Sorting 20,000 names for a circle or grid is the one step above a frame or two.
    expect(
      timed(`${mode} plan, 20,000 nodes`, () =>
        planLayout(model, view, properties, settings, [], "en"),
      ),
    ).toBeLessThan(mode === "circular" || mode === "grid" ? LONG_TASK_MS * 4 : LONG_TASK_MS);
    const request = layoutRequest(view, mode, 1, new Map(), { input: plan.input });
    expect(
      timed(`${mode} layout, 20,000 nodes`, () => {
        expect(placeLayout(request).positions).toHaveLength(PANEL_LIMIT * 2);
      }),
    ).toBeLessThan(WORKER_MS);
  });
});
