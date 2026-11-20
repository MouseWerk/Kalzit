import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

// A panel's menu stands in the window at its button, and scrolling the page closes it. A button
// low in the window has no room below it: the menu opens above the button instead, so no entry
// lies past the window's edge where nobody could reach it.

const WINDOW = { width: 390, height: 560 };

test.use({ viewport: WINDOW });

test("opens a panel's menu above a button that is low in the window", async ({ page, world }) => {
  await signInOwner(page, "en");
  await page.goto(`/dashboards/${world.dashboardId}`);
  const panel = page.getByRole("article", { name: "Sales", exact: true });
  await expect(panel).toBeVisible();
  const name = t("dashboards.panel.menuNamed", { title: "Sales" });
  const button = panel.getByRole("button", { name });
  // The panel's title bar at the window's lower edge.
  await button.evaluate((element) => element.scrollIntoView({ block: "end" }));
  const low = await button.boundingBox();
  expect(low?.y ?? 0).toBeGreaterThan(WINDOW.height / 2);
  await button.click();

  const items = page.getByRole("menu", { name }).getByRole("menuitem");
  await expect(items.first()).toBeVisible();
  const first = await items.first().boundingBox();
  const last = await items.last().boundingBox();
  expect(first?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual(WINDOW.height);
  // Above the button, not over it.
  expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual((low?.y ?? 0) + 1);
});
