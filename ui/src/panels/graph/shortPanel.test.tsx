import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { QueryRequest } from "../../api/generated/shapes";
import { emptyModel, type PanelModel } from "../../features/dashboards/model";
import { addDashboard } from "../../features/dashboards/test/fakeDashboards";
import { addNeo4jSource } from "../../features/datasources/test/fakeDatasources";
import { NEO4J_ID } from "../../features/datasources/test/fakeGraph";
import { parseCss } from "../../test/cssParse";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { COMPACT_BELOW_REM, isShort } from "./shortPanel";

beforeAll(async () => {
  await import("./GraphPanels");
});

const SRC = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(SRC, path), "utf8");
const rules = (path: string) => parseCss(read(path));
const declarations = (path: string, selector: string) =>
  rules(path)
    .filter((rule) => rule.selector === selector)
    .flatMap((rule) => rule.declarations);

/** Height of a graph panel's root in a dashboard panel `rows` grid rows tall, in rem. */
function panelHeight(rows: number): number {
  // Rows of 2rem with 0.5rem between them, less the 2rem header and the body's padding.
  return rows * 2 + (rows - 1) * 0.5 - 2 - (0.5 + 0.75);
}

describe("short graph panels", () => {
  it("count a panel of eight or nine grid rows as short, one of fourteen as not", () => {
    expect(isShort(panelHeight(8) * 16, 16)).toBe(true);
    expect(isShort(panelHeight(9) * 16, 16)).toBe(true);
    expect(isShort(panelHeight(14) * 16, 16)).toBe(false);
    expect(isShort(COMPACT_BELOW_REM * 16, 16)).toBe(false);
    // Not measured yet, or hidden: the full form.
    expect(isShort(null, 16)).toBe(false);
    expect(isShort(0, 16)).toBe(false);
  });

  it("keep the steps, notes and tools in the flow above the body, and scroll rather than squeeze", () => {
    const css = "panels/graph/graph.css";
    // Nothing above the body shrinks into it or lies over it.
    expect(declarations(css, ".graph > :not(.graph__body)")).toContainEqual({
      property: "flex",
      value: "none",
    });
    for (const rule of rules(css)) {
      if (!rule.selector.startsWith(".graph-steps")) continue;
      const position = rule.declarations.find((d) => d.property === "position")?.value;
      expect([undefined, "static", "relative"]).toContain(position);
    }
    // The body's one row is its height: the table and the sheet scroll inside it.
    expect(declarations(css, ".graph__body")).toContainEqual({
      property: "grid-template-rows",
      value: "minmax(0, 1fr)",
    });
    // In a dashboard panel the body keeps a minimum and the panel scrolls.
    expect(declarations(css, ".panel-card .graph__body")).toContainEqual({
      property: "min-height",
      value: "var(--size-graph-min-panel)",
    });
    expect(declarations(css, ".panel-card .graph")).toContainEqual({
      property: "overflow-y",
      value: "auto",
    });
    // The compact steps stay on one line that scrolls sideways.
    expect(declarations(css, ".graph-steps--compact .graph-steps__list")).toEqual(
      expect.arrayContaining([
        { property: "flex-wrap", value: "nowrap" },
        { property: "overflow-x", value: "auto" },
      ]),
    );
  });
});

/** Every observed element reports this height, as a dashboard panel of that size would. */
function observeHeight(height: number) {
  class FakeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      Object.defineProperty(target, "clientHeight", { configurable: true, value: height });
      this.callback(
        [{ target, contentRect: { width: 640, height } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", FakeObserver);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function explorerPanel(rows: number): PanelModel {
  return {
    id: "p-graph",
    type: "network",
    title: "Purchases",
    grid: { x: 0, y: 0, w: 12, h: rows },
    targets: [
      {
        refId: "A",
        datasourceId: NEO4J_ID,
        query: { cypher: "MATCH (c)-[b]->(p) RETURN c, b, p" },
      },
    ],
    transformations: [],
    options: { explorer: true, expandLimit: 10 },
    fieldConfig: {},
  };
}

function setup(rows: number) {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "editor" }] },
  });
  addNeo4jSource(server.areas.datasources);
  addDashboard(server.areas.dashboards, "d-shop", {
    ...emptyModel("Shop"),
    panels: [explorerPanel(rows)],
  });
  return server;
}

describe("the explorer in a short panel", () => {
  it("shows the steps on one line with the next step's settings behind a button, and rows stay clickable", async () => {
    observeHeight(panelHeight(8) * 16);
    const server = setup(8);
    const { user } = renderApp("/dashboards/d-shop");
    const panel = await screen.findByRole("article", { name: "Purchases" });
    const steps = await within(panel).findByRole("region", { name: "Steps" });
    const next = within(steps).getByRole("button", { name: "Next step" });
    expect(next.getAttribute("aria-expanded")).toBe("false");
    expect(within(steps).queryByRole("textbox", { name: "Neighbours per step" })).toBeNull();

    // A row of the node table takes the click and loads the neighbours.
    const table = within(panel).getByRole("table", { name: /^Nodes of / });
    await user.click(within(table).getByRole("button", { name: "Desk" }));
    expect(await within(steps).findByRole("button", { name: "Desk +1 of 1" })).toBeTruthy();
    const sent = server.areas.datasources.queries.at(-1) as QueryRequest;
    expect(JSON.stringify(sent.queries[0]?.query)).toContain("LIMIT 10");

    await user.click(next);
    expect(next.getAttribute("aria-expanded")).toBe("true");
    expect(within(steps).getByRole("textbox", { name: "Neighbours per step" })).toBeTruthy();
  });

  it("shows the full steps bar in a tall panel", async () => {
    observeHeight(panelHeight(16) * 16);
    setup(16);
    renderApp("/dashboards/d-shop");
    const panel = await screen.findByRole("article", { name: "Purchases" });
    const steps = await within(panel).findByRole("region", { name: "Steps" });
    expect(within(steps).getByRole("textbox", { name: "Neighbours per step" })).toBeTruthy();
    expect(within(steps).queryByRole("button", { name: "Next step" })).toBeNull();
  });
});
