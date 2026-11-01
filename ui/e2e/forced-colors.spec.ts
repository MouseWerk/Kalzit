import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Api, fixturesDir, unique } from "./support/api";
import { expect, signInOwner, test } from "./support/test";

/**
 * Forced colors (Windows high contrast): the browser swaps every color of the page for a system
 * color but leaves canvases alone, so the charts read system colors through their probes and
 * draw with them.
 */

type Rgb = [number, number, number];

/** A system color keyword as the browser resolves it in forced colors. */
function systemColor(page: Page, keyword: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.setProperty("forced-color-adjust", "none");
    probe.style.setProperty("color", name);
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, keyword);
}

function rgb(color: string): Rgb {
  const [r = 0, g = 0, b = 0] = (color.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  return [r, g, b];
}

test.use({ colorScheme: "light" });

test("time series canvases draw their series in system colors", async ({ page }) => {
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

  await page.emulateMedia({ forcedColors: "active" });
  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`);
  const card = page.getByRole("article", { name: "Two series", exact: true });
  const canvas = card.locator(".ts__uplot canvas");
  await expect(canvas).toBeVisible();

  const text = await systemColor(page, "CanvasText");
  const link = await systemColor(page, "LinkText");
  const background = await systemColor(page, "Canvas");
  expect(text).not.toEqual(background);
  // The probes hand the canvas system colors: the first series in the text color, the second in
  // the link color.
  const probe = (selector: string) =>
    card.locator(`.ts__probes ${selector}`).evaluate((el) => getComputedStyle(el).color);
  expect(await probe(".ts__probe--axis")).toEqual(text);
  expect(await probe(".ts__probe.series-1")).toEqual(text);
  expect(await probe(".ts__probe.series-2")).toEqual(link);

  // And the canvas draws with them: pixels of the second series' color are on it.
  const target = rgb(link);
  await expect
    .poll(() =>
      canvas.evaluate((element, [r, g, b]) => {
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
      }, target),
    )
    .toBeGreaterThan(20);
});
