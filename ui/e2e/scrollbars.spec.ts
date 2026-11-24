import type { Page } from "@playwright/test";
import { expect, signInOwner, test } from "./support/test";

/**
 * Calm, stable scrollbars: next to the sidebar the main area scrolls instead of the document,
 * with a stable gutter, so the sidebar and the top bar stay put; every scrollbar is thin and
 * drawn from the scrollbar tokens, stronger over the box under the pointer.
 */

/** A color token as the browser computes it, read through a probe in the main area. */
function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    (document.querySelector(".shell__main") ?? document.body).append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

function mainStyle(page: Page) {
  return page.locator(".shell__main").evaluate((main) => {
    const style = getComputedStyle(main);
    return {
      overflowY: style.overflowY,
      gutter: style.scrollbarGutter,
      width: style.scrollbarWidth,
      color: style.scrollbarColor,
    };
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 1280, height: 560 } });

    test("the main area scrolls with a stable gutter while the sidebar and top bar stay", async ({
      page,
    }) => {
      await signInOwner(page);
      await page.goto("/settings/appearance");
      await expect(page.locator(".settings-row").first()).toBeVisible();
      // The pointer rests on the sidebar: the main area shows its calm thumb.
      await page.mouse.move(4, 4);

      const style = await mainStyle(page);
      expect(style.overflowY).toBe("auto");
      expect(style.gutter).toBe("stable");
      expect(style.width).toBe("thin");
      const thumb = await tokenColor(page, "--scrollbar-thumb");
      expect(thumb).toMatch(/\/ 0\.\d+\)$|rgba\(/);
      expect(style.color).toBe(`${thumb} rgba(0, 0, 0, 0)`);

      // Over the main area its thumb turns stronger.
      const main = page.locator(".shell__main");
      const box = await main.boundingBox();
      if (box === null) throw new Error("no main area");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const hover = await tokenColor(page, "--scrollbar-thumb-hover");
      expect(hover).not.toBe(thumb);
      await expect
        .poll(async () => (await mainStyle(page)).color)
        .toBe(`${hover} rgba(0, 0, 0, 0)`);

      // Scrolling moves the main area, not the document; the bars do not move.
      await expect
        .poll(() =>
          main.evaluate((element) => {
            element.scrollTo(0, 4000);
            return element.scrollTop;
          }),
        )
        .toBeGreaterThan(200);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      expect((await page.locator(".top-bar").boundingBox())?.y).toBe(0);
      expect((await page.locator(".shell__sidebar").boundingBox())?.y).toBe(0);
      // The document itself never grows past the window.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollHeight <= document.documentElement.clientHeight,
        ),
      ).toBe(true);
    });

    test("the scroll keys scroll the main area on a page where nothing has focus", async ({
      page,
    }) => {
      await signInOwner(page);
      await page.goto("/settings/appearance");
      await expect(page.locator(".settings-row").first()).toBeVisible();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const main = page.locator(".shell__main");
      await page.keyboard.press("PageDown");
      await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
      await page.keyboard.press("End");
      await expect
        .poll(() =>
          main.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThan(2);
      await page.keyboard.press("Home");
      await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    });
  });
}

test("the scrollbar follows the theme variant", async ({ page }) => {
  await signInOwner(page);
  await page.goto("/settings/appearance");
  await page.mouse.move(4, 4);
  const light = await tokenColor(page, "--scrollbar-thumb");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.light = "paper";
  });
  const paper = await tokenColor(page, "--scrollbar-thumb");
  expect(paper).not.toBe(light);
  expect((await mainStyle(page)).color).toBe(`${paper} rgba(0, 0, 0, 0)`);
});

test("another page starts at its top, and Back returns to where the page was", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await signInOwner(page);
  await page.goto("/settings/appearance");
  await expect(page.locator(".settings-row").first()).toBeVisible();
  const main = page.locator(".shell__main");
  await expect
    .poll(() =>
      main.evaluate((element) => {
        element.scrollTo(0, 600);
        return element.scrollTop;
      }),
    )
    .toBeGreaterThan(200);
  const scrolled = await main.evaluate((element) => element.scrollTop);
  // An entry of the settings navigation, in the app (not a reload).
  await page.locator('.settings-nav__list a:not([aria-current="page"])').first().click();
  await expect(page).not.toHaveURL(/appearance/);
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(/appearance/);
  await expect
    .poll(async () => Math.abs((await main.evaluate((element) => element.scrollTop)) - scrolled))
    .toBeLessThan(2);
});

test("on a phone and on the sign-in page the document scrolls, thin and with a stable gutter", async ({
  page,
}) => {
  await page.goto("/login");
  const root = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return { gutter: style.scrollbarGutter, width: style.scrollbarWidth };
  });
  expect(root).toEqual({ gutter: "stable", width: "thin" });

  await page.setViewportSize({ width: 360, height: 640 });
  await signInOwner(page);
  expect((await mainStyle(page)).overflowY).toBe("visible");
});
