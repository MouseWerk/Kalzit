import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { Api, unique } from "./support/api";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { findOverflow } from "./support/overflow";
import { BINARY as PLUGIN_BINARY, publisherKey, testPluginPackage } from "./support/plugin";
import { boltTarget, GRAPH_FIXTURE, serviceAddress } from "./support/services";
import { expect, signInOwner, test } from "./support/test";
import { fillQuery } from "./support/ui";

/** Each step gets its own limit, so a failure names the step instead of the test's timeout. */
const STEP_MS = 15_000;

/** Customers, their orders and the products in them: the fixture's 17 nodes and 16 edges. */
const SHOP =
  "MATCH (c:Customer)-[p:PLACED]->(o:Order)-[i:CONTAINS]->(pr:Product) RETURN c, p, o, i, pr";
const CATEGORIES = "MATCH (a:Category)-[r:SUBCATEGORY]->(b:Category) RETURN a, r, b";
/** Along orders alone, Ana reaches the monitor arm only through Ben (graph-shop.cypher). */
const ANA_TO_ARM =
  "MATCH p = shortestPath((c:Customer {name: 'Ana'})-[:PLACED|CONTAINS*..10]-(pr:Product {name: 'Monitor arm'})) RETURN p";
const ANA = "MATCH (c:Customer {name: 'Ana'}) RETURN c";
const CUSTOMERS = "MATCH (c:Customer) RETURN c";
const ORDERS_OF_CUSTOMER =
  "MATCH (c:Customer {name: $customer})-[p:PLACED]->(o:Order) RETURN c, p, o";

/**
 * What Chromium's software WebGL (SwiftShader, as on the CI runners) reports while Sigma draws:
 * reading the picking buffer back stalls the software GPU. A performance note of the driver, not
 * an error; everything else on the console still fails the test. (The label programs' picking
 * pass that Chromium refused, "missing fragment shader outputs", is dropped by labelPicking.ts.)
 */
const SIGMA_WEBGL_NOTICES = [
  /^warning: \[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels/,
];

test.beforeEach(({ consoleGuard }) => {
  for (const notice of SIGMA_WEBGL_NOTICES) consoleGuard.allow(notice);
});

/** The line under a graph panel's tools: "17 nodes, 16 edges, 1 component." */
function summary(nodes: number, edges: number, components = 1): string {
  const count = (noun: string, n: number) =>
    t(`graph.count.${noun}.${n === 1 ? "one" : "other"}`, { count: n });
  return t("graph.summary", {
    nodes: count("node", nodes),
    edges: count("edge", edges),
    components: count("component", components),
  });
}

/**
 * Waits for the graph to be drawn, or for the note that this browser cannot draw it (no WebGL 2,
 * where the panel shows the tables instead), and switches a drawn graph to its tables: their
 * rows are the buttons a person (and a screen reader) selects nodes with.
 */
async function showTables(scope: Locator, title: string): Promise<void> {
  const drawing = scope.getByRole("application", { name: title, exact: true });
  const noWebgl = scope.getByText(t("graph.notice.noWebgl"), { exact: true });
  await expect(drawing.or(noWebgl)).toBeVisible({ timeout: STEP_MS });
  if (await drawing.isVisible()) {
    await scope
      .getByRole("button", { name: t("graph.showTable"), exact: true })
      .click({ timeout: STEP_MS });
  }
  await expect(
    scope.getByRole("table", {
      name: new RegExp(`^${t("graph.table.nodes", { title, count: "\\d+" })}$`),
    }),
  ).toBeVisible({ timeout: STEP_MS });
}

/** The caption of a graph panel's node table, which counts the nodes shown. */
function nodeTable(scope: Locator, title: string, count: number): Locator {
  return scope.getByRole("table", {
    name: t("graph.table.nodes", { title, count }),
    exact: true,
  });
}

/** Runs a Cypher query on a source in Explore and waits for the result. */
async function explore(page: Page, source: string, cypher: string): Promise<Locator> {
  await page.goto("/explore", { timeout: STEP_MS });
  await page
    .getByLabel(t("explore.datasource"))
    .selectOption({ label: source }, { timeout: STEP_MS });
  await fillQuery(page, cypher);
  await page.getByRole("button", { name: t("explore.run") }).click({ timeout: STEP_MS });
  return page.getByRole("region", { name: t("explore.result") });
}

/** A graph dashboard on the Neo4j source: one panel per graph panel type and feature. */
function graphDashboard(title: string, datasourceId: string) {
  const panel = (
    id: string,
    type: string,
    name: string,
    grid: { x: number; y: number; w: number; h: number },
    cypher: string,
    options: Record<string, unknown> = {},
  ) => ({
    id,
    type,
    title: name,
    grid,
    targets: [{ refId: "A", datasourceId, query: { cypher } }],
    options,
  });
  return {
    schemaVersion: 1,
    title,
    timeRange: { from: "now-6h", to: "now" },
    variables: [
      { name: "customer", label: "Customer", type: "textbox", current: { value: "David" } },
    ],
    panels: [
      panel("shop", "network", PANELS.shop, { x: 0, y: 0, w: 12, h: 9 }, SHOP, { nodeLimit: 10 }),
      panel("tree", "hierarchy", PANELS.tree, { x: 12, y: 0, w: 12, h: 9 }, CATEGORIES),
      panel("path", "path", PANELS.path, { x: 0, y: 9, w: 12, h: 9 }, ANA_TO_ARM),
      panel("explorer", "network", PANELS.explorer, { x: 12, y: 9, w: 12, h: 9 }, ANA, {
        explorer: true,
        expandLimit: 1,
      }),
      panel("customers", "network", PANELS.customers, { x: 0, y: 18, w: 12, h: 9 }, CUSTOMERS, {
        variable: "customer",
        variableProperty: "name",
      }),
      panel("orders", "network", PANELS.orders, { x: 12, y: 18, w: 12, h: 9 }, ORDERS_OF_CUSTOMER),
    ],
  };
}

const PANELS = {
  shop: "Customers, orders and products",
  tree: "Category tree",
  path: "From Ana to the monitor arm",
  explorer: "Around Ana",
  customers: "Customers",
  orders: "Orders of the customer",
} as const;

test.describe("Neo4j", () => {
  test.use({ viewport: { width: 1440, height: 1600 } });

  let sourceName = "";
  let dashboardId = "";

  test.beforeAll(async () => {
    const address = serviceAddress("KALZIT_E2E_NEO4J");
    sourceName = unique("Shop graph (Neo4j)");
    const owner = await Api.owner();
    try {
      const sourceId = await owner.createSource(
        sourceName,
        "neo4j",
        { ...boltTarget(address), user: GRAPH_FIXTURE.neo4jUser },
        { password: GRAPH_FIXTURE.neo4jPassword },
      );
      dashboardId = await owner.createDashboard(graphDashboard(unique("Shop graph"), sourceId));
    } finally {
      await owner.dispose();
    }
  });

  test("a Cypher query in Explore stays a graph and offers the graph panels", async ({ page }) => {
    await signInOwner(page);
    const result = await explore(page, sourceName, SHOP);
    await expect(result).toContainText(
      summary(GRAPH_FIXTURE.shop.nodes, GRAPH_FIXTURE.shop.edges),
      {
        timeout: STEP_MS,
      },
    );
    const visualization = page.getByLabel(t("explore.visualization"), { exact: true });
    await expect(visualization).toHaveValue("network");
    for (const type of ["network", "hierarchy", "path"]) {
      await expect(visualization.locator(`option[value="${type}"]`)).toHaveCount(1);
    }
    await showTables(result, t("explore.result"));
    await expect(nodeTable(result, t("explore.result"), GRAPH_FIXTURE.shop.nodes)).toBeVisible();
    await expect(result.getByRole("button", { name: "Ana", exact: true })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test("network, hierarchy and path panels, explorer mode and a click that sets a variable", async ({
    page,
  }) => {
    await signInOwner(page);
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    const card = (title: string) => page.getByRole("article", { name: title, exact: true });

    await test.step("the network keeps its node limit and says so, with the tables as fallback", async () => {
      const shop = card(PANELS.shop);
      await expect(
        shop.getByText(t("graph.notice.cut", { shown: 10, count: GRAPH_FIXTURE.shop.nodes }), {
          exact: true,
        }),
      ).toBeVisible({ timeout: STEP_MS });
      await showTables(shop, PANELS.shop);
      await expect(nodeTable(shop, PANELS.shop, 10)).toBeVisible();
    });

    await test.step("the hierarchy draws the category tree", async () => {
      const tree = card(PANELS.tree);
      await expect(tree).toContainText(
        summary(GRAPH_FIXTURE.categories.nodes, GRAPH_FIXTURE.categories.edges),
        { timeout: STEP_MS },
      );
      await showTables(tree, PANELS.tree);
      await expect(nodeTable(tree, PANELS.tree, GRAPH_FIXTURE.categories.nodes)).toBeVisible();
      await expect(tree.getByRole("button", { name: "All products", exact: true })).toBeVisible();
    });

    await test.step("the path reads from Ana through Ben to the monitor arm", async () => {
      const paths = card(PANELS.path).getByRole("list", { name: PANELS.path, exact: true });
      await expect(
        paths.getByRole("heading", { name: t("graph.path.title", { number: 1, count: 6 }) }),
      ).toBeVisible({ timeout: STEP_MS });
      const nodes = paths.locator(".path__node > :first-child");
      await expect(nodes).toHaveText([
        "Ana",
        "A-1002",
        "Desk lamp",
        "A-1003",
        "Ben",
        "A-1004",
        "Monitor arm",
      ]);
    });

    await test.step("explorer mode loads neighbours step by step, and the steps go back", async () => {
      const around = card(PANELS.explorer);
      await showTables(around, PANELS.explorer);
      await expect(nodeTable(around, PANELS.explorer, 1)).toBeVisible();
      // The explorer is on once the panel knows the source may be queried.
      const steps = around.getByRole("region", { name: t("graph.steps.title"), exact: true });
      await expect(steps).toBeVisible({ timeout: STEP_MS });
      const table = nodeTable(around, PANELS.explorer, 1);
      await table.getByRole("button", { name: "Ana", exact: true }).click({ timeout: STEP_MS });
      // Ana has two orders; the panel loads one neighbour per step, and says how many there are.
      await expect(nodeTable(around, PANELS.explorer, 2)).toBeVisible({ timeout: STEP_MS });
      await expect(
        steps.getByRole("button", {
          name: t("graph.steps.stepOf", { name: "Ana", count: 1, total: 2 }),
          exact: true,
        }),
      ).toBeVisible();
      // The next one, with the button the details offer.
      await around
        .getByRole("button", { name: t("graph.explorer.more", { count: 1 }), exact: true })
        .click({ timeout: STEP_MS });
      await expect(nodeTable(around, PANELS.explorer, 3)).toBeVisible({ timeout: STEP_MS });
      await steps
        .getByRole("button", { name: t("graph.steps.undo"), exact: true })
        .click({ timeout: STEP_MS });
      await expect(nodeTable(around, PANELS.explorer, 2)).toBeVisible({ timeout: STEP_MS });
      await steps
        .getByRole("button", {
          name: t("graph.steps.base", { nodes: t("graph.count.node.one", { count: 1 }) }),
          exact: true,
        })
        .click({ timeout: STEP_MS });
      await expect(nodeTable(around, PANELS.explorer, 1)).toBeVisible({ timeout: STEP_MS });
    });

    await test.step("a click on a node sets the dashboard variable", async () => {
      const orders = card(PANELS.orders);
      // David placed one order.
      await expect(orders).toContainText(summary(2, 1), { timeout: STEP_MS });
      const customers = card(PANELS.customers);
      await showTables(customers, PANELS.customers);
      await customers
        .getByRole("button", { name: "Clara", exact: true })
        .click({ timeout: STEP_MS });
      await expect(page.getByLabel("Customer", { exact: true })).toHaveValue("Clara", {
        timeout: STEP_MS,
      });
      // Clara placed two.
      await expect(orders).toContainText(summary(3, 2), { timeout: STEP_MS });
    });

    expect(await seriousViolations(page)).toEqual([]);
  });

  test("a graph panel exports as GraphML and saves a PNG of what it draws", async ({ page }) => {
    await signInOwner(page);
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    const tree = page.getByRole("article", { name: PANELS.tree, exact: true });
    await expect(tree).toContainText(
      summary(GRAPH_FIXTURE.categories.nodes, GRAPH_FIXTURE.categories.edges),
      { timeout: STEP_MS },
    );
    // The menu button shows on hover or focus; the keyboard reaches it without the pointer
    // crossing the drawing.
    const menu = async () => {
      const button = tree.getByRole("button", {
        name: t("dashboards.panel.menuNamed", { title: PANELS.tree }),
      });
      await button.focus({ timeout: STEP_MS });
      await button.press("Enter");
    };

    await test.step("GraphML keeps the graph's nodes and edges", async () => {
      await menu();
      await page
        .getByRole("menuitem", { name: t("analysis.export.buttonNamed", { title: PANELS.tree }) })
        .click({ timeout: STEP_MS });
      const dialog = page.getByRole("dialog", { name: t("analysis.export.title") });
      // A graph is no table: its own formats only.
      await expect(
        dialog.getByRole("radio", { name: t("analysis.export.format.csv") }),
      ).toHaveCount(0);
      await dialog.getByRole("radio", { name: t("analysis.export.format.graphml") }).check();
      const download = page.waitForEvent("download", { timeout: STEP_MS });
      await dialog.getByRole("button", { name: t("analysis.export.submit"), exact: true }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe("Category-tree.graphml");
      const text = await readFile(await file.path(), "utf8");
      expect(text).toContain('<graphml xmlns="http://graphml.graphdrawing.org/xmlns"');
      expect(text.match(/<node /g)).toHaveLength(GRAPH_FIXTURE.categories.nodes);
      expect(text.match(/<edge /g)).toHaveLength(GRAPH_FIXTURE.categories.edges);
    });

    await test.step("the image is a PNG at twice the panel's size or more", async () => {
      const box = await tree.boundingBox();
      await menu();
      const download = page.waitForEvent("download", { timeout: STEP_MS });
      await page
        .getByRole("menuitem", { name: t("dashboards.panel.imageNamed", { title: PANELS.tree }) })
        .click({ timeout: STEP_MS });
      const file = await download;
      expect(file.suggestedFilename()).toBe("Category-tree.png");
      const png = await readFile(await file.path());
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      // The IHDR chunk holds the width and height.
      expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(Math.floor((box?.width ?? 0) * 2));
      expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(Math.floor((box?.height ?? 0) * 2));
      // A drawn panel, not an empty card: title, nodes and labels make the file this large.
      expect(png.length).toBeGreaterThan(5_000);
      // It looks like the panel on screen: scaled to the panel's size, its pixels differ from a
      // screenshot of the panel by little on average (an image without the styles would not).
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const shot = await tree.screenshot({ animations: "disabled" });
      const difference = await page.evaluate(
        async ([image, screen]) => {
          const load = async (base64: string) => {
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            return createImageBitmap(new Blob([bytes], { type: "image/png" }));
          };
          const [a, b] = await Promise.all([load(image), load(screen)]);
          const pixels = (bitmap: ImageBitmap) => {
            const canvas = new OffscreenCanvas(b.width, b.height);
            const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
            context.drawImage(bitmap, 0, 0, b.width, b.height);
            return context.getImageData(0, 0, b.width, b.height).data;
          };
          const [pa, pb] = [pixels(a), pixels(b)];
          let sum = 0;
          for (let i = 0; i < pa.length; i += 4) {
            for (let c = 0; c < 3; c++) sum += Math.abs((pa[i + c] ?? 0) - (pb[i + c] ?? 0));
          }
          return sum / ((pa.length / 4) * 3);
        },
        [png.toString("base64"), shot.toString("base64")] as const,
      );
      expect(difference).toBeLessThan(24);
    });
  });

  test("graph steps in Explore: counts per label and orders that share products", async ({
    page,
  }) => {
    await signInOwner(page);
    const result = await explore(page, sourceName, SHOP);
    await expect(result).toContainText(
      summary(GRAPH_FIXTURE.shop.nodes, GRAPH_FIXTURE.shop.edges),
      { timeout: STEP_MS },
    );
    const steps = page.getByRole("complementary", { name: t("explore.aside") });
    // One "Add step" button opens the kinds of steps as a menu.
    const addStep = steps.getByRole("button", { name: t("analysis.steps.add"), exact: true });
    const kind = (name: string) =>
      page
        .getByRole("menu", { name: t("analysis.steps.add") })
        .getByRole("menuitem", { name: t(name), exact: true });

    // Graph steps are offered for a graph; table steps wait for a step that makes a table.
    await addStep.click({ timeout: STEP_MS });
    await expect(kind("analysis.kind.group")).toHaveCount(0);
    await kind("analysis.kind.countLabels").click({ timeout: STEP_MS });
    const first = steps.getByRole("listitem", { name: t("analysis.steps.number", { n: 1 }) });
    await expect(
      first.getByText(
        t("analysis.where.changes", {
          where: t("analysis.where.database", { engine: "Neo4j" }),
        }),
        { exact: true },
      ),
    ).toBeVisible({ timeout: STEP_MS });
    await expect(first.getByText(t("analysis.chain.frame", { rows: 3, fields: 3 }))).toBeVisible({
      timeout: STEP_MS,
    });
    await first
      .getByRole("button", { name: t("analysis.steps.previewNamed", { n: 1 }) })
      .click({ timeout: STEP_MS });
    const afterCount = steps.getByRole("region", { name: t("analysis.preview.after", { n: 1 }) });
    // 8 orders, 5 customers, 4 products in orders: most first.
    for (const [i, label] of ["Order", "Customer", "Product"].entries()) {
      await expect(afterCount.getByRole("row").nth(i + 1)).toContainText(label, {
        timeout: STEP_MS,
      });
    }
    await addStep.click({ timeout: STEP_MS });
    await expect(kind("analysis.kind.group")).toHaveCount(1);
    await page.keyboard.press("Escape");

    // Orders that share a product, named by their order number.
    await steps
      .getByRole("button", { name: t("analysis.steps.removeNamed", { n: 1 }) })
      .click({ timeout: STEP_MS });
    await addStep.click({ timeout: STEP_MS });
    await kind("analysis.kind.sharedNeighbours").click({ timeout: STEP_MS });
    const shared = steps.getByRole("listitem", { name: t("analysis.steps.number", { n: 1 }) });
    await shared.getByLabel(t("analysis.graph.pairsOf")).selectOption("Order");
    await shared.getByLabel(t("analysis.graph.via")).selectOption("Product");
    await shared.getByLabel(t("analysis.graph.nameBy")).selectOption("name");
    await expect(shared.getByText(t("analysis.chain.frame", { rows: 4, fields: 4 }))).toBeVisible({
      timeout: STEP_MS,
    });
    await shared
      .getByRole("button", { name: t("analysis.steps.previewNamed", { n: 1 }) })
      .click({ timeout: STEP_MS });
    const afterShared = steps.getByRole("region", {
      name: t("analysis.preview.after", { n: 1 }),
    });
    // Ben's and Clara's orders both hold the monitor arm.
    const pair = afterShared.getByRole("row").filter({ hasText: "A-1004" });
    await expect(pair).toContainText("A-1005", { timeout: STEP_MS });
    await expect(pair).toContainText("Monitor arm");
    expect(await seriousViolations(page)).toEqual([]);
  });
});

/** Whether two boxes share any area. */
function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width - 0.5 &&
    b.x < a.x + a.width - 0.5 &&
    a.y < b.y + b.height - 0.5 &&
    b.y < a.y + a.height - 0.5
  );
}

/**
 * An explorer panel eight grid rows tall: the steps stay on one line above the drawing and the
 * table, never over them, and a row of the table takes a plain click. At a desktop width the
 * details open beside the table, on a phone over it; either way inside the panel's body.
 */
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`Neo4j short explorer panel, ${viewport.width} px wide`, () => {
    test.use({ viewport });

    test("the steps leave the drawing and the table their room, and a row click lands", async ({
      page,
    }) => {
      const address = serviceAddress("KALZIT_E2E_NEO4J");
      const owner = await Api.owner();
      let dashboardId = "";
      try {
        const sourceId = await owner.createSource(
          unique("Shop graph (Neo4j, short)"),
          "neo4j",
          { ...boltTarget(address), user: GRAPH_FIXTURE.neo4jUser },
          { password: GRAPH_FIXTURE.neo4jPassword },
        );
        const model = graphDashboard(unique("Shop graph short"), sourceId);
        dashboardId = await owner.createDashboard({
          ...model,
          panels: model.panels
            .filter((p) => p.id === "explorer")
            .map((p) => ({ ...p, grid: { x: 0, y: 0, w: 12, h: 8 } })),
        });
      } finally {
        await owner.dispose();
      }
      await signInOwner(page);
      await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
      const around = page.getByRole("article", { name: PANELS.explorer, exact: true });
      const steps = around.getByRole("region", { name: t("graph.steps.title"), exact: true });
      await expect(steps).toBeVisible({ timeout: STEP_MS });
      // The compact form: the settings of the next step wait behind their button.
      await expect(
        steps.getByRole("button", { name: t("graph.steps.next"), exact: true }),
      ).toHaveAttribute("aria-expanded", "false");
      const body = around.locator(".graph__body");
      const minimum = await page.evaluate(
        () => 6 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      );

      const noOverlap = async () => {
        const bar = await steps.boundingBox();
        const room = await body.boundingBox();
        expect(bar).not.toBeNull();
        expect(room).not.toBeNull();
        if (bar === null || room === null) return;
        expect(overlaps(bar, room)).toBe(false);
        expect(room.height).toBeGreaterThanOrEqual(minimum - 1);
      };
      await noOverlap();

      await showTables(around, PANELS.explorer);
      await noOverlap();
      const table = nodeTable(around, PANELS.explorer, 1);
      // A plain click, no Enter: nothing lies over the row.
      await table.getByRole("button", { name: "Ana", exact: true }).click({ timeout: STEP_MS });
      await expect(nodeTable(around, PANELS.explorer, 2)).toBeVisible({ timeout: STEP_MS });
      await expect(
        steps.getByRole("button", {
          name: t("graph.steps.stepOf", { name: "Ana", count: 1, total: 2 }),
          exact: true,
        }),
      ).toBeVisible();
      await noOverlap();

      // The details of the clicked node stay inside the body, below the steps.
      const sheet = around.getByRole("region", {
        name: t("graph.details", { name: "Ana" }),
        exact: true,
      });
      await expect(sheet).toBeVisible({ timeout: STEP_MS });
      const sheetBox = await sheet.boundingBox();
      const bar = await steps.boundingBox();
      expect(sheetBox !== null && bar !== null && overlaps(sheetBox, bar)).toBe(false);
      const room = await body.boundingBox();
      if (sheetBox !== null && room !== null) {
        expect(sheetBox.y).toBeGreaterThanOrEqual(room.y - 0.5);
        expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(room.y + room.height + 0.5);
      }
      const overflow = await findOverflow(page);
      expect(overflow.offenders).toEqual([]);
      expect(await seriousViolations(page)).toEqual([]);
    });
  });
}

/**
 * Where the drawing shows a node, from the canvas' test hook (SigmaCanvas.tsx), once the layout
 * has settled: the same place twice in a row.
 */
async function drawnNode(scope: Locator, caption: string): Promise<{ x: number; y: number }> {
  const canvas = scope.locator(".graph__canvas");
  let last: { x: number; y: number } | null = null;
  for (let tries = 0; tries < 60; tries++) {
    const now = await canvas.evaluate(
      (element, name) =>
        (
          element as HTMLElement & {
            kalzitNodePosition?: (caption: string) => { x: number; y: number } | null;
          }
        ).kalzitNodePosition?.(name) ?? null,
      caption,
    );
    if (
      now !== null &&
      last !== null &&
      Math.abs(now.x - last.x) + Math.abs(now.y - last.y) < 0.5
    ) {
      return now;
    }
    last = now;
    await scope.page().waitForTimeout(250);
  }
  throw new Error(`${caption} is not drawn`);
}

test.describe("Neo4j drawing", () => {
  test.use({ viewport: { width: 1440, height: 1200 } });

  test("a click on a drawn node picks it, and Shift+click adds to the selection", async ({
    page,
  }) => {
    const address = serviceAddress("KALZIT_E2E_NEO4J");
    const owner = await Api.owner();
    let dashboardId = "";
    try {
      const sourceId = await owner.createSource(
        unique("Shop graph (Neo4j, drawn)"),
        "neo4j",
        { ...boltTarget(address), user: GRAPH_FIXTURE.neo4jUser },
        { password: GRAPH_FIXTURE.neo4jPassword },
      );
      const model = graphDashboard(unique("Shop graph drawn"), sourceId);
      dashboardId = await owner.createDashboard({
        ...model,
        // Full width, so the details open beside the drawing, not over the nodes to click next.
        panels: model.panels
          .filter((p) => p.id === "customers" || p.id === "orders")
          .map((p) => (p.id === "customers" ? { ...p, grid: { x: 0, y: 0, w: 24, h: 12 } } : p)),
      });
    } finally {
      await owner.dispose();
    }
    // The canvas offers where it draws a node only to pages that ask for the test hooks.
    await page.addInitScript(() => {
      (window as { __kalzitTestHooks?: boolean }).__kalzitTestHooks = true;
    });
    await signInOwner(page);
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    const customers = page.getByRole("article", { name: PANELS.customers, exact: true });
    const drawing = customers.getByRole("application", { name: PANELS.customers, exact: true });
    const noWebgl = customers.getByText(t("graph.notice.noWebgl"), { exact: true });
    await expect(drawing.or(noWebgl)).toBeVisible({ timeout: STEP_MS });
    test.skip(await noWebgl.isVisible(), "this browser cannot draw graphs");

    const clara = await drawnNode(customers, "Clara");
    await page.mouse.click(clara.x, clara.y);
    // The pick selects the node (its details open) and sets the variable it is set up for.
    await expect(
      customers.getByRole("region", { name: t("graph.details", { name: "Clara" }), exact: true }),
    ).toBeVisible({ timeout: STEP_MS });
    await expect(page.getByLabel("Customer", { exact: true })).toHaveValue("Clara", {
      timeout: STEP_MS,
    });

    const ana = await drawnNode(customers, "Ana");
    await page.keyboard.down("Shift");
    await page.mouse.click(ana.x, ana.y);
    await page.keyboard.up("Shift");
    await expect(
      customers.getByRole("heading", {
        name: t("graph.selection.count", { count: 2 }),
        exact: true,
      }),
    ).toBeVisible({ timeout: STEP_MS });
    expect(await seriousViolations(page)).toEqual([]);
  });
});

interface DrawnFrame {
  nodes: { index: number; x: number; y: number; radius: number; shape?: string }[];
  labels: { index: number; box: { minX: number; minY: number; maxX: number; maxY: number } }[];
}

/**
 * What the drawing's last frame drew, from the canvas' test hook (SigmaCanvas.tsx): the labels
 * Sigma displays and every visible node with the shape it is drawn with, read from the renderer
 * itself rather than from the label check.
 */
async function drawnFrame(scope: Locator): Promise<DrawnFrame | null> {
  return scope
    .locator(".graph__canvas")
    .evaluate(
      (element) =>
        (
          element as HTMLElement & { kalzitLabelRoom?: () => DrawnFrame | null }
        ).kalzitLabelRoom?.() ?? null,
    );
}

/** Labels of a frame that cover another node's shape or another label (none should). */
function coveringLabels(frame: DrawnFrame): string[] {
  const found: string[] = [];
  const inside = (node: DrawnFrame["nodes"][number], box: DrawnFrame["labels"][number]["box"]) => {
    const dx = Math.max(box.minX - node.x, 0, node.x - box.maxX);
    const dy = Math.max(box.minY - node.y, 0, node.y - box.maxY);
    if (node.shape === "square") return dx < node.radius - 0.5 && dy < node.radius - 0.5;
    if (node.shape === "diamond") return dx + dy < node.radius - 0.5;
    return dx * dx + dy * dy < (node.radius - 0.5) ** 2;
  };
  for (const label of frame.labels) {
    for (const node of frame.nodes) {
      if (node.index !== label.index && inside(node, label.box)) {
        found.push(`label ${label.index} over node ${node.index}`);
      }
    }
    for (const other of frame.labels) {
      if (
        other.index > label.index &&
        overlaps(
          {
            x: label.box.minX,
            y: label.box.minY,
            width: label.box.maxX - label.box.minX,
            height: label.box.maxY - label.box.minY,
          },
          {
            x: other.box.minX,
            y: other.box.minY,
            width: other.box.maxX - other.box.minX,
            height: other.box.maxY - other.box.minY,
          },
        )
      ) {
        found.push(`label ${label.index} over label ${other.index}`);
      }
    }
  }
  return found;
}

test.describe("Neo4j labels and shapes", () => {
  test.use({ viewport: { width: 1024, height: 900 } });

  test("a short panel draws no label over a node or a label, from the first frame on", async ({
    page,
  }) => {
    const address = serviceAddress("KALZIT_E2E_NEO4J");
    const title = "Shop in a short row";
    const owner = await Api.owner();
    let dashboardId = "";
    try {
      const sourceId = await owner.createSource(
        unique("Shop graph (Neo4j, labels)"),
        "neo4j",
        { ...boltTarget(address), user: GRAPH_FIXTURE.neo4jUser },
        { password: GRAPH_FIXTURE.neo4jPassword },
      );
      dashboardId = await owner.createDashboard({
        schemaVersion: 1,
        title: unique("Shop labels"),
        timeRange: { from: "now-6h", to: "now" },
        panels: [
          {
            id: "short",
            type: "network",
            title,
            // Half the width and a short row, as the gallery's all-sources panel.
            grid: { x: 0, y: 0, w: 12, h: 8 },
            targets: [{ refId: "A", datasourceId: sourceId, query: { cypher: SHOP } }],
            // Every label wants to show; the ones without room wait for the zoom.
            options: { labelTop: 200 },
          },
        ],
      });
    } finally {
      await owner.dispose();
    }
    await page.addInitScript(() => {
      (window as { __kalzitTestHooks?: boolean }).__kalzitTestHooks = true;
    });
    await signInOwner(page);
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    const panel = page.getByRole("article", { name: title, exact: true });
    const drawing = panel.getByRole("application", { name: title, exact: true });
    const noWebgl = panel.getByText(t("graph.notice.noWebgl"), { exact: true });
    await expect(drawing.or(noWebgl)).toBeVisible({ timeout: STEP_MS });
    test.skip(await noWebgl.isVisible(), "this browser cannot draw graphs");

    // Every frame from the first one on, while the layout settles and after it did.
    let frames = 0;
    let labelled = 0;
    for (let tries = 0; tries < 40; tries++) {
      const frame = await drawnFrame(panel);
      if (frame !== null && frame.nodes.length > 0) {
        frames++;
        labelled = Math.max(labelled, frame.labels.length);
        expect(coveringLabels(frame)).toEqual([]);
      }
      await page.waitForTimeout(100);
    }
    expect(frames).toBeGreaterThan(0);
    expect(labelled).toBeGreaterThan(0);

    // Zoomed in, more labels find room, and still none covers anything.
    const zoomIn = panel.getByRole("button", { name: t("graph.zoomIn"), exact: true });
    await zoomIn.click();
    await zoomIn.click();
    await page.waitForTimeout(600);
    const zoomed = await drawnFrame(panel);
    expect(zoomed).not.toBeNull();
    if (zoomed !== null) expect(coveringLabels(zoomed)).toEqual([]);

    // Customers, orders and products each have a shape of their own, drawn and in the legend.
    const last = await drawnFrame(panel);
    expect(new Set(last?.nodes.map((n) => n.shape)).size).toBe(3);
    const legend = panel.getByRole("list", { name: t("graph.legend.title"), exact: true });
    const shapes = await legend
      .locator("svg[data-shape]")
      .evaluateAll((list) => list.map((svg) => svg.getAttribute("data-shape")));
    expect(new Set(shapes)).toEqual(new Set(["circle", "square", "diamond"]));
    expect(await seriousViolations(page)).toEqual([]);
  });
});

/**
 * ELK in a hierarchy panel, under the server's CSP. The graph comes from the test plugin (a graph
 * of two nodes, `a` KNOWS `b`) instead of Neo4j, so this runs on the Windows runners too, which
 * have no Linux containers for the graph databases.
 */
test("a hierarchy with ELK loads it on demand and lays the graph out left to right", async ({
  page,
}) => {
  test.skip(
    PLUGIN_BINARY === "",
    "KALZIT_E2E_PLUGIN_BINARY is not set: the test plugin was not built",
  );
  const title = "Graph with ELK";
  const id = "dev.e2etest.elkgraph";
  const owner = await Api.owner();
  let dashboardId = "";
  try {
    // Signed with a key trusted for this test, so unsigned plugins stay off for the others.
    const key = publisherKey();
    const trusted = await owner.context.post("/api/admin/plugin-keys", {
      data: { name: unique("ELK test publisher"), publicKey: key.publicKey },
    });
    expect(trusted.ok(), await trusted.text()).toBe(true);
    const host = (await (await owner.context.get("/api/admin/plugin-host")).json()) as {
      landlockAvailable?: boolean;
    };
    if (process.platform === "linux" && host.landlockAvailable === false) {
      await owner.context.patch("/api/admin/plugin-host", { data: { allowWithoutLandlock: true } });
    }
    const installed = await owner.context.post("/api/admin/plugins", {
      headers: { "Content-Type": "application/zip" },
      data: testPluginPackage({ id, name: "E2E graph" }, key),
    });
    expect(installed.ok(), await installed.text()).toBe(true);
    for (const [step, data] of [
      ["approve", { version: "1.0.0" }],
      ["enable", undefined],
    ] as const) {
      const answer = await owner.context.post(
        `/api/admin/plugins/${id}/${step}`,
        data === undefined ? {} : { data },
      );
      expect(answer.ok(), await answer.text()).toBe(true);
    }
    const sourceId = await owner.createSource(unique("Graph (plugin)"), id, {
      host: "graph.example.test",
    });
    dashboardId = await owner.createDashboard({
      schemaVersion: 1,
      title: unique("ELK hierarchy"),
      timeRange: { from: "now-6h", to: "now" },
      panels: [
        {
          id: "tree",
          type: "hierarchy",
          title,
          grid: { x: 0, y: 0, w: 24, h: 12 },
          targets: [{ refId: "A", datasourceId: sourceId, query: { do: "graph" } }],
          options: { hierarchyLayout: "elk", elkDirection: "right" },
        },
      ],
    });
  } finally {
    await owner.dispose();
  }
  await page.addInitScript(() => {
    (window as { __kalzitTestHooks?: boolean }).__kalzitTestHooks = true;
  });
  // ELK's worker is a script of its own, started only by a panel that uses ELK.
  const elkWorker = page.waitForEvent("worker", {
    predicate: (worker) => /\/assets\/elk-worker[^/]*\.js$/.test(worker.url()),
    timeout: 30_000,
  });
  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
  const panel = page.getByRole("article", { name: title, exact: true });
  const drawing = panel.getByRole("application", { name: title, exact: true });
  const noWebgl = panel.getByText(t("graph.notice.noWebgl"), { exact: true });
  // The plugin's process starts with the first query.
  await expect(drawing.or(noWebgl)).toBeVisible({ timeout: 30_000 });
  test.skip(await noWebgl.isVisible(), "this browser cannot draw graphs");

  await elkWorker;
  await expect(panel.getByText(t("graph.layout.elkRunning"), { exact: true })).toBeHidden({
    timeout: STEP_MS,
  });
  await expect(panel.getByText(t("graph.layout.elkFailed"), { exact: true })).toBeHidden();
  const a = await drawnNode(panel, "a");
  const b = await drawnNode(panel, "b");
  expect(a.x).toBeLessThan(b.x);
  expect(await seriousViolations(page)).toEqual([]);
});

test("Memgraph: a Cypher query in Explore draws a network", async ({ page }) => {
  const address = serviceAddress("KALZIT_E2E_MEMGRAPH");
  const name = unique("Shop graph (Memgraph)");
  const owner = await Api.owner();
  try {
    // The container has no users, so anyone may write: the source accepts that explicitly.
    await owner.createSource(name, "memgraph", {
      ...boltTarget(address),
      allowWriteCapableUser: true,
    });
  } finally {
    await owner.dispose();
  }
  await signInOwner(page);
  const result = await explore(page, name, SHOP);
  await expect(result).toContainText(summary(GRAPH_FIXTURE.shop.nodes, GRAPH_FIXTURE.shop.edges), {
    timeout: STEP_MS,
  });
  await expect(page.getByLabel(t("explore.visualization"), { exact: true })).toHaveValue("network");
  await showTables(result, t("explore.result"));
  await expect(nodeTable(result, t("explore.result"), GRAPH_FIXTURE.shop.nodes)).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});
