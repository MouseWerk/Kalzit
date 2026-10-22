import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { SCREENSHOT_NOW } from "./screenshots/demo";

/**
 * The README screenshots (`npm run screenshots`), not part of the test run. The same global
 * setup as the e2e tests starts the real binary; the fixture data lies around a fixed moment and
 * the pages run on a clock fixed to it, so a rerun gives near-identical images.
 */
process.env.KALZIT_E2E_FIXTURE_NOW = String(SCREENSHOT_NOW);

export default defineConfig({
  testDir: "./screenshots",
  testMatch: /\.shots\.ts$/,
  outputDir: join(import.meta.dirname, ".output", "screenshots"),
  globalSetup: "./global-setup.ts",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "Europe/Berlin",
  },
});
