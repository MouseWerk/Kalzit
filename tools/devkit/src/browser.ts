import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import type { Credentials, InstanceState } from "./instance/manager.ts";

export type Locale = "en" | "de";
export type Theme = "light" | "dark" | "contrast";

export interface Variant {
  locale: Locale;
  theme: Theme;
  width: number;
  height: number;
}

export function launch(): Promise<Browser> {
  return chromium.launch();
}

/**
 * A browser context at one variant: viewport, locale and color scheme, the page clock fixed to
 * the instance's fixture moment, and (unless signed out) the seeded owner signed in with the
 * variant's language and theme as account preferences. Language and theme are preferences of
 * the account, so variants run one after another, never in parallel on one instance.
 */
export async function openVariant(
  browser: Browser,
  state: InstanceState,
  credentials: Credentials,
  variant: Variant,
  signedOut: boolean,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: state.url,
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: 1,
    locale: variant.locale === "de" ? "de-DE" : "en-US",
    timezoneId: "Europe/Berlin",
    colorScheme: variant.theme === "dark" ? "dark" : "light",
  });
  const page = await context.newPage();
  if (state.fixedNow !== undefined) {
    await page.clock.setFixedTime(state.fixedNow);
  }
  if (!signedOut && credentials.owner !== undefined) {
    const login = await context.request.post("/api/auth/login", {
      data: { email: credentials.owner.email, password: credentials.owner.password },
    });
    if (!login.ok()) throw new Error(`sign-in failed: HTTP ${login.status()}`);
    const prefs = await context.request.patch("/api/me/preferences", {
      data: { language: variant.locale, theme: variant.theme },
    });
    if (!prefs.ok()) throw new Error(`setting preferences failed: HTTP ${prefs.status()}`);
  }
  return { context, page };
}

/** Lets requests, fonts and charts settle; no spinner, focus ring or hover in the picture. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page
    .waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0, null, {
      timeout: 8_000,
    })
    .catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => {});
  await page.mouse.move(0, 0);
}

export function variants(
  locales: readonly Locale[],
  themes: readonly Theme[],
  widths: readonly number[],
  height: number,
): Variant[] {
  return locales.flatMap((locale) =>
    themes.flatMap((theme) => widths.map((width) => ({ locale, theme, width, height }))),
  );
}
