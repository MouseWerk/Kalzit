import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * The UI sweep (`npm run e2e:sweep`), run on demand and not part of the test run: every page in
 * light and dark, German and English, at three widths, with the look-and-layout checks of
 * support/audit.ts. It reports and does not gate: a finding fails nothing; only a route the sweep
 * does not know and a check that no longer catches its probe do. The report lands in
 * e2e/.output/ui-sweep (report.html, report.md, report.json, shots/). The same global setup as
 * the e2e tests starts the real binary.
 *
 * `KALZIT_SWEEP_PAGES` (a regular expression on page names) narrows a run to some pages,
 * `--grep "dark, de, 390"` to some variants.
 */
export default defineConfig({
  testDir: ".",
  outputDir: join(import.meta.dirname, ".output", "ui-sweep-results"),
  globalSetup: "./sweep/global-setup.ts",
  fullyParallel: true,
  retries: 0,
  workers: Number(process.env.KALZIT_SWEEP_WORKERS ?? 4),
  timeout: 45 * 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    timezoneId: "UTC",
    // Still pages: a transition caught halfway reads as a wrong color or a moved box.
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [
    { name: "setup", testMatch: /first-run\.setup\.ts/ },
    { name: "sweep", dependencies: ["setup"], testMatch: /sweep[\\/].*\.sweep\.ts$/ },
  ],
});
