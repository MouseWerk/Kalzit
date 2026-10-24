import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

// The Updates page against the real server: nothing is downloaded (that would reach GitHub) and
// nothing is installed; a package that is not one is refused with its reason, and a manual
// backup appears in the list.

test("refuses a file that is not an update package and makes a backup on request", async ({ page }) => {
  await signInOwner(page, "en");
  await page.goto("/admin/server/updates");
  await expect(page.getByRole("heading", { level: 1, name: t("admin.updates.title") })).toBeVisible();

  await page.getByLabel(/Drop the package here/).setInputFiles({
    name: "not-a-package.kalzit-update",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("this is not a Kalzit update"),
  });
  await expect(page.getByText(/The release files are not valid/).first()).toBeVisible();
  const history = page.getByRole("region", { name: t("admin.updates.history.title") });
  await expect(history.getByText(t("admin.updates.history.aborted")).first()).toBeVisible();

  await page.getByRole("button", { name: t("admin.updates.backups.now") }).click();
  const backups = page.getByRole("list", { name: t("admin.updates.backups.title") });
  await expect(backups.getByText(t("admin.updates.backups.manual")).first()).toBeVisible();
});
