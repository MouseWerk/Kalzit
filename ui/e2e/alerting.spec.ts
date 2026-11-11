import { join } from "node:path";
import { Api, fixturesDir, unique } from "./support/api";
import { t } from "./support/i18n";
import { selectOption } from "./support/select";
import { expect, signInOwner, test } from "./support/test";
import { fillQuery } from "./support/ui";

/**
 * Alerting (board docs/design/blueprint/Alerting.dc.html): an admin adds a contact point and a
 * rule, an editor sees contact points read-only and silences an instance's labels.
 */

let owner: Api;

test.beforeAll(async () => {
  owner = await Api.owner();
});

test.afterAll(async () => {
  await owner.dispose();
});

/** A SQLite source with the fixture data, opted in to alerting. */
async function optedInSource(name: string): Promise<string> {
  const id = await owner.createSqliteSource(name, join(fixturesDir(), "sales.db"));
  const answer = await owner.context.put(`/api/orgs/${owner.orgId}/datasources/${id}/alerting`, {
    data: { enabled: true },
  });
  expect(answer.status()).toBe(200);
  return id;
}

async function createWebhook(name: string): Promise<string> {
  const answer = await owner.context.post(`/api/orgs/${owner.orgId}/alerting/contact-points`, {
    data: { name, kind: "webhook", language: "en", url: "http://127.0.0.1:9/kalzit" },
  });
  expect(answer.status()).toBe(201);
  return ((await answer.json()) as { id: string }).id;
}

test("an admin adds a webhook and a rule that notifies it", async ({ page }) => {
  const sourceName = unique("Alerting Verkauf");
  await optedInSource(sourceName);
  await signInOwner(page);

  // The contact point: its secret is shown once, after saving.
  const pointName = unique("Lager-Webhook");
  await page.goto("/alerting/contact-points");
  await page.getByRole("button", { name: t("alerting.contact.add") }).click();
  const dialog = page.getByRole("dialog", { name: t("alerting.contact.newTitle") });
  await dialog.getByRole("radio", { name: t("alerting.contact.kind.webhook") }).click();
  await dialog.getByLabel(t("alerting.editor.name"), { exact: true }).fill(pointName);
  await dialog.getByLabel(t("alerting.contact.url")).fill("http://127.0.0.1:9/kalzit");
  await dialog.getByRole("button", { name: t("alerting.editor.save") }).click();
  const secret = page.getByRole("dialog", {
    name: t("alerting.contact.secretTitle", { name: pointName }),
  });
  await expect(secret.locator("pre")).toHaveText(/^[0-9a-f]{64}$/);
  await secret.getByRole("button", { name: t("alerting.contact.secretDone") }).click();
  await expect(page.getByText(pointName, { exact: true })).toBeVisible();

  // The rule: query, reduce, condition and the contact point, saved explicitly.
  const ruleName = unique("Umsatz unter Plan");
  await page.goto("/alerting/rules/new");
  await page.getByLabel(t("alerting.editor.name"), { exact: true }).fill(ruleName);
  await selectOption(page.getByLabel(t("alerting.editor.source"), { exact: true }), sourceName);
  await fillQuery(page, "SELECT ts AS time, amount FROM sales WHERE $__timeFilter(ts)");
  // Close the completions typing opened, so they cover no field below.
  await page.keyboard.press("Escape");
  await page.getByLabel(t("alerting.editor.threshold"), { exact: true }).fill("1000");
  await page.getByRole("checkbox", { name: new RegExp(pointName) }).check();
  await page.getByRole("button", { name: t("alerting.editor.save") }).click();
  await expect(page).toHaveURL(/\/alerting\/rules\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1, name: ruleName })).toBeVisible();

  await page.goto("/alerting");
  await expect(page.getByRole("link", { name: ruleName })).toBeVisible();
  const nav = page.getByRole("navigation", { name: t("nav.label") });
  await expect(nav.getByRole("link", { name: /Alerting/ })).toBeVisible();
});

test("an editor sees contact points read-only and silences by labels", async ({ pageAs }) => {
  const pointName = unique("Bereitschaft");
  await createWebhook(pointName);
  const editor = await owner.createMember(unique("Erika Editor"), "editor");
  const page = await pageAs(editor.email, editor.password);

  await page.goto("/alerting/contact-points");
  await expect(page.getByText(pointName)).toBeVisible();
  await expect(page.getByText(t("alerting.contact.readOnly"))).toBeVisible();
  await expect(page.getByRole("button", { name: t("alerting.contact.add") })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: t("alerting.contact.menu.label", { name: pointName }) }),
  ).toHaveCount(0);

  const team = unique("lager").replace(/[^a-z0-9_]/gi, "_");
  await page.goto("/alerting/silences");
  await page.getByRole("button", { name: t("alerting.silences.add") }).click();
  const dialog = page.getByRole("dialog", { name: t("alerting.silences.dialogTitle") });
  await dialog.getByLabel(t("alerting.silences.labelNamed", { index: 1 })).fill("team");
  await dialog.getByLabel(t("alerting.silences.valueNamed", { index: 1 })).fill(team);
  await dialog.getByLabel(t("alerting.silences.comment")).fill("Umzug Rechenzentrum");
  await expect(dialog.getByText(t("alerting.silences.affectedZero"))).toBeVisible();
  await dialog.getByRole("button", { name: t("alerting.silences.save") }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.getByRole("row").filter({ hasText: `team=${team}` });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: new RegExp(t("alerting.silences.end")) }).click();
  await page
    .getByRole("dialog", { name: t("alerting.silences.endTitle") })
    .getByRole("button", { name: t("alerting.silences.end") })
    .click();
  await expect(row).toHaveCount(0);
});
