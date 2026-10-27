import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { GALLERY_NOW } from "./gallery/datacenter";

/**
 * The gallery renders (`npm run gallery`): curated scenes of a fictional data center for the
 * website, at twice the device scale, dark and light. Not part of the test run and not committed:
 * the gallery workflow (.github/workflows/gallery.yml) uploads them as an artifact. The same
 * global setup as the e2e tests starts the real binary; the pages run on a clock fixed to
 * GALLERY_NOW, around which all example data lies, so a rerun gives near-identical images.
 */
process.env.KALZIT_E2E_FIXTURE_NOW = String(GALLERY_NOW);

export default defineConfig({
  testDir: "./gallery",
  testMatch: /\.shots\.ts$/,
  outputDir: join(import.meta.dirname, ".output", "gallery-results"),
  globalSetup: "./global-setup.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    trace: "retain-on-failure",
  },
});
