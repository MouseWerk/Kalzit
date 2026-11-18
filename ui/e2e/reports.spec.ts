import { join } from "node:path";
import { Api, fixturesDir, OWNER, regionDashboard, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

/**
 * Reports (board docs/design/blueprint/Reports.dc.html): an owner starts a report from a
 * dashboard, looks at the preview the server draws, saves it and finds it in the list; pausing
 * and deleting from the row menu; a viewer has neither the entry nor the list. The test server
 * has no mail server, so nothing is sent: the pages say so and "send now" is not offered.
 */

let owner: Api;

test.beforeAll(async () => {
  owner = await Api.owner();
});

test.afterAll(async () => {
  await owner.dispose();
});

async function salesDashboard(title: string): Promise<string> {
  const sourceId = await owner.createSqliteSource(
    unique("Berichte Verkauf"),
    join(fixturesDir(), "sales.db"),
  );
  return owner.createDashboard(regionDashboard(title, sourceId));
}

/** A report on the dashboard that goes to this member, through the API. */
async function createReport(name: string, dashboardId: string, userId: string): Promise<string> {
  const answer = await owner.context.post(`/api/orgs/${owner.orgId}/reports`, {
    data: {
      name,
      dashboardId,
      schedule: { kind: "daily", time: "06:30" },
      timeZone: "Europe/Berlin",
      formats: ["pdf"],
      language: "en",
      recipients: [{ userId }],
    },
  });
  expect(answer.status()).toBe(201);
  return ((await answer.json()) as { id: string }).id;
}

test("an owner starts a report from a dashboard, previews it and saves it", async ({ page }) => {
  const title = unique("Verkauf Überblick");
  const dashboardId = await salesDashboard(title);
  const recipient = await owner.createMember(unique("Rita Recipient"), "viewer");
  await signInOwner(page);

  // From the dashboard's menu; the range chosen there comes along.
  await page.goto(`/dashboards/${dashboardId}`);
  await expect(page.getByRole("group", { name: "Sales" })).toBeVisible();
  await page.getByRole("button", { name: t("toolbar.more"), exact: true }).click();
  await page.getByRole("menuitem", { name: t("reports.fromDashboard") }).click();
  await expect(page).toHaveURL(/\/reports\/new\?/);
  await expect(page.getByRole("heading", { level: 1, name: t("reports.new") })).toBeVisible();
  await expect(page.getByLabel(t("reports.dashboard"), { exact: true })).toContainText(title);

  const name = unique("Wochenbericht Vertrieb");
  await page.getByLabel(t("reports.name"), { exact: true }).fill(name);
  await page.getByRole("radio", { name: t("reports.schedule.daily") }).click();
  await expect(page.getByText(/^Next runs: /)).toBeVisible();
  const add = page.getByLabel(t("reports.recipients.add"), { exact: true });
  await add.fill(recipient.name);
  await add.press("Enter");
  await expect(
    page.getByRole("button", { name: t("reports.recipients.remove", { name: recipient.name }) }),
  ).toBeVisible();

  // The preview: the server draws the PDF with the same renderer as a run and sends nothing.
  await page.getByRole("button", { name: t("reports.preview"), exact: true }).click();
  const preview = page.getByRole("dialog", { name: t("reports.preview.title", { name }) });
  await expect(preview.getByText(/\.pdf$/)).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByText(t("reports.preview.note"))).toBeVisible();
  const download = page.waitForEvent("download");
  await preview.getByRole("button", { name: t("reports.preview.download") }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  // In a tab of its own the file is a PDF document of this page's origin.
  const opened = page.waitForEvent("popup");
  await preview.getByRole("link", { name: t("reports.preview.open") }).click();
  const tab = await opened;
  await tab.waitForLoadState();
  expect(tab.url()).toMatch(/^blob:http/);
  expect(await tab.evaluate(() => document.contentType)).toBe("application/pdf");
  await tab.close();
  await preview.getByRole("button", { name: t("admin.common.close") }).click();

  await page.getByRole("button", { name: t("admin.common.save"), exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/[^/?]+$/);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByText(t("reports.rights.owner", { name: OWNER.name }))).toBeVisible();

  // Without a mail server nothing can be sent, and the page says so.
  await expect(page.getByRole("heading", { name: t("reports.noMail.title") })).toBeVisible();
  await expect(page.getByRole("button", { name: t("reports.menu.send") })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.getByRole("link", { name: t("reports.tab.runs"), exact: true }).click();
  await expect(page.getByText(/^No run yet/)).toBeVisible();

  // The list, reached through the entry in the navigation.
  const nav = page.getByRole("navigation", { name: t("nav.label") });
  await nav.getByRole("link", { name: t("reports.title"), exact: true }).click();
  await expect(page).toHaveURL(/\/reports$/);
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name }) });
  await expect(row).toContainText(t("reports.content.all", { dashboard: title }));
  await expect(row).toContainText(t("reports.schedule.dailyAt", { time: "07:00" }));

  // The dashboard knows its reports.
  await page.goto(`/dashboards/${dashboardId}`);
  await page.getByRole("button", { name: t("toolbar.more"), exact: true }).click();
  await page.getByRole("menuitem", { name: t("reports.ofDashboard", { count: 1 }) }).click();
  await expect(page).toHaveURL(/\/reports\?dashboard=/);
  await expect(page.getByRole("link", { name })).toBeVisible();
});

test("pausing and deleting from the row menu", async ({ page }) => {
  const dashboardId = await salesDashboard(unique("Lagerbestand"));
  const recipient = await owner.createMember(unique("Paul Pause"), "viewer");
  const name = unique("Lager täglich");
  await createReport(name, dashboardId, recipient.id);
  await signInOwner(page);
  await page.goto("/reports");

  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name }) });
  const menu = page.getByRole("button", { name: t("reports.menu.label", { name }) });
  await menu.click();
  await page.getByRole("menuitem", { name: t("reports.menu.pause") }).click();
  await expect(row.getByText(t("reports.state.paused"))).toBeVisible();
  await menu.click();
  await page.getByRole("menuitem", { name: t("reports.menu.resume") }).click();
  await expect(row.getByText(t("reports.state.paused"))).toHaveCount(0);

  await menu.click();
  await page.getByRole("menuitem", { name: t("admin.common.delete") }).click();
  const dialog = page.getByRole("dialog", { name: t("reports.delete.title", { name }) });
  await dialog.getByRole("button", { name: t("admin.common.delete") }).click();
  await expect(page.getByRole("link", { name })).toHaveCount(0);
});

test("a viewer has no entry and no list", async ({ pageAs }) => {
  const viewer = await owner.createMember(unique("Vera Viewer"), "viewer");
  const page = await pageAs(viewer.email, viewer.password);
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: t("reports.forbidden.title") })).toBeVisible();
  const nav = page.getByRole("navigation", { name: t("nav.label") });
  await expect(nav.getByRole("link", { name: t("reports.title"), exact: true })).toHaveCount(0);
});
