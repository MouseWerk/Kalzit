import { Api } from "./support/api";
import { expect, signInOwner, test } from "./support/test";

/**
 * Charts size from their own box: a donut with its legend table on the right, in a narrow and
 * short panel (6 of 24 columns, 4 rows), stands whole inside the panel on the first render, not
 * pushed out to the right by a size measured before the layout settled.
 */
let dashboardId = "";

test.beforeAll(async ({ world }) => {
  const owner = await Api.owner();
  const sql = (query: string) => [
    { refId: "A", datasourceId: world.sourceId, query: { sql: query } },
  ];
  // All rows, not a time range: the four regions are there whenever the test runs.
  const share =
    "SELECT region, ROUND(SUM(amount)) AS total FROM sales GROUP BY region ORDER BY region";
  dashboardId = await owner.createDashboard({
    schemaVersion: 1,
    title: "Narrow charts",
    timeRange: { from: "now-6h", to: "now" },
    variables: [],
    panels: [
      {
        id: "share",
        type: "piechart",
        title: "Share per region",
        grid: { x: 0, y: 0, w: 6, h: 4 },
        targets: sql(share),
        options: {
          pieType: "donut",
          labels: "percent",
          legend: { mode: "table", placement: "right", values: [] },
          legendValues: ["value", "percent"],
        },
      },
      {
        id: "bars",
        type: "bar",
        title: "Sales per region",
        grid: { x: 6, y: 0, w: 6, h: 4 },
        targets: sql(share),
        options: {},
      },
    ],
  });
  await owner.dispose();
});

test.use({ viewport: { width: 1440, height: 900 } });

test("a donut in a narrow panel stands inside the panel on the first render", async ({ page }) => {
  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`);
  const card = page.locator('[data-panel-id="share"]');
  const slices = card.locator(".pie__slice");
  await expect(slices).toHaveCount(4);
  // Measured two animation frames after the slices appear: enough for the browser to lay out
  // and paint the first drawing (and for a ResizeObserver delivery in between), too little for a
  // later redraw to hide a first drawing that stood outside the panel.
  const fit = await card.evaluate(async (element) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const panel = element.getBoundingClientRect();
    const paths = [...element.querySelectorAll(".pie__slice")].map((path) =>
      path.getBoundingClientRect(),
    );
    return {
      panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
      donut: {
        left: Math.min(...paths.map((box) => box.left)),
        right: Math.max(...paths.map((box) => box.right)),
        top: Math.min(...paths.map((box) => box.top)),
        bottom: Math.max(...paths.map((box) => box.bottom)),
      },
    };
  });
  expect(fit.donut.left).toBeGreaterThanOrEqual(fit.panel.left - 0.5);
  expect(fit.donut.right).toBeLessThanOrEqual(fit.panel.right + 0.5);
  expect(fit.donut.top).toBeGreaterThanOrEqual(fit.panel.top - 0.5);
  expect(fit.donut.bottom).toBeLessThanOrEqual(fit.panel.bottom + 0.5);
  // A readable circle, not a dot.
  expect(fit.donut.right - fit.donut.left).toBeGreaterThan(48);
  // The legend names all four regions.
  await expect(card.locator(".viz-legend__name")).toHaveCount(4);

  // The bar chart beside it keeps its category names inside the panel.
  const bars = page.locator('[data-panel-id="bars"]');
  await expect(bars.locator(".bar__rect")).toHaveCount(4);
  const inside = await bars.evaluate((element) => {
    const panel = element.getBoundingClientRect();
    return [...element.querySelectorAll(".bar__svg text")].every((text) => {
      const box = text.getBoundingClientRect();
      return box.left >= panel.left - 0.5 && box.right <= panel.right + 0.5;
    });
  });
  expect(inside).toBe(true);
});
