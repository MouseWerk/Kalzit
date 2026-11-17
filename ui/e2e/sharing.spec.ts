import { join } from "node:path";
import { Api, baseUrl, fixturesDir, regionDashboard, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

/**
 * Sharing (board docs/design/blueprint/Sharing.dc.html): an admin makes a public link and a
 * snapshot from the Share dialog, a visitor without an account opens the link and sees one
 * neutral message once it is revoked, and the lists under Verwaltung and the account show both.
 */

let owner: Api;

// The server's switch for public sharing is one value for all of these.
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  owner = await Api.owner();
  const settings = (await (await owner.context.get("/api/admin/settings")).json()) as {
    items: { key: string; version: number }[];
  };
  const version =
    settings.items.find((item) => item.key === "sharing.public_enabled")?.version ?? 0;
  const answer = await owner.context.patch("/api/admin/settings/sharing.public_enabled", {
    data: { value: true, version },
  });
  expect(answer.status()).toBe(200);
});

test.afterAll(async () => {
  await owner.dispose();
});

async function dashboard(title: string): Promise<string> {
  const source = await owner.createSqliteSource(unique("Verkauf"), join(fixturesDir(), "sales.db"));
  return owner.createDashboard(regionDashboard(title, source));
}

test("an admin shares a dashboard in public, a visitor opens it, and revoking ends it", async ({
  page,
  browser,
  consoleGuard,
}) => {
  const title = unique("Verkauf öffentlich");
  const dashboardId = await dashboard(title);
  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`);
  await expect(page.getByRole("group", { name: "Sales" })).toBeVisible();

  await page.getByRole("button", { name: t("toolbar.shareButton"), exact: true }).click();
  const dialog = page.getByRole("dialog", { name: t("sharing.dialog.title", { name: title }) });
  // The first tab is the address for people in the organization, with range and variable.
  const address = dialog.getByLabel(t("sharing.org.link"));
  await expect(address).toHaveValue(new RegExp(`/dashboards/${dashboardId}\\?from=now-6h`));
  await expect(address).toHaveValue(/var-region=Nord/);

  await dialog.getByRole("tab", { name: t("sharing.tab.public") }).click();
  await expect(dialog.getByText(t("sharing.public.lead"))).toBeVisible();
  await dialog.getByRole("button", { name: t("sharing.public.create") }).click();
  await expect(dialog.getByText(t("sharing.public.createdCopied")).first()).toBeVisible();
  const url = await dialog.getByLabel(t("sharing.tab.public"), { exact: true }).inputValue();
  expect(url).toMatch(/\/public\/dashboards\/[A-Za-z0-9_-]{43}$/);

  // A visitor: no session, no navigation, the panel drawn from the stored query.
  const visitor = await browser.newContext({ baseURL: baseUrl(), locale: "en-US" });
  const publicPage = await visitor.newPage();
  await publicPage.goto(url);
  await expect(publicPage.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(publicPage.getByRole("article", { name: "Sales" })).toBeVisible();
  await expect(publicPage.getByRole("article", { name: "Sales" }).locator("canvas")).toBeVisible();
  await expect(publicPage.getByRole("navigation")).toHaveCount(0);
  const fixed = publicPage.getByRole("list", { name: t("sharing.viewer.fixedValues") });
  await expect(fixed).toContainText("Region");
  await expect(fixed).toContainText("Nord");
  // The range is a choice inside the window: 30 days lie outside the default 7.
  await publicPage.getByRole("button", { name: t("dashboards.time.last6h") }).click();
  const menu = publicPage.getByRole("dialog", { name: t("sharing.viewer.range") });
  await expect(
    menu.getByRole("button", { name: new RegExp(t("dashboards.time.last30d")) }),
  ).toHaveAttribute("aria-disabled", "true");
  await menu.getByRole("button", { name: new RegExp(t("dashboards.time.last24h")) }).click();
  await expect(
    publicPage.getByRole("button", { name: t("dashboards.time.last24h") }),
  ).toBeVisible();

  // Revoking is final and asks first, with the focus on Cancel.
  await dialog
    .getByRole("button", { name: t("sharing.revoke.confirm") })
    .first()
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: t("sharing.revoke.title", { name: title }),
  });
  await expect(confirm.getByRole("button", { name: t("dashboards.dialog.cancel") })).toBeFocused();
  await confirm.getByRole("button", { name: t("sharing.revoke.confirm") }).click();
  await expect(confirm).toHaveCount(0);

  // The visitor learns nothing but that the link does not work; the browser logs the 404.
  consoleGuard.allow(/404/);
  await publicPage.reload();
  await expect(
    publicPage.getByRole("heading", { name: t("sharing.viewer.unavailable") }),
  ).toBeVisible();
  await visitor.close();
});

test("a snapshot freezes the panels and is listed for the admin and its creator", async ({
  page,
}) => {
  const title = unique("Verkauf Snapshot");
  const dashboardId = await dashboard(title);
  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`);
  await expect(page.getByRole("group", { name: "Sales" })).toBeVisible();

  await page.getByRole("button", { name: t("toolbar.shareButton"), exact: true }).click();
  const dialog = page.getByRole("dialog", { name: t("sharing.dialog.title", { name: title }) });
  await dialog.getByRole("tab", { name: t("sharing.tab.snapshot") }).click();
  const name = unique("Stand heute");
  await dialog.getByLabel(t("sharing.snapshot.name")).fill(name);
  await dialog.getByRole("button", { name: t("sharing.snapshot.create") }).click();
  await dialog.getByRole("link", { name: t("sharing.snapshot.open") }).click();

  // In the app, with the note that says it is frozen, and the panel drawn from stored results.
  await expect(page).toHaveURL(new RegExp(`/dashboards/${dashboardId}/snapshots/`));
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(page.getByRole("article", { name: "Sales" }).locator("canvas")).toBeVisible();
  await expect(
    page.getByRole("link", { name: t("sharing.snapshot.toLive") }).first(),
  ).toBeVisible();

  await page.goto("/admin/shares");
  await expect(page.getByRole("heading", { name: t("admin.shares.title") })).toBeVisible();
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toContainText(t("sharing.kind.snapshotOrg"));
  await expect(row).toContainText(t("sharing.status.active"));

  await page.goto("/settings/my-shares");
  await expect(page.getByRole("row", { name: new RegExp(name) })).toBeVisible();
});

test("an editor sees why public sharing is not open to them", async ({ pageAs }) => {
  const title = unique("Verkauf Bearbeiter");
  const dashboardId = await dashboard(title);
  const editor = await owner.createMember(unique("Edda Editor"), "editor");
  const page = await pageAs(editor.email, editor.password);
  await page.goto(`/dashboards/${dashboardId}`);
  await page.getByRole("button", { name: t("toolbar.shareButton"), exact: true }).click();
  const dialog = page.getByRole("dialog", { name: t("sharing.dialog.title", { name: title }) });
  await dialog.getByRole("tab", { name: t("sharing.tab.public") }).click();
  await expect(dialog.getByText(t("sharing.block.permission"))).toBeVisible();
  await expect(dialog.getByRole("button", { name: t("sharing.public.create") })).toBeDisabled();
});
