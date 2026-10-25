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
