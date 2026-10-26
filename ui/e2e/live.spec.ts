import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Api, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

/** Each step gets its own limit, so a failure names the step instead of the test's timeout. */
const STEP_MS = 15_000;
/** A polled feed runs every 5 s (the server's shortest refresh); room for one missed run. */
const PUSH_MS = 25_000;

function filesDir(): string {
  const dir = process.env.KALZIT_E2E_FILES;
  if (dir === undefined || dir === "") {
    throw new Error("KALZIT_E2E_FILES is not set; run the suite through playwright.config.ts");
  }
  return dir;
}

function writeCsv(path: string, rows: readonly [string, number][]): void {
  const lines = ["item;count", ...rows.map(([item, count]) => `${item};${count}`)];
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

test("a live dashboard shows a file source's new content without a refresh", async ({ page }) => {
  const path = join(filesDir(), `${unique("live").replace(/[^\w-]+/g, "-")}.csv`);
  writeCsv(path, [["Anfang", 1]]);
  const owner = await Api.owner();
  let dashboardId: string;
  try {
    const sourceId = await owner.createFileSource(unique("Live-Datei"), path);
    dashboardId = await owner.createDashboard({
      schemaVersion: 1,
      title: unique("Live"),
      timeRange: { from: "now-1h", to: "now" },
      // The interval live polls with: a file cannot report changes.
      refreshSeconds: 5,
      panels: [
        {
          id: "p1",
          type: "table",
          title: "Stand",
          grid: { x: 0, y: 0, w: 12, h: 8 },
          targets: [{ refId: "A", datasourceId: sourceId, query: {} }],
        },
      ],
    });
  } finally {
    await owner.dispose();
  }

  await test.step("sign in and open the dashboard", async () => {
    await signInOwner(page);
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
  });
  const panel = page.getByRole("article", { name: "Stand", exact: true });
  await expect(panel.getByText("Anfang", { exact: true })).toBeVisible({ timeout: STEP_MS });

  await test.step("turn live on in the refresh menu", async () => {
    await page
      .getByRole("button", {
        name: t("toolbar.refresh.menuRunning", {
          interval: t("toolbar.refresh.everySeconds", { n: 5 }),
        }),
        exact: true,
      })
      .click({ timeout: STEP_MS });
    await page
      .getByRole("menuitemradio", { name: t("live.menu.live"), exact: true })
      .click({ timeout: STEP_MS });
    await expect(page.getByRole("button", { name: t("live.menu.label") })).toBeVisible({
      timeout: STEP_MS,
    });
    // The file polls: the panel says so, quietly, with the interval.
    await expect(panel.locator(".panel-card__live")).toContainText(
      t("live.every", { interval: "5s" }),
      { timeout: PUSH_MS },
    );
  });

  await test.step("a change of the file reaches the panel", async () => {
    writeCsv(path, [
      ["Anfang", 1],
      ["Nachtrag", 2],
    ]);
    await expect(panel.getByText("Nachtrag", { exact: true })).toBeVisible({ timeout: PUSH_MS });
  });
});
