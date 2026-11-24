import { Api, unique } from "./support/api";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

/**
 * The XY chart and the Trend panel on the sales data (docs/design/blueprint/XYMapTrend.dc.html):
 * an XY chart of amount against a day count with a series per region, a Trend over amount
 * buckets, and a Trend over the same buckets in falling order, which never sorts by itself: it
 * explains on the dashboard and offers the visible step "Sort" in the panel editor.
 */

const range = "$__timeFilter(ts)";
const buckets = (order: "ASC" | "DESC") =>
  `SELECT CAST(amount / 50 AS INTEGER) * 50 AS bucket, ROUND(AVG(amount), 1) AS average, COUNT(*) AS orders FROM sales WHERE ${range} GROUP BY bucket ORDER BY bucket ${order}`;

let dashboardId = "";

test.beforeAll(async ({ world }) => {
  const owner = await Api.owner();
  const target = (sql: string) => [{ refId: "A", datasourceId: world.sourceId, query: { sql } }];
  try {
    dashboardId = await owner.createDashboard({
      schemaVersion: 1,
      title: unique("XY and Trend"),
      timeRange: { from: "now-6h", to: "now" },
      variables: [],
      panels: [
        {
          id: "xy",
          type: "xy",
          title: "Amount against days",
          grid: { x: 0, y: 0, w: 12, h: 9 },
          targets: target(
            `SELECT region, amount, (CAST(strftime('%M', ts) AS INTEGER) % 7) + 1 AS days FROM sales WHERE ${range}`,
          ),
          options: { seriesBy: "region", show: "points" },
        },
        {
          id: "trend",
          type: "trend",
          title: "Average per amount bucket",
          grid: { x: 12, y: 0, w: 12, h: 9 },
          targets: target(buckets("ASC")),
        },
        {
          id: "falling",
          type: "trend",
          title: "Buckets in falling order",
          grid: { x: 0, y: 9, w: 12, h: 9 },
          targets: target(buckets("DESC")),
        },
        {
          // The server takes the sort step the hint offers.
          id: "sorted",
          type: "trend",
          title: "Buckets sorted by a step",
          grid: { x: 12, y: 9, w: 12, h: 9 },
          targets: target(buckets("DESC")),
          transformations: [{ id: "s", type: "sort", frame: "A", by: [{ field: "bucket" }] }],
        },
      ],
    });
  } finally {
    await owner.dispose();
  }
});

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme, viewport: { width: 1440, height: 1000 } });

    test("draws the XY chart and the trends, and explains data that do not fit", async ({
      page,
    }) => {
      await signInOwner(page);
      await page.goto(`/dashboards/${dashboardId}`);
      const xy = page.getByRole("group", { name: "Amount against days" });
      await expect(xy.locator(".xy__point").first()).toBeVisible();
      expect(await xy.locator(".xy__point").count()).toBeGreaterThan(10);
      // One legend entry per region.
      await expect(page.locator(".viz-legend").filter({ hasText: "Nord" }).first()).toBeVisible();
      const trend = page.getByRole("group", { name: "Average per amount bucket" });
      await expect(trend.locator(".ts__line, canvas").first()).toBeVisible();
      await expect(
        page.getByRole("group", { name: "Buckets sorted by a step" }).locator(".ts__line").first(),
      ).toBeVisible();
      // Falling X: a hint with the field, no drawing, and no buttons for a viewer of the dashboard.
      const hint = page.locator(".fit-hint").filter({ hasText: t("panels.trend.falls") });
      await expect(hint).toBeVisible();
      await expect(hint).toContainText("bucket");
      await expect(hint.getByRole("button", { name: t("panels.trend.addSort") })).toHaveCount(0);
      // Keyboard: the XY chart's points are read out in X order.
      await xy.focus();
      await page.keyboard.press("Home");
      await expect(xy.getByRole("status")).toContainText("amount");
      expect(await seriousViolations(page)).toEqual([]);
    });
  });
}

test("the panel editor adds the Sort step the Trend hint offers, or switches to the XY chart", async ({
  page,
}) => {
  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}/panels/falling/edit`);
  const preview = page.locator(".panel-editor__preview");
  const hint = preview.locator(".fit-hint");
  await expect(hint).toContainText(t("panels.trend.falls"));
  await hint.getByRole("button", { name: t("panels.trend.addSort") }).click();
  // The step is in the list, visible and switchable, and the trend draws.
  await expect(page.getByText(t("analysis.kind.sort")).first()).toBeVisible();
  await expect(preview.locator(".fit-hint")).toHaveCount(0);
  await expect(preview.locator(".ts__line").first()).toBeVisible();

  await page.goto(`/dashboards/${dashboardId}/panels/falling/edit`);
  await preview
    .locator(".fit-hint")
    .getByRole("button", { name: t("panels.trend.showAsXY") })
    .click();
  await expect(preview.locator(".xy__point").first()).toBeVisible();
});

test.describe("360 px wide", () => {
  test.use({ viewport: { width: 360, height: 1600 } });

  test("the XY chart and the hint fit without sticking out", async ({ page }) => {
    await signInOwner(page);
    await page.goto(`/dashboards/${dashboardId}`);
    await expect(page.locator(".xy__point").first()).toBeVisible();
    await expect(page.locator(".fit-hint").first()).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(360);
  });
});
