import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { KalzitClient } from "./client.ts";

/**
 * The README demo organization (ui/e2e/screenshots/demo.ts): an owner, colleagues with
 * different roles, two teams, the SQLite sales fixture as a data source, the "Sales by region"
 * dashboard, the panel gallery dashboard and three more dashboards. Credentials are generated per
 * instance; the names match the README pictures.
 */

export interface Account {
  name: string;
  email: string;
  password: string;
  role: string;
}

export interface Seeded {
  orgName: string;
  owner: Account;
  members: Account[];
  sourceId: string;
  sourceName: string;
  dashboardId: string;
  dashboardTitle: string;
  galleryId: string;
  graph?: { sourceId: string; dashboardId: string };
  ai?: { providerId: string };
}

export function password(): string {
  return `dk-${randomBytes(12).toString("base64url")}`;
}

const SALES_BY_REGION =
  "SELECT ts AS time, amount FROM sales WHERE region = $region AND $__timeFilter(ts) ORDER BY ts";

export async function seedDemo(
  baseUrl: string,
  setupToken: string,
  fixtures: string,
  id: string,
): Promise<{ client: KalzitClient; seeded: Seeded }> {
  const owner: Account = {
    name: "Maria Keller",
    email: `maria.keller.${id}@kalzit.test`,
    password: password(),
    role: "owner",
  };
  const orgName = "Sunstone Analytics";
  await KalzitClient.setup(baseUrl, {
    token: setupToken,
    orgName,
    name: owner.name,
    email: owner.email,
    password: owner.password,
  });
  const client = await KalzitClient.signIn(baseUrl, owner.email, owner.password);
  const members: Account[] = [];
  const ids: Record<string, string> = {};
  for (const [name, role] of [
    ["Jonas Becker", "admin"],
    ["Lea Hoffmann", "editor"],
    ["Tim Schulz", "editor"],
    ["Sofia Wagner", "viewer"],
    ["Paul Richter", "viewer"],
  ] as const) {
    const pw = password();
    const member = await client.createMember(name, role, pw);
    ids[name] = member.id;
    members.push({ name, email: member.email, password: pw, role });
  }
  await client.createTeam("Vertrieb", [ids["Jonas Becker"] ?? "", ids["Lea Hoffmann"] ?? ""]);
  await client.createTeam("Controlling", [ids["Tim Schulz"] ?? ""]);

  const sourceName = "Sales (SQLite)";
  const sourceId = await client.createSource(sourceName, "sqlite", {
    path: join(fixtures, "sales.db"),
  });
  const target = (sql: string) => [{ refId: "A", datasourceId: sourceId, query: { sql } }];
  const dashboardTitle = "Sales by region";
  const dashboardId = await client.createDashboard({
    schemaVersion: 1,
    title: dashboardTitle,
    timeRange: { from: "now-6h", to: "now" },
    variables: [
      {
        name: "region",
        label: "Region",
        type: "query",
        datasourceId: sourceId,
        query: { sql: "SELECT DISTINCT region FROM sales ORDER BY region" },
      },
    ],
    panels: [
      {
        id: "trend",
        type: "timeseries",
        title: "Sales in the selected region",
        grid: { x: 0, y: 0, w: 16, h: 9 },
        targets: target(SALES_BY_REGION),
        options: { unit: "EUR" },
      },
      {
        id: "latest",
        type: "stat",
        title: "Latest value",
        grid: { x: 16, y: 0, w: 8, h: 9 },
        targets: target(SALES_BY_REGION),
        options: { unit: "EUR", reducer: "last" },
      },
      {
        id: "regions",
        type: "bar",
        title: "Total per region",
        grid: { x: 0, y: 9, w: 12, h: 8 },
        targets: target(
          "SELECT region, ROUND(SUM(amount)) AS total FROM sales WHERE $__timeFilter(ts) GROUP BY region ORDER BY region",
        ),
      },
      {
        id: "table",
        type: "table",
        title: "Per region",
        grid: { x: 12, y: 9, w: 12, h: 8 },
        targets: target(
          "SELECT region, COUNT(*) AS readings, ROUND(AVG(amount), 1) AS average, ROUND(MAX(amount), 1) AS highest FROM sales WHERE $__timeFilter(ts) GROUP BY region ORDER BY region",
        ),
      },
    ],
  });
  const range = "$__timeFilter(ts)";
  const galleryId = await client.createDashboard({
    schemaVersion: 1,
    title: "Sales overview",
    timeRange: { from: "now-6h", to: "now" },
    variables: [],
    panels: [
      {
        id: "notes",
        type: "text",
        title: "About this dashboard",
        grid: { x: 0, y: 0, w: 8, h: 9 },
        targets: [],
        options: {
          mode: "markdown",
          content:
            "Sales of the **last six hours** per region, from the shop database.\n\n- Online, store and partner sales are summed per region\n- The pie shows each region's share of all sales",
        },
      },
      {
        id: "channels",
        type: "bar",
        title: "Sales per region and channel",
        grid: { x: 8, y: 0, w: 16, h: 9 },
        targets: target(
          `SELECT region, ROUND(SUM(amount) * 12) AS online, ROUND(SUM(amount) * 8) AS store, ROUND(SUM(amount) * 5) AS partner FROM sales WHERE ${range} GROUP BY region ORDER BY region`,
        ),
        options: { legend: { mode: "list", placement: "right", values: [] } },
      },
      {
        id: "average",
        type: "bargauge",
        title: "Average order per region",
        grid: { x: 0, y: 9, w: 12, h: 9 },
        targets: target(
          `SELECT region, ROUND(AVG(amount), 1) AS average FROM sales WHERE ${range} GROUP BY region ORDER BY region`,
        ),
        options: { reducer: "last", displayMode: "basic", orientation: "horizontal" },
      },
      {
        id: "share",
        type: "piechart",
        title: "Share of sales",
        grid: { x: 12, y: 9, w: 12, h: 9 },
        targets: target(
          `SELECT region, ROUND(SUM(amount) * 25) AS total FROM sales WHERE ${range} GROUP BY region ORDER BY region`,
        ),
        options: {
          labels: "percent",
          legend: { mode: "table", placement: "right", values: [] },
          legendValues: ["value"],
        },
        fieldConfig: { defaults: { unit: "short" }, overrides: [] },
      },
    ],
  });
  for (const [title, region] of [
    ["Region North", "Nord"],
    ["Region West", "West"],
    ["Weekly review", "Süd"],
  ] as const) {
    await client.createDashboard({
      schemaVersion: 1,
      title,
      timeRange: { from: "now-6h", to: "now" },
      variables: [],
      panels: [
        {
          id: "trend",
          type: "timeseries",
          title: `Sales, ${region}`,
          grid: { x: 0, y: 0, w: 24, h: 9 },
          targets: target(
            `SELECT ts AS time, amount FROM sales WHERE region = '${region}' AND $__timeFilter(ts) ORDER BY ts`,
          ),
        },
      ],
    });
  }
  return {
    client,
    seeded: {
      orgName,
      owner,
      members,
      sourceId,
      sourceName,
      dashboardId,
      dashboardTitle,
      galleryId,
    },
  };
}

/** The Neo4j shop graph as a source and a dashboard of network, hierarchy and path panels. */
export async function seedGraph(
  client: KalzitClient,
  bolt: { host: string; port: number; user: string; password: string },
): Promise<{ sourceId: string; dashboardId: string }> {
  const sourceId = await client.createSource(
    "Shop graph (Neo4j)",
    "neo4j",
    { host: bolt.host, port: bolt.port, user: bolt.user },
    { password: bolt.password },
  );
  const panel = (
    id: string,
    type: string,
    title: string,
    grid: { x: number; y: number; w: number; h: number },
    cypher: string,
  ) => ({
    id,
    type,
    title,
    grid,
    targets: [{ refId: "A", datasourceId: sourceId, query: { cypher } }],
  });
  const dashboardId = await client.createDashboard({
    schemaVersion: 1,
    title: "Shop graph",
    timeRange: { from: "now-6h", to: "now" },
    variables: [],
    panels: [
      panel(
        "shop",
        "network",
        "Customers, orders and products",
        { x: 0, y: 0, w: 12, h: 11 },
        "MATCH (c:Customer)-[p:PLACED]->(o:Order)-[i:CONTAINS]->(pr:Product) RETURN c, p, o, i, pr",
      ),
      panel(
        "tree",
        "hierarchy",
        "Category tree",
        { x: 12, y: 0, w: 12, h: 11 },
        "MATCH (a:Category)-[r:SUBCATEGORY]->(b:Category) RETURN a, r, b",
      ),
      panel(
        "path",
        "path",
        "From Ana to the monitor arm",
        { x: 0, y: 11, w: 24, h: 8 },
        "MATCH p = shortestPath((c:Customer {name: 'Ana'})-[:PLACED|CONTAINS*..10]-(pr:Product {name: 'Monitor arm'})) RETURN p",
      ),
    ],
  });
  return { sourceId, dashboardId };
}

/**
 * Connects the fake AI provider as a server-wide provider, tests it (which stores the result),
 * turns AI on and opens the demo source to AI, so Explore's AI buttons and Fragen work.
 */
export async function seedAi(
  client: KalzitClient,
  baseUrl: string,
  sourceIds: readonly string[],
): Promise<{ providerId: string }> {
  const provider = await client.request<{ id: string }>("POST", "/api/admin/ai/providers", {
    name: "Devkit fake provider",
    kind: "openai",
    baseUrl,
    model: "devkit-fake-1",
    leavesNetwork: "no",
  });
  const test = await client.request<{ ok: boolean; reason?: string }>(
    "POST",
    `/api/admin/ai/providers/${provider.id}/test`,
  );
  if (!test.ok) {
    throw new Error(`the fake AI provider failed its connection test: ${test.reason ?? "?"}`);
  }
  await client.setServerSetting("ai.enabled", true);
  for (const sourceId of sourceIds) {
    await client.request("PUT", client.org(`/datasources/${sourceId}/ai-access`), {
      readable: true,
    });
  }
  return { providerId: provider.id };
}
