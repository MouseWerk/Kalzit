import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { Api, fixturesDir, unique } from "./support/api";
import { systemColor } from "./support/colors";
import { t } from "./support/i18n";
import { boltTarget, GRAPH_FIXTURE, serviceAddress } from "./support/services";
import { expect, signInOwner, test } from "./support/test";

/**
 * Forced colors (Windows high contrast): the browser swaps every color of the page for a system
 * color but leaves canvases alone, so the charts read system colors through their probes and
 * draw with them.
 */

type Rgb = [number, number, number];

function rgb(color: string): Rgb {
  const [r = 0, g = 0, b = 0] = (color.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  return [r, g, b];
}

/** How many opaque pixels of the canvas are close to a color. */
function drawnPixels(canvas: Locator, color: Rgb): Promise<number> {
  return canvas.evaluate((element, [r, g, b]) => {
    const c = element as HTMLCanvasElement;
    const data = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data;
    let hits = 0;
    for (let i = 0; data !== undefined && i < data.length; i += 4) {
      const near =
        Math.abs((data[i] ?? 0) - r) < 24 &&
        Math.abs((data[i + 1] ?? 0) - g) < 24 &&
        Math.abs((data[i + 2] ?? 0) - b) < 24 &&
        (data[i + 3] ?? 0) > 200;
      if (near) hits += 1;
    }
    return hits;
  }, color);
}

test.use({ colorScheme: "light" });

test("time series canvases draw their series in system colors and redraw when it changes", async ({
  page,
}) => {
  const owner = await Api.owner();
  let dashboardId = "";
  try {
    const sourceId = await owner.createSqliteSource(
      unique("Forced colors"),
      join(fixturesDir(), "sales.db"),
    );
    dashboardId = await owner.createDashboard({
      schemaVersion: 1,
      title: unique("High contrast"),
      timeRange: { from: "now-6h", to: "now" },
      panels: [
        {
          id: "p1",
          type: "timeseries",
          title: "Two series",
          grid: { x: 0, y: 0, w: 24, h: 10 },
          targets: [
            {
              refId: "A",
              datasourceId: sourceId,
              query: {
                sql: "SELECT ts AS time, amount AS nord, amount * 2 AS doppelt FROM sales WHERE region = 'Nord' AND $__timeFilter(ts) ORDER BY ts",
              },
            },
          ],
        },
      ],
    });
  } finally {
    await owner.dispose();
  }

  // Loaded with Kalzit's colors; high contrast is turned on afterwards, then off again.
  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`);
  const card = page.getByRole("article", { name: "Two series", exact: true });
  const canvas = card.locator(".ts__uplot canvas");
  await expect(canvas).toBeVisible();
  const probe = (selector: string) =>
    card.locator(`.ts__probes ${selector}`).evaluate((el) => getComputedStyle(el).color);
  const themed = await probe(".ts__probe.series-2");
  await expect.poll(() => drawnPixels(canvas, rgb(themed))).toBeGreaterThan(20);

  await page.emulateMedia({ forcedColors: "active" });
  const text = await systemColor(page, "CanvasText");
  const link = await systemColor(page, "LinkText");
  const background = await systemColor(page, "Canvas");
  expect(text).not.toEqual(background);
  // The probes hand the canvas system colors: the first series in the text color, the second in
  // the link color.
  expect(await probe(".ts__probe--axis")).toEqual(text);
  expect(await probe(".ts__probe.series-1")).toEqual(text);
  expect(await probe(".ts__probe.series-2")).toEqual(link);
  // And the chart draws again with them, without a reload.
  await expect.poll(() => drawnPixels(canvas, rgb(link))).toBeGreaterThan(20);

  await page.emulateMedia({ forcedColors: "none" });
  await expect.poll(() => probe(".ts__probe.series-2")).toEqual(themed);
  await expect.poll(() => drawnPixels(canvas, rgb(themed))).toBeGreaterThan(20);
});

/**
 * Graph panels draw with WebGL, which forced colors leave alone too. Left to the browser, every
 * probe turned into the text color, the label background included, and the labels vanished.
 */
test("graph labels keep a background apart from their text", async ({ page }) => {
  const address = serviceAddress("KALZIT_E2E_NEO4J");
  const owner = await Api.owner();
  let dashboardId = "";
  try {
    const sourceId = await owner.createSource(
      unique("Shop graph (forced colors)"),
      "neo4j",
      { ...boltTarget(address), user: GRAPH_FIXTURE.neo4jUser },
      { password: GRAPH_FIXTURE.neo4jPassword },
    );
    dashboardId = await owner.createDashboard({
      schemaVersion: 1,
      title: unique("Graph in high contrast"),
      timeRange: { from: "now-6h", to: "now" },
      panels: [
        {
          id: "g1",
          type: "network",
          title: "Customers and orders",
          grid: { x: 0, y: 0, w: 24, h: 10 },
          targets: [
            {
              refId: "A",
              datasourceId: sourceId,
              query: { cypher: "MATCH (c:Customer)-[p:PLACED]->(o:Order) RETURN c, p, o" },
            },
          ],
        },
      ],
    });
  } finally {
    await owner.dispose();
  }

  await page.emulateMedia({ forcedColors: "active" });
  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`);
  const card = page.getByRole("article", { name: "Customers and orders", exact: true });
  const drawing = card.getByRole("application", { name: "Customers and orders", exact: true });
  const noWebgl = card.getByText(t("graph.notice.noWebgl"), { exact: true });
  await expect(drawing.or(noWebgl)).toBeVisible({ timeout: 15_000 });
  test.skip(await noWebgl.isVisible(), "this browser cannot draw graphs");

  const probe = (name: string) =>
    drawing.locator(`.graph__probe--${name}`).evaluate((el) => getComputedStyle(el).color);
  const text = await probe("text");
  expect(text).toEqual(await systemColor(page, "CanvasText"));
  // The label backgrounds, plain and selected, are the system background, not the text color.
  const background = await probe("bg");
  expect(background).toEqual(await systemColor(page, "Canvas"));
  expect(background).not.toEqual(text);
  expect(await probe("active")).not.toEqual(text);
  expect(await probe("edge")).not.toEqual(background);
});
