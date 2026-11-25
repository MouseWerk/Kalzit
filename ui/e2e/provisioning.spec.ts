import { join } from "node:path";
import { Api, fixturesDir, SQL, unique } from "./support/api";
import { t } from "./support/i18n";
import { findOverflow } from "./support/overflow";
import { selectOption } from "./support/select";
import { expect, signInOwner, test } from "./support/test";

/**
 * Provisioning and the Grafana import (board docs/design/blueprint/Provisioning.dc.html): a
 * dashboard applied from a file is marked and read-only until an admin unlocks it, Verwaltung >
 * Provisioning lists it with its drift, and a Grafana dashboard is imported in steps with its
 * report.
 */

let owner: Api;

test.beforeAll(async () => {
  owner = await Api.owner();
});

test.afterAll(async () => {
  await owner.dispose();
});

function source(): Promise<string> {
  return owner.createSqliteSource(unique("Lager"), join(fixturesDir(), "sales.db"));
}

test("a dashboard from files is marked, read-only, and unlocked in an emergency", async ({
  page,
}) => {
  const sourceId = await source();
  const set = unique("lager").replace(/[^A-Za-z0-9._-]/g, "-");
  const uid = `${set}-board`;
  const title = unique("Lagerbestand");
  const path = "dashboards/lagerbestand.json";
  // As `kalzit provision apply` sends it: one file, one resource.
  const answer = await owner.context.post(`/api/orgs/${owner.orgId}/provisioning/apply`, {
    data: {
      set,
      prune: false,
      secretValues: {},
      files: [
        {
          path,
          content: JSON.stringify({
            apiVersion: "kalzit/v1",
            kind: "Dashboard",
            uid,
            spec: {
              model: {
                schemaVersion: 1,
                title,
                timeRange: { from: "now-6h", to: "now" },
                panels: [
                  {
                    id: "p1",
                    type: "timeseries",
                    title: "Sales",
                    grid: { x: 0, y: 0, w: 12, h: 8 },
                    targets: [{ refId: "A", datasourceId: sourceId, query: { sql: SQL.series } }],
                  },
                ],
              },
            },
          }),
        },
      ],
    },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  const applied = (await answer.json()) as { plan: { changes: { resourceId: string }[] } };
  const dashboardId = applied.plan.changes[0]?.resourceId ?? "";

  await signInOwner(page);
  await page.goto(`/dashboards/${dashboardId}`);
  await expect(page.getByRole("group", { name: "Sales" })).toBeVisible();
  // Edit stays where it is, locked, and the badge says where the dashboard comes from.
  const edit = page.getByRole("button", { name: t("dashboards.edit"), exact: true });
  await expect(edit).toHaveAttribute("aria-disabled", "true");
  await expect(edit).toHaveAccessibleDescription(t("dashboards.managedLocked"));
  const badge = page.getByRole("button", { name: t("provisioning.badge.managed") });
  await badge.click();
  const field = page.getByRole("dialog", { name: t("provisioning.badge.managed") });
  await expect(field).toContainText(path);
  await expect(field).toContainText(set);
  // Escape closes the field and gives the focus back to the badge.
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(badge).toBeFocused();

  // Unlocking asks first; afterwards the dashboard can be edited and counts as drift.
  await badge.click();
  await field.getByRole("button", { name: t("provisioning.unlock.button") }).click();
  const ask = page.getByRole("alertdialog", {
    name: t("provisioning.unlock.title", { name: title }),
  });
  await expect(ask.getByRole("button", { name: t("dashboards.dialog.cancel") })).toBeFocused();
  await ask.getByRole("button", { name: t("provisioning.unlock.confirm") }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByRole("button", { name: t("provisioning.badge.unlocked") })).toBeVisible();
  await expect(edit).not.toHaveAttribute("aria-disabled", "true");

  await page.goto("/admin/provisioning");
  await expect(
    page.getByRole("heading", { name: t("admin.provisioning.title"), level: 1 }),
  ).toBeVisible();
  const drift = page.getByRole("region", { name: t("provisioning.drift.title") });
  await expect(drift).toContainText(title);
  await expect(drift).toContainText(t("provisioning.drift.unlocked"));
  await expect(page.getByRole("region", { name: t("provisioning.applies.title") })).toContainText(
    set,
  );
});

test("a Grafana dashboard is imported in steps, with its report kept", async ({ page }) => {
  const sourceName = unique("Lager SQLite");
  await owner.createSqliteSource(sourceName, join(fixturesDir(), "sales.db"));
  const title = unique("Lager Übersicht");
  const grafana = {
    title,
    schemaVersion: 39,
    panels: [
      {
        id: 1,
        type: "timeseries",
        title: "Durchsatz",
        gridPos: { x: 0, y: 0, w: 12, h: 8 },
        datasource: { type: "frser-sqlite-datasource", uid: "lager-sqlite" },
        targets: [{ refId: "A", rawSql: SQL.series }],
      },
      {
        id: 2,
        type: "grafana-worldmap-panel",
        title: "Standorte",
        gridPos: { x: 12, y: 0, w: 12, h: 8 },
        datasource: { type: "frser-sqlite-datasource", uid: "lager-sqlite" },
        targets: [{ refId: "A", rawSql: "SELECT 1" }],
      },
    ],
  };

  await signInOwner(page);
  await page.goto("/dashboards");
  await page.getByRole("button", { name: t("dashboards.import.menu") }).click();
  await page.getByRole("menuitem", { name: t("dashboardTools.import.grafana") }).click();
  await expect(page.getByRole("heading", { name: t("provisioning.import.title") })).toBeVisible();

  // Step 1: the file, pasted; what was found, and the name the dashboard gets.
  await page.getByText(t("provisioning.import.paste"), { exact: true }).click();
  await page.getByLabel(t("provisioning.import.json")).fill(JSON.stringify(grafana));
  await page.getByRole("button", { name: t("provisioning.import.readJson") }).click();
  await expect(page.getByText(t("provisioning.import.foundTitle", { title }))).toBeVisible();
  await page.getByRole("button", { name: t("provisioning.import.next") }).click();

  // Step 2: the file's one source gets a Kalzit source.
  await expect(
    page.getByRole("heading", { name: t("provisioning.import.sourcesTitle") }),
  ).toBeFocused();
  // On a phone each source is a card and the choice keeps its width.
  const full = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 740 });
  const choice = page.getByRole("combobox", {
    name: t("provisioning.import.sourceFor", { name: "lager-sqlite" }),
  });
  expect((await choice.boundingBox())?.width ?? 0).toBeGreaterThan(200);
  expect((await findOverflow(page)).offenders).toEqual([]);
  const mapCard = page.locator(".admin-table-card");
  expect(await mapCard.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  await page.setViewportSize(full ?? { width: 1280, height: 720 });
  await selectOption(
    page.getByRole("combobox", {
      name: t("provisioning.import.sourceFor", { name: "lager-sqlite" }),
    }),
    sourceName,
  );
  await page.getByRole("button", { name: t("provisioning.import.showReport") }).click();

  // Step 3: nothing exists yet; the plugin panel is skipped with its reason.
  const skipped = page.getByRole("row", { name: /Standorte/ });
  await expect(skipped).toBeVisible();
  await page.getByRole("button", { name: t("provisioning.import.run"), exact: true }).click();

  // The new dashboard opens with the quiet line that leads to the report.
  await expect(page.getByRole("group", { name: "Durchsatz" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Standorte" })).toHaveCount(0);
  await page.getByRole("link", { name: t("provisioning.notice.report") }).click();
  await expect(
    page.getByRole("heading", { name: t("provisioning.import.reportTitle"), level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /Standorte/ })).toBeVisible();
});
