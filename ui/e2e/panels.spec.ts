import type { Page } from "@playwright/test";
import { galleryDashboard } from "./screenshots/demo";
import { Api } from "./support/api";
import { seriousViolations } from "./support/axe";
import { findOverflow } from "./support/overflow";
import { expect, signInOwner, test } from "./support/test";

/**
 * The bar chart, bar gauge, pie and text panels on one dashboard, as the README shows them:
 * grouped bars with the legend on the right, one gauge bar per row with its value after it, a
 * pie with labels on its slices and a legend table, and Markdown text.
 */
let dashboardId = "";

test.beforeAll(async ({ world }) => {
  const owner = await Api.owner();
  dashboardId = await owner.createDashboard(galleryDashboard(world.sourceId));
  await owner.dispose();
});

async function open(page: Page): Promise<void> {
  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`);
  await expect(page.locator(".bar__rect")).toHaveCount(12);
  await expect(page.locator(".bargauge__lane-bar")).toHaveCount(4);
  await expect(page.locator(".pie__slice")).toHaveCount(4);
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme, viewport: { width: 1440, height: 900 } });

    test("draws grouped bars, gauge rows and pie labels with legends beside them", async ({
      page,
    }) => {
      await open(page);
      const bars = page.getByRole("group", { name: "Sales per region and channel" });
      await expect(page.locator(".viz-layout--right").filter({ has: bars })).toHaveCount(1);
      // Compact axis values, one name per category.
      await expect(bars.locator(".ts__label", { hasText: /\d k$/ }).first()).toBeVisible();
      const gauge = page.getByRole("group", { name: "Average order per region" });
      await expect(gauge.locator(".bargauge__name")).toHaveText(["Nord", "Ost", "Süd", "West"]);
      // Each value follows its bar: the longest bar still leaves its value inside the panel.
      const lastBar = await gauge.locator(".bargauge__lane-bar").last().boundingBox();
      const lastValue = await gauge
        .locator(".bargauge__item .bargauge__value")
        .last()
        .boundingBox();
      const box = await gauge.boundingBox();
      expect(lastValue?.x ?? 0).toBeGreaterThan((lastBar?.x ?? 0) + (lastBar?.width ?? 0));
      expect((lastValue?.x ?? 0) + (lastValue?.width ?? 0)).toBeLessThanOrEqual(
        (box?.x ?? 0) + (box?.width ?? 0) + 1,
      );
      await expect(page.locator(".pie__label--inside")).toHaveCount(4);
      await expect(page.getByRole("columnheader", { name: "Value" })).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });
  });
}

test.describe("360 px wide", () => {
  test.use({ viewport: { width: 360, height: 1600 } });

  test("legends move below the drawings and nothing sticks out", async ({ page }) => {
    await open(page);
    const legend = page.locator(".bar .viz-legend--list");
    const plot = page.locator(".bar .bar__plot");
    const legendBox = await legend.boundingBox();
    const plotBox = await plot.boundingBox();
    expect(legendBox?.y ?? 0).toBeGreaterThan((plotBox?.y ?? 0) + (plotBox?.height ?? 0) - 1);
    const overflow = await findOverflow(page);
    expect(overflow.offenders).toEqual([]);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width);
  });

  test("text with a long word or address wraps instead of scrolling sideways", async ({
    page,
    world,
  }) => {
    const owner = await Api.owner();
    const id = await owner.createDashboard({
      schemaVersion: 1,
      title: "Long words",
      timeRange: { from: "now-6h", to: "now" },
      variables: [],
      panels: [
        {
          id: "notes",
          type: "text",
          title: "Notes",
          grid: { x: 0, y: 0, w: 24, h: 6 },
          targets: [],
          options: {
            mode: "markdown",
            content: `See https://kalzit.dev/${"a".repeat(120)} and Donaudampfschifffahrtsgesellschaftskapitänsmützenabzeichen for ${world.sourceName}.`,
          },
        },
      ],
    });
    await owner.dispose();
    await signInOwner(page);
    await page.goto(`/dashboards/${id}`);
    const text = page.locator(".text-panel");
    await expect(text).toContainText("Donaudampf");
    const { scroll, client } = await text.evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
    }));
    expect(scroll).toBeLessThanOrEqual(client);
  });
});
