import { Api, OWNER } from "./support/api";
import { t } from "./support/i18n";
import { expect, signIn, test } from "./support/test";

/**
 * Runs once before every other project: a fresh server shows the setup page, the first owner
 * sets Kalzit up, signs out and signs in again. Everything else builds on this account.
 */
test("first-run setup creates the owner, who can sign out and sign in again", async ({
  page,
  consoleGuard,
}) => {
  // The wrong code and the wrong password below are refused requests, which browsers log.
  consoleGuard.allow(/status of 403 .*\/api\/setup$/);
  consoleGuard.allow(/status of 401 .*\/api\/auth\/login$/);
  const token = process.env.KALZIT_E2E_SETUP_TOKEN ?? "";

  // Any address leads to setup while no account exists.
  await page.goto("/dashboards");
  await expect(page.getByRole("heading", { name: t("setup.title") })).toBeVisible();

  // A wrong code is refused at its field and nothing is created.
  await page.getByLabel(t("setup.token")).fill("0000-0000-0000-0000-0000-0000");
  await page.getByLabel(t("setup.orgName")).fill(OWNER.orgName);
  await page.getByLabel(t("setup.name")).fill(OWNER.name);
  await page.getByLabel(t("setup.email")).fill(OWNER.email);
  await page.getByLabel(t("setup.password"), { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: t("setup.submit") }).click();
  await expect(page.getByText(t("errors.invalid_setup_token"))).toBeVisible();

  await page.getByLabel(t("setup.token")).fill(token);
  await page.getByRole("button", { name: t("setup.submit") }).click();
  await expect(
    page.getByRole("heading", { name: t("home.welcome", { name: OWNER.name }) }),
  ).toBeVisible();
  await expect(page.getByText(OWNER.orgName).first()).toBeVisible();

  // Setup is done: the setup page now sends people to sign in.
  await page.getByRole("button", { name: t("userMenu.label") }).click();
  await page.getByRole("menuitem", { name: t("userMenu.signOut") }).click();
  await expect(page.getByRole("heading", { name: t("login.title") })).toBeVisible();

  // A wrong password is refused, the right one signs in.
  await page.getByLabel(t("login.email")).fill(OWNER.email);
  await page.getByLabel(t("login.password"), { exact: true }).fill("not-the-password");
  await page.getByRole("button", { name: t("login.submit") }).click();
  await expect(page.getByText(t("errors.invalid_credentials"))).toBeVisible();

  await signIn(page, OWNER.email, OWNER.password);
  await expect(
    page.getByRole("heading", { name: t("home.welcome", { name: OWNER.name }) }),
  ).toBeVisible();

  // The German runs sign in as a second owner whose language is German.
  const owner = await Api.owner();
  try {
    await owner.createGermanOwner();
  } finally {
    await owner.dispose();
  }
});
