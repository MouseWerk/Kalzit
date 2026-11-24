import { Api, unique } from "./support/api";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

/**
 * The map panel on the sales data (docs/design/blueprint/XYMapTrend.dc.html, frames 3 to 5 and
 * 8): points per region from coordinates the query adds, one region without coordinates, and
 * areas per country code with one code Kalzit does not know. Every request stays on this server:
 * the outlines ship with Kalzit.
 */

const range = "$__timeFilter(ts)";
const places = `SELECT region,
  CASE region WHEN 'Nord' THEN 53.55 WHEN 'Ost' THEN 52.52 WHEN 'Süd' THEN 48.14 ELSE NULL END AS lat,
  CASE region WHEN 'Nord' THEN 9.99 WHEN 'Ost' THEN 13.40 WHEN 'Süd' THEN 11.58 ELSE NULL END AS lon,
  ROUND(SUM(amount), 1) AS umsatz
  FROM sales WHERE ${range} GROUP BY region ORDER BY region`;
const countries = `SELECT
  CASE region WHEN 'Nord' THEN 'DE' WHEN 'Ost' THEN 'POL' WHEN 'Süd' THEN 'AT' ELSE 'UK' END AS land,
  ROUND(SUM(amount), 1) AS umsatz
  FROM sales WHERE ${range} GROUP BY region ORDER BY region`;

let dashboardId = "";

test.beforeAll(async ({ world }) => {
  const owner = await Api.owner();
  const target = (sql: string) => [{ refId: "A", datasourceId: world.sourceId, query: { sql } }];
  try {
    dashboardId = await owner.createDashboard({
      schemaVersion: 1,
      title: unique("Map"),
      timeRange: { from: "now-6h", to: "now" },
      variables: [],
      panels: [
        {
          id: "cities",
          type: "map",
          title: "Revenue by region",
          grid: { x: 0, y: 0, w: 12, h: 10 },
          targets: target(places),
          options: { layers: [{ kind: "points", valueField: "umsatz" }] },
        },
        {
          id: "countries",
          type: "map",
          title: "Revenue by country",
          grid: { x: 12, y: 0, w: 12, h: 10 },
          targets: target(countries),
          options: { layers: [{ kind: "areas", valueField: "umsatz" }] },
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

    test("draws points and areas over the bundled outlines and asks no other host", async ({
      page,
    }) => {
      const hosts = new Set<string>();
      page.on("request", (request) => hosts.add(new URL(request.url()).host));
      await signInOwner(page);
      await page.goto(`/dashboards/${dashboardId}`);
      const cities = page.locator(".panel-card").filter({ hasText: "Revenue by region" });
      await expect(cities.getByTestId("map-outlines")).toBeVisible();
      await expect(cities.locator(".map__dot")).toHaveCount(3);
      await expect(cities.getByText(t("map.status.rows", { shown: 3, total: 4 }))).toBeVisible();
      // The region without coordinates is named with its reason, nothing disappears silently.
      await cities.getByRole("button", { name: t("map.missing.strip", { count: 1 }) }).click();
      await expect(cities.getByText(t("map.missing.noPlace"))).toBeVisible();
      // The keyboard reads the places from west to east, with their value.
      const map = cities.getByRole("group", {
        name: t("map.canvas.label", { title: "Revenue by region" }),
      });
      await map.focus();
      await page.keyboard.press("ArrowRight");
      await expect(map.getByRole("status")).toContainText("Nord");

      const areas = page.locator(".panel-card").filter({ hasText: "Revenue by country" });
      await expect(areas.getByTestId("map-areas").locator("path")).toHaveCount(3);
      await expect(areas.getByText(t("map.codes.title", { count: 1 }))).toBeVisible();
      // A viewer of the dashboard gets the explanation, the button is the editor's.
      await expect(
        areas.getByRole("button", { name: t("map.codes.addOne", { key: "UK", code: "GB" }) }),
      ).toHaveCount(0);
      expect(await seriousViolations(page)).toEqual([]);
      const own = new URL(page.url()).host;
      expect([...hosts].filter((host) => host !== own)).toEqual([]);
    });
  });
}

test("the panel editor adds the code pair the hint offers", async ({ page }) => {
  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}/panels/countries/edit`);
  const preview = page.locator(".panel-editor__preview");
  await preview
    .getByRole("button", { name: t("map.codes.addOne", { key: "UK", code: "GB" }) })
    .click();
  await expect(preview.getByTestId("map-areas").locator("path")).toHaveCount(4);
  await expect(page.getByText("UK → GB")).toBeVisible();
});

test.describe("360 px wide", () => {
  test.use({ viewport: { width: 360, height: 1600 } });

  test("the map and its corner fit without sticking out", async ({ page }) => {
    await signInOwner(page);
    await page.goto(`/dashboards/${dashboardId}`);
    await expect(page.locator(".map__dot").first()).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(360);
    expect(await seriousViolations(page)).toEqual([]);
  });
});
