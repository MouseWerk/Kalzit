import { Api, SQL, unique } from "./support/api";
import { t } from "./support/i18n";
import { selectOption } from "./support/select";
import { expect, signInOwner, test } from "./support/test";

/**
 * The axis, legend and tooltip options of the time series (ParityEditors board, frames 2 to 4):
 * a logarithmic scale and the legend value "Total" set in the panel editor show in the preview,
 * are saved with the dashboard and draw on the dashboard again.
 */
test("a log scale and a Total legend value are set in the editor and kept", async ({
  page,
  world,
}) => {
  const owner = await Api.owner();
  let dashboardId = "";
  try {
    dashboardId = await owner.createDashboard({
      schemaVersion: 1,
      title: unique("Axes and legend"),
      timeRange: { from: "now-6h", to: "now" },
      panels: [
        {
          id: "sales",
          type: "timeseries",
          title: "Sales",
          grid: { x: 0, y: 0, w: 12, h: 8 },
          targets: [{ refId: "A", datasourceId: world.sourceId, query: { sql: SQL.series } }],
        },
      ],
    });

    await signInOwner(page);
    await page.goto(`/dashboards/${dashboardId}/panels/sales/edit`);
    const preview = page.locator(".panel-editor__preview");
    await expect(preview.locator(".ts__plot")).toBeVisible();
    const pane = page.locator(".options-pane");

    // Axes: logarithmic, base 10.
    await pane
      .locator("summary", { hasText: t("panels.section.axes") })
      .first()
      .click();
    await selectOption(pane.getByLabel(t("panels.axis.scale")).first(), {
      label: t("panels.axis.scale.log"),
    });
    await expect(pane.getByLabel(t("panels.axis.base")).first()).toBeVisible();

    // Legend: a table with the value "Total", picked from the group "Frequent".
    await pane
      .locator("summary", { hasText: t("panels.section.legend") })
      .first()
      .click();
    await selectOption(pane.getByLabel(t("panels.legend.kind")), {
      label: t("panels.legend.mode.table"),
    });
    await pane.getByRole("button", { name: t("panels.legend.addValue"), exact: true }).click();
    const list = pane.getByRole("listbox", { name: t("panels.legend.values") });
    await list
      .getByRole("group", { name: t("panels.calcGroup.frequent") })
      .getByRole("option", { name: new RegExp(`^${t("panels.calc.sum")}`) })
      .click();
    await expect(
      page.getByRole("button", {
        name: t("panels.legend.removeValue", { value: t("panels.calc.sum") }),
      }),
    ).toBeVisible();
    await expect(
      preview.getByRole("columnheader", { name: new RegExp(t("panels.calc.sum")) }),
    ).toBeVisible();

    await page.getByRole("button", { name: t("dashboards.editor.saveDashboard") }).click();
    await page
      .getByRole("dialog", { name: t("dashboards.save.title") })
      .getByRole("button", { name: t("dashboards.save.submit"), exact: true })
      .click();

    // Stored as the panel's field options and legend values.
    await expect
      .poll(async () => {
        const response = await owner.context.get(
          `/api/orgs/${owner.orgId}/dashboards/${dashboardId}`,
        );
        const body = (await response.json()) as {
          model: {
            panels: {
              options: { legend?: { mode: string; values?: string[] } };
              fieldConfig: { defaults?: { axisScale?: string } };
            }[];
          };
        };
        const panel = body.model.panels[0];
        return {
          scale: panel?.fieldConfig.defaults?.axisScale,
          mode: panel?.options.legend?.mode,
          values: panel?.options.legend?.values,
        };
      })
      .toEqual({ scale: "log", mode: "table", values: ["sum"] });

    // The dashboard draws the legend table with its Total column.
    await page.goto(`/dashboards/${dashboardId}`);
    const chart = page.getByRole("group", { name: "Sales" });
    await expect(chart).toBeVisible();
    await expect(
      page.locator(".viz-legend__table").getByRole("columnheader", {
        name: new RegExp(t("panels.calc.sum")),
      }),
    ).toBeVisible();
  } finally {
    await owner.dispose();
  }
});
