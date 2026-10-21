import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const OUTPUT = join(import.meta.dirname, ".output");
const CI = process.env.CI !== undefined && process.env.CI !== "";

/**
 * Browsers to run. Chromium runs every scenario; Firefox and WebKit run the checks that differ
 * between engines (the query editor under the server's CSP). `KALZIT_E2E_BROWSERS=chromium`
 * skips the others where they cannot be installed.
 */
const browsers = (process.env.KALZIT_E2E_BROWSERS ?? "chromium,firefox,webkit")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");

const ENGINE_CHECKS = /editor-csp\.spec\.ts/;

const others = [
  { name: "firefox", device: devices["Desktop Firefox"] },
  { name: "webkit", device: devices["Desktop Safari"] },
].filter((browser) => browsers.includes(browser.name));

/**
 * End-to-end tests against the release binary with the embedded UI. Global setup builds (or
 * takes, with KALZIT_E2E_BINARY) the binary, starts it on a free port with a fresh data
 * directory and a fixture SQLite database, and stops it afterwards.
 */
export default defineConfig({
  testDir: ".",
  outputDir: join(OUTPUT, "results"),
  globalSetup: "./global-setup.ts",
  fullyParallel: true,
  forbidOnly: CI,
  retries: 0,
  workers: CI ? 2 : 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: join(OUTPUT, "report"), open: "never" }],
  ],
  use: {
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /first-run\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      dependencies: ["setup"],
      testMatch: /\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    ...others.map((browser) => ({
      name: browser.name,
      dependencies: ["setup"],
      testMatch: ENGINE_CHECKS,
      use: { ...browser.device },
    })),
  ],
});
