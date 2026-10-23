import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { Api, baseUrl } from "../support/api";
import { t } from "../support/i18n";
import { fillQuery, panelAction, startEditing, toolbarAction } from "../support/ui";
import { DEMO_OWNER, type Demo, SCREENSHOT_NOW, seedDemo } from "./demo";

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "screenshots",
);

let demo: Demo;

// One seeded server for all pictures: a failure stops the run instead of seeding again.
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  demo = await seedDemo(process.env.KALZIT_E2E_SETUP_TOKEN ?? "");
});

test.afterAll(async () => {
  await demo.owner.dispose();
});

/** A page whose clock stands at the screenshot moment, so relative times and ranges repeat. */
async function openPage(
  browser: Browser,
  colorScheme: "light" | "dark" = "light",
  viewport = { width: 1440, height: 900 },
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: baseUrl(),
    viewport,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    colorScheme,
  });
  const page = await context.newPage();
  // Date.now stands still at that moment; timers keep running, so the app works as usual.
  await page.clock.setFixedTime(SCREENSHOT_NOW);
  // The server stamps sessions, memberships and saves with the real time of the run; the
  // pictures show them at the screenshot moment instead.
  for (const pattern of [
    /\/api\/me\/sessions(\?|$)/,
    /\/api\/orgs\/[^/]+\/(members|dashboards|audit)(\?|$)/,
  ]) {
    await context.route(pattern, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: atScreenshotTime(body, Date.now()) });
    });
  }
  return page;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Moves every timestamp in an API answer (Unix ms, as the API writes times) to the screenshot
 * moment, keeping whole days apart: "signed in now, expires in 30 days" stays so.
 */
function atScreenshotTime(value: unknown, realNow: number): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => atScreenshotTime(item, realNow));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, atScreenshotTime(item, realNow)]),
    );
  }
  const isTimestamp =
    typeof value === "number" &&
    Number.isInteger(value) &&
    Math.abs(value - realNow) < 400 * DAY_MS;
  return isTimestamp ? SCREENSHOT_NOW + Math.round((value - realNow) / DAY_MS) * DAY_MS : value;
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(t("login.email")).fill(DEMO_OWNER.email);
  await page.getByLabel(t("login.password"), { exact: true }).fill(DEMO_OWNER.password);
  await page.getByRole("button", { name: t("login.submit") }).click();
  await expect(page.getByRole("navigation", { name: t("nav.label") })).toBeVisible();
}

async function shoot(page: Page, name: string): Promise<void> {
  // Let requests, fonts and charts settle; no spinner or focus ring in the picture.
  const nav = page.getByRole("navigation", { name: t("nav.label") });
  if ((await nav.count()) > 0) {
    // Explore appears once the data source list has loaded; the owner sees all five entries.
    await expect(nav.getByRole("link", { name: t("explore.nav") })).toBeVisible();
  }
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: join(OUT, `${name}.png`),
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
}

async function dashboardReady(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: demo.dashboardTitle })).toBeVisible();
  await expect(page.getByRole("group", { name: "Sales in the selected region" })).toBeVisible();
  await expect(page.locator(".stat")).toBeVisible();
  // uPlot, not the SVG chart shown while it loads.
  await expect(page.locator(".uplot")).toHaveCount(1);
  await expect(page.getByRole("table").first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

test("sign-in", async ({ browser }) => {
  const page = await openPage(browser);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: t("login.title") })).toBeVisible();
  await shoot(page, "sign-in");
  await page.context().close();
});

test("start page", async ({ browser }) => {
  const page = await openPage(browser);
  await signIn(page);
  // The demo dashboard starred and opened once, so both card rows show it.
  const dashboard = `/api/orgs/${demo.owner.orgId}/dashboards/${demo.dashboardId}`;
  expect((await page.request.put(`${dashboard}/star`)).ok()).toBe(true);
  expect((await page.request.post(`${dashboard}/views`)).ok()).toBe(true);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: t("home.welcome", { name: DEMO_OWNER.name }) }),
  ).toBeVisible();
  await expect(page.locator(".stat-tile__skeleton")).toHaveCount(0);
  await expect(page.locator(".dash-card")).toHaveCount(2);
  await shoot(page, "start");
  await page.context().close();
});

test("dashboards", async ({ browser }) => {
  const page = await openPage(browser);
  await signIn(page);
  await page.goto("/dashboards");
  await expect(page.getByRole("link", { name: demo.dashboardTitle })).toBeVisible();
  await shoot(page, "dashboards");
  await page.context().close();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`dashboard, ${colorScheme}`, async ({ browser }) => {
    const page = await openPage(browser, colorScheme);
    await signIn(page);
    await page.goto(`/dashboards/${demo.dashboardId}`);
    await dashboardReady(page);
    await shoot(page, `dashboard-${colorScheme}`);
    await page.context().close();
  });
}

test("time picker, dark", async ({ browser }) => {
  const page = await openPage(browser, "dark");
  await signIn(page);
  await page.goto(`/dashboards/${demo.dashboardId}`);
  await dashboardReady(page);
  await page
    .getByRole("button", {
      name: t("dashboards.time.buttonLabel", { range: t("dashboards.time.last6h") }),
    })
    .click();
  const picker = page.getByRole("dialog", { name: t("dashboards.time.title") });
  await picker.getByRole("button", { name: t("toolbar.calendar.pickStart") }).click();
  await expect(picker.locator(".calendar")).toBeVisible();
  // The picture shows the picker as it opens, without the focus ring in its search field.
  await shoot(page, "time-picker-dark");
  await page.context().close();
});

test("dashboard, phone", async ({ browser }) => {
  const page = await openPage(browser, "light", { width: 360, height: 780 });
  await signIn(page);
  await page.goto(`/dashboards/${demo.dashboardId}`);
  await dashboardReady(page);
  await shoot(page, "dashboard-phone");
  await page.context().close();
});

/** The full-page panel editor on the demo's time series, its chart drawn. */
async function panelEditor(page: Page): Promise<void> {
  await page.goto(`/dashboards/${demo.dashboardId}`);
  await dashboardReady(page);
  await startEditing(page);
  await panelAction(page, "Sales in the selected region", "dashboards.panel.editNamed");
  const editor = page.getByRole("region", { name: t("dashboards.editor.title") });
  await expect(editor.locator(".cm-content").first()).toBeVisible();
  await expect(editor.locator(".uplot")).toHaveCount(1);
  await expect(editor.locator('[aria-busy="true"]')).toHaveCount(0);
}

test("panel editor, dark", async ({ browser }) => {
  const page = await openPage(browser, "dark");
  await signIn(page);
  await panelEditor(page);
  await shoot(page, "panel-editor-dark");
  await page.context().close();
});

/** A new panel: the visualization picker open, the first query ready. */
async function newPanel(page: Page): Promise<void> {
  await page.goto(`/dashboards/${demo.dashboardId}`);
  await dashboardReady(page);
  await startEditing(page);
  await toolbarAction(page, "toolbar.add", "dashboards.addPanel");
  const editor = page.getByRole("region", { name: t("dashboards.editor.newTitle") });
  await expect(editor.locator(".cm-content").first()).toBeVisible();
  await expect(editor.getByRole("radio").first()).toBeVisible();
}

test("new panel, dark", async ({ browser }) => {
  const page = await openPage(browser, "dark");
  await signIn(page);
  await newPanel(page);
  await shoot(page, "panel-new-dark");
  await page.context().close();
});

test("new panel, phone", async ({ browser }) => {
  const page = await openPage(browser, "light", { width: 360, height: 780 });
  await signIn(page);
  await newPanel(page);
  await shoot(page, "panel-new-phone");
  await page.context().close();
});

test("panel editor, phone", async ({ browser }) => {
  const page = await openPage(browser, "light", { width: 360, height: 780 });
  await signIn(page);
  await panelEditor(page);
  await shoot(page, "panel-editor-phone");
  await page.context().close();
});

test("explore", async ({ browser }) => {
  const page = await openPage(browser);
  await signIn(page);
  await page.goto("/explore");
  await page.getByLabel(t("explore.datasource")).selectOption({ label: demo.sourceName });
  await fillQuery(
    page,
    "SELECT ts AS time, amount FROM sales WHERE region = 'West' AND $__timeFilter(ts) ORDER BY ts",
  );
  // Closes the suggestion list; on the page (not in a dialog) Escape does nothing else.
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-tooltip")).toHaveCount(0);
  await page.getByRole("button", { name: t("explore.run") }).click();
  const result = page.getByRole("region", { name: t("explore.result") });
  await expect(result.locator(".uplot")).toBeVisible();
  await expect(result).toHaveAttribute("aria-busy", "false");
  await shoot(page, "explore");
  await page.context().close();
});

for (const scheme of ["light", "dark"] as const) {
  test(`data source kinds, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await page.goto("/data-sources/new");
    await expect(page.getByRole("link", { name: "PostgreSQL", exact: true })).toBeVisible();
    await shoot(page, `data-source-kinds-${scheme}`);
    await page.context().close();
  });
}

test("data source form", async ({ browser }) => {
  const page = await openPage(browser);
  await signIn(page);
  // The form for a new PostgreSQL source, filled in but not sent: the demo's own SQLite source
  // would show this machine's run folder, and a connection test a time that differs per run.
  await page.goto("/data-sources/new?kind=postgres");
  await page.getByLabel(t("datasources.form.name"), { exact: true }).fill("Shop (PostgreSQL)");
  await page.getByLabel(t("datasources.settings.host")).fill("db.internal");
  await page.getByLabel(t("datasources.settings.database")).fill("shop");
  await page.getByLabel(t("datasources.settings.user")).fill("kalzit_reader");
  await shoot(page, "data-source");
  await page.context().close();
});

test("administration, members", async ({ browser }) => {
  const page = await openPage(browser);
  await signIn(page);
  await page.goto("/admin/members");
  await expect(page.getByLabel(t("admin.members.roleOf", { name: "Paul Richter" }))).toBeVisible();
  await shoot(page, "admin-members");
  await page.context().close();
});

test("account", async ({ browser }) => {
  const page = await openPage(browser);
  await signIn(page);
  // Every picture signed in once; two sessions (this browser and one other) look like real use.
  expect((await page.request.post("/api/me/sessions/revoke-others")).ok()).toBe(true);
  const other = await Api.signIn(DEMO_OWNER.email, DEMO_OWNER.password);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: t("admin.account.title") })).toBeVisible();
  const sessions = page.getByRole("list", { name: t("admin.account.sessions") });
  await expect(sessions).toBeVisible();
  // Scrolled so the sessions list is whole, not cut at the bottom edge.
  await page
    .getByRole("heading", { name: t("admin.account.sessions") })
    .evaluate((heading) => heading.scrollIntoView({ block: "start" }));
  await expect(sessions.getByRole("listitem")).toHaveCount(2);
  await shoot(page, "account");
  await other.dispose();
  await page.context().close();
});
