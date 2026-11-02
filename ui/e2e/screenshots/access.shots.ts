import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { baseUrl } from "../support/api";
import { t } from "../support/i18n";
import { SCREENSHOT_NOW } from "./demo";

/**
 * The setup pages, taken while the server is still fresh: this file runs before readme.shots.ts
 * (files run in name order with one worker), whose seeding completes setup. Nothing here
 * completes it; checking the code only confirms it.
 */
// KALZIT_SCREENSHOTS_OUT sends the pictures elsewhere (the devkit's capture_screens scenes).
const OUT =
  process.env.KALZIT_SCREENSHOTS_OUT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "screenshots");

test.describe.configure({ mode: "serial" });

async function openPage(browser: Browser, colorScheme: "light" | "dark"): Promise<Page> {
  const context = await browser.newContext({
    baseURL: baseUrl(),
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    colorScheme,
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(SCREENSHOT_NOW);
  return page;
}

async function shoot(page: Page, name: string): Promise<void> {
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

test("setup, the code", async ({ browser }) => {
  const page = await openPage(browser, "light");
  await page.goto("/setup");
  await expect(
    page.getByRole("heading", { level: 1, name: t("access.setup.code.title") }),
  ).toBeVisible();
  await shoot(page, "setup");
  await page.context().close();
});

test("setup, the account", async ({ browser }) => {
  const page = await openPage(browser, "dark");
  await page.goto("/setup");
  await page
    .getByLabel(t("access.setup.code.label"))
    .fill(process.env.KALZIT_E2E_SETUP_TOKEN ?? "");
  await page.getByRole("button", { name: t("access.next") }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: t("access.setup.account.title") }),
  ).toBeVisible();
  await page.getByLabel(t("access.setup.account.name")).fill("Lea Hoffmann");
  await page.getByLabel(t("access.setup.account.email")).fill("lea.hoffmann@example.com");
  await page
    .getByLabel(t("access.setup.account.password"), { exact: true })
    .fill("kalzit-sunstone-24");
  await shoot(page, "setup-account-dark");
  await page.context().close();
});
