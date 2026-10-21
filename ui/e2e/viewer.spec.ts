import { join } from "node:path";
import { Api, fixturesDir, regionDashboard, SQL, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, test } from "./support/test";
import { fillQuery } from "./support/ui";

let owner: Api;

test.beforeAll(async () => {
  owner = await Api.owner();
});

test.afterAll(async () => {
  await owner.dispose();
});

test("a viewer reads a dashboard and changes its variable, but cannot edit or explore", async ({
  pageAs,
}) => {
  const viewer = await owner.createMember(unique("Viktor Viewer"), "viewer");
  const source = await owner.createSqliteSource(
    unique("Verkauf"),
    join(fixturesDir(), "sales.db"),
  );
  const title = unique("Regionen");
  const dashboardId = await owner.createDashboard(regionDashboard(title, source));

  const page = await pageAs(viewer.email, viewer.password);
  const nav = page.getByRole("navigation", { name: t("nav.label") });
  await expect(nav.getByRole("link", { name: t("dashboards.nav") })).toBeVisible();
  await expect(nav.getByRole("link", { name: t("explore.nav") })).toHaveCount(0);

  await nav.getByRole("link", { name: t("dashboards.nav") }).click();
  await page.getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboards/${dashboardId}`));
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  const region = page
    .getByRole("region", { name: t("dashboards.variables.label") })
    .getByLabel("Region");
  await expect(region).toHaveValue("Nord");
  await expect(page.getByRole("group", { name: "Sales" })).toBeVisible();

  // Changing the variable runs the stored panel query again with the new value.
  const rerun = page.waitForResponse(
    (response) =>
      response.url().includes(`/dashboards/${dashboardId}/panels/p1/query`) &&
      (response.request().postData() ?? "").includes('"West"'),
  );
  await region.selectOption("West");
  const answer = await rerun;
  expect(answer.status()).toBe(200);
  type Answer = {
    results: Record<string, { result?: { frame: { fields: { name: string; values: unknown[] }[] } } }>;
  };
  const body = (await answer.json()) as Answer;
  const amounts = body.results.A?.result?.frame.fields.find((f) => f.name === "amount")?.values;
  // The fixture puts West at about 400, far from Nord's 100: the value reached the query.
  expect(amounts?.length).toBeGreaterThan(0);
  expect(Math.min(...(amounts as number[]))).toBeGreaterThan(350);
  await expect(page.getByRole("group", { name: "Sales" })).toBeVisible();

  // Viewers see no editing controls, and the server refuses a save anyway.
  await expect(page.getByRole("button", { name: t("dashboards.edit") })).toHaveCount(0);
  await expect(page.getByRole("button", { name: t("dashboards.delete") })).toHaveCount(0);
  const save = await page.request.put(`/api/orgs/${owner.orgId}/dashboards/${dashboardId}`, {
    data: { model: regionDashboard("Changed by a viewer", source), version: 1 },
  });
  expect(save.status()).toBe(403);

  // Explore is not reachable by address either.
  await page.goto("/explore");
  await expect(page.getByRole("heading", { name: t("explore.forbidden.title") })).toBeVisible();
});

test("a viewer with query access to one data source can use Explore", async ({ pageAs }) => {
  const analyst = await owner.createMember(unique("Anna Analyst"), "viewer");
  const name = unique("Freigegeben");
  const source = await owner.createSqliteSource(name, join(fixturesDir(), "sales.db"));
  await owner.grantQuery(analyst.id, source);

  const page = await pageAs(analyst.email, analyst.password);
  const nav = page.getByRole("navigation", { name: t("nav.label") });
  await nav.getByRole("link", { name: t("explore.nav") }).click();
  await expect(page.getByRole("heading", { name: t("explore.title") })).toBeVisible();
  await page.getByLabel(t("explore.datasource")).selectOption({ label: name });
  await fillQuery(page, SQL.series);
  await page.getByRole("button", { name: t("explore.run") }).click();
  const result = page.getByRole("region", { name: t("explore.result") });
  await expect(result.locator(".ts__plot")).toBeVisible();
  // A viewer may query but not build dashboards.
  await expect(result.getByRole("button", { name: t("explore.addToDashboard") })).toHaveCount(0);
});
