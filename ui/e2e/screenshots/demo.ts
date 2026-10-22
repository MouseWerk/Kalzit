import { join } from "node:path";
import { Api, fixturesDir } from "../support/api";

/** The moment the screenshots show; the fixture data covers the six hours before it. */
export const SCREENSHOT_NOW = Date.UTC(2026, 9, 20, 14, 0, 0);

export const DEMO_OWNER = {
  name: "Maria Keller",
  email: "maria.keller@kalzit.test",
  password: "demo-password-maria",
  orgName: "Sunstone Analytics",
} as const;

export interface Demo {
  owner: Api;
  sourceId: string;
  sourceName: string;
  dashboardId: string;
  dashboardTitle: string;
}

const SALES_BY_REGION =
  "SELECT ts AS time, amount FROM sales WHERE region = $region AND $__timeFilter(ts) ORDER BY ts";

/**
 * A small, believable organization: an owner, colleagues with different roles, a team, the
 * SQLite sales fixture as a data source and a dashboard with a region variable and four panels.
 */
export async function seedDemo(setupToken: string): Promise<Demo> {
  await Api.setup({ token: setupToken, ...DEMO_OWNER });
  const owner = await Api.signIn(DEMO_OWNER.email, DEMO_OWNER.password);
  const jonas = await owner.createMember("Jonas Becker", "admin");
  const lea = await owner.createMember("Lea Hoffmann", "editor");
  const tim = await owner.createMember("Tim Schulz", "editor");
  await owner.createMember("Sofia Wagner", "viewer");
  await owner.createMember("Paul Richter", "viewer");
  await owner.createTeam("Vertrieb", [jonas.id, lea.id]);
  await owner.createTeam("Controlling", [tim.id]);

  const sourceName = "Sales (SQLite)";
  const sourceId = await owner.createSqliteSource(sourceName, join(fixturesDir(), "sales.db"));
  const dashboardTitle = "Sales by region";
  const target = (sql: string) => [{ refId: "A", datasourceId: sourceId, query: { sql } }];
  const dashboardId = await owner.createDashboard({
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
  return { owner, sourceId, sourceName, dashboardId, dashboardTitle };
}
