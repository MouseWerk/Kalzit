import { Api, OWNER } from "./support/api";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { findOverflow } from "./support/overflow";
import { expect, signIn, test } from "./support/test";

/**
 * Runs once before every other project: a fresh server shows the setup page, the first owner
 * goes through its four steps, signs out and signs in again. Everything else builds on this
 * account.
 */
test("first-run setup creates the owner, who can sign out and sign in again", async ({
  page,
  consoleGuard,
}) => {
  // The wrong code and the wrong password below are refused requests, which browsers log.
  consoleGuard.allow(/status of 403 .*\/api\/setup\/check$/);
  consoleGuard.allow(/status of 401 .*\/api\/auth\/login$/);
  const token = process.env.KALZIT_E2E_SETUP_TOKEN ?? "";

  // Any address leads to setup while no account exists.
  await page.goto("/dashboards");
  await expect(
    page.getByRole("heading", { level: 1, name: t("access.setup.code.title") }),
  ).toBeVisible();
  // The test server takes its code from KALZIT_SETUP_TOKEN, so that tab is chosen first.
  await expect(
    page.getByRole("tab", { name: new RegExp(t("access.setup.where.fixed")) }),
  ).toHaveAttribute("aria-selected", "true");

  // A wrong code is refused at its field, on its own step; nothing is created.
  const code = page.getByLabel(t("access.setup.code.label"));
  await code.fill("0000-0000-0000-0000-0000-0000");
  await page.getByRole("button", { name: t("access.next") }).click();
  await expect(page.getByText(t("access.setup.code.wrongFixed"))).toBeVisible();
  await expect(code).toHaveAttribute("aria-invalid", "true");
  expect(await seriousViolations(page)).toEqual([]);

  // At 360 px nothing sticks out, the steps read "Step 1 of 4".
  const wide = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(
    page.getByText(t("access.setup.stepOf", { step: 1, total: 4 }), { exact: false }),
  ).toBeVisible();
  const overflow = await findOverflow(page);
  expect(overflow.offenders).toEqual([]);
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width);
  if (wide !== null) {
    await page.setViewportSize(wide);
  }

  await code.fill(token);
  await page.getByRole("button", { name: t("access.next") }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: t("access.setup.account.title") }),
  ).toBeFocused();
  await page.getByLabel(t("access.setup.account.name")).fill(OWNER.name);
  await page.getByLabel(t("access.setup.account.email")).fill(OWNER.email);
  await page.getByLabel(t("access.setup.account.password"), { exact: true }).fill(OWNER.password);
  // The password rated and its rules ticked off: nothing serious for axe.
  await expect(page.getByText(t("password.strengthStrong"))).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await page.getByRole("button", { name: t("access.next") }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: t("access.setup.org.title") }),
  ).toBeVisible();
  await page.getByLabel(t("access.setup.org.name")).fill(OWNER.orgName);
  expect(await seriousViolations(page)).toEqual([]);
  await page.getByRole("button", { name: t("access.setup.org.submit") }).click();

  // Done: signed in as the owner, with the next steps.
  const firstName = OWNER.name.split(" ")[0] ?? OWNER.name;
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: t("access.setup.done.title", { name: firstName }),
    }),
  ).toBeVisible();
  await expect(page.getByText(t("access.setup.done.codeDeleted"))).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await page.getByRole("link", { name: t("access.setup.done.toStart") }).click();
  await expect(
    page.getByRole("heading", { name: t("home.welcome", { name: OWNER.name }) }),
  ).toBeVisible();
  await expect(page.getByText(OWNER.orgName).first()).toBeVisible();

  // Setup is done: signing out leads to sign in, and the setup page only says it is done.
  await page.getByRole("button", { name: t("userMenu.label") }).click();
  await page.getByRole("menuitem", { name: t("userMenu.signOut") }).click();
  await expect(page.getByRole("heading", { name: t("access.login.title") })).toBeVisible();
  await page.goto("/setup");
  await expect(
    page.getByRole("heading", { name: t("access.setup.already.title", { product: "Kalzit" }) }),
  ).toBeVisible();
  await page.getByRole("link", { name: t("access.toLogin") }).click();

  // A wrong password is refused, the right one signs in.
  await page.getByLabel(t("access.login.email")).fill(OWNER.email);
  await page.getByLabel(t("access.login.password"), { exact: true }).fill("not-the-password");
  await page.getByRole("button", { name: t("access.login.submit") }).click();
  await expect(page.getByText(t("access.login.wrong"))).toBeVisible();

  await signIn(page, OWNER.email, OWNER.password);
  await expect(
    page.getByRole("heading", { name: t("home.welcome", { name: OWNER.name }) }),
  ).toBeVisible();

  // The German runs sign in as a second owner whose language is German, the contrast run as a
  // third one whose theme is the contrast theme.
  const owner = await Api.owner();
  try {
    await owner.createGermanOwner();
    await owner.createContrastOwner();
  } finally {
    await owner.dispose();
  }
});
