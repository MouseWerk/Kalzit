import {
  type BrowserContext,
  type BrowserContextOptions,
  test as base,
  type ConsoleMessage,
  expect,
  type Page,
} from "@playwright/test";
import { join } from "node:path";
import { Api, baseUrl, fixturesDir, OWNER, regionDashboard, unique } from "./api";
import { t } from "./i18n";

interface Observed {
  text: string;
  url: string;
}

/**
 * Console output every page may show:
 * - Signed out, the sign-in page asks `GET /api/me`, which answers 401; browsers log that as a
 *   failed resource however the app handles it (ui/README.md, "Expected browser console entry").
 * - CodeMirror's style element is refused by `style-src 'self'` and mirrored into a constructed
 *   style sheet (editorStyles.ts); the browser still reports the refused element once.
 */
const ALWAYS_ALLOWED: readonly ((message: Observed) => boolean)[] = [
  (m) => /status of 401/.test(m.text) && m.url.endsWith("/api/me"),
  (m) => /inline style|style-src|Refused to apply a stylesheet/i.test(m.text),
];

export interface ConsoleGuard {
  /**
   * Declares console output this test expects, such as a failed request it provokes. The pattern
   * sees the message and the address it came from, as in "error: Failed to load ... <url>".
   */
  allow(pattern: RegExp): void;
  /** What the test allowed so far; contexts the test opens itself share it. */
  readonly allowed: readonly RegExp[];
}

function report(seen: readonly Observed[]): void {
  if (seen.length > 0) {
    throw new Error(
      `Unexpected browser console output:\n${seen.map((m) => `${m.text} (${m.url})`).join("\n")}`,
    );
  }
}

function observe(message: ConsoleMessage): Observed {
  return { text: `${message.type()}: ${message.text()}`, url: message.location().url };
}

/**
 * Watches every page of a context for console warnings and errors and for uncaught exceptions.
 * Anything not allowed fails the test at its end, so a broken page cannot pass by looking right.
 */
function guard(context: BrowserContext, allowed: readonly RegExp[], seen: Observed[]): void {
  const record = (observed: Observed) => {
    if (!ALWAYS_ALLOWED.some((ok) => ok(observed)) && !allowed.some((p) => p.test(`${observed.text} ${observed.url}`))) {
      seen.push(observed);
    }
  };
  context.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      record(observe(message));
    }
  });
  context.on("weberror", (error) => {
    record({ text: `uncaught: ${error.error().message}`, url: error.page()?.url() ?? "" });
  });
}

/** What the page checks look at: a data source and a dashboard with a variable and a panel. */
export interface World {
  sourceId: string;
  sourceName: string;
  dashboardId: string;
  dashboardTitle: string;
}

interface WorkerFixtures {
  world: World;
}

interface Fixtures {
  consoleGuard: ConsoleGuard;
  /** A page in a context of its own (another person, another language), signed in. */
  pageAs: (
    email: string,
    password: string,
    options?: BrowserContextOptions,
  ) => Promise<Page>;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  world: [
    async ({}, use) => {
      const owner = await Api.owner();
      const sourceName = unique("Seiten");
      const sourceId = await owner.createSqliteSource(sourceName, join(fixturesDir(), "sales.db"));
      const dashboardTitle = unique("Übersicht");
      const dashboardId = await owner.createDashboard(regionDashboard(dashboardTitle, sourceId));
      await owner.dispose();
      await use({ sourceId, sourceName, dashboardId, dashboardTitle });
    },
    { scope: "worker" },
  ],
  // The server picks a free port at start, so the address is known only after global setup.
  baseURL: async ({}, use) => {
    await use(baseUrl());
  },
  consoleGuard: [
    async ({ context }, use) => {
      const allowed: RegExp[] = [];
      const seen: Observed[] = [];
      guard(context, allowed, seen);
      await use({ allow: (pattern) => allowed.push(pattern), allowed });
      report(seen);
    },
    { auto: true },
  ],
  pageAs: async ({ browser, baseURL, consoleGuard }, use) => {
    const contexts: BrowserContext[] = [];
    const seen: Observed[] = [];
    await use(async (email, password, options = {}) => {
      const context = await browser.newContext({ baseURL, locale: "en-US", ...options });
      contexts.push(context);
      guard(context, consoleGuard.allowed, seen);
      const page = await context.newPage();
      await signIn(page, email, password, options.locale?.startsWith("de") ? "de" : "en");
      return page;
    });
    for (const context of contexts) {
      await context.close();
    }
    report(seen);
  },
});

export { expect };

/** Signs in through the sign-in page and waits for the app's navigation. */
export async function signIn(
  page: Page,
  email: string,
  password: string,
  language: "de" | "en" = "en",
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(t("login.email", {}, language)).fill(email);
  await page.getByLabel(t("login.password", {}, language), { exact: true }).fill(password);
  await page.getByRole("button", { name: t("login.submit", {}, language) }).click();
  await expect(page.getByRole("navigation", { name: t("nav.label", {}, language) })).toBeVisible();
}

export function signInOwner(page: Page, language: "de" | "en" = "en"): Promise<void> {
  return signIn(page, OWNER.email, OWNER.password, language);
}
