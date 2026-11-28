import type { Page } from "@playwright/test";
import { Api, unique } from "./support/api";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { selectOption } from "./support/select";
import { boltTarget, GRAPH_FIXTURE, serviceAddress } from "./support/services";
import { expect, signIn, signInOwner, test } from "./support/test";

/*
 * Graph patterns, schema, plans and search templates (board Graph083.dc.html) on the shop graph
 * of the graph spec (e2e/fixtures/graph-shop.cypher): 5 customers, 8 orders, 4 products.
 */

/** Each step gets its own limit, so a failure names the step instead of the test's timeout. */
const STEP_MS = 15_000;

/** The orders of the customers, as a pattern: Customer -PLACED-> Order. */
const ORDERS_OF = {
  nodes: [
    {
      id: "c",
      labels: ["Customer"],
      conditions: [{ property: "name", op: "eq", value: { param: "customer" } }],
    },
    { id: "o", labels: ["Order"] },
  ],
  edges: [{ id: "e1", from: "c", to: "o", types: ["PLACED"], direction: "out" }],
  parameters: [{ name: "customer", type: "string", label: "Customer" }],
};

async function openExplore(page: Page, source: string): Promise<void> {
  await page.goto("/explore", { timeout: STEP_MS });
  await selectOption(
    page.getByLabel(t("explore.datasource")),
    { label: source },
    { timeout: STEP_MS },
  );
}

test.describe("Neo4j patterns", () => {
  test.use({ viewport: { width: 1440, height: 1400 } });

  let sourceName = "";
  let templateId = "";
  let viewer = { email: "", password: "" };

  test.beforeAll(async () => {
    const address = serviceAddress("KALZIT_E2E_NEO4J");
    sourceName = unique("Shop graph (Neo4j, patterns)");
    const owner = await Api.owner();
    try {
      const sourceId = await owner.createSource(
        sourceName,
        "neo4j",
        { ...boltTarget(address), user: GRAPH_FIXTURE.neo4jUser },
        { password: GRAPH_FIXTURE.neo4jPassword },
      );
      templateId = await owner.createAnalysis({
        schemaVersion: 1,
        title: "Orders of $customer",
        timeRange: null,
        targets: [{ refId: "A", datasourceId: sourceId, query: { pattern: ORDERS_OF } }],
        steps: [],
        visualization: { type: "network" },
      });
      viewer = await owner.createMember(unique("Vera Viewer"), "viewer");
    } finally {
      await owner.dispose();
    }
  });

  test("a pattern drawn from the schema writes Cypher, runs, and goes to the text and back", {
    tag: "@smoke",
  }, async ({ page }) => {
    await signInOwner(page);
    await openExplore(page, sourceName);
    await page
      .getByRole("button", { name: t("datasources.editor.pattern.pattern"), exact: true })
      .click();

    await test.step("the empty builder offers the labels of the source", async () => {
      await expect(page.getByRole("heading", { name: t("graphPatterns.empty.title") })).toBeVisible(
        {
          timeout: STEP_MS,
        },
      );
      await page
        .getByRole("list", { name: t("graphPatterns.empty.labels") })
        .getByRole("button", { name: /^Customer/ })
        .click();
    });

    await test.step("an edge to a new node, typed from the schema", async () => {
      await page.getByRole("button", { name: t("graphPatterns.panel.addEdgeButton") }).click();
      await selectOption(page.getByRole("combobox", { name: t("graphPatterns.panel.type") }), {
        value: "PLACED",
      });
      // The list is the same pattern for the keyboard: the new node is its last row.
      await page.getByRole("button", { name: t("graphPatterns.bar.list"), exact: true }).click();
      await page.getByRole("button", { name: /^Node any node n/ }).click();
      await selectOption(page.getByRole("combobox", { name: t("graphPatterns.panel.type") }), {
        value: "Order",
      });
      await expect(page.locator(".pattern__text")).toContainText("PLACED", { timeout: STEP_MS });
      await expect(page.locator(".pattern__text")).toContainText("LIMIT 500");
      await expect(
        page.getByText(
          "Find Customer c and Order n. c has an edge PLACED to n. At most 500 matches.",
        ),
      ).toBeVisible();
    });

    await test.step("it runs as a graph of customers and their orders", async () => {
      await page.getByRole("button", { name: t("explore.run") }).click();
      const result = page.getByRole("region", { name: t("explore.result") });
      // Every one of the 8 orders with its customer: 5 + 8 nodes, 8 edges.
      await expect(result).toContainText(t("graph.count.edge.other", { count: 8 }), {
        timeout: STEP_MS,
      });
    });

    await test.step("schema and plan beside the result", async () => {
      await page.getByRole("tab", { name: t("explore.tab.schema") }).click();
      const schema = page.getByRole("tabpanel", { name: t("explore.tab.schema") });
      await schema
        .getByRole("button", { name: t("graphPatterns.schema.list"), exact: true })
        .click({ timeout: STEP_MS });
      await schema.getByRole("button", { name: /^Customer/ }).click();
      await expect(
        schema.getByRole("table", { name: t("graphPatterns.schema.properties") }),
      ).toContainText("city");
      await page.getByRole("tab", { name: t("explore.tab.plan") }).click();
      await page.getByRole("button", { name: t("graphPatterns.plan.explain") }).click();
      await expect(page.getByText(t("graphPatterns.plan.explained"))).toBeVisible({
        timeout: STEP_MS,
      });
      await expect(
        page.getByRole("table", { name: t("graphPatterns.plan.caption") }),
      ).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });

    await test.step("to the text and back into the builder", async () => {
      await page.getByRole("tab", { name: t("explore.tab.result") }).click();
      await page
        .getByRole("button", { name: t("graphPatterns.query.editAsText", { language: "Cypher" }) })
        .click();
      await expect(page.locator(".cm-content").first()).toContainText("PLACED", {
        timeout: STEP_MS,
      });
      await page.getByRole("button", { name: t("graphPatterns.modes.understood") }).click();
      await page.getByRole("button", { name: t("datasources.editor.pattern.open") }).click();
      await expect(page.locator(".pattern__text")).toContainText("PLACED", { timeout: STEP_MS });
    });
  });

  test("a viewer runs a search template with their own value", async ({ page }) => {
    await signIn(page, viewer.email, viewer.password);
    await page.goto(`/explore/saved/${templateId}`, { timeout: STEP_MS });
    await expect(page.getByText(t("graphPatterns.template.first"))).toBeVisible({
      timeout: STEP_MS,
    });
    await page.getByRole("button", { name: t("graphPatterns.template.run") }).click();
    await expect(
      page.getByText(t("graphPatterns.template.missing", { name: "Customer" })),
    ).toBeVisible();
    await page.getByRole("textbox", { name: "Customer" }).fill("Ana");
    await page.getByRole("button", { name: t("graphPatterns.template.run") }).click();
    await expect(page.getByRole("heading", { name: "Orders of Ana" })).toBeVisible({
      timeout: STEP_MS,
    });
    const result = page.getByRole("region", { name: t("explore.result") });
    // Ana placed two orders: 3 nodes, 2 edges.
    await expect(result).toContainText(t("graph.count.edge.other", { count: 2 }), {
      timeout: STEP_MS,
    });
    // What the search does, to read.
    await expect(page.getByRole("heading", { name: t("graphPatterns.about.title") })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
});

test("Memgraph: a pattern runs as Cypher and its plan reads as a tree", async ({ page }) => {
  const address = serviceAddress("KALZIT_E2E_MEMGRAPH");
  const name = unique("Shop graph (Memgraph, patterns)");
  const owner = await Api.owner();
  try {
    await owner.createSource(name, "memgraph", {
      ...boltTarget(address),
      allowWriteCapableUser: true,
    });
  } finally {
    await owner.dispose();
  }
  await signInOwner(page);
  await openExplore(page, name);
  await page
    .getByRole("button", { name: t("datasources.editor.pattern.pattern"), exact: true })
    .click();
  await page
    .getByRole("list", { name: t("graphPatterns.empty.labels") })
    .getByRole("button", { name: /^Product/ })
    .click({ timeout: STEP_MS });
  await expect(page.locator(".pattern__text")).toContainText("Product", { timeout: STEP_MS });
  await page.getByRole("button", { name: t("explore.run") }).click();
  const result = page.getByRole("region", { name: t("explore.result") });
  await expect(result).toContainText(t("graph.count.node.other", { count: 4 }), {
    timeout: STEP_MS,
  });
  await page.getByRole("tab", { name: t("explore.tab.plan") }).click();
  await page.getByRole("button", { name: t("graphPatterns.plan.explain") }).click();
  await expect(page.getByRole("table", { name: t("graphPatterns.plan.caption") })).toBeVisible({
    timeout: STEP_MS,
  });
});
