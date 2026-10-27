import type { Locator } from "@playwright/test";
import { Api, unique } from "./support/api";
import { t } from "./support/i18n";
import { boltTarget, GRAPH_FIXTURE, MONGO_FIXTURE, serviceAddress } from "./support/services";
import { expect, signInOwner, test } from "./support/test";

/** Each step gets its own limit, so a failure names the step instead of the test's timeout. */
const STEP_MS = 15_000;

/** The customers of a city with their orders: the graph panel the variable drives. */
const ORDERS_IN_CITY = "MATCH (c:Customer {city: $city})-[p:PLACED]->(o:Order) RETURN c, p, o";
const GRAPH_PANEL = "Orders in the city";

/** The software WebGL notices of the renderer library, as in graph.spec.ts. */
const SIGMA_WEBGL_NOTICES = [
  /^warning: \[\.WebGL-0x[0-9a-f]+\] GL_INVALID_OPERATION: glDrawArraysInstanced: Active draw buffers with missing fragment shader outputs\./,
  /^warning: \[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels/,
];

test.beforeEach(({ consoleGuard }) => {
  for (const notice of SIGMA_WEBGL_NOTICES) consoleGuard.allow(notice);
});

/** The line under a graph panel's tools: "3 nodes, 2 edges, 1 component." */
function summary(nodes: number, edges: number): string {
  const count = (noun: string, n: number) =>
    t(`graph.count.${noun}.${n === 1 ? "one" : "other"}`, { count: n });
  return t("graph.summary", {
    nodes: count("node", nodes),
    edges: count("edge", edges),
    components: count("component", 1),
  });
}

/** The caption of a graph panel's node table, which counts the nodes shown. */
function nodeTable(scope: Locator, title: string, count: number): Locator {
  return scope.getByRole("table", { name: t("graph.table.nodes", { title, count }), exact: true });
}

/**
 * Switches a drawn graph to its tables, whose rows are the buttons a person selects nodes with;
 * where WebGL 2 is missing, or the tables are already shown, they are there already.
 */
async function showTables(scope: Locator, title: string): Promise<void> {
  const drawing = scope.getByRole("application", { name: title, exact: true });
  const noWebgl = scope.getByText(t("graph.notice.noWebgl"), { exact: true });
  const tables = scope.getByRole("table", {
    name: new RegExp(`^${t("graph.table.nodes", { title, count: "\\d+" })}$`),
  });
  await expect(drawing.or(noWebgl).or(tables).first()).toBeVisible({ timeout: STEP_MS });
  if (await drawing.isVisible()) {
    await scope
      .getByRole("button", { name: t("graph.showTable"), exact: true })
      .click({ timeout: STEP_MS });
  }
}

// The MongoDB order A-1003 is from Leipzig (e2e/fixtures/mongo-orders.js); in the graph fixture
// David lives there and placed A-1007 (e2e/fixtures/graph-shop.cypher). A click on the order in
// the document explorer sets $city from customer.city, and the Cypher network panel, which reads
// $city as a Bolt parameter, shows David and his order instead of Ana and hers.
test("a Mongo document click drives a Cypher graph panel through a dashboard variable", async ({
  page,
}) => {
  const neo4j = serviceAddress("KALZIT_E2E_NEO4J");
  const mongo = serviceAddress("KALZIT_E2E_MONGODB");
  const owner = await Api.owner();
  let dashboardId = "";
  try {
    const orders = await owner.createSource(
      unique("Bestellungen"),
      "mongodb",
      { hosts: mongo, database: MONGO_FIXTURE.database, user: MONGO_FIXTURE.user },
      { password: MONGO_FIXTURE.password },
    );
    const graph = await owner.createSource(
      unique("Shop graph"),
      "neo4j",
      { ...boltTarget(neo4j), user: GRAPH_FIXTURE.neo4jUser },
      { password: GRAPH_FIXTURE.neo4jPassword },
    );
    dashboardId = await owner.createDashboard({
      schemaVersion: 1,
      title: unique("Across shapes"),
      timeRange: { from: "now-1h", to: "now" },
      variables: [{ name: "city", type: "textbox", current: "Hamburg" }],
      panels: [
        {
          id: "order",
          type: "documents",
          title: "Order",
          grid: { x: 0, y: 0, w: 12, h: 12 },
          targets: [
            {
              refId: "A",
              datasourceId: orders,
              query: { collection: MONGO_FIXTURE.collection, filter: '{"number": "A-1003"}' },
            },
          ],
          options: { variable: "city", variablePath: "customer.city" },
        },
        {
          id: "graph",
          type: "network",
          title: GRAPH_PANEL,
          grid: { x: 12, y: 0, w: 12, h: 12 },
          targets: [{ refId: "A", datasourceId: graph, query: { cypher: ORDERS_IN_CITY } }],
        },
      ],
    });
  } finally {
    await owner.dispose();
  }

  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
  const panel = page.getByRole("article", { name: GRAPH_PANEL, exact: true });

  await test.step("the graph panel starts with the customers of Hamburg", async () => {
    await expect(panel).toContainText(summary(3, 2), { timeout: STEP_MS });
    await showTables(panel, GRAPH_PANEL);
    await expect(nodeTable(panel, GRAPH_PANEL, 3)).toBeVisible({ timeout: STEP_MS });
    await expect(panel.getByRole("button", { name: "Ana", exact: true })).toBeVisible();
  });

  await test.step("a click on the order sets $city from customer.city", async () => {
    await page
      .getByRole("treeitem")
      .filter({ hasText: t("documents.tree.document", { number: 1 }) })
      .first()
      .click({ timeout: STEP_MS });
    await expect(page.getByRole("textbox", { name: "city" })).toHaveValue("Leipzig", {
      timeout: STEP_MS,
    });
  });

  await test.step("the graph panel runs again with the new value as a parameter", async () => {
    await showTables(panel, GRAPH_PANEL);
    await expect(nodeTable(panel, GRAPH_PANEL, 2)).toBeVisible({ timeout: STEP_MS });
    await expect(panel.getByRole("button", { name: "David", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Ana", exact: true })).toHaveCount(0);
  });
});
