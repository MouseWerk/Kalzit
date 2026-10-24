import { expect, type Locator, type Page } from "@playwright/test";
import { type Language, t } from "./i18n";

/**
 * Replaces the text of the query editor inside `scope`. Waits for CodeMirror (it loads after
 * the page) and enters the text in one go, like a paste. No Escape afterwards: inside a dialog
 * it would close the dialog when no suggestion list is open.
 */
export async function fillQuery(scope: Page | Locator, text: string): Promise<void> {
  const editor = scope.locator(".cm-content").first();
  await expect(editor).toBeVisible();
  await editor.click();
  const page = "page" in scope ? scope.page() : scope;
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
  await expect(editor).toHaveText(text);
}

/**
 * Picks an action from a panel's menu: `action` is the i18n key of the action's accessible name
 * ("dashboards.panel.editNamed"), which names the panel by its title.
 */
export async function panelAction(
  page: Page,
  title: string,
  action: string,
  language: Language = "en",
): Promise<void> {
  await page
    .getByRole("article", { name: title, exact: true })
    .getByRole("button", { name: t("dashboards.panel.menuNamed", { title }, language) })
    .click();
  await page.getByRole("menuitem", { name: t(action, { title }, language) }).click();
}

/**
 * Runs a toolbar action that is a button on wide screens and an entry of the overflow menu on a
 * phone: `key` is the i18n key of both names ("dashboards.edit", "dashboards.settings").
 */
export async function toolbarButton(page: Page, key: string, language: Language = "en") {
  const button = page.getByRole("button", { name: t(key, {}, language), exact: true }).first();
  if (await button.isVisible()) {
    await button.click();
  } else {
    await page.getByRole("button", { name: t("toolbar.more", {}, language), exact: true }).click();
    await page.getByRole("menuitem", { name: t(key, {}, language), exact: true }).click();
  }
}

/** Starts edit mode: the Edit button on wide screens, the overflow menu on a phone. */
export async function startEditing(page: Page, language: Language = "en"): Promise<void> {
  await toolbarButton(page, "dashboards.edit", language);
  await expect(
    page.getByRole("button", { name: t("dashboards.save", {}, language) }),
  ).toBeVisible();
}

/**
 * Adds a panel while editing: the rail's Add pane on wide screens (any visualization), the
 * overflow menu on a phone, where there is no rail.
 */
export async function addPanel(page: Page, language: Language = "en"): Promise<void> {
  const rail = page.getByRole("complementary", { name: t("toolbar.rail", {}, language) });
  if (await rail.isVisible()) {
    await rail.getByRole("button", { name: t("toolbar.add", {}, language), exact: true }).click();
    await page
      .getByRole("region", { name: t("toolbar.add", {}, language) })
      .getByRole("button", { name: t("toolbar.add.all", {}, language), exact: true })
      .click();
  } else {
    await page.getByRole("button", { name: t("toolbar.more", {}, language), exact: true }).click();
    await page.getByRole("menuitem", { name: t("dashboards.addPanel", {}, language) }).click();
  }
}
