import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "@playwright/test";
import { baseUrl, OWNER } from "../support/api";
import { t } from "../support/i18n";
import { expect, test } from "../support/test";
import { seedVisual } from "./seed";
import {
  STATE_FILE,
  settle,
  setupShot,
  stageContext,
  stagePage,
  steadyText,
  VISUAL_DIR,
} from "./stage";
import {
  COMPARABLE,
  NOT_COMPARABLE,
  SETUP_DONE,
  SETUP_STEPS,
  THEMES,
  WIDTHS,
  type Width,
} from "./variants";

test.skip(!COMPARABLE, NOT_COMPARABLE);

/**
 * Runs once on the fresh server: the four setup steps at every width and in both themes, then the
 * seed for every other screen (seed.ts) and the owner's session for them.
 */

const CSS_WIDTHS = WIDTHS.filter((width) => width.scale === 1);
const HIDPI = WIDTHS.find((width) => width.scale === 2);

/** Tries for two equal pictures in a row, as the comparison does before it compares. */
const STABLE_TRIES = 20;

/** A picture of the page once two in a row are the same. */
async function stableShot(page: Page, scale: "css" | "device"): Promise<Buffer> {
  const shoot = () => page.screenshot({ animations: "disabled", caret: "hide", scale });
  let last = await shoot();
  for (let attempt = 0; attempt < STABLE_TRIES; attempt++) {
    // A short pause between two pictures, as the comparison itself waits between its tries.
    await page.waitForTimeout(100);
    const next = await shoot();
    if (next.equals(last)) {
      return next;
    }
    last = next;
  }
  throw new Error(`the page did not hold still for two pictures in ${STABLE_TRIES} tries`);
}

/**
 * Pictures of the current step, each width by resizing the page and each theme by the scheme.
 * They are kept for the width projects to compare (screens.visual.ts, "setup steps"): a
 * difference fails there, while the setup goes on to seed the server for every other screen.
 */
async function shootStep(page: Page, step: string, widths: readonly Width[]): Promise<void> {
  for (const width of widths) {
    await page.setViewportSize({ width: width.width, height: width.height });
    for (const theme of THEMES) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await steadyText(page);
      const file = setupShot(width, step, theme);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, await stableShot(page, width.scale === 2 ? "device" : "css"));
    }
  }
}

async function codeStep(page: Page): Promise<void> {
  await page.goto("/setup");
  await expect(
    page.getByRole("heading", { level: 1, name: t("access.setup.code.title") }),
  ).toBeVisible();
}

async function accountStep(page: Page): Promise<void> {
  await page
    .getByLabel(t("access.setup.code.label"))
    .fill(process.env.KALZIT_E2E_SETUP_TOKEN ?? "");
  await page.getByRole("button", { name: t("access.next") }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: t("access.setup.account.title") }),
  ).toBeFocused();
  await page.getByLabel(t("access.setup.account.name")).fill(OWNER.name);
  await page.getByLabel(t("access.setup.account.email")).fill(OWNER.email);
  await page.getByLabel(t("access.setup.account.password"), { exact: true }).fill(OWNER.password);
  await expect(page.getByText(t("password.strengthStrong"))).toBeVisible();
}

async function orgStep(page: Page): Promise<void> {
  await page.getByRole("button", { name: t("access.next") }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: t("access.setup.org.title") }),
  ).toBeVisible();
  await page.getByLabel(t("access.setup.org.name")).fill(OWNER.orgName);
}

test("the setup steps, then the seed for the screens", async ({ page, browser, consoleGuard }) => {
  test.setTimeout(15 * 60_000);
  mkdirSync(VISUAL_DIR, { recursive: true });
  await stageContext(page.context(), {});
  await stagePage(page);
  // The same steps once more at twice the device scale, up to the last one: the setup is made
  // only once, in the page above.
  const hidpiContext =
    HIDPI === undefined
      ? undefined
      : await browser.newContext({
          baseURL: baseUrl(),
          viewport: { width: HIDPI.width, height: HIDPI.height },
          deviceScaleFactor: HIDPI.scale,
          locale: "en-US",
          timezoneId: "UTC",
          reducedMotion: "reduce",
        });
  const hidpi = await hidpiContext?.newPage();
  if (hidpiContext !== undefined && hidpi !== undefined) {
    await stageContext(hidpiContext, {});
    await stagePage(hidpi);
  }
  const both = async (step: (opened: Page) => Promise<void>, name: string) => {
    await step(page);
    await shootStep(page, name, CSS_WIDTHS);
    if (hidpi !== undefined && HIDPI !== undefined) {
      await step(hidpi);
      await shootStep(hidpi, name, [HIDPI]);
    }
  };

  const [code, account, organization] = SETUP_STEPS;
  await both(codeStep, code);
  await both(accountStep, account);
  await both(orgStep, organization);
  await hidpiContext?.close();

  await page.getByRole("button", { name: t("access.setup.org.submit") }).click();
  const firstName = OWNER.name.split(" ")[0] ?? OWNER.name;
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: t("access.setup.done.title", { name: firstName }),
    }),
  ).toBeVisible();
  await shootStep(page, SETUP_DONE, CSS_WIDTHS);

  // Tips show once and at their own moment; the pictures show the screens without them.
  const tips = await page.request.patch("/api/me/preferences", { data: { showTips: false } });
  expect(tips.ok()).toBe(true);
  await page.context().storageState({ path: STATE_FILE });
  await seedVisual(page);
  // What the pages wrote to the console is for the e2e tests to judge, not for this run.
  await consoleGuard.drain();
});
