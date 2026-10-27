import { join } from "node:path";
import {
  type BrowserContext,
  type BrowserContextOptions,
  test as base,
  type ConsoleMessage,
  expect,
  type Page,
} from "@playwright/test";
import { Api, baseUrl, fixturesDir, OWNER, OWNER_DE, regionDashboard, unique } from "./api";
import { t } from "./i18n";

interface Observed {
  text: string;
  url: string;
}

/**
 * Console output every page may show: signed out, the sign-in page asks `GET /api/me`, which
 * answers 401; browsers log that as a failed resource however the app handles it (ui/README.md,
 * "Expected browser console entry").
 */
const ALWAYS_ALLOWED: readonly ((message: Observed) => boolean)[] = [
  (m) => /status of 401/.test(m.text) && m.url.endsWith("/api/me"),
];

/**
 * The CSP notice for a refused inline style. CodeMirror writes its styles into a `<style>`
 * element, which `style-src 'self'` refuses; the UI mirrors it into a constructed style sheet
 * (editorStyles.ts), and the browser reports the refused element (again whenever CodeMirror
 * adds rules to it). WebKit's inspector, through which Playwright drives WebKit, adds a
 * `body {}` style of its own and reports refused sheets of its own when a page loads, also with
 * the app's scripts blocked. A notice passes only while no other `<style>` was ever added to the
 * document, and only up to a budget (per permitted style write, plus WebKit's own at load), so
 * an inline style the policy hides fails the test however the browser words its report.
 */
const STYLE_NOTICE = /inline style|style-src|Refused to apply a stylesheet/i;
/** WebKit reports one refused sheet up to three times as the page's style sheets load. */
const NOTICES_PER_STYLE_WRITE = 3;
/** Notices WebKit's inspector causes in every loaded document, seen as up to three. */
const WEBKIT_NOTICES_PER_DOCUMENT = 3;

/**
 * Runs in every document before its scripts: counts the `<style>` writes that may cause a
 * notice (CodeMirror's element, the WebKit inspector's `body {}`) and records any other.
 */
function recordStyleWrites(): void {
  const log = {
    doc: Math.random().toString(36).slice(2),
    permitted: 0,
    foreign: [] as string[],
    refusedAttributes: [] as string[],
  };
  (window as unknown as { __kalzitStyles: typeof log }).__kalzitStyles = log;
  // A style attribute the policy refused keeps its text but applies no declaration. Writes
  // through the CSSOM (element.style, as React does) are allowed and always apply.
  const checkAttribute = (element: Element) => {
    const text = element.getAttribute("style")?.trim() ?? "";
    const applied = (element as HTMLElement).style?.length ?? 0;
    if (text !== "" && applied === 0 && element.closest('[class*="cm-"]') === null) {
      log.refusedAttributes.push(`<${element.tagName.toLowerCase()} style="${text.slice(0, 60)}">`);
    }
  };
  const classify = (style: HTMLStyleElement) => {
    const text = (style.textContent ?? "").trim();
    if (text.includes(".cm-") || text === "body {}") {
      log.permitted += 1;
    } else if (text !== "") {
      log.foreign.push(text.slice(0, 80));
    }
  };
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        checkAttribute(record.target as Element);
        continue;
      }
      // New text in a style element: the element itself, or a text node inside it.
      const owner = record.target instanceof Text ? record.target.parentElement : record.target;
      if (owner instanceof HTMLStyleElement) {
        classify(owner);
        continue;
      }
      for (const node of record.addedNodes) {
        if (node instanceof HTMLStyleElement) {
          classify(node);
        }
        // Markup inserted with style attributes (innerHTML) brings no attribute record.
        if (node instanceof Element) {
          for (const styled of [node, ...node.querySelectorAll("[style]")]) {
            if (styled.hasAttribute("style")) {
              checkAttribute(styled);
            }
          }
        }
      }
    }
  }).observe(document, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style"],
  });
}

interface StyleLog {
  doc: string;
  permitted: number;
  foreign: string[];
  refusedAttributes: string[];
}

function styleLog(page: Page): Promise<StyleLog | null> {
  return page
    .evaluate(() => (window as unknown as { __kalzitStyles?: StyleLog }).__kalzitStyles ?? null)
    .catch(() => null);
}

export interface ConsoleGuard {
  /**
   * Declares console output this test expects, such as a failed request it provokes. The pattern
   * sees the message and the address it came from, as in "error: Failed to load ... <url>".
   */
  allow(pattern: RegExp): void;
  /** What the test allowed so far; contexts the test opens itself share it. */
  readonly allowed: readonly RegExp[];
}

function observe(message: ConsoleMessage): Observed {
  return { text: `${message.type()}: ${message.text()}`, url: message.location().url };
}

/**
 * Charts measure their box in a ResizeObserver callback and render in it (useElementSize). A
 * render that changes the size again makes the browser report "ResizeObserver loop ..." as an
 * error event on the window, which no console listener sees; this turns it into a console error,
 * so the guard fails the test.
 */
function reportResizeLoops(): void {
  window.addEventListener("error", (event) => {
    if (typeof event.message === "string" && event.message.includes("ResizeObserver loop")) {
      // biome-ignore lint/suspicious/noConsole: the guard fails the test on console errors.
      console.error(`uncaught: ${event.message}`);
    }
  });
}

/**
 * Watches every page of a context for console warnings and errors and for uncaught exceptions.
 * Anything not allowed fails the test at its end, so a broken page cannot pass by looking right.
 */
class Guard {
  private readonly seen: Observed[] = [];
  private readonly checks: Promise<void>[] = [];
  /** Style notices so far, per document. */
  private readonly notices = new Map<string, number>();
  private baseline = 0;

  constructor(private readonly allowed: readonly RegExp[]) {}

  async watch(context: BrowserContext): Promise<void> {
    await context.addInitScript(recordStyleWrites);
    await context.addInitScript(reportResizeLoops);
    if (context.browser()?.browserType().name() === "webkit") {
      this.baseline = WEBKIT_NOTICES_PER_DOCUMENT;
    }
    context.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        this.consider(observe(message), message.page());
      }
    });
    context.on("weberror", (error) => {
      const url = error.page()?.url() ?? "";
      this.consider({ text: `uncaught: ${error.error().message}`, url }, null);
    });
  }

  private consider(observed: Observed, page: Page | null): void {
    if (
      ALWAYS_ALLOWED.some((ok) => ok(observed)) ||
      this.allowed.some((p) => p.test(`${observed.text} ${observed.url}`))
    ) {
      return;
    }
    if (page === null || !STYLE_NOTICE.test(observed.text)) {
      this.seen.push(observed);
      return;
    }
    this.checks.push(
      styleLog(page).then((log) => {
        const problem = this.styleProblem(log);
        if (problem !== null) {
          this.seen.push({ ...observed, text: `${observed.text} [${problem}]` });
        }
      }),
    );
  }

  private styleProblem(log: StyleLog | null): string | null {
    if (log === null) {
      return "the page's style writes could not be read";
    }
    // A refused style attribute fails whatever the budget: nothing in the app may write one.
    if (log.refusedAttributes.length > 0) {
      return `refused style attribute: ${log.refusedAttributes.join(" | ")}`;
    }
    if (log.foreign.length > 0) {
      return `inline style that is not CodeMirror's: ${log.foreign.join(" | ")}`;
    }
    const count = (this.notices.get(log.doc) ?? 0) + 1;
    this.notices.set(log.doc, count);
    const budget = this.baseline + NOTICES_PER_STYLE_WRITE * log.permitted;
    return count > budget ? `style notice ${count}, expected at most ${budget}` : null;
  }

  async finish(): Promise<void> {
    await Promise.all(this.checks);
    if (this.seen.length > 0) {
      const lines = this.seen.map((m) => `${m.text} (${m.url})`);
      throw new Error(`Unexpected browser console output:\n${lines.join("\n")}`);
    }
  }
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
  pageAs: (email: string, password: string, options?: BrowserContextOptions) => Promise<Page>;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  world: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures a function takes from this pattern
    async ({}, use) => {
      const owner = await Api.owner();
      // A long name, as people give them: selects and lists have to fit it at 360 px.
      const sourceName = unique("Umsatzdaten der Regionen Nord, Ost, Süd und West");
      const sourceId = await owner.createSqliteSource(sourceName, join(fixturesDir(), "sales.db"));
      const dashboardTitle = unique("Übersicht");
      const dashboardId = await owner.createDashboard(regionDashboard(dashboardTitle, sourceId));
      await owner.dispose();
      await use({ sourceId, sourceName, dashboardId, dashboardTitle });
    },
    { scope: "worker" },
  ],
  // The server picks a free port at start, so the address is known only after global setup.
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures a function takes from this pattern
  baseURL: async ({}, use) => {
    await use(baseUrl());
  },
  consoleGuard: [
    async ({ context }, use) => {
      const allowed: RegExp[] = [];
      const guard = new Guard(allowed);
      await guard.watch(context);
      await use({ allow: (pattern) => allowed.push(pattern), allowed });
      await guard.finish();
    },
    { auto: true },
  ],
  pageAs: async ({ browser, consoleGuard }, use) => {
    const contexts: BrowserContext[] = [];
    const guard = new Guard(consoleGuard.allowed);
    await use(async (email, password, options = {}) => {
      const context = await browser.newContext({ baseURL: baseUrl(), locale: "en-US", ...options });
      contexts.push(context);
      await guard.watch(context);
      const page = await context.newPage();
      await signIn(page, email, password, options.locale?.startsWith("de") ? "de" : "en");
      return page;
    });
    // Checked while the pages are open, so pending style checks can still look at them.
    try {
      await guard.finish();
    } finally {
      for (const context of contexts) {
        await context.close();
      }
    }
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
  await page.getByLabel(t("access.login.email", {}, language)).fill(email);
  await page.getByLabel(t("access.login.password", {}, language), { exact: true }).fill(password);
  await page.getByRole("button", { name: t("access.login.submit", {}, language) }).click();
  await expect(page.getByRole("navigation", { name: t("nav.label", {}, language) })).toBeVisible();
}

/** Signs in as the owner, or as the owner's German twin for German runs. */
export function signInOwner(page: Page, language: "de" | "en" = "en"): Promise<void> {
  return language === "de"
    ? signIn(page, OWNER_DE.email, OWNER_DE.password, language)
    : signIn(page, OWNER.email, OWNER.password, language);
}
