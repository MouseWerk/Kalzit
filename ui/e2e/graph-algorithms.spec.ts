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
 * with its place and its sentence, its result as a style rule, and the quick actions of the
 * canvas for a viewer, who asks no data source anything with them. Memgraph computes the same
 * step with MAGE or on the server.
 */

const STEP_MS = 20_000;

/** Customers, their orders and the products in them: Ana reaches the monitor arm through Ben. */
const SHOP =
  "MATCH (c:Customer)-[p:PLACED]->(o:Order)-[k:CONTAINS]->(x:Product) RETURN c, p, o, k, x";
const PANEL = "Shop for algorithms";

const SIGMA_WEBGL_NOTICES = [
  /^warning: \[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels/,
];

test.beforeEach(({ consoleGuard }) => {
  for (const notice of SIGMA_WEBGL_NOTICES) consoleGuard.allow(notice);
});

function dashboard(title: string, datasourceId: string) {
  return {
    schemaVersion: 2,
    title,
    timeRange: { from: "now-6h", to: "now" },
    panels: [
      {
        id: "shop",
        type: "network",
        title: PANEL,
        grid: { x: 0, y: 0, w: 24, h: 14 },
        targets: [{ refId: "A", datasourceId, query: { cypher: SHOP } }],
        options: {},
      },
    ],
  };
}

const card = (page: Page) => page.getByRole("article", { name: PANEL, exact: true });

/** Switches the panel to its tables, picks the rows of `names` (Ctrl adds), and back. */
async function choose(panel: Locator, names: readonly string[]) {
  const view = panel.getByRole("group", { name: t("graph.view.label"), exact: true });
  await view.getByRole("button", { name: t("graph.view.table"), exact: true }).click();
  for (const [i, name] of names.entries()) {
    const row = panel.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first();
    await row.click({ modifiers: i === 0 ? [] : ["ControlOrMeta"], timeout: STEP_MS });
  }
  await view.getByRole("button", { name: t("graph.view.graph"), exact: true }).click();
  await expect(panel.getByRole("application", { name: PANEL, exact: true })).toBeVisible();
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
  test.use({ viewport: { width: 1440, height: 1400 } });

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

  test("PageRank from the catalog says where it ran and what it found; its result becomes a rule", async ({
    page,
  }) => {
    await signInOwner(page);
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    await startEditing(page);
    await panelAction(page, PANEL, "dashboards.panel.editNamed");
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
    expect(await seriousViolations(page)).toEqual([]);
  });

  test("a viewer finds the path between two nodes and the most important nodes", async ({
    page,
  }) => {
    if (viewer === null) throw new Error("no viewer");
    await signIn(page, viewer.email, viewer.password);
    const queries: string[] = [];
    page.on("request", (request) => {
      if (/\/query$/.test(new URL(request.url()).pathname)) queries.push(request.url());
    });
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    const panel = card(page);
    const drawing = panel.getByRole("application", { name: PANEL, exact: true });
    const noWebgl = panel.getByText(t("graph.notice.noWebgl"), { exact: true });
    await expect(drawing.or(noWebgl)).toBeVisible({ timeout: STEP_MS });
    test.skip(await noWebgl.isVisible(), "this browser cannot draw graphs");
    const before = queries.length;

    await choose(panel, ["Ana", "Monitor arm"]);
    const bar = panel.getByRole("group", { name: t("graphCanvas.quick.bar"), exact: true });
    await bar.getByRole("button", { name: t("graphCanvas.quick.findPath"), exact: true }).click();
    await bar
      .getByRole("button", { name: t("graphCanvas.quick.path.shortest"), exact: true })
      .click();
    const sheet = panel.getByRole("region", {
      name: t("graphCanvas.quick.path.shortest"),
      exact: true,
    });
    // Along PLACED and CONTAINS, Ana reaches the monitor arm only through Ben.
    await expect(
      sheet.getByRole("button", { name: /^Path 1: Ana › .*Ben.* › Monitor arm/ }),
    ).toBeVisible({ timeout: STEP_MS });
    expect(await seriousViolations(page)).toEqual([]);
    await sheet.getByRole("button", { name: t("graphCanvas.quick.close"), exact: true }).click();

    await bar.getByRole("button", { name: t("graphCanvas.quick.top"), exact: true }).click();
    const top = panel.getByRole("region", { name: t("graphCanvas.quick.top"), exact: true });
    await expect(top.getByRole("listitem").first()).toBeVisible({ timeout: STEP_MS });
    await top
      .getByRole("radio", { name: t("graphCanvas.quick.measure.degree"), exact: true })
      .click();
    await expect(
      top.getByRole("radio", { name: t("graphCanvas.quick.measure.degree") }),
    ).toHaveAttribute("aria-checked", "true");
    expect(await seriousViolations(page)).toEqual([]);
    // The quick actions computed on the loaded graph: no new query reached the data source.
    expect(queries.length).toBe(before);
  });
});

test("Memgraph computes PageRank too, in MAGE or on the server", async ({ page }) => {
  const address = serviceAddress("KALZIT_E2E_MEMGRAPH");
  const owner = await Api.owner();
  let dashboardId = "";
  try {
    const sourceId = await owner.createSource(
      unique("Shop graph in Memgraph"),
      "memgraph",
      // The container has no users, so anyone may write: the source accepts that explicitly.
      { ...boltTarget(address), allowWriteCapableUser: true },
    );
    dashboardId = await owner.createDashboard(dashboard(unique("Memgraph algorithms"), sourceId));
  } finally {
    await owner.dispose();
  }
  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
  await startEditing(page);
  await panelAction(page, PANEL, "dashboards.panel.editNamed");
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
