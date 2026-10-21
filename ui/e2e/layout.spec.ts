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
      test(`${main.name}: no horizontal scrolling`, async ({ page, world }) => {
        await signInOwner(page, variant.language);
        await page.goto(main.path(world));
        await main.ready(page, world, variant.language);
        const overflow = await page.evaluate(() => {
          const width = document.documentElement.clientWidth;
          // The element reaching furthest to the right, so a failure names the culprit.
          let worst = "";
          let right = width;
          for (const element of document.querySelectorAll("body *")) {
            const rect = element.getBoundingClientRect();
            if (rect.width > 0 && rect.right > right + 0.5) {
              right = rect.right;
              worst = `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`;
            }
          }
          return { scroll: document.documentElement.scrollWidth, width, worst, right };
        });
        expect(
          overflow.scroll,
          `${overflow.worst} reaches ${Math.round(overflow.right)} px of ${overflow.width} px`,
        ).toBeLessThanOrEqual(overflow.width);
      });
    }
  });
}
