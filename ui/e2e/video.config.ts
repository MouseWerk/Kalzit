import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * The product video (`npm run video`): one scene, "Kalzit in 60 seconds", recorded by Playwright
 * against the real binary at 1920 x 1080. Not part of the test run and not committed: the gallery
 * workflow (.github/workflows/gallery.yml, set `video`) converts the recording with ffmpeg and
 * uploads it as an artifact. The same global setup as the e2e tests starts the binary; the Neo4j
 * of the e2e services holds the shop graph (e2e/fixtures/graph-shop.cypher).
 */
export default defineConfig({
  testDir: "./video",
  testMatch: /\.video\.ts$/,
  outputDir: join(import.meta.dirname, ".output", "video-results"),
  globalSetup: "./global-setup.ts",
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    trace: "retain-on-failure",
  },
});
