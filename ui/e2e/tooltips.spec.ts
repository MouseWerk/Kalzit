import type { Page } from "@playwright/test";
import { Api, regionDashboard, unique } from "./support/api";
import { expect, signInOwner, test } from "./support/test";

/**
 * Hover tooltips in a real browser: a chart's tooltip lies above the whole page (at the end of
 * the body, fixed, on the tooltip layer), so its panel cannot clip it and neither a neighbouring
 * panel, a sticky table heading nor the toolbar can cover it; at the viewport's edges it flips
 * or shifts and stays whole.
 */

const TABLE = "Sales table";

/** The region dashboard with a table beside its time series panel. */
async function dashboardWithTable(sourceId: string): Promise<string> {
  const owner = await Api.owner();
  const model = regionDashboard(unique("Tooltips"), sourceId) as {
    panels: Record<string, unknown>[];
  };
  const first = model.panels[0] as Record<string, unknown>;
  const id = await owner.createDashboard({
    ...model,
    panels: [
      first,
      { ...first, id: "p2", type: "table", title: TABLE, grid: { x: 12, y: 0, w: 12, h: 8 } },
    ],
  });
  await owner.dispose();
  return id;
}

interface Seen {
  box: { left: number; top: number; right: number; bottom: number };
  viewport: { width: number; height: number };
  parent: string;
  position: string;
  layer: number;
  layers: { bar: number; sticky: number; menu: number; popover: number };
}

/** The time series tooltip on screen, with what decides whether anything can clip or cover it. */
async function tooltip(page: Page): Promise<Seen> {
  const tip = page.locator(".ts__tooltip[data-placed]");
  await expect(tip).toBeVisible();
  return await tip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    const token = (name: string) => Number(root.getPropertyValue(name));
    return {
      box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      parent: element.parentElement?.tagName ?? "",
      position: style.position,
      layer: Number(style.zIndex),
      layers: {
        bar: token("--z-bar"),
        sticky: token("--z-sticky"),
        menu: token("--z-menu"),
        popover: token("--z-popover"),
      },
    };
  });
}

function expectWhole(seen: Seen) {
  expect(seen.box.left).toBeGreaterThanOrEqual(0);
  expect(seen.box.top).toBeGreaterThanOrEqual(0);
  expect(seen.box.right).toBeLessThanOrEqual(seen.viewport.width);
  expect(seen.box.bottom).toBeLessThanOrEqual(seen.viewport.height);
}

test("a chart's tooltip lies above the page and stays whole at every edge", async ({
  page,
  world,
}) => {
  const id = await dashboardWithTable(world.sourceId);
  await signInOwner(page);
  await page.goto(`/dashboards/${id}`);
  const card = page.getByRole("article", { name: "Sales", exact: true });
  const plot = card.locator(".ts__plot");
  await expect(page.locator(".uplot")).toHaveCount(1);
  await expect(page.getByRole("article", { name: TABLE, exact: true })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);

  await test.step("at the panel's right edge, beside the table: out of the panel, not clipped", async () => {
    const box = await plot.boundingBox();
    const cardBox = await card.boundingBox();
    if (box === null || cardBox === null) throw new Error("the time series panel is not on screen");
    await page.mouse.move(box.x + box.width * 0.92, box.y + box.height / 2);
    const seen = await tooltip(page);
    // Not inside the panel: nothing of the page clips it or confines its layer.
    expect(seen.parent).toBe("BODY");
    expect(seen.position).toBe("fixed");
    for (const below of Object.values(seen.layers)) {
      expect(seen.layer).toBeGreaterThan(below);
    }
    // It reaches out of its panel, over the neighbouring table, and all of it is on screen.
    expect(seen.box.right).toBeGreaterThan(cardBox.x + cardBox.width);
    expectWhole(seen);
  });

  await test.step("at the top of the panel, right under the toolbar", async () => {
    const box = await plot.boundingBox();
    if (box === null) throw new Error("the time series panel is not on screen");
    await page.mouse.move(box.x + box.width * 0.4, box.y + 3);
    expectWhole(await tooltip(page));
  });

  await test.step("at the viewport's bottom edge it opens upwards", async () => {
    const box = await plot.boundingBox();
    if (box === null) throw new Error("the time series panel is not on screen");
    // A window that ends in the middle of the plot.
    const width = page.viewportSize()?.width ?? 1280;
    await page.mouse.move(0, 0);
    await page.setViewportSize({ width, height: Math.round(box.y + box.height * 0.6) });
    const cut = await plot.boundingBox();
    const height = page.viewportSize()?.height ?? 0;
    if (cut === null) throw new Error("the time series panel is not on screen");
    await page.mouse.move(cut.x + cut.width * 0.4, height - 6);
    const seen = await tooltip(page);
    expectWhole(seen);
    expect(seen.box.bottom).toBeLessThanOrEqual(height - 6);
  });
});
