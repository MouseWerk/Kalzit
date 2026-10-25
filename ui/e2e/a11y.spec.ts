import { baseUrl, OWNER_CONTRAST } from "./support/api";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { MAIN_PAGES } from "./support/pages";
import { expect, signIn, signInOwner, test } from "./support/test";

test("sign-in page: no serious accessibility violations", async ({ browser }) => {
  // Signed out, as a visitor sees it.
  const context = await browser.newContext({ baseURL: baseUrl(), locale: "en-US" });
  const page = await context.newPage();
  await page.goto("/login");
  await expect(page.getByRole("button").first()).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await context.close();
});

// English in the light theme, German in the dark one: both catalogs and both palettes.
const VARIANTS = [
  { colorScheme: "light", locale: "en-US", language: "en" },
  { colorScheme: "dark", locale: "de-DE", language: "de" },
] as const;

for (const variant of VARIANTS) {
  test.describe(`${variant.colorScheme} theme, ${variant.language}`, () => {
    test.use({ colorScheme: variant.colorScheme, locale: variant.locale });

    for (const main of MAIN_PAGES) {
      test(`${main.name}: no serious accessibility violations`, async ({ page, world }) => {
        await signInOwner(page, variant.language);
        await page.goto(main.path(world));
        await main.ready(page, world, variant.language);
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
  });
}

/**
 * The high-contrast theme, as the theme of the owner's contrast twin, at a narrow desktop width
 * (900 px), where the layouts switch between their wide and narrow forms.
 */
test.describe("contrast theme, en, 900 px", () => {
  test.use({ viewport: { width: 900, height: 720 }, locale: "en-US" });

  for (const main of MAIN_PAGES) {
    test(`${main.name}: no serious accessibility violations`, async ({ page, world }) => {
      await signIn(page, OWNER_CONTRAST.email, OWNER_CONTRAST.password, "en");
      await page.goto(main.path(world));
      await main.ready(page, world, "en");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "contrast");
      expect(await seriousViolations(page)).toEqual([]);
    });
  }
});

test.describe("stacked list on a phone", () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test("data sources keep table roles and name each value's column", async ({ page, world }) => {
    await signInOwner(page, "en");
    await page.goto("/data-sources");
    const table = page.getByRole("table");
    await expect(table.getByRole("link", { name: world.sourceName })).toBeVisible();
    // The rows are stacked, so the header row is hidden; the roles keep the table a table.
    await expect(
      table.getByRole("columnheader", { name: t("datasources.column.kind") }),
    ).toHaveCount(1);
    const kindCell = table
      .getByRole("row")
      .filter({ hasText: world.sourceName })
      .getByRole("cell")
      .nth(1);
    await expect(kindCell).toHaveAttribute("data-label", t("datasources.column.kind"));
    // The label is drawn in front of the value, in the header's words.
    const label = await kindCell.evaluate((cell) => getComputedStyle(cell, "::before").content);
    expect(label).toContain(t("datasources.column.kind"));
    expect(await seriousViolations(page)).toEqual([]);
  });
});
