import { findOverflow } from "./support/overflow";
import { MAIN_PAGES } from "./support/pages";
import { expect, signInOwner, test } from "./support/test";

// German words run longer, so both languages are checked.
for (const variant of [
  { locale: "en-US", language: "en" },
  { locale: "de-DE", language: "de" },
] as const) {
  test.describe(`360 px wide, ${variant.language}`, () => {
    test.use({ viewport: { width: 360, height: 740 }, locale: variant.locale });

    for (const main of MAIN_PAGES) {
      test(`${main.name}: nothing sticks out to the right`, async ({ page, world }) => {
        await signInOwner(page, variant.language);
        await page.goto(main.path(world));
        await main.ready(page, world, variant.language);
        const overflow = await findOverflow(page);
        expect(overflow.offenders).toEqual([]);
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width);
      });
    }
  });
}
