import type { Page } from "@playwright/test";
import { Api, regionDashboard, unique } from "./support/api";
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
  ["usage.title", "/admin/usage"],
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
async function boxInView(page: Page, selector: string) {
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

/** Scrolls the window, the page's scroll container, and waits until it got there. */
async function scrollPage(page: Page, y: number) {
  // Repeated until it sticks: content still loading may make the page shorter at first.
  await expect
    .poll(() =>
      page.evaluate((top) => {
        window.scrollTo(0, top);
        return window.scrollY;
      }, y),
    )
    .toBeGreaterThan(200);
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
    await scrollPage(page, 4000);
    const bar = await boxInView(page, ".top-bar");
    expect(bar.y).toBe(0);
  });
}

test("the settings navigation stays in view while the section scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 520 });
  await signInOwner(page);
  await page.goto("/settings/appearance");
  await expect(page.getByRole("navigation", { name: t("settings.navLabel") })).toBeVisible();
  await expect(page.locator(".settings-row").first()).toBeVisible();
  await scrollPage(page, 4000);
  const bar = await boxInView(page, ".top-bar");
  const nav = await boxInView(page, ".settings-nav");
  // Right below the bar, filling the height under it.
  expect(nav.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  expect(nav.y).toBeLessThan(bar.y + bar.height + 40);
});

test("a dashboard's toolbar and rail stick right below the top bar", async ({ page, world }) => {
  const owner = await Api.owner();
  const model = regionDashboard(unique("Lang"), world.sourceId);
  const [first] = model.panels as Record<string, unknown>[];
  model.panels = [0, 1, 2, 3, 4, 5].map((i) => ({
    ...first,
    id: `p${i + 1}`,
    title: `Sales ${i + 1}`,
    grid: { x: 0, y: i * 8, w: 12, h: 8 },
  }));
  const id = await owner.createDashboard(model);
  await owner.dispose();
  await page.setViewportSize({ width: 1440, height: 600 });
  await signInOwner(page);
  await page.goto(`/dashboards/${id}`);
  await expect(page.getByRole("group", { name: "Sales 1" })).toBeVisible();
  await scrollPage(page, 600);
  const bar = await boxInView(page, ".top-bar");
  const toolbar = await boxInView(page, ".dash-toolbar");
  expect(Math.round(toolbar.y)).toBe(Math.round(bar.y + bar.height));
  const rail = await boxInView(page, ".dash-rail__column");
  expect(rail.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
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

test("signing out from a page that polls sends nothing with the ended session", async ({
  page,
}) => {
  await signInOwner(page);
  // The instances page asks the server again every few seconds.
  await page.goto("/admin/server/instances");
  await expect(page.getByRole("heading", { name: t("admin.instances.title") })).toBeVisible();
  const refused: string[] = [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() === 401 && path !== "/api/me") {
      refused.push(`${response.request().method()} ${path}`);
    }
  });
  await page.getByRole("button", { name: t("userMenu.label") }).click();
  await page.getByRole("menuitem", { name: t("userMenu.signOut"), exact: true }).click();
  // The shell changes while the sign-in page loads: nothing of it asks the server again.
  await page.keyboard.press("ControlOrMeta+B");
  await expect(page.getByRole("heading", { name: t("access.login.title") })).toBeVisible();
  // Long enough for a poll or a refetch that was still on its way to arrive.
  await page.waitForTimeout(1000);
  expect(refused).toEqual([]);
});

test("a click into the plugin drop zone draws no focus ring, the keyboard does", async ({
  page,
}) => {
  await signInOwner(page);
  await page.goto("/settings/plugins");
  await page.getByRole("button", { name: t("plugins.install.open") }).click();
  const dialog = page.getByRole("dialog", { name: t("plugins.install.title") });
  const drop = dialog.locator(".plugin-drop");
  const input = dialog.getByLabel(t("plugins.install.drop"));
  const outline = () => drop.evaluate((element) => getComputedStyle(element).outlineStyle);
  const chooser = page.waitForEvent("filechooser");
  await drop.click();
  await chooser;
  await expect(input).toBeFocused();
  expect(await outline()).toBe("none");
  // Away and back with the keyboard: now the ring shows.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(input).toBeFocused();
  expect(await outline()).not.toBe("none");
});

test("the appearance preview sits beside the rows by the room of the section, not the window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await signInOwner(page);
  await page.goto("/settings/appearance");
  const card = page.locator(".settings-appearance > .settings-card");
  const preview = page.locator(".settings-preview");
  await expect(preview).toBeVisible();
  const shell = page.locator(".shell");
  const beside = async () => {
    const [a, b] = [await card.boundingBox(), await preview.boundingBox()];
    return a !== null && b !== null && b.x >= a.x + a.width;
  };
  const below = async () => {
    const [a, b] = [await card.boundingBox(), await preview.boundingBox()];
    return a !== null && b !== null && b.y >= a.y + a.height;
  };
  // With the rail, a 1200 px window leaves the section room for both side by side.
  await page.keyboard.press("ControlOrMeta+B");
  await expect(shell).toHaveAttribute("data-sidebar", "collapsed");
  await expect.poll(beside).toBe(true);
  // The full sidebar takes that room: the preview goes below the rows, the window unchanged.
  await page.keyboard.press("ControlOrMeta+B");
  await expect(shell).toHaveAttribute("data-sidebar", "expanded");
  await expect.poll(below).toBe(true);
});
