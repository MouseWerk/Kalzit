import { join } from "node:path";
import { Api, fixturesDir, regionDashboard, SQL, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";
import { fillQuery } from "./support/ui";

test("a time range chosen on a dashboard lands in the address and survives a reload", async ({
  page,
  world,
}) => {
  await signInOwner(page);
  await page.goto(`/dashboards/${world.dashboardId}`);
  await expect(page.getByRole("group", { name: "Sales" })).toBeVisible();
  await page
    .getByRole("button", {
      name: t("dashboards.time.buttonLabel", { range: t("dashboards.time.last6h") }),
    })
    .click();
  await page.getByRole("button", { name: t("dashboards.time.last24h") }).click();
  await expect(page).toHaveURL(/from=now-24h/);
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: t("dashboards.time.buttonLabel", { range: t("dashboards.time.last24h") }),
    }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "Sales" })).toBeVisible();
});

test("Explore adds a panel to an existing dashboard", async ({ page, world }) => {
  // A dashboard of its own: the shared one stays as the page checks expect it.
  const owner = await Api.owner();
  const title = unique("Bestehend");
  await owner.createDashboard(regionDashboard(title, world.sourceId));
  await owner.dispose();
  await signInOwner(page);
  await page.goto("/explore");
  await page.getByLabel(t("explore.datasource")).selectOption({ label: world.sourceName });
  await fillQuery(page, SQL.series);
  await page.getByRole("button", { name: t("explore.run") }).click();
  const result = page.getByRole("region", { name: t("explore.result") });
  await expect(result.locator(".ts__plot")).toBeVisible();
  await result.getByRole("button", { name: t("explore.addToDashboard") }).click();
  const add = page.getByRole("dialog", { name: t("explore.add.title") });
  await add.getByLabel(t("explore.add.existing")).check();
  await add.getByLabel(t("explore.add.dashboard"), { exact: true }).selectOption({ label: title });
  await add.getByRole("button", { name: t("explore.add.submit") }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator(".ts__plot")).toHaveCount(2);
});

test("a data source is renamed, moved to the trash and restored", async ({ page }) => {
  const owner = await Api.owner();
  const name = unique("Papierkorb");
  const id = await owner.createSqliteSource(name, join(fixturesDir(), "sales.db"));
  // Created last, so it is on the first page of the list: proof that the list has loaded.
  const stays = unique("Bleibt");
  await owner.createSqliteSource(stays, join(fixturesDir(), "sales.db"));
  await owner.dispose();
  await signInOwner(page);
  await page.goto(`/data-sources/${id}`);
  const renamed = `${name} neu`;
  await page.getByLabel(t("datasources.form.name")).fill(renamed);
  await page.getByRole("button", { name: t("datasources.form.save"), exact: true }).click();
  await expect(page.getByText(t("datasources.form.saved"))).toBeVisible();

  await page.getByRole("button", { name: t("datasources.delete") }).click();
  const confirm = page.getByRole("dialog", { name: t("datasources.delete.title") });
  await confirm.getByRole("button", { name: t("datasources.delete.confirm") }).click();
  await expect(page).toHaveURL(/\/data-sources/);
  await expect(page.getByText(t("datasources.deleted"))).toBeVisible();
  // The list has loaded, and the deleted source is not in it.
  const rows = page.getByRole("row");
  await expect(rows.filter({ hasText: stays })).toBeVisible();
  await expect(rows.filter({ hasText: renamed })).toHaveCount(0);

  await page.getByRole("link", { name: t("datasources.trash.link") }).click();
  await page
    .getByRole("button", { name: t("datasources.restoreNamed", { name: renamed }) })
    .click();
  await page.getByRole("link", { name: t("datasources.trash.back") }).click();
  await expect(rows.filter({ hasText: stays })).toBeVisible();
  await expect(rows.filter({ hasText: renamed })).toHaveCount(1);
});

test("Escape closes a dialog and focus returns to the button that opened it", async ({ page }) => {
  await signInOwner(page);
  await page.goto("/admin/teams");
  const opener = page.getByRole("button", { name: t("admin.teams.create") });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: t("admin.teams.createTitle") });
  await expect(dialog.getByLabel(t("admin.teams.name"))).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("after signing out, going back does not show the signed-in pages", async ({ page }) => {
  await signInOwner(page);
  await page.goto("/admin/members");
  await expect(page.getByRole("heading", { name: t("admin.members.title") })).toBeVisible();
  await page.getByRole("button", { name: t("userMenu.label") }).click();
  await page.getByRole("menuitem", { name: t("userMenu.signOut") }).click();
  await expect(page.getByRole("heading", { name: t("login.title") })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: t("login.signedOut") })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: t("login.title") })).toBeVisible();
  await expect(page.getByRole("heading", { name: t("admin.members.title") })).toHaveCount(0);
});

test("an editor creates a dashboard and adds a panel with a query", async ({ pageAs }) => {
  const owner = await Api.owner();
  const editor = await owner.createMember(unique("Edda Editor"), "editor");
  const name = unique("Editorquelle");
  await owner.createSqliteSource(name, join(fixturesDir(), "sales.db"));
  await owner.dispose();

  const page = await pageAs(editor.email, editor.password);
  await page.goto("/dashboards");
  await page.getByRole("button", { name: t("dashboards.new") }).click();
  const create = page.getByRole("dialog", { name: t("dashboards.new.title") });
  const title = unique("Neu");
  await create.getByLabel(t("dashboards.new.titleLabel")).fill(title);
  await create.getByRole("button", { name: t("dashboards.new.create") }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  await page
    .getByRole("button", { name: t("dashboards.addPanel") })
    .first()
    .click();
  const editorDialog = page.getByRole("dialog", { name: t("dashboards.editor.title") });
  await editorDialog.getByLabel(t("dashboards.editor.panelTitle")).fill("Umsatz");
  await editorDialog.getByRole("button", { name: t("dashboards.editor.addQuery") }).click();
  await editorDialog.getByLabel(t("dashboards.editor.datasource")).selectOption({ label: name });
  await fillQuery(editorDialog, SQL.series);
  await editorDialog.getByRole("button", { name: t("dashboards.editor.run") }).click();
  await expect(editorDialog.locator(".ts__plot")).toBeVisible();
  await editorDialog.getByRole("button", { name: t("dashboards.editor.apply") }).click();
  await page.getByRole("button", { name: t("dashboards.save") }).click();
  const save = page.getByRole("dialog", { name: t("dashboards.save.title") });
  await save.getByRole("button", { name: t("dashboards.save.submit") }).click();
  await expect(save).toBeHidden();
  await page.reload();
  await expect(page.getByRole("group", { name: "Umsatz" })).toBeVisible();
});
