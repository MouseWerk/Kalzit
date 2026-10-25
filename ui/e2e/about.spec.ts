import type { Page } from "@playwright/test";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

// Settings, About against the real server and the real bundle: the build the server reports, the
// license list the build wrote (Rust crates and npm packages), and the calcite crystal, which
// moves normally and holds still with reduced motion.

const CANVAS = ".about-crystal__canvas";

/** A fingerprint of what the crystal's canvas shows right now, and whether it shows anything. */
async function picture(page: Page): Promise<{ drawn: boolean; data: string }> {
  return page.evaluate((selector) => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector);
    if (canvas == null) {
      return { drawn: false, data: "" };
    }
    const blank = document.createElement("canvas");
    blank.width = canvas.width;
    blank.height = canvas.height;
    const data = canvas.toDataURL();
    return { drawn: data !== blank.toDataURL(), data };
  }, CANVAS);
}

test("shows the build, the company, the license and the shipped packages", async ({ page }) => {
  await signInOwner(page, "en");
  await page.goto("/settings/about");
  await expect(
    page.getByRole("heading", { level: 2, name: t("settings.section.about.label") }),
  ).toBeVisible();

  const product = page.getByRole("region", { name: t("settings.about.product") });
  await expect(product.getByText(/^\d+\.\d+\.\d+/).first()).toBeVisible();
  await expect(product.getByText(/^(SQLite|PostgreSQL)$/)).toBeVisible();
  await expect(product.getByText(/^\d{4}-\d{2}-\d{2}$/)).toBeVisible();

  const license = page.getByRole("region", { name: t("settings.about.license") });
  await expect(license.getByText(t("settings.about.licenseName"))).toBeVisible();

  // The list written at build time holds crates and npm packages with their licenses.
  const list = page.getByRole("region", { name: t("settings.about.licenseList") });
  await expect(list.getByRole("rowheader", { name: "axum", exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: t("settings.about.licenseSearch") }).fill("react");
  await expect(list.getByRole("rowheader", { name: "react", exact: true })).toBeVisible();
  await expect(list.getByRole("rowheader", { name: "axum", exact: true })).toHaveCount(0);
  expect(await seriousViolations(page)).toEqual([]);

  // The license texts the build wrote are served, as UTF-8 text, and the page links them.
  const notices = await page.request.get("/THIRD-PARTY-NOTICES.txt");
  expect(notices.ok()).toBe(true);
  expect(notices.headers()["content-type"]).toBe("text/plain; charset=utf-8");
  const text = await notices.text();
  expect(text).toContain("axum");
  expect(text).toContain("Permission is hereby granted");
  await expect(
    page.getByRole("link", { name: new RegExp(`^${t("settings.about.notices")}`) }),
  ).toHaveAttribute("href", "/THIRD-PARTY-NOTICES.txt");
});

async function openCrystal(page: Page) {
  await signInOwner(page, "en");
  await page.goto("/settings/about");
  await expect(page.locator(CANVAS)).toBeVisible();
  await expect.poll(async () => (await picture(page)).drawn).toBe(true);
}

test.describe("with motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("the crystal turns and the beam travels", async ({ page }) => {
    await openCrystal(page);
    const first = (await picture(page)).data;
    await expect.poll(async () => (await picture(page)).data, { timeout: 8000 }).not.toBe(first);
  });

  test("the crystal stops while the page is hidden", async ({ page }) => {
    await openCrystal(page);
    // Hidden by scrolling it out of view: no frames are drawn until it returns.
    await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "4000px";
      spacer.id = "e2e-spacer";
      document.querySelector(".about-card:last-child")?.before(spacer);
    });
    await page.locator(".about-card:last-child").scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    const away = (await picture(page)).data;
    await page.waitForTimeout(1500);
    expect((await picture(page)).data).toBe(away);
  });
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the crystal shows one still picture", async ({ page }) => {
    await openCrystal(page);
    const first = (await picture(page)).data;
    await page.waitForTimeout(2000);
    expect((await picture(page)).data).toBe(first);
  });
});
