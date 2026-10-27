import { Api, unique } from "./support/api";
import { t } from "./support/i18n";
import { MONGO_FIXTURE, serviceAddress } from "./support/services";
import { expect, signInOwner, test } from "./support/test";

/** Each step gets its own limit, so a failure names the step instead of the test's timeout. */
const STEP_MS = 15_000;

/**
 * A Neo4j server for this spec: `bolt://user:password@host:port`. CI does not start one in the
 * e2e job yet (the graph services come with their own change), so without it the spec is skipped
 * with this reason; the server's integration tests cover Cypher parameters against Neo4j and
 * Memgraph in the meantime.
 */
function neo4jAddress(): URL {
  const value = process.env.KALZIT_E2E_NEO4J ?? "";
  test.skip(
    value === "",
    "KALZIT_E2E_NEO4J is not set: the e2e job starts no Neo4j yet; server/tests/datasources.rs covers Cypher parameters",
  );
  return new URL(value);
}

// The order A-1003 of the MongoDB fixture is from the region Ost. A click on it in the document
// explorer sets $region, and the Cypher panel, which reads $region as a Bolt parameter, follows.
test("a Mongo document click drives a Cypher panel through a dashboard variable", async ({
  page,
}) => {
  const neo4j = neo4jAddress();
  const hosts = serviceAddress("KALZIT_E2E_MONGODB");
  const owner = await Api.owner();
  let dashboardId = "";
  try {
    const mongo = await owner.createSource(
      unique("Bestellungen"),
      "mongodb",
      { hosts, database: MONGO_FIXTURE.database, user: MONGO_FIXTURE.user },
      { password: MONGO_FIXTURE.password },
    );
    const graph = await owner.createSource(
      unique("Kunden-Graph"),
      "neo4j",
      {
        host: neo4j.hostname,
        port: Number(neo4j.port || 7687),
        ...(neo4j.username === "" ? {} : { user: decodeURIComponent(neo4j.username) }),
      },
      neo4j.password === "" ? {} : { password: decodeURIComponent(neo4j.password) },
    );
    dashboardId = await owner.createDashboard({
      schemaVersion: 1,
      title: unique("Formübergreifend"),
      timeRange: { from: "now-1h", to: "now" },
      variables: [{ name: "region", type: "textbox", current: "Nord" }],
      panels: [
        {
          id: "orders",
          type: "documents",
          title: "Order",
          grid: { x: 0, y: 0, w: 12, h: 10 },
          targets: [
            {
              refId: "A",
              datasourceId: mongo,
              query: { collection: MONGO_FIXTURE.collection, filter: '{"number": "A-1003"}' },
            },
          ],
          options: { variable: "region", variablePath: "customer.region" },
        },
        {
          id: "graph",
          type: "table",
          title: "Region in Neo4j",
          grid: { x: 12, y: 0, w: 12, h: 10 },
          targets: [
            {
              refId: "A",
              datasourceId: graph,
              query: { cypher: "RETURN $region AS region, size($region) AS length" },
            },
          ],
        },
      ],
    });
  } finally {
    await owner.dispose();
  }

  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });

  await test.step("the Cypher panel starts with the variable's value", async () => {
    await expect(page.getByRole("cell", { name: "Nord", exact: true })).toBeVisible({
      timeout: STEP_MS,
    });
  });

  await test.step("a click on the document sets $region from customer.region", async () => {
    await page
      .getByRole("treeitem")
      .filter({ hasText: t("documents.tree.document", { number: 1 }) })
      .first()
      .click({ timeout: STEP_MS });
    await expect(page.getByRole("textbox", { name: "region" })).toHaveValue("Ost", {
      timeout: STEP_MS,
    });
  });

  await test.step("the Cypher panel runs again with the new value as a parameter", async () => {
    await expect(page.getByRole("cell", { name: "Ost", exact: true })).toBeVisible({
      timeout: STEP_MS,
    });
    await expect(page.getByRole("cell", { name: "3", exact: true })).toBeVisible();
  });
});
