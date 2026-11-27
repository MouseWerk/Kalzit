import type { Page } from "@playwright/test";
import { baseUrl } from "./support/api";
import { t } from "./support/i18n";
import { expect, test } from "./support/test";

/**
 * The pages before the app on large and ultrawide monitors (docs/quality/ultrawide/auth.md):
 * the backdrop lies behind the text (UW-A1), and the sign-in background reaches the right edge of
 * the window on every width while the form column keeps its width (UW-A2).
 */

/** The darkest pixel of `selector`'s screenshot and the element's text colour, as 0-255 luminance. */
async function darkestAndText(page: Page, selector: string): Promise<[number, number]> {
  const shot = await page.locator(selector).first().screenshot();
  return page.evaluate(
    async ({ png, selector }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("no canvas");
      }
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
      let darkest = 255;
      for (let i = 0; i < data.length; i += 4) {
        darkest = Math.min(darkest, luma(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0));
      }
      const element = document.querySelector(selector);
      if (element === null) {
        throw new Error(`no ${selector}`);
      }
      // The computed colour in any colour space, read back through a 1 x 1 canvas.
      context.fillStyle = getComputedStyle(element).color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return [darkest, luma(r ?? 0, g ?? 0, b ?? 0)] as [number, number];
    },
    { png: shot.toString("base64"), selector },
  );
}

for (const [path, width] of [
  ["/help/getting-started", 1920],
  ["/login", 900],
] as const) {
  test(`keeps the backdrop behind the heading of ${path} at ${width} px`, async ({ page }) => {
    // The light stands still with reduced motion, so the place it falls on is the same each run.
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.setViewportSize({ width, height: 1080 });
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
    const [darkest, text] = await darkestAndText(page, "main h1");
    // The glyphs' cores are the text colour itself; the light over them would lift them.
    expect(Math.abs(darkest - text)).toBeLessThanOrEqual(6);
  });
}

for (const scheme of ["light", "dark"] as const) {
  for (const [width, height] of [
    [1920, 1080],
    [2560, 1440],
    [3440, 1440],
    [3840, 1600],
    [5120, 1440],
  ] as const) {
    test(`runs the sign-in background to the window's edge at ${width} px, ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height });
      await page.goto("/login");
      await expect(page.getByLabel(t("access.login.email"))).toBeVisible();
      const measure = await page.evaluate(() => {
        const box = (selector: string) => {
          const element = document.querySelector(selector);
          return element === null ? null : element.getBoundingClientRect();
        };
        return {
          window: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
          panel: box(".access__panel"),
          backdrop: box(".access__panel .access-bd"),
          flow: box(".access__flow"),
          brand: box(".access__brand"),
          tools: box(".access__tools"),
        };
      });
      expect(measure.scroll).toBe(measure.window);
      // The panel and its backdrop end at the window's edge, with no frame on that side.
      expect(Math.round(measure.panel?.right ?? 0)).toBe(measure.window);
      expect(Math.round(measure.backdrop?.right ?? 0)).toBeGreaterThanOrEqual(measure.window - 1);
      // The form column keeps its 400 px and shares its left edge with the mark.
      expect(Math.round(measure.flow?.width ?? 0)).toBe(400);
      expect(Math.abs((measure.flow?.left ?? 0) - (measure.brand?.left ?? 0))).toBeLessThanOrEqual(
        1,
      );
      // The sheet still stands in the middle: the form starts where a 1536 px sheet would put it.
      const gutter = Math.max(0, (measure.window - 1536) / 2);
      expect(measure.flow?.left ?? 0).toBeGreaterThanOrEqual(gutter);
      expect(measure.flow?.left ?? 0).toBeLessThanOrEqual(gutter + 64 + 1);
      // Language, theme and help stay in the sheet's corner.
      expect(measure.tools?.right ?? 0).toBeLessThanOrEqual(measure.window - gutter);
    });
  }
}

test("keeps the backdrop behind the text at 4K with 200 % scaling", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl()}/login`);
  await expect(page.locator(".access__panel")).toBeVisible();
  const right = await page.evaluate(
    () => document.querySelector(".access__panel")?.getBoundingClientRect().right ?? 0,
  );
  expect(Math.round(right)).toBe(1920);
  await context.close();
});
