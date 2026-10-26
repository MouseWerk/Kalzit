import { Api, type Member, regionDashboard, SQL, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";
import { addPanel, fillQuery, startEditing } from "./support/ui";

test("an Explore query is saved, found in the list, opened again and linked into a panel", async ({
  page,
  world,
}) => {
  const owner = await Api.owner();
  const dashboardTitle = unique("Mit Auswertung");
  const dashboardId = await owner.createDashboard(regionDashboard(dashboardTitle, world.sourceId));
  const title = unique("Umsatz Nord");
  try {
    await signInOwner(page);

    // Explore: run a query and save it as an analysis.
    await page.goto("/explore");
    await page.getByLabel(t("explore.datasource")).selectOption({ label: world.sourceName });
    await fillQuery(page, SQL.series);
    await page.getByRole("button", { name: t("explore.run") }).click();
    await expect(
      page.getByRole("region", { name: t("explore.result") }).locator(".ts__plot"),
    ).toBeVisible();
    await page.getByRole("button", { name: t("analyses.explore.save"), exact: true }).click();
    const save = page.getByRole("dialog", { name: t("analyses.save.title") });
    await expect(
      save.getByRole("checkbox", { name: new RegExp(t("analyses.save.keepRange")) }),
    ).not.toBeChecked();
    await save.getByRole("textbox", { name: t("analyses.save.name") }).fill(title);
    await save.getByRole("button", { name: t("analyses.save.submit"), exact: true }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page).toHaveURL(/\/explore\?analysis=/);

    // The list under Explore finds it; Open brings it back into Explore and runs it.
    await page
      .getByRole("navigation", { name: t("nav.label") })
      .getByRole("link", { name: t("analyses.nav"), exact: true })
      .click();
    await expect(page).toHaveURL(/\/explore\/saved/);
    await page.getByRole("searchbox", { name: t("analyses.list.search") }).fill(title);
    await page
      .getByRole("link", { name: t("analyses.row.openNamed", { title }), exact: true })
      .click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(
      page.getByRole("region", { name: t("explore.result") }).locator(".ts__plot"),
    ).toBeVisible();

    // A new panel starts from the saved analysis, linked.
    await page.goto(`/dashboards/${dashboardId}`);
    await expect(page.getByRole("heading", { name: dashboardTitle })).toBeVisible();
    await startEditing(page);
    await addPanel(page);
    const editor = page.getByRole("region", { name: t("dashboards.editor.newTitle") });
    await editor.getByRole("radio", { name: new RegExp(t("analyses.start.analysis")) }).check();
    const picker = editor.getByRole("region", { name: t("analyses.picker.label") });
    await picker.getByRole("searchbox", { name: t("analyses.list.search") }).fill(title);
    await picker.getByRole("option", { name: new RegExp(title) }).click();
    await expect(picker.locator(".ts__plot")).toBeVisible();
    await picker.getByRole("button", { name: t("analyses.picker.apply") }).click();
    await expect(
      editor.getByRole("article", { name: t("analyses.linked.label", { title }) }),
    ).toBeVisible();
    await editor.getByRole("button", { name: t("dashboards.editor.saveDashboard") }).click();
    await page
      .getByRole("dialog", { name: t("dashboards.save.title") })
      .getByRole("button", { name: t("dashboards.save.submit"), exact: true })
      .click();

    // The stored panel names the analysis and keeps no queries of its own.
    await expect
      .poll(async () => {
        const response = await owner.context.get(
          `/api/orgs/${owner.orgId}/dashboards/${dashboardId}`,
        );
        const body = (await response.json()) as {
          model: { panels: { analysisId?: string; targets: unknown[] }[] };
          analyses: Record<string, { title: string }>;
        };
        const linked = body.model.panels.find((panel) => panel.analysisId !== undefined);
        return linked === undefined
          ? null
          : {
              targets: linked.targets.length,
              title: body.analyses[linked.analysisId ?? ""]?.title,
            };
      })
      .toEqual({ targets: 0, title });
  } finally {
    await owner.dispose();
  }
});

test("a viewer opens a shared analysis read-only from the Analyses list and runs it", async ({
  pageAs,
  world,
}) => {
  const title = unique("Umsatz je Region");
  const model = {
    schemaVersion: 1,
    title,
    description: "Für die Wochenrunde",
    timeRange: { from: "now-6h", to: "now" },
    targets: [
      {
        refId: "A",
        datasourceId: world.sourceId,
        query: {
          sql: "SELECT region, ROUND(SUM(amount)) AS total FROM sales WHERE $__timeFilter(ts) GROUP BY region ORDER BY region",
        },
      },
    ],
    steps: [],
    visualization: { type: "table", options: {} },
  };
  const owner = await Api.owner();
  const orgId = owner.orgId;
  let analysisId: string;
  let viewer: Member;
  try {
    viewer = await owner.createMember(unique("Vera Viewer"), "viewer");
    analysisId = await owner.createAnalysis(model);
  } finally {
    await owner.dispose();
  }

  const page = await pageAs(viewer.email, viewer.password);
  // Viewers have no Explore; the saved analyses are theirs as "Analyses".
  const nav = page.getByRole("navigation", { name: t("nav.label") });
  await expect(nav.getByRole("link", { name: t("explore.nav"), exact: true })).toHaveCount(0);
  await nav.getByRole("link", { name: t("analyses.navReaders"), exact: true }).click();
  await expect(page).toHaveURL(/\/explore\/saved/);
  await page.getByRole("searchbox", { name: t("analyses.list.search") }).fill(title);
  await page
    .getByRole("link", { name: t("analyses.row.openShortNamed", { title }), exact: true })
    .click();

  // The page to view and run: the stored queries ran, nothing offers to change them.
  await expect(page).toHaveURL(new RegExp(`/explore/saved/${analysisId}$`));
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText(t("analyses.view.readOnly"))).toBeVisible();
  const result = page.getByRole("region", { name: t("explore.result") });
  await expect(result.getByText("Nord", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: t("analyses.linked.edit") })).toHaveCount(0);

  // Run again asks the server to run the stored analysis, not a query of the page's own.
  const rerun = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/analyses/${analysisId}/query`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: t("analyses.view.run") }).click();
  expect((await rerun).status()).toBe(200);
  await expect(result.getByText("West", { exact: true }).first()).toBeVisible();

  // Saving is refused on the server too.
  const save = await page.request.put(`/api/orgs/${orgId}/analyses/${analysisId}`, {
    data: { model: { ...model, title: "Von Vera" }, version: 1 },
  });
  expect(save.status()).toBe(403);
});
