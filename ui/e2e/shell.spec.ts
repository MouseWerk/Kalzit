import { Api } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

test("Ctrl+B collapses and expands the sidebar, and the choice survives a reload", async ({
  page,
}) => {
  await signInOwner(page);
  const shell = page.locator(".shell");
  const toggle = page.getByRole("button", { name: t("nav.sidebar"), exact: true });
  await expect(shell).toHaveAttribute("data-sidebar", "expanded");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  await page.keyboard.press("ControlOrMeta+B");
  await expect(shell).toHaveAttribute("data-sidebar", "collapsed");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // The rail keeps every entry reachable by name.
  await expect(
    page.getByRole("navigation", { name: t("nav.label") }).getByRole("link", {
      name: t("dashboards.nav"),
    }),
  ).toBeVisible();

  await page.reload();
  await expect(shell).toHaveAttribute("data-sidebar", "collapsed");

  await page.keyboard.press("ControlOrMeta+B");
  await expect(shell).toHaveAttribute("data-sidebar", "expanded");
  await toggle.click();
  await expect(shell).toHaveAttribute("data-sidebar", "collapsed");
  await toggle.click();
  await expect(shell).toHaveAttribute("data-sidebar", "expanded");
});

test("/ opens the search, and the workspace card opens the organization menu", async ({ page }) => {
  await signInOwner(page);
  await page.keyboard.press("/");
  const palette = page.getByRole("dialog", { name: t("shell.palette.title") });
  await expect(palette).toBeVisible();
  // Inside the palette's field, "/" is typed like any other letter.
  await page.keyboard.press("/");
  await expect(palette.getByRole("combobox")).toHaveValue("/");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  const card = page.locator("button.org-switcher");
  await card.click();
  const menu = page.getByRole("menu", { name: t("shell.org.menu") });
  await expect(menu.getByRole("menuitem", { name: t("shell.org.settings") })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(card).toBeFocused();
});

test("Ctrl+B does nothing while typing in a field", async ({ page }) => {
  await signInOwner(page);
  await page.goto("/dashboards");
  await page.getByRole("searchbox", { name: t("dashboards.search") }).fill("abc");
  await page.keyboard.press("ControlOrMeta+B");
  await expect(page.locator(".shell")).toHaveAttribute("data-sidebar", "expanded");
});

const SECTIONS = [
  ["admin.teams.title", "/admin/teams"],
  ["admin.roles.title", "/admin/roles"],
  ["admin.audit.title", "/admin/audit"],
  ["admin.users.title", "/admin/server/users"],
  ["admin.orgs.title", "/admin/server/organizations"],
  ["admin.serverAudit.title", "/admin/server/audit"],
] as const;

test("members open from their own entry in the organization group", async ({ page }) => {
  await signInOwner(page);
  const nav = page.getByRole("navigation", { name: t("nav.label") });
  const members = nav.getByRole("link", { name: t("nav.members"), exact: true });
  await members.click();
  await expect(page).toHaveURL(/\/admin\/members$/);
  await expect(
    page.getByRole("heading", { name: t("admin.members.title"), exact: true }),
  ).toBeVisible();
  await expect(members).toHaveAttribute("aria-current", "page");
});

test("every administration section opens from the sidebar", async ({ page }) => {
  await signInOwner(page);
  const nav = page.getByRole("navigation", { name: t("nav.label") });
  const sections = nav.getByRole("button", { name: t("admin.sections") });
  if ((await sections.getAttribute("aria-expanded")) !== "true") {
    await sections.click();
  }
  const list = nav.getByRole("list", { name: t("admin.sections") });
  for (const [label, path] of SECTIONS) {
    await list.getByRole("link", { name: t(label), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { name: t(label), exact: true })).toBeVisible();
    await expect(list.getByRole("link", { name: t(label), exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
});

/** The element's box, which must be inside the window. */
async function boxInView(page: import("@playwright/test").Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  const view = page.viewportSize();
  expect(box).not.toBeNull();
  expect(view).not.toBeNull();
  if (box === null || view === null) throw new Error("no box");
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  return box;
}

for (const viewport of [
  { width: 1440, height: 520 },
  { width: 360, height: 640 },
]) {
  test(`the top bar stays at the top while the page scrolls, ${viewport.width} px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await signInOwner(page);
    await page.goto("/settings/appearance");
    await expect(page.locator(".settings-row").first()).toBeVisible();
    // Over the page's content, not the sidebar, which scrolls on its own.
    await page.mouse.move(viewport.width - 40, viewport.height / 2);
    // Over the section, not the sidebar or the navigation, which scroll on their own.
    await page.mouse.move(900, 300);
    await page.mouse.wheel(0, 4000);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
    const bar = await boxInView(page, ".top-bar");
    expect(bar.y).toBe(0);
  });
}

test("the settings navigation stays in view while the section scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 520 });
  await signInOwner(page);
  await page.goto("/settings/appearance");
  const nav = page.getByRole("navigation", { name: t("settings.navLabel") });
  await expect(nav).toBeVisible();
  // Over the section, not the sidebar or the navigation, which scroll on their own.
  await page.mouse.move(900, 300);
  await page.mouse.wheel(0, 4000);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
  const bar = await boxInView(page, ".top-bar");
  const after = await boxInView(page, ".settings-nav");
  // Right below the bar, filling the height under it.
  expect(after.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  expect(after.y).toBeLessThan(bar.y + bar.height + 40);
});

test("a pin's menu opens beside it, whole and usable", async ({ page, world }) => {
  const owner = await Api.owner();
  await owner.context.put(`/api/orgs/${owner.orgId}/dashboards/${world.dashboardId}/pin`);
  await owner.dispose();
  await signInOwner(page);
  const more = page.getByRole("button", {
    name: t("shell.pins.actionsNamed", { name: world.dashboardTitle }),
  });
  await more.click();
  const menu = page.getByRole("menu", {
    name: t("shell.pins.actionsNamed", { name: world.dashboardTitle }),
  });
  await expect(menu).toBeVisible();
  const box = await boxInView(page, '[role="menu"]');
  // A real menu, not a sliver: wide enough for its items, and not over the sidebar's buttons.
  expect(box.width).toBeGreaterThan(120);
  const trigger = await more.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual((trigger?.x ?? 0) + (trigger?.width ?? 0));
  await menu.getByRole("menuitem", { name: t("shell.pins.unpin") }).click();
  await expect(menu).toBeHidden();
  await expect(more).toBeHidden();
});
