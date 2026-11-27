import type { Page, TestInfo } from "@playwright/test";
import { Api, baseUrl, OWNER, unique } from "./support/api";
import { t } from "./support/i18n";
import { findOverflow } from "./support/overflow";
import { expect, test } from "./support/test";

/**
 * The picture in the panel of the pages before the app (board Auth.dc.html, frames 3A, 13 and
 * 14): the crystal with table, document and graph next to the form from 1024 px, in a panel that
 * reaches the window's right edge at every width (finding UW-A2); still, except for the one light
 * after a sign-in; gone on narrow screens, in forced colors and where the server turned it off
 * (`signin.backdrop`). Every size attaches its picture to the report, in light and dark.
 *
 * One after another: the last tests change the server's setting, which every sign-in page reads.
 */
test.describe.configure({ mode: "serial" });

interface Size {
  name: string;
  width: number;
  height: number;
  scale: number;
}

const SIZES: readonly Size[] = [
  { name: "360", width: 360, height: 780, scale: 1 },
  { name: "1024", width: 1024, height: 768, scale: 1 },
  { name: "1280", width: 1280, height: 800, scale: 1 },
  { name: "1920", width: 1920, height: 1080, scale: 1 },
  { name: "3440", width: 3440, height: 1440, scale: 1 },
  { name: "5120x1440", width: 5120, height: 1440, scale: 1 },
  // A 4K screen at 200 %: 1920 by 1080 CSS pixels, two device pixels each.
  { name: "4K at 200 percent", width: 1920, height: 1080, scale: 2 },
];

/** From this width the form and the panel stand side by side (auth.css, 64rem). */
const SPLIT_FROM = 1024;
/** The panel's distance to the window's edge (--space-3). */
const PANEL_INSET = 12;
/** The form column (--size-access-column). */
const COLUMN = 400;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) {
    throw new Error(`${selector} has no box`);
  }
  return box;
}

async function attach(page: Page, testInfo: TestInfo, name: string): Promise<Buffer> {
  await page.evaluate(() => document.fonts.ready);
  const picture = await page.screenshot({ caret: "hide" });
  await testInfo.attach(name, { body: picture, contentType: "image/png" });
  return picture;
}

async function openSignIn(page: Page): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The server's answer about the picture is in.
  await page.waitForLoadState("networkidle");
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const size of SIZES) {
    test.describe(`sign-in picture at ${size.name}, ${colorScheme}`, () => {
      test.use({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.scale,
        colorScheme,
      });

      test("fits its panel, sharp and still", async ({ page }, testInfo) => {
        await openSignIn(page);
        const overflow = await findOverflow(page);
        expect(overflow.offenders).toEqual([]);
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width);
        const flow = await boxOf(page, ".access__flow");
        expect(flow.width).toBeLessThanOrEqual(COLUMN + 0.5);

        if (size.width < SPLIT_FROM) {
          // One column: no panel and no picture, so the form is reached without scrolling.
          await expect(page.locator(".access-bd")).toBeHidden();
          await attach(page, testInfo, `sign-in ${size.name} ${colorScheme}`);
          return;
        }

        await expect(page.locator(".access-art")).toBeVisible();
        // The form column is as wide as on every screen; the panel ends at the window's edge.
        expect(flow.width).toBeGreaterThanOrEqual(COLUMN - 0.5);
        const panel = await boxOf(page, ".access__panel");
        expect(Math.abs(panel.x + panel.width - (size.width - PANEL_INSET))).toBeLessThanOrEqual(1);
        expect(panel.x).toBeGreaterThanOrEqual(flow.x + flow.width);
        // The whole crystal lies inside the panel, clear of the tools above and the line below.
        const crystal = await boxOf(page, ".access-art__edge");
        const tools = await boxOf(page, ".access__tools");
        const line = await boxOf(page, ".access__say");
        expect(crystal.x).toBeGreaterThanOrEqual(panel.x);
        expect(crystal.x + crystal.width).toBeLessThanOrEqual(panel.x + panel.width);
        expect(crystal.y).toBeGreaterThanOrEqual(tools.y + tools.height);
        expect(crystal.y + crystal.height).toBeLessThanOrEqual(line.y);
        // Large enough to read as the face of the page, at every size.
        expect(crystal.height).toBeGreaterThanOrEqual(panel.height * 0.35);

        // Hairlines that keep their width however large the drawing is; no image file.
        const drawn = await page.evaluate(() => {
          const style = (selector: string) => {
            const element = document.querySelector(selector);
            return element === null ? null : getComputedStyle(element);
          };
          const line = style(".access-art__behind--near .access-art__line");
          const edge = style(".access-art__edge");
          return {
            line: line?.strokeWidth,
            edge: edge?.strokeWidth,
            vector: edge?.getPropertyValue("vector-effect"),
            stroke: edge?.stroke,
            images: document.querySelectorAll(".access-bd image, .access-bd img").length,
            background: style(".access-bd")?.backgroundImage,
          };
        });
        const tall = panel.height >= 1200;
        expect(drawn.line).toBe(tall ? "1.5px" : "1px");
        expect(drawn.edge).toBe(tall ? "2px" : "1.5px");
        expect(drawn.vector).toBe("non-scaling-stroke");
        expect(drawn.images).toBe(0);
        expect(drawn.background).toBe("none");

        // Still: with motion allowed, two pictures half a second apart are the same.
        await page.emulateMedia({ reducedMotion: "no-preference", colorScheme });
        const first = await attach(page, testInfo, `sign-in ${size.name} ${colorScheme}`);
        await page.waitForTimeout(500);
        const second = await page.screenshot({ caret: "hide" });
        expect(first.equals(second)).toBe(true);
      });
    });
  }
}

test.describe("sign-in picture, movement and fallbacks", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** Notes in the page whether the light was ever switched on. */
  async function watchLight(page: Page): Promise<void> {
    await page.addInitScript(() => {
      new MutationObserver((records) => {
        for (const record of records) {
          if ((record.target as Element).hasAttribute("data-lit")) {
            (window as unknown as { __lit: boolean }).__lit = true;
          }
        }
      }).observe(document, { attributes: true, attributeFilter: ["data-lit"], subtree: true });
    });
  }

  async function signInAsOwner(page: Page): Promise<void> {
    await page.getByLabel(t("access.login.email")).fill(OWNER.email);
    await page.getByLabel(t("access.login.password"), { exact: true }).fill(OWNER.password);
    await page.getByRole("button", { name: t("access.login.submit"), exact: true }).click();
    await expect(page.getByRole("navigation", { name: t("nav.label") })).toBeVisible();
  }

  const wasLit = (page: Page) =>
    page.evaluate(() => (window as unknown as { __lit?: boolean }).__lit === true);

  test("a light runs over the crystal's edges once after a sign-in, then the app opens", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await watchLight(page);
    await openSignIn(page);
    // Nothing moves before: no animation runs on the page's picture.
    expect(
      await page.evaluate(
        () => document.querySelector(".access-bd")?.getAnimations({ subtree: true }).length,
      ),
    ).toBe(0);
    await signInAsOwner(page);
    expect(await wasLit(page)).toBe(true);
  });

  test("nothing moves for reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await watchLight(page);
    await openSignIn(page);
    await signInAsOwner(page);
    expect(await wasLit(page)).toBe(false);
  });

  test("forced colors show a plain panel without the picture", async ({ page }, testInfo) => {
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "no-preference" });
    await watchLight(page);
    await openSignIn(page);
    await expect(page.locator(".access-bd")).toBeHidden();
    await expect(page.locator(".access__panel")).toBeVisible();
    await expect(page.locator(".access__say")).toBeVisible();
    await attach(page, testInfo, "sign-in forced colors");
    await signInAsOwner(page);
    expect(await wasLit(page)).toBe(false);
  });

  test("the contrast theme shows a plain panel without the picture", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("kalzit.theme", "contrast"));
    await openSignIn(page);
    await expect(page.locator(".access-bd")).toBeHidden();
    await expect(page.locator(".access__panel")).toBeVisible();
  });

  test("the error page stands in the same frame while the server does not answer", async ({
    page,
    consoleGuard,
  }, testInfo) => {
    consoleGuard.allow(/Failed to load resource|net::ERR_FAILED|Failed to fetch|route match/);
    await page.route(
      (url) => url.pathname.startsWith("/api/"),
      (route) => route.abort("connectionrefused"),
    );
    await page.goto("/login");
    const heading = page.getByRole("heading", {
      level: 1,
      name: t("errorPage.title", { product: "Kalzit" }),
    });
    await expect(heading).toBeVisible();
    await expect(page.getByRole("alert").filter({ has: heading })).toBeVisible();
    await expect(page.getByText(t("errors.network"))).toBeVisible();
    // The frame: the mark, language, theme and help, and the panel with its picture.
    await expect(page.getByRole("link", { name: t("access.top.help") })).toBeVisible();
    await expect(page.locator(".access__panel .access-art")).toBeVisible();
    const overflow = await findOverflow(page);
    expect(overflow.offenders).toEqual([]);
    await attach(page, testInfo, "error page in the frame");
    // The server is back: one click leads to the form.
    await page.unroute((url) => url.pathname.startsWith("/api/"));
    await page.unrouteAll({ behavior: "wait" });
    await page.getByRole("button", { name: t("common.retry") }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: t("access.login.title") }),
    ).toBeVisible();
  });
});

test.describe("sign-in picture, the server's switch", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("only a server admin may turn the picture off", async ({ playwright }) => {
    const owner = await Api.owner();
    try {
      const member = await owner.createMember(unique("Vera Viewer"), "viewer");
      const viewer = await Api.signIn(member.email, member.password);
      const refused = await viewer.context.patch("/api/admin/settings/signin.backdrop", {
        data: { value: false, version: 0 },
      });
      expect(refused.status()).toBe(403);
      await viewer.dispose();
      const anonymous = await playwright.request.newContext({ baseURL: baseUrl() });
      const unknown = await anonymous.patch("/api/admin/settings/signin.backdrop", {
        data: { value: false, version: 0 },
      });
      expect(unknown.status()).toBe(401);
      const branding = (await (await anonymous.get("/api/branding")).json()) as {
        signIn: { backdrop: boolean };
      };
      expect(branding.signIn.backdrop).toBe(true);
      await anonymous.dispose();
    } finally {
      await owner.dispose();
    }
  });

  test("Settings > Appearance turns it off at once, and Undo brings it back", async ({
    page,
    pageAs,
    consoleGuard,
  }, testInfo) => {
    consoleGuard.allow(/status of 401/);
    const label = t("admin.settings.signin.backdrop.label");
    const admin = await pageAs(OWNER.email, OWNER.password, {
      viewport: { width: 1440, height: 900 },
    });
    try {
      await admin.goto("/settings/appearance");
      const picture = admin.getByRole("switch", { name: label });
      await expect(picture).toBeChecked();
      await picture.click();
      await expect(admin.getByText(t("admin.settings.saved", { name: label }))).toBeVisible();

      // A visitor sees the plain panel on the next page load, with the line on the product.
      await openSignIn(page);
      await expect(page.locator(".access__panel")).toBeVisible();
      await expect(page.locator(".access-bd")).toHaveCount(0);
      await expect(page.locator(".access__say")).toBeVisible();
      await attach(page, testInfo, "sign-in without the picture");

      await admin.getByRole("button", { name: t("common.undo") }).click();
      await expect(picture).toBeChecked();
      await page.reload();
      await expect(page.locator(".access-art")).toBeVisible();
    } finally {
      // Whatever happened above, the other tests find the picture on.
      const owner = await Api.owner();
      const list = (await (await owner.context.get("/api/admin/settings")).json()) as {
        items: { key: string; version: number; value: unknown }[];
      };
      const setting = list.items.find((item) => item.key === "signin.backdrop");
      if (setting !== undefined && setting.value !== true) {
        await owner.context.patch("/api/admin/settings/signin.backdrop", {
          data: { value: true, version: setting.version },
        });
      }
      await owner.dispose();
    }
  });
});
