import { Api, unique } from "./support/api";
import { expect, signInOwner, test } from "./support/test";

/**
 * The panel editor opened by its address (a reload, a shared link), without the dashboard having
 * been shown first: it previews with the dashboard's variables and their current values, and a
 * panel over several queries draws all of them.
 */

const STATE = (region: string) =>
  `SELECT ts AS time, CASE WHEN amount >= 150 THEN 'ok' ELSE 'degraded' END AS state FROM sales WHERE region = '${region}' AND $__timeFilter(ts) ORDER BY ts`;

test("the editor opened by link previews with the dashboard's variables", async ({
  page,
  world,
}) => {
  const owner = await Api.owner();
  let dashboardId = "";
  try {
    dashboardId = await owner.createDashboard({
      schemaVersion: 1,
      title: unique("Editor by link"),
      timeRange: { from: "now-6h", to: "now" },
      variables: [
        // A query variable without a stored value: it takes its first option once they load.
        {
          name: "region",
          type: "query",
          datasourceId: world.sourceId,
          query: { sql: "SELECT DISTINCT region FROM sales ORDER BY region" },
        },
        // A custom variable with a stored current value that is not its first.
        {
          name: "minimum",
          type: "custom",
          options: ["0", "1"],
          current: "1",
        },
      ],
      panels: [
        {
          id: "table",
          type: "table",
          title: "Readings",
          grid: { x: 0, y: 0, w: 12, h: 8 },
          targets: [
            {
              refId: "A",
              datasourceId: world.sourceId,
              query: {
                sql: "SELECT region, $minimum AS minimum, COUNT(*) AS readings FROM sales WHERE region = $region GROUP BY region",
              },
            },
          ],
        },
      ],
    });
  } finally {
    await owner.dispose();
  }

  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}/panels/table/edit`);
  const preview = page.locator(".panel-editor__preview");
  // The first region and the stored value of the custom variable, not empty values.
  await expect(preview.getByRole("cell", { name: "Nord", exact: true })).toBeVisible();
  await expect(preview.getByRole("cell", { name: "1", exact: true })).toBeVisible();
});

test("a state timeline over several queries shows a row for each, also in the editor", async ({
  page,
  world,
}) => {
  const owner = await Api.owner();
  let dashboardId = "";
  try {
    dashboardId = await owner.createDashboard({
      schemaVersion: 1,
      title: unique("States per region"),
      timeRange: { from: "now-6h", to: "now" },
      variables: [],
      panels: [
        {
          id: "states",
          type: "state-timeline",
          title: "States per region",
          grid: { x: 0, y: 0, w: 24, h: 9 },
          targets: ["Nord", "Ost", "Süd"].map((region, i) => ({
            refId: String.fromCharCode(65 + i),
            datasourceId: world.sourceId,
            query: { sql: STATE(region) },
          })),
        },
      ],
    });
  } finally {
    await owner.dispose();
  }

  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`);
  const panel = page.getByRole("article", { name: "States per region", exact: true });
  await expect(panel.locator(".state__name")).toHaveText(["state (A)", "state (B)", "state (C)"]);

  await page.goto(`/dashboards/${dashboardId}/panels/states/edit`);
  const preview = page.locator(".panel-editor__preview");
  await expect(preview.locator(".state__name")).toHaveText(["state (A)", "state (B)", "state (C)"]);
});
