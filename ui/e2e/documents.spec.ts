import type { Page } from "@playwright/test";
import { Api, OWNER_DE, unique } from "./support/api";
import { de } from "./support/i18n";
import { MONGO_FIXTURE, serviceAddress } from "./support/services";
import { expect, test } from "./support/test";

/** Each step gets its own limit, so a failure names the step instead of the test's timeout. */
const STEP_MS = 15_000;

/**
 * Replaces the JSON of a pipeline stage. The stage editors are CodeMirror editors named after
 * their stage; the text goes in at once, like a paste.
 */
async function fillStage(page: Page, number: number, text: string): Promise<void> {
  const editor = page.getByRole("textbox", {
    name: de("documents.pipeline.stageLabel", { number }),
    exact: true,
  });
  await editor.click({ timeout: STEP_MS });
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
  await expect(editor).toHaveText(text, { timeout: STEP_MS });
}

/** Of the fixture's 48 orders, every fifth from the fourth on is from the region Ost: 9. */
const OST = 9;
/** Of those, the status runs open, paid, shipped, paid, ...: 4 are paid. */
const OST_PAID = 4;

// In German, as the documents panels are written for German readers first: "über alle 9
// Dokumente" is the line that tells the counts come from the whole result in the database.
test("MongoDB in Explore: stages with a preview, the schema, the distribution over all documents and a filter as a visible stage", async ({
  pageAs,
}) => {
  const hosts = serviceAddress("KALZIT_E2E_MONGODB");
  const name = unique("Bestellungen");
  const owner = await Api.owner();
  try {
    await owner.createSource(
      name,
      "mongodb",
      { hosts, database: MONGO_FIXTURE.database, user: MONGO_FIXTURE.user },
      { password: MONGO_FIXTURE.password },
    );
  } finally {
    await owner.dispose();
  }
  const page = await pageAs(OWNER_DE.email, OWNER_DE.password, { locale: "de-DE" });
  const result = page.getByRole("region", { name: de("explore.result") });
  const run = page.getByRole("button", { name: de("explore.run") });

  await test.step("open the collection in Explore and run it without stages", async () => {
    await page.goto("/explore", { timeout: STEP_MS });
    await page
      .getByLabel(de("explore.datasource"))
      .selectOption({ label: name }, { timeout: STEP_MS });
    await page
      .getByLabel(de("documents.pipeline.collection"), { exact: true })
      .fill(MONGO_FIXTURE.collection, { timeout: STEP_MS });
    await run.click({ timeout: STEP_MS });
    await expect(result).toContainText(
      de("documents.summary.countMany", { count: MONGO_FIXTURE.documents }),
      { timeout: STEP_MS },
    );
  });

  await test.step("a $match stage, previewed on its own", async () => {
    await page
      .getByLabel(de("documents.pipeline.addWhich"), { exact: true })
      .selectOption("$match", { timeout: STEP_MS });
    await page
      .getByRole("button", { name: de("documents.pipeline.add"), exact: true })
      .click({ timeout: STEP_MS });
    await fillStage(page, 1, '{"$match": {"customer.region": "Ost"}}');
    await page
      .getByRole("button", { name: de("documents.pipeline.preview", { number: 1 }) })
      .click({ timeout: STEP_MS });
    const preview = page.getByRole("region", {
      name: de("documents.pipeline.previewOf", { number: 1 }),
    });
    await expect(preview).toContainText(de("documents.summary.countMany", { count: OST }), {
      timeout: STEP_MS,
    });
    await run.click({ timeout: STEP_MS });
    await expect(result).toContainText(de("documents.summary.countMany", { count: OST }), {
      timeout: STEP_MS,
    });
  });

  await test.step("the schema lists the nested paths", async () => {
    await page
      .getByLabel(de("explore.visualization"), { exact: true })
      .selectOption("schema", { timeout: STEP_MS });
    await expect(result.getByText("customer.region", { exact: true }).first()).toBeVisible({
      timeout: STEP_MS,
    });
    await expect(result.getByText("items[].price", { exact: true }).first()).toBeVisible({
      timeout: STEP_MS,
    });
  });

  await test.step("the distribution counts all documents of the result in the database", async () => {
    await page
      .getByLabel(de("explore.visualization"), { exact: true })
      .selectOption("distribution", { timeout: STEP_MS });
    await page
      .getByLabel(de("documents.distribution.path"), { exact: true })
      .selectOption("status", { timeout: STEP_MS });
    await expect(
      result.getByText(de("documents.distribution.scope.all", { count: OST }), { exact: true }),
    ).toBeVisible({ timeout: STEP_MS });
  });

  await test.step("a click on a value adds a visible $match stage and runs it", async () => {
    await result
      .getByRole("button", { name: de("documents.distribution.filterValue", { value: "paid" }) })
      .click({ timeout: STEP_MS });
    await expect(
      page.getByRole("heading", {
        name: de("documents.pipeline.stage", { number: 2, name: "$match" }),
      }),
    ).toBeVisible({ timeout: STEP_MS });
    await expect(
      page.getByRole("textbox", {
        name: de("documents.pipeline.stageLabel", { number: 2 }),
        exact: true,
      }),
    ).toHaveText('{"$match": {"status": "paid"}}', { timeout: STEP_MS });
    await expect(
      result.getByText(de("documents.distribution.scope.all", { count: OST_PAID }), {
        exact: true,
      }),
    ).toBeVisible({ timeout: STEP_MS });
  });
});
