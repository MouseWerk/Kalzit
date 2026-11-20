import type { Locator, Page } from "@playwright/test";
import { Api, SQL, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test, type World } from "./support/test";

// A panel's menu stands in the window at its button, and scrolling the page closes it. A button
// low in the window has no room below it: the menu opens above the button instead, so no entry
// lies past the window's edge where nobody could reach it. Where even the room above is too
// little, the menu is as high as that room and scrolls in itself, without closing.

const LOW = "Lagerbestand";

/** A dashboard of the spec's own: a panel, and below it the one whose menu is opened. */
async function seedDashboard(world: World): Promise<string> {
  const owner = await Api.owner();
  try {
    const panel = (id: string, title: string, y: number) => ({
      id,
      type: "timeseries",
      title,
      grid: { x: 0, y, w: 12, h: 8 },
      targets: [{ refId: "A", datasourceId: world.sourceId, query: { sql: SQL.series } }],
    });
    return await owner.createDashboard({
      schemaVersion: 1,
      title: unique("Zwei Panels untereinander"),
      timeRange: { from: "now-6h", to: "now" },
      variables: [],
      panels: [panel("p1", "Umsatz", 0), panel("p2", LOW, 8)],
    });
  } finally {
    await owner.dispose();
  }
}

/** Opens the dashboard and brings the lower panel's menu button to the window's lower edge. */
async function buttonAtTheLowerEdge(page: Page, world: World, height: number): Promise<Locator> {
  const dashboardId = await seedDashboard(world);
  await signInOwner(page, "en");
  await page.goto(`/dashboards/${dashboardId}`);
  const panel = page.getByRole("article", { name: LOW, exact: true });
  await expect(panel).toBeVisible();
  const button = panel.getByRole("button", {
    name: t("dashboards.panel.menuNamed", { title: LOW }),
  });
  await button.evaluate((element) => element.scrollIntoView({ block: "end" }));
  // The panel above it fills the window: the button stands at the lower edge.
  const box = await button.boundingBox();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThan(height - 24);
  return button;
}

const menuOf = (page: Page) =>
  page.getByRole("menu", { name: t("dashboards.panel.menuNamed", { title: LOW }) });

test.describe("a window with room above the button", () => {
  const WINDOW = { width: 390, height: 560 };
  test.use({ viewport: WINDOW });

  test("opens a panel's menu above a button that is low in the window", async ({ page, world }) => {
    const button = await buttonAtTheLowerEdge(page, world, WINDOW.height);
    const low = await button.boundingBox();
    // The button shows itself on hover and on focus; from the keyboard nothing scrolls.
    await button.focus();
    await button.press("Enter");

    const menu = menuOf(page);
    const items = menu.getByRole("menuitem");
    await expect(items.first()).toBeVisible();
    const first = await items.first().boundingBox();
    const last = await items.last().boundingBox();
    expect(first?.y ?? -1).toBeGreaterThanOrEqual(0);
    // Above the button, not over it, and whole: nothing to scroll.
    expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual((low?.y ?? 0) + 1);
    expect(await menu.evaluate((list) => list.scrollHeight <= list.clientHeight)).toBe(true);
  });
});

test.describe("a window too low for the menu", () => {
  const WINDOW = { width: 390, height: 170 };
  test.use({ viewport: WINDOW });

  test("keeps the menu between the window's edge and its button, scrolling in itself", async ({
    page,
    world,
  }) => {
    const button = await buttonAtTheLowerEdge(page, world, WINDOW.height);
    const low = await button.boundingBox();
    await button.focus();
    await button.press("Enter");

    const menu = menuOf(page);
    await expect(menu).toBeVisible();
    const frame = await menu.boundingBox();
    expect(frame?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((frame?.y ?? 0) + (frame?.height ?? 0)).toBeLessThanOrEqual((low?.y ?? 0) + 1);
    // More entries than fit: the menu scrolls, and scrolling in it does not close it.
    expect(await menu.evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(true);
    await menu.evaluate((list) => list.scrollTo(0, list.scrollHeight));
    await expect.poll(() => menu.evaluate((list) => list.scrollTop)).toBeGreaterThan(0);
    await expect(menu).toBeVisible();
    const last = await menu.getByRole("menuitem").last().boundingBox();
    expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual((low?.y ?? 0) + 1);
    // A scroll of the page still closes it.
    await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
    await expect(menu).toBeHidden();
  });
});
