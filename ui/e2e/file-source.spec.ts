import { join } from "node:path";
import { unique } from "./support/api";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

/** Each step gets its own limit, so a failure names the step instead of the test's timeout. */
const STEP_MS = 15_000;

function filesDir(): string {
  const dir = process.env.KALZIT_E2E_FILES;
  if (dir === undefined || dir === "") {
    throw new Error("KALZIT_E2E_FILES is not set; run the suite through playwright.config.ts");
  }
  return dir;
}

/** A promise that fails after `ms` with the step's name, for awaits without a timeout of their own. */
function within<T>(what: string, ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

test("the owner connects a CSV file and explores it with the file query editor", async ({
  page,
}) => {
  const source = unique("Regionen");
  const path = join(filesDir(), "regions.csv");

  await test.step("sign in", () => within("sign in", STEP_MS, signInOwner(page)));

  await test.step("create the file source", async () => {
    await page.goto("/data-sources/new?kind=file", { timeout: STEP_MS });
    await page.getByLabel(t("datasources.form.name"), { exact: true }).fill(source, {
      timeout: STEP_MS,
    });
    await page.getByLabel(t("datasources.settings.path"), { exact: true }).fill(path, {
      timeout: STEP_MS,
    });
    await page
      .getByRole("button", { name: t("datasources.form.create") })
      .click({ timeout: STEP_MS });
    // The source is stored once the form has moved on to its page, headed by its name; waiting
    // for it keeps the create request from being cancelled by leaving the page.
    await expect(page.getByRole("heading", { level: 1, name: source, exact: true })).toBeVisible({
      timeout: STEP_MS,
    });
  });

  await test.step("open it in Explore", async () => {
    await page.goto("/explore", { timeout: STEP_MS });
    await page
      .getByLabel(t("explore.datasource"))
      .selectOption({ label: source }, { timeout: STEP_MS });
  });

  await test.step("the editor shows the file, how it is read and its columns", async () => {
    await expect(page.getByText(path, { exact: true })).toBeVisible({ timeout: STEP_MS });
    await expect(page.getByText(t("datasources.editor.file.columns", { count: 2 }))).toBeVisible({
      timeout: STEP_MS,
    });
    await expect(page.getByText("amount", { exact: true })).toBeVisible({ timeout: STEP_MS });
  });

  await test.step("no serious accessibility violations", async () => {
    expect(await within("the accessibility check", STEP_MS, seriousViolations(page))).toEqual([]);
  });

  await test.step("run reads the file with the query {}", async () => {
    const run = page.getByRole("button", { name: t("explore.run") });
    await expect(run).toBeEnabled({ timeout: STEP_MS });
    await run.click({ timeout: STEP_MS });
    const result = page.getByRole("region", { name: t("explore.result") });
    await expect(result.getByText("Nord")).toBeVisible({ timeout: STEP_MS });
    // Semicolons and decimal commas, read automatically: 1.234,5 is a number.
    await expect(result.getByText("1,234.5")).toBeVisible({ timeout: STEP_MS });
    await result.getByRole("tab", { name: t("explore.tab.inspect") }).click({ timeout: STEP_MS });
    await expect(result).toContainText("3 rows, 2 fields", { timeout: STEP_MS });
  });
});
