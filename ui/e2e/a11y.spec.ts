import { baseUrl } from "./support/api";
import { seriousViolations } from "./support/axe";
import { MAIN_PAGES } from "./support/pages";
import { expect, signInOwner, test } from "./support/test";

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
