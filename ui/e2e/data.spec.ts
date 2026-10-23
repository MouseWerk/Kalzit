import { join } from "node:path";
import { fixturesDir, SQL, unique } from "./support/api";
import { pattern, t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";
import { fillQuery, panelAction } from "./support/ui";

test("the owner connects SQLite, explores a time series and builds a dashboard with a variable", async ({
  page,
}) => {
  await signInOwner(page);
  const source = unique("Umsätze");
  const title = unique("Umsatz nach Region");

  // Data source: pick the kind, enter the file, add it, test the connection.
  await page.goto("/data-sources");
  await page.getByRole("link", { name: t("datasources.add") }).click();
  await page.getByRole("link", { name: "SQLite" }).click();
  await page.getByLabel(t("datasources.form.name")).fill(source);
  await page.getByLabel(t("datasources.settings.path")).fill(join(fixturesDir(), "sales.db"));
  await page.getByRole("button", { name: t("datasources.form.create") }).click();
  await expect(page.getByRole("heading", { name: t("datasources.edit.title") })).toBeVisible();
  await page.getByRole("button", { name: t("datasources.health.test"), exact: true }).click();
  const health = page.locator(".ds-health-region");
  await expect(health).toContainText(pattern("datasources.health.ok"));
  await expect(health).toContainText(pattern("datasources.reason.health.connected_read_only"));

  // Explore: a time series from the fixture, in the last hour.
  await page
    .getByRole("navigation", { name: t("nav.label") })
    .getByRole("link", {
      name: t("explore.nav"),
    })
    .click();
  await page.getByLabel(t("explore.datasource")).selectOption({ label: source });
  await fillQuery(page, SQL.series);
  await page.getByRole("button", { name: t("explore.run") }).click();
  const result = page.getByRole("region", { name: t("explore.result") });
  await expect(result.getByLabel(t("explore.visualization"))).toHaveValue("timeseries");
  await expect(result.locator(".ts__plot")).toBeVisible();
  await result.getByRole("tab", { name: t("explore.tab.inspect") }).click();
  await expect(result).toContainText(/\d+ rows, 2 fields/);

  // Into a new dashboard.
  await result.getByRole("button", { name: t("explore.addToDashboard") }).click();
  const add = page.getByRole("dialog", { name: t("explore.add.title") });
  await add.getByLabel(t("explore.add.new")).check();
  await add.getByLabel(t("dashboards.new.titleLabel")).fill(title);
  await add.getByRole("button", { name: t("explore.add.submit") }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator(".ts__plot")).toBeVisible();

  // A query variable for the region, and the panel's query uses it.
  await page.getByRole("button", { name: t("dashboards.edit") }).click();
  await page.getByRole("button", { name: t("dashboards.settings") }).click();
  const settings = page.getByRole("dialog", { name: t("dashboards.settings.title") });
  await settings.getByRole("button", { name: t("dashboards.variables.add") }).click();
  const variable = settings.getByRole("region", { name: "var1" });
  await variable.getByLabel(t("dashboards.variables.name")).fill("region");
  const editorOfRegion = settings.getByRole("region", { name: "region" });
  await editorOfRegion.getByLabel(t("dashboards.variables.labelField")).fill("Region");
  await editorOfRegion
    .getByLabel(t("dashboards.variables.type"))
    .selectOption({ label: t("dashboards.variables.type.query") });
  await editorOfRegion
    .getByLabel(t("dashboards.editor.datasource"))
    .selectOption({ label: source });
  await fillQuery(editorOfRegion, SQL.regions);
  await settings.getByRole("button", { name: t("dashboards.editor.apply") }).click();
  await expect(settings).toBeHidden();

  // A panel from Explore is named after its data source.
  const panelTitle = source;
  await panelAction(page, panelTitle, "dashboards.panel.editNamed");
  const editor = page.getByRole("region", { name: t("dashboards.editor.title") });
  await editor.getByLabel(t("dashboards.editor.panelTitle")).fill("Umsatz");
  await fillQuery(editor, SQL.byRegion);
  // Escape closes the query's suggestions first, then leaves the editor with the change in the
  // dashboard, unsaved.
  const suggestions = page.locator(".cm-tooltip-autocomplete");
  await expect(suggestions).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(suggestions).toHaveCount(0);
  await expect(editor).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();

  await page.getByRole("button", { name: t("dashboards.save") }).click();
  const save = page.getByRole("dialog", { name: t("dashboards.save.title") });
  await save.getByLabel(t("dashboards.save.message")).fill("Region als Variable");
  await save.getByRole("button", { name: t("dashboards.save.submit") }).click();
  await expect(save).toBeHidden();
  await expect(page.getByRole("button", { name: t("dashboards.edit") })).toBeVisible();

  // Saved and reloaded: the variable lists the regions and the panel shows its series.
  await page.reload();
  const region = page
    .getByRole("region", { name: t("dashboards.variables.label") })
    .getByLabel("Region");
  await expect(region).toHaveValue("Nord");
  await expect(region.locator("option")).toHaveText(["Nord", "Ost", "Süd", "West"]);
  await expect(page.getByRole("group", { name: "Umsatz" })).toBeVisible();
});
