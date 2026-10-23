import { join } from "node:path";
import { unique } from "./support/api";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

function filesDir(): string {
  const dir = process.env.KALZIT_E2E_FILES;
  if (dir === undefined || dir === "") {
    throw new Error("KALZIT_E2E_FILES is not set; run the suite through playwright.config.ts");
  }
  return dir;
}

test("the owner connects a CSV file and explores it with the file query editor", async ({
  page,
}) => {
  await signInOwner(page);
  const source = unique("Regionen");
  const path = join(filesDir(), "regions.csv");

  await page.goto("/data-sources/new?kind=file");
  await page.getByLabel(t("datasources.form.name"), { exact: true }).fill(source);
  await page.getByLabel(t("datasources.settings.path"), { exact: true }).fill(path);
  await page.getByRole("button", { name: t("datasources.form.create") }).click();
  await expect(page.getByRole("heading", { name: t("datasources.edit.title") })).toBeVisible();

  await page.goto("/explore");
  await page.getByLabel(t("explore.datasource")).selectOption({ label: source });
  // The editor shows what will be read: the file, how, and the columns the schema found.
  await expect(page.getByText(path, { exact: true })).toBeVisible();
  await expect(page.getByText(t("datasources.editor.file.columns", { count: 2 }))).toBeVisible();
  await expect(page.getByText("amount", { exact: true })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  // The query is {}: Run is ready at once and reads the file.
  const run = page.getByRole("button", { name: t("explore.run") });
  await expect(run).toBeEnabled();
  await run.click();
  const result = page.getByRole("region", { name: t("explore.result") });
  await expect(result.getByText("Nord")).toBeVisible();
  // Semicolons and decimal commas, read automatically: 1.234,5 is a number.
  await expect(result.getByText("1,234.5")).toBeVisible();
  await result.getByRole("tab", { name: t("explore.tab.inspect") }).click();
  await expect(result).toContainText("3 rows, 2 fields");
});
