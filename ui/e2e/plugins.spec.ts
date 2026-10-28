import { Api, unique } from "./support/api";
import { t } from "./support/i18n";
import { BINARY, ID, NAME, writePackage } from "./support/plugin";
import { expect, signInOwner, test } from "./support/test";
import { fillQuery } from "./support/ui";

test("an admin installs a plugin from a file, approves and starts it, and queries a source of its kind", async ({
  page,
}) => {
  test.skip(BINARY === "", "KALZIT_E2E_PLUGIN_BINARY is not set: the test plugin was not built");
  test.setTimeout(120_000);
  const file = test.info().outputPath(`${ID}-1.0.0.zip`);
  writePackage(file);
  const source = unique("Zahlen");

  // A Linux runner without Landlock refuses plugins unless allowed; the server's own tests do
  // the same. Through the API: the switch is not what this test is about.
  const owner = await Api.owner();
  const host = (await (await owner.context.get("/api/admin/plugin-host")).json()) as {
    landlockAvailable: boolean;
  };
  if (process.platform === "linux" && !host.landlockAvailable) {
    const allowed = await owner.context.patch("/api/admin/plugin-host", {
      data: { allowWithoutLandlock: true },
    });
    expect(allowed.ok(), await allowed.text()).toBe(true);
  }

  try {
    await signInOwner(page);

    await test.step("allow unsigned plugins after typing the server's name", async () => {
      await page.goto("/settings/plugins#trust");
      await page.getByRole("switch", { name: t("plugins.trust.unsigned.title") }).click();
      const dialog = page.getByRole("dialog", { name: t("plugins.risk.unsignedTitle") });
      const name = new URL(page.url()).hostname;
      await dialog.getByRole("textbox").fill(name);
      await dialog.getByRole("button", { name: t("plugins.risk.allow") }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText(t("plugins.banner.title"))).toBeVisible();
    });

    await test.step("install the package: the checks, the permissions, then start", async () => {
      await page.goto("/settings/plugins");
      await page.getByRole("button", { name: t("plugins.install.open") }).click();
      const choose = page.getByRole("dialog", { name: t("plugins.install.title") });
      await choose.getByLabel(t("plugins.install.drop")).setInputFiles(file);
      const review = page.getByRole("dialog", {
        name: t("plugins.install.reviewTitle", { name: NAME, version: "1.0.0" }),
      });
      await expect(review.getByText(t("plugins.step.package.done"))).toBeVisible();
      await expect(review.getByText(t("plugins.step.signature.none"))).toBeVisible();
      await expect(review.getByText(t("plugins.step.checksum.done"))).toBeVisible();
      await review.getByRole("checkbox", { name: t("plugins.install.grant") }).check();
      await review.getByRole("button", { name: t("plugins.install.confirm") }).click();
      await expect(review).toBeHidden();
      const row = page.getByRole("row").filter({ hasText: NAME });
      await expect(row.getByText(t("plugins.signature.unsigned"))).toBeVisible();
      await expect(row.getByText(t("plugins.status.idle"))).toBeVisible();
    });

    await test.step("add a data source of the plugin's kind", async () => {
      await page.goto("/data-sources/new");
      await page.getByRole("link", { name: NAME, exact: true }).click();
      await page.getByLabel(t("datasources.form.name"), { exact: true }).fill(source);
      await page
        .getByLabel(t("datasources.settings.host"), { exact: true })
        .fill("db.example.test");
      await page.getByRole("button", { name: t("datasources.form.create") }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: source, exact: true }),
      ).toBeVisible();
    });

    await test.step("run a query through the plugin in Explore", async () => {
      await page.goto("/explore");
      await page.getByLabel(t("explore.datasource")).selectOption({ label: source });
      await fillQuery(page, '{"do": "rows", "n": 4}');
      await page.getByRole("button", { name: t("explore.run") }).click();
      const result = page.getByRole("region", { name: t("explore.result") });
      await result.getByRole("tab", { name: t("explore.tab.inspect") }).click();
      await expect(result).toContainText(t("dashboards.inspect.size", { rows: 4, fields: 1 }), {
        timeout: 30_000,
      });
    });

    await test.step("the plugin runs, and unsigned plugins are turned off again", async () => {
      await page.goto("/settings/plugins");
      const row = page.getByRole("row").filter({ hasText: NAME });
      await expect(row.getByText(t("plugins.status.running"))).toBeVisible();
      await page.getByRole("button", { name: t("plugins.banner.turnOff") }).click();
      await expect(page.getByText(t("plugins.banner.title"))).toBeHidden();
    });
  } finally {
    await owner.context.patch("/api/admin/plugin-host", { data: { allowUnsigned: false } });
    await owner.dispose();
  }
});
