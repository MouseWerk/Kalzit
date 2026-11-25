import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test as base, expect } from "../support/test";
import { SCREENS, type Screen } from "./screens";
import { readSeed, type Seed } from "./seed";
import { dynamicRegions, STATE_FILE, settle, stageContext, stagePage } from "./stage";
import {
  COMPARABLE,
  NOT_COMPARABLE,
  SETUP_DONE,
  SETUP_STEPS,
  shotName,
  slug,
  THEMES,
  WIDTHS,
} from "./variants";

/**
 * Every screen in light and dark at the width of the project (visual.config.ts), compared with
 * its baseline in e2e/visual/baselines. A difference fails; `npm run visual:update` writes new
 * baselines, which a reviewer looks at in the pull request (docs/process.md, "Visual
 * comparison").
 */

const test = base.extend<object, { seed: Seed }>({
  seed: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures a function takes from this pattern
    async ({}, use) => {
      await use(readSeed());
    },
    { scope: "worker" },
  ],
});

test.skip(!COMPARABLE, NOT_COMPARABLE);

async function shoot(screen: Screen, page: Page, seed: Seed) {
  const width = WIDTHS.find((candidate) => candidate.name === test.info().project.name);
  if (width === undefined) {
    throw new Error(`no width for the project ${test.info().project.name}`);
  }
  await stageContext(page.context(), seed.frozen);
  await stagePage(page);
  await screen.prepare?.(page);
  for (const theme of THEMES) {
    // A fresh load per theme: charts take their colors when they draw.
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(screen.path(seed));
    await screen.ready(page, seed, "en");
    await settle(page);
    await expect(page).toHaveScreenshot(shotName(width, screen.name, theme), {
      mask: await dynamicRegions(page),
    });
  }
}

test.describe("signed in", () => {
  test.use({ storageState: STATE_FILE });
  for (const screen of SCREENS.filter((candidate) => !candidate.signedOut)) {
    test(screen.name, async ({ page, seed, consoleGuard }) => {
      await shoot(screen, page, seed);
      // What the pages write to the console is for the e2e tests to judge, not for this run.
      await consoleGuard.drain();
    });
  }
});

test.describe("signed out", () => {
  for (const screen of SCREENS.filter((candidate) => candidate.signedOut)) {
    test(screen.name, async ({ page, seed, consoleGuard }) => {
      await shoot(screen, page, seed);
      await consoleGuard.drain();
    });
  }
});

test("every screen has a file name of its own", () => {
  const names = SCREENS.map((screen) => slug(screen.name));
  expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
});

/**
 * Baselines of screens that no longer exist would lie around unchecked: `visual:update` writes
 * and replaces baselines but never deletes one. A removed or renamed screen's files go with it.
 */
test("every baseline of this width belongs to a screen", () => {
  const width = WIDTHS.find((candidate) => candidate.name === test.info().project.name);
  if (width === undefined) {
    throw new Error(`no width for the project ${test.info().project.name}`);
  }
  const dir = join(test.info().project.testDir, "baselines", width.name);
  const screens = [
    ...SCREENS.map((screen) => screen.name),
    ...SETUP_STEPS,
    ...(width.scale === 1 ? [SETUP_DONE] : []),
  ];
  const expected = new Set(
    screens.flatMap((screen) => THEMES.map((theme) => shotName(width, screen, theme)[1])),
  );
  const present = existsSync(dir) ? readdirSync(dir) : [];
  expect(present.filter((file) => !expected.has(file))).toEqual([]);
});
