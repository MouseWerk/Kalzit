import type { Page } from "@playwright/test";
import { DIALOG_BODIES, findOverflow } from "./support/overflow";
import { MAIN_PAGES } from "./support/pages";
import { expect, signInOwner, test } from "./support/test";

async function expectNothingSticksOut(page: Page): Promise<void> {
  const overflow = await findOverflow(page);
  expect(overflow.offenders).toEqual([]);
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width);
}

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
        await expectNothingSticksOut(page);
      });
    }
  });
}

/**
 * Probes that the check above can fail: content too wide for a dialog whose body scrolls
 * (overflow: auto) must be caught, not hidden behind the body's scrollbar.
 */
test.describe("the overflow check itself", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  const PROBES = {
    "a 900 px block": (body: Element) => {
      const block = document.createElement("div");
      block.style.width = "900px";
      block.style.height = "4px";
      body.append(block);
    },
    // Preformatted, so it cannot wrap: a plain long word wraps in these dialogs by design
    // (overflow-wrap: break-word) and overflows nothing.
    "an unbreakable 80-character line": (body: Element) => {
      const line = document.createElement("pre");
      line.textContent = "x".repeat(80);
      body.append(line);
    },
  } as const;

  for (const [name, inject] of Object.entries(PROBES)) {
    for (const main of MAIN_PAGES.filter(
      (m) => m.name === "dashboard settings" || m.name === "add member",
    )) {
      test(`${name} in the ${main.name} dialog is caught`, async ({ page, world }) => {
        test.fail(true, "the probe makes the dialog too wide on purpose");
        await signInOwner(page);
        await page.goto(main.path(world));
        await main.ready(page, world, "en");
        await page.locator(DIALOG_BODIES).first().evaluate(inject);
        await expectNothingSticksOut(page);
      });
    }
  }
});
