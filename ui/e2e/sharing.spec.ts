import { join } from "node:path";
import { Api, baseUrl, fixturesDir, regionDashboard, unique } from "./support/api";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { findOverflow } from "./support/overflow";
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
  const address = dialog.getByRole("textbox", { name: t("sharing.org.link"), exact: true });
  await expect(address).toHaveValue(new RegExp(`/dashboards/${dashboardId}\\?from=now-6h`));
  await expect(address).toHaveValue(/var-region=Nord/);

  await dialog.getByRole("tab", { name: t("sharing.tab.public") }).click();
  await expect(dialog.getByText(t("sharing.public.lead"))).toBeVisible();
  await dialog.getByRole("button", { name: t("sharing.public.create") }).click();
  // "Created", with "and copied" where the browser lets the page write to the clipboard.
  await expect(
    dialog.getByRole("status").filter({ hasText: t("sharing.public.created") }),
  ).toBeVisible();
  const url = await dialog
    .getByRole("textbox", { name: t("sharing.public.address"), exact: true })
    .inputValue();
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
  await dialog.getByRole("textbox", { name: t("sharing.snapshot.name"), exact: true }).fill(name);
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

test("on a phone the visitor's page fits, its range menu stays in view, and axe finds nothing", async ({
  browser,
  consoleGuard,
}) => {
  const title = unique("Verkauf am Telefon");
  const dashboardId = await dashboard(title);
  const created = await owner.context.post(
    `/api/orgs/${owner.orgId}/dashboards/${dashboardId}/public-links`,
    // The start range is as long as the window: the widest range a link offers must load.
    {
      data: {
        maxWindowMs: 6 * 3_600_000,
        timeRange: { from: "now-6h", to: "now" },
        variables: { region: "Nord" },
      },
    },
  );
  expect(created.status(), await created.text()).toBe(201);
  const { token } = (await created.json()) as { token: string };

  const visitor = await browser.newContext({
    baseURL: baseUrl(),
    locale: "de-DE",
    viewport: { width: 360, height: 740 },
  });
  const page = await visitor.newPage();
  await page.goto(`/public/dashboards/${token}`);
  await expect(page.getByRole("article", { name: "Sales" }).locator("canvas")).toBeVisible();
  expect((await findOverflow(page)).offenders).toEqual([]);
  expect(await seriousViolations(page)).toEqual([]);

  // The menu spans the page between its gutters instead of running off the left edge.
  await page.getByRole("button", { name: t("dashboards.time.last6h", {}, "de") }).click();
  const menu = page.getByRole("dialog", { name: t("sharing.viewer.range", {}, "de") });
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
  expect(await seriousViolations(page)).toEqual([]);

  // Every other address under /public is the same neutral page, on a phone too.
  consoleGuard.allow(/404/);
  for (const path of ["/public/dashboards/", `/public/dashboards/${token}/more`]) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: t("sharing.viewer.unavailable", {}, "de") }),
    ).toBeVisible();
  }
  expect((await findOverflow(page)).offenders).toEqual([]);
  expect(await seriousViolations(page)).toEqual([]);
  await visitor.close();
});

test("the lists of shares fit their card from 1280 px down to a phone, the row's actions in view", async ({
  page,
}) => {
  const title = unique("Verkauf mit einem langen Namen für die Liste der Freigaben");
  const dashboardId = await dashboard(title);
  const now = Date.now();
  const internal = unique("Stand intern");
  for (const body of [
    { title: unique("Stand für die Filialen im Norden"), public: true },
    { title: internal, public: false },
  ]) {
    const made = await owner.context.post(
      `/api/orgs/${owner.orgId}/dashboards/${dashboardId}/snapshots`,
      { data: { ...body, timeRange: { from: now - 3_600_000, to: now } } },
    );
    expect(made.status(), await made.text()).toBe(201);
  }
  await signInOwner(page);
  // From a wide window down to a phone: at each width the table fits its card (nothing is
  // reached only by scrolling sideways) and the row's menu is in view. Where the card is too
  // narrow for every column, their values fold into the name's lines.
  for (const width of [1280, 1024, 800, 600, 420, 360]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ["/admin/shares", "/settings/my-shares"]) {
      await page.goto(path);
      const table = page.getByRole("table");
      await expect(table).toBeVisible();
      const card = page.locator(".share-table-card");
      expect(
        await card.evaluate((element) => element.scrollWidth - element.clientWidth),
        `${path} at ${width} px`,
      ).toBe(0);
      const row = table.getByRole("row", { name: new RegExp(internal) });
      const menu = row.getByRole("button", { name: /^Actions for/ });
      const box = await menu.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0), `${path} at ${width} px`).toBeLessThanOrEqual(
        width,
      );
      // The kind is always readable: in its column, or folded under the name.
      await expect(
        row.getByText(t("sharing.kind.snapshotOrg")).filter({ visible: true }),
      ).toHaveCount(1);
      if (width === 1280 || width === 1024) {
        await menu.click();
        await expect(
          page.getByRole("menuitem", { name: t("sharing.revoke.confirm") }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
      }
    }
  }
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
