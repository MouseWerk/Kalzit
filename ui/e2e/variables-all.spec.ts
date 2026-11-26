import { join } from "node:path";
import { Api, fixturesDir, unique } from "./support/api";
import { REGIONS } from "./support/fixture-db";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

let owner: Api;

test.beforeAll(async () => {
  owner = await Api.owner();
});

test.afterAll(async () => {
  await owner.dispose();
});

/** Sales per region in the dashboard's range, for the regions `$region` names. */
const PER_REGION =
  "SELECT region, COUNT(*) AS n FROM sales WHERE region IN ($region) AND $__timeFilter(ts) " +
  "GROUP BY region ORDER BY region";

// "All" goes to SQLite as one bound parameter per value (board ParityEditors, frame 9): the
// table lists every region, a pick narrows it, and the order of the options is the variable's.
test("“All” of a query variable sends every value, and a pick narrows the panel", async ({
  page,
}) => {
  const source = await owner.createSqliteSource(unique("Verkauf"), join(fixturesDir(), "sales.db"));
  const title = unique("Alle Regionen");
  const dashboardId = await owner.createDashboard({
    schemaVersion: 2,
    title,
    timeRange: { from: "now-6h", to: "now" },
    variables: [
      {
        name: "region",
        label: "Region",
        type: "query",
        datasourceId: source,
        query: { sql: "SELECT DISTINCT region FROM sales" },
        multi: true,
        includeAll: true,
        sort: "alphabeticalDesc",
        current: ["$__all"],
      },
    ],
    panels: [
      {
        id: "p1",
        type: "table",
        title: "Per region",
        grid: { x: 0, y: 0, w: 12, h: 8 },
        targets: [{ refId: "A", datasourceId: source, query: { sql: PER_REGION } }],
      },
    ],
  });

  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const bar = page.getByRole("region", { name: t("dashboards.variables.label") });
  const picker = bar.getByRole("button", {
    name: t("dashboards.variables.picker", {
      label: "Region",
      value: t("dashboards.variables.all"),
    }),
  });
  await expect(picker).toBeVisible();
  const panel = page.getByRole("article", { name: "Per region" });
  for (const region of REGIONS) {
    await expect(panel.getByRole("cell", { name: region, exact: true })).toBeVisible();
  }

  await picker.click();
  const menu = page.getByRole("menu", { name: "Region" });
  // Z to A, as the variable sorts; "All" stands apart in the quick choices.
  await expect(menu.getByRole("menuitemcheckbox")).toHaveText([
    t("dashboards.variables.all"),
    ...[...REGIONS].reverse(),
  ]);
  await menu.getByRole("menuitemcheckbox", { name: "Ost", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("cell", { name: "Ost", exact: true })).toBeVisible();
  await expect(panel.getByRole("cell", { name: "West", exact: true })).toHaveCount(0);
});
