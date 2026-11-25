import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { VISUAL_NOW } from "./visual/stage";
import { screensAt, WIDTHS } from "./visual/variants";

/**
 * The visual comparison (`npm run visual`): every screen in light and dark at each width of
 * visual/variants.ts, compared pixel by pixel with the baselines in e2e/visual/baselines.
 * `npm run visual:update` writes the baselines of the screens that changed; nothing else does.
 *
 * Baselines are made on Linux with Chromium only: fonts are drawn differently on Windows and
 * macOS, so the comparison runs on Linux (CI: the Linux e2e job and tools/local-ci/linux.sh) and
 * skips elsewhere. The same global setup as the e2e tests starts the real binary on a fresh data
 * directory; the fixture data lies around a fixed moment, the pages run on a clock fixed to it,
 * and the seed uses fixed names, so every run shows the same pages (docs/process.md, "Visual
 * comparison").
 */
process.env.KALZIT_E2E_FIXTURE_NOW = String(VISUAL_NOW);
process.env.KALZIT_E2E_STABLE_NAMES = "1";
process.env.KALZIT_E2E_SERVER_LOG = "visual-server.log";

const OUTPUT = join(import.meta.dirname, ".output");
const CI = process.env.CI !== undefined && process.env.CI !== "";

/**
 * How pictures are compared. Per pixel, `threshold` is the color distance (0 to 1, in YIQ) up to
 * which two pixels count as equal, stricter than Playwright's 0.2; beyond it a single pixel fails
 * (no share of pixels may differ). Two runs on one Linux machine give identical pictures; the
 * threshold is not raised to get a run green.
 */
const SCREENSHOT = {
  threshold: 0.1,
  maxDiffPixels: 0,
  animations: "disabled",
  caret: "hide",
  scale: "css",
} as const;

export default defineConfig({
  testDir: "./visual",
  testMatch: /\.visual\.ts$/,
  outputDir: join(OUTPUT, "visual-results"),
  snapshotPathTemplate: "{testDir}/baselines/{arg}{ext}",
  globalSetup: "./visual/global-setup.ts",
  fullyParallel: true,
  forbidOnly: CI,
  retries: 0,
  workers: Number(process.env.KALZIT_VISUAL_WORKERS ?? (CI ? 3 : 4)),
  timeout: 120_000,
  // A baseline is never written by a failing run: only `npm run visual:update` writes them.
  updateSnapshots: "none",
  expect: { timeout: 15_000, toHaveScreenshot: SCREENSHOT },
  reporter: [
    ["list"],
    ["html", { outputFolder: join(OUTPUT, "visual-report"), open: "never" }],
    ["./visual/summary.ts"],
    ...(CI ? [["./support/exit-guard.ts"] as [string]] : []),
  ],
  use: {
    ...devices["Desktop Chrome"],
    locale: "en-US",
    timezoneId: "UTC",
    contextOptions: { reducedMotion: "reduce" },
    // Grayscale text everywhere: Chromium draws text with colored subpixel edges on some layers
    // and in gray on others, by compositing decisions that vary between runs. One color profile
    // and no font hinting, so other Linux machines draw the same pixels.
    launchOptions: {
      args: ["--disable-lcd-text", "--force-color-profile=srgb", "--font-render-hinting=none"],
    },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /setup\.visual\.ts$/,
      use: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
    ...WIDTHS.map((width) => ({
      name: width.name,
      dependencies: ["setup"],
      testMatch: /screens\.visual\.ts$/,
      grep: screensAt(width),
      use: {
        viewport: { width: width.width, height: width.height },
        deviceScaleFactor: width.scale,
        isMobile: false,
      },
      expect: {
        timeout: 15_000,
        toHaveScreenshot: {
          ...SCREENSHOT,
          scale: width.scale === 2 ? ("device" as const) : ("css" as const),
        },
      },
    })),
  ],
});
