import type { Page } from "@playwright/test";
import { Api, regionDashboard, unique } from "./support/api";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

// The wave 2 parity package "table footer, save dialog, query options" (ParityEditors board,
// frames 5, 12 and 13).

async function totalsDashboard(sourceId: string): Promise<string> {
  const owner = await Api.owner();
  try {
    return await owner.createDashboard({
      schemaVersion: 2,
      title: unique("Fußzeile"),
      timeRange: { from: "now-6h", to: "now" },
      variables: [],
      panels: [
        {
          id: "totals",
          type: "table",
          title: "Totals",
          grid: { x: 0, y: 0, w: 12, h: 8 },
          targets: [
            {
              refId: "A",
              datasourceId: sourceId,
              query: {
                sql: "SELECT region, COUNT(*) AS readings FROM sales GROUP BY region ORDER BY region",
              },
            },
          ],
          options: {
            footer: {
              show: true,
              over: "all",
              numbers: "sum",
              columns: [{ column: "region", calc: "count" }],
            },
          },
        },
      ],
    });
  } finally {
    await owner.dispose();
  }
}

test("a table footer calculates per column and says what it calculates over", async ({
  page,
  world,
}) => {
  const id = await totalsDashboard(world.sourceId);
  await signInOwner(page);
  await page.goto(`/dashboards/${id}`);
  const foot = page.locator("tfoot");
  await expect(foot.getByRole("cell").first()).toContainText(
    t("panels.table.footer.countOf", { count: "4", total: "4" }),
  );
  await expect(foot.getByRole("cell").nth(1)).toContainText(t("panels.calc.sum"));
  await expect(page.getByText(t("panels.table.footer.overAll", { count: "4" }))).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});

async function openQueryOptions(page: Page) {
  const toggle = page.getByRole("button", { name: new RegExp(t("dashboards.queryOptions.title")) });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

test("query options are saved with the panel, the save dialog lists the change, and editing goes on", async ({
  page,
  world,
}) => {
  const owner = await Api.owner();
  const title = unique("Abfrage-Optionen");
  const id = await owner.createDashboard(regionDashboard(title, world.sourceId));
  await owner.dispose();
  await signInOwner(page);
  await page.goto(`/dashboards/${id}/panels/p1/edit`);
  await openQueryOptions(page);
  await page.getByLabel(t("dashboards.queryOptions.points.label")).fill("100");
  await page.getByLabel(t("dashboards.queryOptions.interval.label")).fill("5m");
  await expect(page.getByText("$__interval = 5m")).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await page.getByRole("button", { name: t("dashboards.editor.apply") }).click();

  await page.getByRole("button", { name: t("dashboards.save"), exact: true }).click();
  const dialog = page.getByRole("dialog", { name: t("dashboards.save.title") });
  await expect(
    dialog.getByText(
      t("dashboards.diff.panelChangedParts", {
        title: "Sales",
        parts: t("dashboards.diff.part.queryOptions"),
      }),
    ),
  ).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await dialog.getByRole("tab", { name: t("dashboards.save.jsonTab") }).click();
  const json = dialog.getByRole("tabpanel", { name: t("dashboards.save.jsonTab") });
  await expect(json).toContainText('"maxDataPoints": 100');
  await expect(json).toContainText('"minInterval": "5m"');
  expect(await seriousViolations(page)).toEqual([]);

  // The stored panel asks with its own points and interval from now on.
  const asked = page.waitForRequest(
    (request) => request.method() === "POST" && /\/panels\/p1\/query$/.test(request.url()),
  );
  await dialog.getByRole("button", { name: t("dashboards.save.submit"), exact: true }).click();
  await expect(dialog).toBeHidden();
  const body = (await asked).postDataJSON() as { maxDataPoints: number; intervalMs: number };
  expect(body.maxDataPoints).toBe(100);
  expect(body.intervalMs).toBe(300_000);
  // Save keeps edit mode (G16): "Finish editing" stays where it was, with nothing left to save.
  await expect(page.getByRole("button", { name: t("dashboards.doneEditing") })).toBeVisible();
  await expect(
    page.getByRole("button", { name: t("dashboards.save"), exact: true }),
  ).toBeDisabled();
});

test("finishing editing with changes offers to save them", async ({ page, world }) => {
  const owner = await Api.owner();
  const id = await owner.createDashboard(regionDashboard(unique("Beenden"), world.sourceId));
  await owner.dispose();
  await signInOwner(page);
  await page.goto(`/dashboards/${id}/panels/p1/edit`);
  await openQueryOptions(page);
  await page.getByLabel(t("dashboards.queryOptions.hideNote.label")).check();
  await page.getByRole("button", { name: t("dashboards.editor.apply") }).click();

  await page.getByRole("button", { name: t("dashboards.doneEditing") }).click();
  const ask = page.getByRole("alertdialog", { name: t("dashboards.finish.title") });
  await expect(ask).toContainText(t("dashboards.finish.textOne"));
  expect(await seriousViolations(page)).toEqual([]);
  await ask.getByRole("button", { name: t("dashboards.finish.save") }).click();
  const dialog = page.getByRole("dialog", { name: t("dashboards.save.title") });
  await dialog.getByRole("button", { name: t("dashboards.save.submit"), exact: true }).click();
  await expect(dialog).toBeHidden();
  // Saved from "Finish editing": edit mode ends.
  await expect(page.getByRole("button", { name: t("dashboards.edit") }).first()).toBeVisible();
});
