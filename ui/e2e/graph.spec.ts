import type { Locator, Page } from "@playwright/test";
import { Api, unique } from "./support/api";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
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

    await test.step("explorer mode loads neighbours up to its limit, and undo removes them", async () => {
      const around = card(PANELS.explorer);
      await showTables(around, PANELS.explorer);
      await expect(nodeTable(around, PANELS.explorer, 1)).toBeVisible();
      await around.getByRole("button", { name: "Ana", exact: true }).click({ timeout: STEP_MS });
      // The click loads the neighbours at once once the panel knows the source may be queried;
      // a click before that only selects, and the details offer the same action.
      const load = around.getByRole("button", { name: t("graph.explorer.expand"), exact: true });
      await expect(load).toBeVisible({ timeout: STEP_MS });
      if (await load.isEnabled()) {
        await load.click({ timeout: STEP_MS });
      }
      // Ana has two orders; the panel loads one neighbour per step.
      await expect(nodeTable(around, PANELS.explorer, 2)).toBeVisible({ timeout: STEP_MS });
      await around
        .getByRole("button", { name: t("graph.explorer.undo", { name: "Ana" }), exact: true })
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
