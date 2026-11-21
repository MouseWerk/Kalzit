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
      await password.fill("visible-for-a-moment");
      await expect(password).toHaveAttribute("type", "password");
      await expect(show).toHaveAttribute("aria-pressed", "false");
      await show.click();
      await expect(password).toHaveAttribute("type", "text");
      await expect(show).toHaveAttribute("aria-pressed", "true");
      await show.click();
      await expect(password).toHaveAttribute("type", "password");
      await expect(show).toHaveAttribute("aria-pressed", "false");
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
      // In the language the page shows: docs/guide or docs/guide/de.
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: t("access.help.getting-started", {}, variant.language),
        }),
      ).toBeVisible();
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

/** Answers the sign-in page's texts as the server would with these settings saved. */
async function stubSignInTexts(page: Page, signIn: Record<string, string>): Promise<void> {
  await page.route(/\/api\/branding(\?|$)/, async (route) => {
    const answer = await route.fetch();
    const body = (await answer.json()) as { signIn?: Record<string, unknown> };
    await route.fulfill({
      response: answer,
      json: { ...body, signIn: { ...body.signIn, ...signIn } },
    });
  });
}

test.describe("sign-in page with the longest notice at 1024 x 768", () => {
  test.use({ viewport: { width: 1024, height: 768 }, locale: "en-US" });

  test("the notice starts level with the heading and its end can be reached", async ({ page }) => {
    const end = "[Ask operations](https://intranet.example/operations).";
    const sentence = "Maintenance on Saturday from 22:00 to 02:00, signing in is not possible. ";
    const notice = `${sentence.repeat(40).slice(0, 2000 - end.length - 2)}\n\n${end}`;
    expect(notice).toHaveLength(2000);
    await stubSignInTexts(page, {
      notice,
      organization: "Basalt Works",
      serverName: "kalzit.basalt.example",
    });
    await page.goto("/login");

    const note = page.getByRole("note");
    const heading = page.getByRole("heading", { level: 1, name: t("access.login.title") });
    await expect(note).toBeVisible();
    await expect(page.getByText("Basalt Works", { exact: true })).toBeVisible();
    // Next to the form, in the panel, and in the heading's row: the line with the organization
    // above the heading does not move one against the other.
    await expect(
      page.getByRole("complementary", { name: t("access.panel.noticeLabel") }),
    ).toContainText("Ask operations");
    const noteBox = await note.boundingBox();
    const headingBox = await heading.boundingBox();
    expect(noteBox?.x ?? 0).toBeGreaterThan((headingBox?.x ?? 0) + (headingBox?.width ?? 0));
    expect(Math.abs((noteBox?.y ?? 0) - (headingBox?.y ?? -100))).toBeLessThanOrEqual(1);
    // Taller than the window: nothing of it is cut off, the page scrolls to its last line.
    expect(noteBox?.height ?? 0).toBeGreaterThan(768);
    const link = note.getByRole("link", { name: "Ask operations" });
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeInViewport({ ratio: 1 });
    expect(
      await link.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit !== null && element.contains(hit);
      }),
    ).toBe(true);
    const overflow = await findOverflow(page);
    expect(overflow.offenders).toEqual([]);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width);
  });
});

test.describe("sign-in page with a long provider name at 1024 x 768", () => {
  test.use({ viewport: { width: 1024, height: 768 }, locale: "de-DE" });

  test("the name wraps inside the column", async ({ page }) => {
    const provider = "Partnerportal der Unternehmensgruppe";
    await page.route(/\/api\/auth\/providers(\?|$)/, (route) =>
      route.fulfill({
        json: {
          providers: [{ slug: "portal", name: provider, kind: "oidc" }],
          passwordForm: "expanded",
          localSignIn: true,
        },
      }),
    );
    await page.goto("/login");
    const button = page.getByRole("link", { name: t("access.sso.button", { provider }, "de") });
    await expect(button).toBeVisible();
    // No card around the form: the column of 400 px is the edge.
    const column = await page.locator(".access__flow").boundingBox();
    const box = await button.boundingBox();
    expect(column?.width ?? 0).toBeLessThanOrEqual(400);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      (column?.x ?? 0) + (column?.width ?? 0),
    );
    expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  });
});
