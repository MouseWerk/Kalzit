import type { Page } from "@playwright/test";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { findOverflow } from "./support/overflow";
import { expect, test } from "./support/test";

/** Sends the empty form, so both fields show their error; nothing reaches the server. */
async function submitEmpty(page: Page, language: "de" | "en"): Promise<void> {
  await page.goto("/login");
  await page
    .getByRole("button", { name: t("access.login.submit", {}, language), exact: true })
    .click();
  await expect(page.getByText(t("validation.passwordRequired", {}, language))).toBeVisible();
}

for (const variant of [
  { colorScheme: "light", locale: "en-US", language: "en" },
  { colorScheme: "dark", locale: "de-DE", language: "de" },
] as const) {
  test.describe(`sign-in page, ${variant.colorScheme}, ${variant.language}`, () => {
    test.use({ colorScheme: variant.colorScheme, locale: variant.locale });

    test("marks both fields and stays accessible with its errors", async ({ page }) => {
      await submitEmpty(page, variant.language);
      const email = page.getByLabel(t("access.login.email", {}, variant.language));
      const password = page.getByLabel(t("access.login.password", {}, variant.language), {
        exact: true,
      });
      await expect(email).toHaveAttribute("aria-invalid", "true");
      await expect(password).toHaveAttribute("aria-invalid", "true");
      await expect(email).toBeFocused();
      expect(await seriousViolations(page)).toEqual([]);
    });

    test("shows the password on request and hides it again", async ({ page }) => {
      await page.goto("/login");
      const password = page.getByLabel(t("access.login.password", {}, variant.language), {
        exact: true,
      });
      const show = page.getByRole("button", { name: t("password.show", {}, variant.language) });
      const hide = page.getByRole("button", { name: t("password.hide", {}, variant.language) });
      await password.fill("visible-for-a-moment");
      await expect(password).toHaveAttribute("type", "password");
      await show.click();
      await expect(password).toHaveAttribute("type", "text");
      await hide.click();
      await expect(password).toHaveAttribute("type", "password");
      // Sending the form hides it again.
      await show.click();
      await page
        .getByRole("button", { name: t("access.login.submit", {}, variant.language), exact: true })
        .click();
      await expect(password).toHaveAttribute("type", "password");
    });

    test("stands on the calm backdrop, with language, theme and help in the top bar", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/login");
      await expect(page.locator(".access-bd__lamp")).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: t(
            "access.top.language",
            { language: t(`language.${variant.language}`, {}, variant.language) },
            variant.language,
          ),
        }),
      ).toBeVisible();
      // Help opens the guide that ships with Kalzit, readable without an account.
      await page.getByRole("link", { name: t("access.top.help", {}, variant.language) }).click();
      await expect(page).toHaveURL(/\/help\/getting-started$/);
      await expect(page.getByRole("heading", { level: 1, name: "Getting started" })).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });
  });

  test.describe(`sign-in page at 360 px, ${variant.language}`, () => {
    test.use({ viewport: { width: 360, height: 740 }, locale: variant.locale });

    test("nothing sticks out to the right, errors shown", async ({ page }) => {
      await submitEmpty(page, variant.language);
      // No drifting light on a phone, only the quiet grid.
      await expect(page.locator(".access-bd__lamp")).toBeHidden();
      const overflow = await findOverflow(page);
      expect(overflow.offenders).toEqual([]);
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width);
    });
  });
}
