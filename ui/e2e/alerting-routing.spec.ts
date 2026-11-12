import { Api, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

/**
 * Notification policies (board docs/design/blueprint/AlertingRouting.dc.html): an admin builds
 * and reorders the tree and checks a way; an editor sees the same tree read-only.
 */

let owner: Api;

test.beforeAll(async () => {
  owner = await Api.owner();
});

test.afterAll(async () => {
  await owner.dispose();
});

const policies = () => `/api/orgs/${owner.orgId}/alerting/policies`;

async function rootId(): Promise<string> {
  const answer = await owner.context.get(policies());
  expect(answer.status()).toBe(200);
  const { items } = (await answer.json()) as { items: { id: string; isRoot: boolean }[] };
  const root = items.find((item) => item.isRoot);
  expect(root).toBeDefined();
  return root?.id ?? "";
}

async function createPolicy(parentId: string, name: string, team: string): Promise<string> {
  const answer = await owner.context.post(policies(), {
    data: { parentId, name, matchers: [{ label: "team", op: "=", value: team }] },
  });
  expect(answer.status()).toBe(201);
  return ((await answer.json()) as { id: string }).id;
}

async function createWebhook(name: string): Promise<void> {
  const answer = await owner.context.post(`/api/orgs/${owner.orgId}/alerting/contact-points`, {
    data: { name, kind: "webhook", language: "en", url: "http://127.0.0.1:9/kalzit" },
  });
  expect(answer.status()).toBe(201);
}

/** A tree row by the policy's name; the row's name also says where it is. */
const row = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("treeitem", { name: new RegExp(`^${name}, `) });

test("an admin adds a policy, reorders the tree by keyboard and checks a way", async ({ page }) => {
  const pointName = unique("Bereitschaft Lager");
  await createWebhook(pointName);
  const team = unique("lager").replace(/[^a-z0-9_]/gi, "_");
  await signInOwner(page);

  // A new policy below "Standard": a condition and a contact point, saved explicitly.
  const name = unique("Lager");
  await page.goto("/alerting/policies");
  await page.getByRole("link", { name: t("alerting.policies.add") }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: t("alerting.policies.newTitle") }),
  ).toBeVisible();
  await page.getByLabel(t("alerting.editor.name"), { exact: true }).fill(name);
  await page.getByLabel(t("alerting.policies.matcherLabelOf", { index: 1 })).fill("team");
  await page.getByLabel(t("alerting.policies.matcherValueOf", { index: 1 })).fill(team);
  await page.getByRole("checkbox", { name: new RegExp(pointName) }).check();
  await page.getByRole("button", { name: t("alerting.editor.save") }).click();
  await expect(page).toHaveURL(/\/alerting\/policies\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

  // A second one after it, then moved above it with Alt+Up, and the move undone.
  const second = unique("Vertrieb");
  await createPolicy(await rootId(), second, unique("vertrieb"));
  await page.goto("/alerting/policies");
  const moved = row(page, second);
  await expect(moved).toBeVisible();
  const before = await page.getByRole("treeitem").allInnerTexts();
  expect(before.findIndex((text) => text.includes(second))).toBeGreaterThan(
    before.findIndex((text) => text.includes(name)),
  );
  await moved.focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.getByText(t("alerting.policies.moved.up", { name: second }))).toBeVisible();
  await expect
    .poll(async () => {
      const texts = await page.getByRole("treeitem").allInnerTexts();
      return (
        texts.findIndex((text) => text.includes(second)) <
        texts.findIndex((text) => text.includes(name))
      );
    })
    .toBe(true);
  await page.getByRole("button", { name: /Undo/ }).click();
  await expect
    .poll(async () => {
      const texts = await page.getByRole("treeitem").allInnerTexts();
      return (
        texts.findIndex((text) => text.includes(second)) >
        texts.findIndex((text) => text.includes(name))
      );
    })
    .toBe(true);

  // The checker: labels with the team take the new policy's way to its contact point.
  await page.getByLabel(t("alerting.policies.check.labels"), { exact: true }).fill(`team=${team}`);
  const checker = page.locator("#route-checker");
  await expect(checker.getByText(`Standard › ${name}`)).toBeVisible();
  await expect(checker.getByText(pointName)).toBeVisible();
});

test("an editor sees the policy tree read-only", async ({ pageAs }) => {
  const name = unique("Lager kritisch");
  await createPolicy(await rootId(), name, unique("lager"));
  const editor = await owner.createMember(unique("Erika Editor"), "editor");
  const page = await pageAs(editor.email, editor.password);

  await page.goto("/alerting/policies");
  await expect(row(page, name)).toBeVisible();
  await expect(page.getByText(/^View only\./)).toBeVisible();
  await expect(page.getByRole("link", { name: t("alerting.policies.add") })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: t("alerting.policies.menu.label", { name }) }),
  ).toHaveCount(0);

  await row(page, name).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByText(t("alerting.policies.readOnlyDetail"))).toBeVisible();
  await expect(page.getByRole("button", { name: t("alerting.editor.save") })).toHaveCount(0);
});
