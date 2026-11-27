import type { Locator, Page } from "@playwright/test";
import { Api, type Member, unique } from "./support/api";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { boltTarget, GRAPH_FIXTURE, serviceAddress } from "./support/services";
import { expect, signIn, signInOwner, test } from "./support/test";
import { panelAction, startEditing } from "./support/ui";

/**
 * Graph algorithms and paths (board Graph082, docs/guide/graph-algorithms.md), against the shop
 * graph of e2e/fixtures/graph-shop.cypher: an algorithm step from the catalog in the panel editor
 * with its place, its sentence and its result as a style rule; the quick actions of the canvas for
 * a viewer (paths with their keys, "how are these connected", the most important nodes, Escape),
 * who asks no data source anything with them, with their sheet in place of the node sheet;
 * suggested edges with the key U; and Memgraph computing the same step.
 */

const STEP_MS = 20_000;

/**
 * Customers, their orders and the products in them: Ana reaches the monitor arm through Ben.
 * CONTAINS carries a number (`quantity`), which a weighted path can sum.
 */
const SHOP =
  "MATCH (c:Customer)-[p:PLACED]->(o:Order)-[k:CONTAINS]->(x:Product) RETURN c, p, o, k, x";
/**
 * The whole shop, its category tree included: Ana reaches the monitor arm along several loopless
 * paths (src/panels/graph/canvas/shopFixture.test.ts counts them), so k shortest paths walk.
 */
const WHOLE = "MATCH (n) OPTIONAL MATCH (n)-[r]->(m) RETURN n, r, m";
/** Customers and their orders only: no number on any edge. */
const ORDERS = "MATCH (c:Customer)-[p:PLACED]->(o:Order) RETURN c, p, o";
const PANELS = {
  shop: "Shop for algorithms",
  orders: "Orders without weights",
  suggested: "Shop with suggestions",
  whole: "Whole shop",
} as const;

const SIGMA_WEBGL_NOTICES = [
  /^warning: \[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels/,
];

test.beforeEach(({ consoleGuard }) => {
  for (const notice of SIGMA_WEBGL_NOTICES) consoleGuard.allow(notice);
});

function dashboard(title: string, datasourceId: string) {
  const panel = (id: string, name: string, y: number, cypher: string, more = {}) => ({
    id,
    type: "network",
    title: name,
    grid: { x: 0, y, w: 24, h: 14 },
    targets: [{ refId: "A", datasourceId, query: { cypher } }],
    options: {},
    ...more,
  });
  return {
    schemaVersion: 2,
    title,
    timeRange: { from: "now-6h", to: "now" },
    panels: [
      panel("shop", PANELS.shop, 0, SHOP),
      panel("orders", PANELS.orders, 14, ORDERS),
      panel("whole", PANELS.whole, 42, WHOLE),
      panel("suggested", PANELS.suggested, 28, SHOP, {
        transformations: [
          {
            id: "0199f0a0-1c2e-7a4b-9e1d-3f5a6b7c8d91",
            type: "linkPrediction",
            frame: "A",
            measure: "adamicAdar",
            topK: 3,
          },
        ],
      }),
    ],
  };
}

const card = (page: Page, title: string) => page.getByRole("article", { name: title, exact: true });
const bar = (panel: Locator) =>
  panel.getByRole("group", { name: t("graphCanvas.quick.bar"), exact: true });

/** Switches the panel to its tables, picks the rows of `names` (Ctrl adds), and back. */
async function choose(panel: Locator, title: string, names: readonly string[]) {
  const view = panel.getByRole("group", { name: t("graph.view.label"), exact: true });
  await view.getByRole("button", { name: t("graph.view.table"), exact: true }).click();
  for (const [i, name] of names.entries()) {
    const row = panel.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first();
    await row.click({ modifiers: i === 0 ? [] : ["ControlOrMeta"], timeout: STEP_MS });
  }
  await view.getByRole("button", { name: t("graph.view.graph"), exact: true }).click();
  await expect(panel.getByRole("application", { name: title, exact: true })).toBeVisible();
}

/** Waits for the drawing; skips where the browser cannot draw graphs. */
async function drawn(panel: Locator, title: string): Promise<Locator> {
  const drawing = panel.getByRole("application", { name: title, exact: true });
  const noWebgl = panel.getByText(t("graph.notice.noWebgl"), { exact: true });
  await expect(drawing.or(noWebgl)).toBeVisible({ timeout: STEP_MS });
  test.skip(await noWebgl.isVisible(), "this browser cannot draw graphs");
  return drawing;
}

async function addPageRank(page: Page, steps: Locator) {
  await steps.getByRole("button", { name: t("analysis.steps.add"), exact: true }).click();
  const catalog = page.getByRole("dialog", { name: t("analysis.steps.add") });
  await expect(
    catalog.getByText(
      t("analysis.catalog.groupCount", {
        group: t("graphSteps.catalog.graphGroup.centrality"),
        count: 6,
      }),
      { exact: true },
    ),
  ).toBeVisible({ timeout: STEP_MS });
  expect(await seriousViolations(page)).toEqual([]);
  await catalog
    .getByRole("searchbox", { name: t("analysis.catalog.search") })
    .fill(t("graphSteps.kind.centrality.pageRank"));
  await page.keyboard.press("Enter");
  await expect(catalog).toHaveCount(0);
}

test.describe("graph algorithms", () => {
  // Tall enough for all four panels at once: each draws only once it is on screen.
  test.use({ viewport: { width: 1440, height: 2600 } });

  let dashboardId = "";
  let viewer: Member | null = null;

  test.beforeAll(async () => {
    const address = serviceAddress("KALZIT_E2E_NEO4J");
    const owner = await Api.owner();
    try {
      const sourceId = await owner.createSource(
        unique("Shop graph for algorithms"),
        "neo4j",
        { ...boltTarget(address), user: GRAPH_FIXTURE.neo4jUser },
        { password: GRAPH_FIXTURE.neo4jPassword },
      );
      dashboardId = await owner.createDashboard(dashboard(unique("Algorithms"), sourceId));
      viewer = await owner.createMember(unique("Ada Viewer"), "viewer");
    } finally {
      await owner.dispose();
    }
  });

  test("PageRank from the catalog says where it ran and what it found; its result becomes rules", {
    tag: "@smoke",
  }, async ({ page }) => {
    await signInOwner(page);
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    await startEditing(page);
    await panelAction(page, PANELS.shop, "dashboards.panel.editNamed");
    await page.getByRole("tab", { name: /^Steps/ }).click();
    const steps = page.getByRole("region", { name: t("analysis.steps.title"), exact: true });
    await addPageRank(page, steps);
    const first = steps.getByRole("listitem", { name: t("analysis.steps.number", { n: 1 }) });
    // In Neo4j with Graph Data Science, else on the server with the reason; the same result.
    await expect(
      first
        .getByText(t("graphSteps.where.library", { engine: "Neo4j", library: "GDS" }))
        .or(first.getByText(t("analysis.where.server"), { exact: true })),
    ).toBeVisible({ timeout: STEP_MS });
    await expect(first.getByText(/^17 nodes scored\. Highest value: /)).toBeVisible({
      timeout: STEP_MS,
    });
    await first.getByRole("button", { name: t("graphSteps.algo.useSize"), exact: true }).click();
    await expect(
      page.getByText(t("graphSteps.algo.added.size", { property: "pagerank" })),
    ).toBeAttached();
    await first.getByRole("button", { name: t("graphSteps.algo.useColor"), exact: true }).click();
    await expect(
      page.getByText(t("graphSteps.algo.added.color", { property: "pagerank" })),
    ).toBeAttached();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test("a viewer finds paths, walks them, sees how nodes connect, and the most important nodes", {
    tag: "@smoke",
  }, async ({ page }) => {
    if (viewer === null) throw new Error("no viewer");
    await signIn(page, viewer.email, viewer.password);
    const queries: string[] = [];
    page.on("request", (request) => {
      if (/\/query$/.test(new URL(request.url()).pathname)) queries.push(request.url());
    });
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    const panel = card(page, PANELS.shop);
    const drawing = await drawn(panel, PANELS.shop);
    const whole = card(page, PANELS.whole);
    await whole.scrollIntoViewIfNeeded();
    const wholeDrawing = await drawn(whole, PANELS.whole);
    const before = queries.length;

    await test.step("three shortest paths, walked with J and Shift+J", async () => {
      await whole.scrollIntoViewIfNeeded();
      await choose(whole, PANELS.whole, ["Ana", "Monitor arm"]);
      await bar(whole)
        .getByRole("button", { name: t("graphCanvas.quick.findPath") })
        .click();
      // Focus is in the menu; a weight per number on the edges.
      await expect(
        bar(whole).getByRole("button", { name: t("graphCanvas.quick.path.shortest") }),
      ).toBeFocused();
      await expect(
        bar(whole).getByRole("button", {
          name: t("graphCanvas.quick.path.weightedBy", { property: "quantity" }),
        }),
      ).toBeVisible();
      await bar(whole)
        .getByRole("button", { name: t("graphCanvas.quick.path.kShortestN", { k: 3 }) })
        .click();
      const sheet = whole.getByRole("region", {
        name: t("graphCanvas.quick.path.kShortestN", { k: 3 }),
        exact: true,
      });
      const first = sheet.getByRole("button", { name: /^Path 1: Ana › .* › Monitor arm/ });
      await expect(first).toHaveAttribute("aria-pressed", "true", { timeout: STEP_MS });
      await expect(sheet.getByRole("button", { name: /^Path 3: Ana › / })).toBeVisible();
      // One sheet at a time: the answer stands where the node sheet would, beside the drawing.
      await expect(whole.locator(".graph__details")).toHaveCount(1);
      const canvasBox = await wholeDrawing.boundingBox();
      const sheetBox = await sheet.boundingBox();
      if (canvasBox === null || sheetBox === null) throw new Error("no layout");
      const overlaps =
        sheetBox.x < canvasBox.x + canvasBox.width &&
        canvasBox.x < sheetBox.x + sheetBox.width &&
        sheetBox.y < canvasBox.y + canvasBox.height &&
        canvasBox.y < sheetBox.y + sheetBox.height;
      expect(overlaps).toBe(false);
      expect(await seriousViolations(page)).toEqual([]);
      await wholeDrawing.focus();
      await page.keyboard.press("j");
      await expect(sheet.getByRole("button", { name: /^Path 2: / })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.keyboard.press("Shift+J");
      await expect(first).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
    });

    await test.step("how three nodes are connected, with W", async () => {
      await choose(panel, PANELS.shop, ["Ana", "Ben", "Clara"]);
      await drawing.focus();
      await page.keyboard.press("w");
      const sheet = panel.getByRole("region", {
        name: t("graphCanvas.quick.connect"),
        exact: true,
      });
      await expect(sheet.getByText(t("graphCanvas.quick.connected", { count: 3 }))).toBeVisible({
        timeout: STEP_MS,
      });
      await sheet.getByRole("button", { name: t("graphCanvas.quick.close") }).click();
    });

    await test.step("the most important nodes by another measure", async () => {
      await bar(panel)
        .getByRole("button", { name: t("graphCanvas.quick.top") })
        .click();
      const top = panel.getByRole("region", { name: t("graphCanvas.quick.top"), exact: true });
      await expect(top.getByRole("listitem").first()).toBeVisible({ timeout: STEP_MS });
      const pageRank = top.getByRole("radio", { name: t("graphCanvas.quick.measure.pageRank") });
      await pageRank.focus();
      await page.keyboard.press("ArrowRight");
      await expect(
        top.getByRole("radio", { name: t("graphCanvas.quick.measure.degree") }),
      ).toHaveAttribute("aria-checked", "true");
      expect(await seriousViolations(page)).toEqual([]);
    });
    // The quick actions computed on the loaded graph: no new query reached the data source.
    expect(queries.length).toBe(before);
  });

  test("without a number on the edges the weighted path says why", async ({ page }) => {
    if (viewer === null) throw new Error("no viewer");
    await signIn(page, viewer.email, viewer.password);
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    const panel = card(page, PANELS.orders);
    await drawn(panel, PANELS.orders);
    await choose(panel, PANELS.orders, ["Ana", "Ben"]);
    await bar(panel)
      .getByRole("button", { name: t("graphCanvas.quick.findPath") })
      .click();
    const weighted = bar(panel).getByRole("button", {
      name: new RegExp(`^${t("graphCanvas.quick.path.weighted")}`),
    });
    await expect(weighted).toHaveAttribute("aria-disabled", "true");
    await expect(weighted).toContainText(t("graphCanvas.quick.noWeight"));
    await page.keyboard.press("Escape");
    await expect(weighted).toHaveCount(0);
  });

  test("suggested edges are not counted; U hides and shows them", async ({ page }) => {
    if (viewer === null) throw new Error("no viewer");
    await signIn(page, viewer.email, viewer.password);
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    const panel = card(page, PANELS.suggested);
    const drawing = await drawn(panel, PANELS.suggested);
    const toggle = panel.getByRole("button", {
      name: t("graphCanvas.quick.suggestionsToggle"),
      exact: true,
    });
    await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: STEP_MS });
    await expect(panel.getByText(/suggested edges; they are not counted/)).toBeVisible();
    await drawing.focus();
    await page.keyboard.press("u");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(
      panel.getByText(t("graphCanvas.quick.suggestionsHidden"), { exact: true }),
    ).toBeAttached();
    await page.keyboard.press("u");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  });
});

test("Memgraph computes PageRank too, in MAGE or on the server", async ({ page }) => {
  const address = serviceAddress("KALZIT_E2E_MEMGRAPH");
  const owner = await Api.owner();
  let dashboardId = "";
  try {
    const sourceId = await owner.createSource(unique("Shop graph in Memgraph"), "memgraph", {
      ...boltTarget(address),
      // The container has no users, so anyone may write: the source accepts that explicitly.
      allowWriteCapableUser: true,
    });
    dashboardId = await owner.createDashboard(dashboard(unique("Memgraph algorithms"), sourceId));
  } finally {
    await owner.dispose();
  }
  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
  await startEditing(page);
  await panelAction(page, PANELS.shop, "dashboards.panel.editNamed");
  await page.getByRole("tab", { name: /^Steps/ }).click();
  const steps = page.getByRole("region", { name: t("analysis.steps.title"), exact: true });
  await addPageRank(page, steps);
  const first = steps.getByRole("listitem", { name: t("analysis.steps.number", { n: 1 }) });
  await expect(
    first
      .getByText(t("graphSteps.where.library", { engine: "Memgraph", library: "MAGE" }))
      .or(first.getByText(t("analysis.where.server"), { exact: true })),
  ).toBeVisible({ timeout: STEP_MS });
  await expect(first.getByText(/^17 nodes scored\./)).toBeVisible({ timeout: STEP_MS });
});
