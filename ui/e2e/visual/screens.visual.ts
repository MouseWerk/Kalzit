import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test as base, expect } from "../support/test";
import { baselineDir } from "./baselines";
import { SCREENS, type Screen } from "./screens";
import { readSeed, type Seed } from "./seed";
import {
  noteUnplaced,
  STATE_FILE,
  settle,
  setupShot,
  stageContext,
  stagePage,
  steadyText,
} from "./stage";
import {
  COMPARABLE,
  HIDPI_SCREENS,
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
 * its approved baseline (baselines.ts: the commit of MouseWerk/kalzit-visual named in
 * baselines.lock). A difference fails; `npm run visual:update` writes new
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
  let tab = page;
  for (const [index, theme] of THEMES.entries()) {
    // A fresh page per theme: charts take their colors when they draw, and a page in edit mode
    // would hold a navigation back with its question about unsaved changes.
    if (index > 0) {
      const next = await page.context().newPage();
      await tab.close();
      tab = next;
    }
    await stagePage(tab);
    await screen.prepare?.(tab);
    await tab.emulateMedia({ colorScheme: theme });
    await tab.goto(screen.path(seed));
    await screen.ready(tab, seed, "en");
    await settle(tab);
    noteUnplaced(
      shotName(width, screen.name, theme).join("/"),
      await steadyText(tab, seed.dynamic),
    );
    // Soft: both themes are compared and reported, not only the first that differs.
    await expect.soft(tab).toHaveScreenshot(shotName(width, screen.name, theme), {
      mask: screen.masks?.(tab) ?? [],
    });
  }
}

test.describe("signed in", () => {
  test.use({ storageState: STATE_FILE });
  for (const screen of SCREENS.filter((candidate) => !candidate.signedOut)) {
    test(screen.name, async ({ page, seed, consoleGuard }) => {
      await shoot(screen, page, seed);
      // Not a console check: the e2e tests fail on console output; this run only compares pictures.
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

/**
 * The setup steps, taken by the setup project on the fresh server (setup.visual.ts) and compared
 * here, so a difference fails this test while the setup still seeds the server for every screen.
 */
test("the setup steps", () => {
  const width = WIDTHS.find((candidate) => candidate.name === test.info().project.name);
  if (width === undefined) {
    throw new Error(`no width for the project ${test.info().project.name}`);
  }
  const steps = [...SETUP_STEPS, ...(width.scale === 1 ? [SETUP_DONE] : [])];
  for (const step of steps) {
    for (const theme of THEMES) {
      // Soft: every step is compared and reported, not only the first that differs.
      expect
        .soft(readFileSync(setupShot(width, step, theme)))
        .toMatchSnapshot(shotName(width, step, theme));
    }
  }
});

test("every screen has a file name of its own", () => {
  const names = SCREENS.map((screen) => slug(screen.name));
  expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  // The screens at twice the scale are screens of the list.
  const known = new Set(SCREENS.map((screen) => screen.name));
  expect(HIDPI_SCREENS.filter((name) => !known.has(name))).toEqual([]);
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
  const dir = join(baselineDir(), width.name);
  const screens = [
    ...SCREENS.map((screen) => screen.name).filter(
      (name) => width.scale === 1 || HIDPI_SCREENS.includes(name),
    ),
    ...SETUP_STEPS,
    ...(width.scale === 1 ? [SETUP_DONE] : []),
  ];
  const expected = new Set(
    screens.flatMap((screen) => THEMES.map((theme) => shotName(width, screen, theme)[1])),
  );
  const present = existsSync(dir) ? readdirSync(dir) : [];
  expect(present.filter((file) => !expected.has(file))).toEqual([]);
});
