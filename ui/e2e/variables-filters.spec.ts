import { join } from "node:path";
import { Api, fixturesDir, unique } from "./support/api";
import { seriousViolations } from "./support/axe";
import { REGIONS } from "./support/fixture-db";
import { t } from "./support/i18n";
import { expect, test } from "./support/test";

let owner: Api;

test.beforeAll(async () => {
  owner = await Api.owner();
});

test.afterAll(async () => {
  await owner.dispose();
});

/** Sales per region in the dashboard's range, narrowed by the dashboard's ad hoc filters. */
const PER_REGION =
  "SELECT region, COUNT(*) AS n FROM sales WHERE $__filter AND $__timeFilter(ts) " +
  "GROUP BY region ORDER BY region";

// Ad hoc filters (board ParityEditors, frame 10): a chip narrows the panel through `$__filter`,
// where the server binds the value; a click on the value changes only it, and removing the chip
// shows every region again. The bar stays free of serious accessibility findings.
test("ad hoc filters narrow a SQL panel through $__filter", async ({ page }) => {
  const source = await owner.createSqliteSource(unique("Verkauf"), join(fixturesDir(), "sales.db"));
  const title = unique("Freie Filter");
  const dashboardId = await owner.createDashboard({
    schemaVersion: 2,
    title,
    timeRange: { from: "now-6h", to: "now" },
    variables: [{ name: "filters", label: "Filter", type: "adhoc", datasourceId: source }],
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

  await page.goto(`/dashboards/${dashboardId}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const panel = page.getByRole("article", { name: "Per region" });
  for (const region of REGIONS) {
    await expect(panel.getByRole("cell", { name: region, exact: true })).toBeVisible();
  }

  const bar = page.getByRole("region", { name: t("dashboards.variables.label") });
  await bar.getByRole("button", { name: t("dashboards.filters.add") }).click();
  const editor = page.getByRole("dialog", {
    name: t("dashboards.filters.addTitle", { label: "Filter" }),
  });
  await editor.getByLabel(t("dashboards.filters.key")).fill("region");
  await editor.getByLabel(t("dashboards.filters.value")).fill("Ost");
  expect(await seriousViolations(page)).toEqual([]);
  await editor.getByLabel(t("dashboards.filters.value")).press("Enter");
  await expect(editor).toBeHidden();

  await expect(panel.getByRole("cell", { name: "Ost", exact: true })).toBeVisible();
  await expect(panel.getByRole("cell", { name: "West", exact: true })).toHaveCount(0);
  expect(await seriousViolations(page)).toEqual([]);

  const chip = (value: string) =>
    t("dashboards.filters.chip", {
      key: "region",
      operator: t("dashboards.filters.operator.eq"),
      value,
    });
  await bar
    .getByRole("button", { name: t("dashboards.filters.editValue", { filter: chip("Ost") }) })
    .click();
  const change = page.getByRole("dialog", {
    name: t("dashboards.filters.editTitle", { label: "Filter" }),
  });
  await change.getByLabel(t("dashboards.filters.value")).fill("West");
  await change.getByRole("button", { name: t("dashboards.filters.apply") }).click();
  await expect(panel.getByRole("cell", { name: "West", exact: true })).toBeVisible();
  await expect(panel.getByRole("cell", { name: "Ost", exact: true })).toHaveCount(0);

  await bar
    .getByRole("button", { name: t("dashboards.filters.remove", { filter: chip("West") }) })
    .click();
  for (const region of REGIONS) {
    await expect(panel.getByRole("cell", { name: region, exact: true })).toBeVisible();
  }
});
