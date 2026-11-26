import { join } from "node:path";
import { Api, fixturesDir, unique } from "./support/api";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

const STEP_MS = 15_000;

test("the step catalog finds two new table steps by keyword and adds them", async ({ page }) => {
  const owner = await Api.owner();
  const id = await owner.createSqliteSource(unique("Verkäufe"), join(fixturesDir(), "sales.db"));
  await owner.dispose();
  await signInOwner(page);
  await page.goto(`/explore?source=${id}`);
  const start = page.getByRole("region", { name: t("explore.guide.title", { kind: "SQLite" }) });
  await start.getByRole("button", { name: t("help.starter.sql.rows") }).click();
  const result = page.getByRole("region", { name: t("explore.result") });
  await expect(result.getByLabel(t("explore.visualization"))).toBeVisible({ timeout: STEP_MS });

  const steps = page.getByRole("complementary", { name: t("explore.aside") });
  const addStep = steps.getByRole("button", { name: t("analysis.steps.add"), exact: true });
  const catalog = page.getByRole("dialog", { name: t("analysis.steps.add") });
  const search = catalog.getByRole("searchbox", { name: t("analysis.catalog.search") });

  // A generic word finds the step under Kalzit's own name; Enter adds the first hit.
  await addStep.click({ timeout: STEP_MS });
  await expect(search).toBeFocused();
  await expect(
    catalog.getByText(t("analysis.catalog.before.frame", { rows: 100, fields: 3 })),
  ).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await search.fill("rename");
  await expect(catalog.getByRole("option").first()).toContainText(t("analysis.kind.organize"));
  await page.keyboard.press("Enter");
  await expect(catalog).toHaveCount(0);
  const first = steps.getByRole("listitem", { name: t("analysis.steps.number", { n: 1 }) });
  await first
    .getByRole("checkbox", { name: t("analysis.organize.show", { field: "region" }) })
    .click();
  await expect(
    first.getByText(t("analysis.steps.status.rows", { rows: 100, fields: 2 })),
  ).toBeVisible({ timeout: STEP_MS });

  // "top" is a keyword of Limit; the preview shows the step on the result before it.
  await addStep.click({ timeout: STEP_MS });
  await search.fill("top");
  const limit = catalog
    .getByRole("option")
    .filter({ has: page.getByText(t("analysis.kind.limit"), { exact: true }) });
  await limit.hover();
  const preview = catalog.getByRole("complementary");
  await expect(preview.getByText(t("analysis.catalog.afterData"))).toBeVisible();
  await expect(preview.getByRole("columnheader", { name: "region" })).toHaveCount(0);
  await limit.click();
  const second = steps.getByRole("listitem", { name: t("analysis.steps.number", { n: 2 }) });
  await expect(
    second.getByText(t("analysis.steps.status.rows", { rows: 10, fields: 2 })),
  ).toBeVisible({ timeout: STEP_MS });
});
