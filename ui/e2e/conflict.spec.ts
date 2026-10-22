import type { Page } from "@playwright/test";
import { Api, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

async function retitle(page: Page, title: string): Promise<void> {
  // The toolbar's button; an empty dashboard offers a second one in its empty state.
  await page
    .getByRole("button", { name: t("dashboards.edit") })
    .first()
    .click();
  await page.getByRole("button", { name: t("dashboards.settings") }).click();
  const settings = page.getByRole("dialog", { name: t("dashboards.settings.title") });
  await settings.getByLabel(t("dashboards.settings.dashboardTitle")).fill(title);
  await settings.getByRole("button", { name: t("dashboards.editor.apply") }).click();
  await expect(settings).toBeHidden();
}

async function save(page: Page): Promise<void> {
  await page.getByRole("button", { name: t("dashboards.save") }).click();
  const dialog = page.getByRole("dialog", { name: t("dashboards.save.title") });
  await dialog.getByRole("button", { name: t("dashboards.save.submit") }).click();
}

test("two pages save the same dashboard: the second sees the conflict dialog", async ({
  page,
  context,
  consoleGuard,
}) => {
  // The second save is refused with 409, which the browser logs.
  consoleGuard.allow(/status of 409 .*\/dashboards\/[0-9a-f-]+$/);
  const owner = await Api.owner();
  const original = unique("Konflikt");
  const id = await owner.createDashboard({
    schemaVersion: 1,
    title: original,
    variables: [],
    panels: [],
  });
  await owner.dispose();

  await signInOwner(page);
  const other = await context.newPage();
  for (const p of [page, other]) {
    await p.goto(`/dashboards/${id}`);
    await expect(p.getByRole("heading", { name: original })).toBeVisible();
  }

  await retitle(page, `${original} A`);
  await retitle(other, `${original} B`);

  await save(page);
  await expect(page.getByRole("heading", { name: `${original} A` })).toBeVisible();
  await expect(page.getByRole("button", { name: t("dashboards.edit") }).first()).toBeVisible();

  await save(other);
  const conflict = other.getByRole("dialog", { name: t("dashboards.conflict.title") });
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText(t("dashboards.conflict.text", { version: 2 }));
  await expect(conflict).toContainText(
    t("dashboards.diff.title", { from: original, to: `${original} B` }),
  );

  // Taking theirs shows the version the first page saved.
  await conflict.getByRole("button", { name: t("dashboards.conflict.takeTheirs") }).click();
  await expect(conflict).toBeHidden();
  await expect(other.getByRole("heading", { name: `${original} A` })).toBeVisible();
});
