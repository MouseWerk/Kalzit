import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { baseUrl } from "../support/api";
import { t } from "../support/i18n";
import { fillQuery } from "../support/ui";
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
async function openPage(browser: Browser, colorScheme: "light" | "dark" = "light"): Promise<Page> {
  const context = await browser.newContext({
    baseURL: baseUrl(),
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    colorScheme,
  });
  const page = await context.newPage();
  // Date.now stands still at that moment; timers keep running, so the app works as usual.
  await page.clock.setFixedTime(SCREENSHOT_NOW);
  return page;
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
  await expect(
    page.getByRole("heading", { name: t("home.welcome", { name: DEMO_OWNER.name }) }),
  ).toBeVisible();
  await shoot(page, "start");
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
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: t("admin.account.title") })).toBeVisible();
  await expect(page.getByRole("list", { name: t("admin.account.sessions") })).toBeVisible();
  await shoot(page, "account");
  await page.context().close();
});
