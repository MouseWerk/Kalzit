import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { MAIN_PAGES } from "./support/pages";
import { expect, signInOwner, test } from "./support/test";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/** Serious and critical axe findings, with the first elements of each, readable in a failure. */
async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 5)
        .map((n) => `    ${n.target.join(" ")}: ${n.failureSummary?.replace(/\s+/g, " ")}`);
      return `${v.id} (${v.impact}): ${v.help}\n${nodes.join("\n")}`;
    });
}

test("sign-in page: no serious accessibility violations", async ({ browser, baseURL }) => {
  // Signed out, as a visitor sees it.
  const context = await browser.newContext({ baseURL, locale: "en-US" });
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
