import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { baseUrl } from "../support/api";
import {
  auditFocus,
  auditLayout,
  CHECKS,
  contentHeight,
  type Finding,
  measure,
} from "../support/audit";
import { appRoutes, matchesRoute } from "../support/routes";
import { test as base, expect, signInOwner } from "../support/test";
import { ALLOWED } from "./allow";
import { type Extras, SWEEP_PAGES, type SweepPage, seedExtras, UNVISITED_ROUTES } from "./pages";
import {
  type PageResult,
  SWEEP_DIR,
  type Variant,
  type VariantResult,
  variantName,
} from "./report";

/**
 * The UI sweep (`npm run e2e:sweep`): every page in each theme, language and width, with the
 * checks of support/audit.ts. Findings go into the report (e2e/.output/ui-sweep), never into a
 * failed test; the checklist and the findings of the last pass are in
 * docs/quality/ui-pass-2026-11.md.
 */

const test = base.extend<object, { extras: Extras }>({
  extras: [
    async ({ world }, use) => {
      await use(await seedExtras(world));
    },
    { scope: "worker" },
  ],
});

const VARIANTS: Variant[] = (["light", "dark"] as const).flatMap((theme) =>
  (["en", "de"] as const).flatMap((language) =>
    [
      { width: 1440, height: 900 },
      { width: 1024, height: 768 },
      { width: 390, height: 844 },
    ].map((size) => ({ theme, language, ...size })),
  ),
);

const ONLY = new RegExp(process.env.KALZIT_SWEEP_PAGES ?? "", "i");
const PAGES = SWEEP_PAGES.filter((page) => ONLY.test(page.name));
/** The tallest screenshot; a longer page is cut there. */
const MAX_SHOT_HEIGHT = 6000;

const fileName = (name: string) => name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

/** Waits until the page stopped changing for a moment: data arrived, fonts are in. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) => {
      let timer = setTimeout(finish, 250);
      const limit = setTimeout(finish, 3000);
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(finish, 250);
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      function finish() {
        clearTimeout(timer);
        clearTimeout(limit);
        observer.disconnect();
        done();
      }
    });
  });
}

const problem = (kind: string, error: unknown): Finding => ({
  check: "open",
  severity: "broken",
  element: "",
  label: "",
  kind,
  detail: (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "",
});

async function visit(
  context: BrowserContext,
  sweepPage: SweepPage,
  variant: Variant,
  path: string,
  ready: (page: Page) => Promise<void>,
): Promise<PageResult> {
  const started = Date.now();
  const page = await context.newPage();
  const findings: Finding[] = [];
  const shot = join("shots", variantName(variant), `${fileName(sweepPage.name)}.jpg`);
  let reached = false;
  try {
    await sweepPage.prepare?.(page);
    await page.goto(path);
    await ready(page);
    await settle(page);
    reached = true;
    findings.push(...(await auditLayout(page, sweepPage.name, ALLOWED)));
  } catch (error) {
    findings.push(
      problem(reached ? "the checks did not run" : "the page did not reach its state", error),
    );
  }
  let shown: string | undefined;
  try {
    // The whole page in one picture: the window grows until nothing scrolls.
    const height = Math.min(await contentHeight(page), MAX_SHOT_HEIGHT);
    if (height > variant.height) {
      await page.setViewportSize({ width: variant.width, height });
      await settle(page);
    }
    const measured = await measure(page, findings);
    findings.splice(0, findings.length, ...measured);
    await page.screenshot({ path: join(SWEEP_DIR, shot), type: "jpeg", quality: 72 });
    shown = shot.replaceAll("\\", "/");
    if (reached) {
      findings.push(...(await auditFocus(page, sweepPage.name, ALLOWED)));
    }
  } catch (error) {
    findings.push(problem("the screenshot or the focus check did not run", error));
  }
  const url = new URL(page.url());
  await page.close();
  return {
    page: sweepPage.name,
    path,
    url: url.pathname,
    ...(shown === undefined ? {} : { shot: shown }),
    ms: Date.now() - started,
    findings: findings.map(({ ref: _ref, ...finding }) => finding),
  };
}

for (const variant of VARIANTS) {
  const locale = variant.language === "de" ? "de-DE" : "en-US";
  const viewport = { width: variant.width, height: variant.height };

  test.describe(`${variant.theme}, ${variant.language}, ${variant.width} px`, () => {
    test.use({ colorScheme: variant.theme, locale, viewport });

    test("every page", async ({ browser, context, page, world, extras, consoleGuard }) => {
      const started = Date.now();
      mkdirSync(join(SWEEP_DIR, "shots", variantName(variant)), { recursive: true });
      await signInOwner(page, variant.language);
      // The account follows the system's scheme, so the emulated one decides the theme.
      const scheme = await page.evaluate(() =>
        matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      );
      expect(scheme).toBe(variant.theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
      await expect(page.locator("html")).toHaveAttribute("lang", variant.language);
      await page.close();

      const visitor = await browser.newContext({
        baseURL: baseUrl(),
        locale,
        viewport,
        colorScheme: variant.theme,
        reducedMotion: "reduce",
      });
      const pages: PageResult[] = [];
      for (const sweepPage of PAGES) {
        const result = await visit(
          sweepPage.signedOut === true ? visitor : context,
          sweepPage,
          variant,
          sweepPage.path(world, extras),
          (opened) => sweepPage.ready(opened, world, variant.language),
        );
        // What the pages wrote to the console, with the page that wrote it.
        for (const line of await consoleGuard.drain()) {
          result.findings.push({
            check: "console",
            severity: "off",
            element: "",
            label: "",
            kind: line.replace(/https?:\/\/[^\s)]+/g, "<url>").slice(0, 160),
            detail: line,
          });
        }
        pages.push(result);
      }
      await visitor.close();

      const result: VariantResult = { variant, started, ended: Date.now(), pages };
      writeFileSync(
        join(SWEEP_DIR, "results", `${variantName(variant)}.json`),
        JSON.stringify(result),
      );
    });
  });
}

test.describe("the sweep itself", () => {
  test("knows every route of the router", () => {
    const paths = SWEEP_PAGES.map((page) =>
      page.path(
        { sourceId: "s", sourceName: "", dashboardId: "d", dashboardTitle: "" },
        {
          teamId: "t",
          roleId: "r",
          ruleId: "a",
          policyId: "p",
          rootPolicyId: "p0",
          analysisId: "e",
          playlistId: "l",
          reportId: "b",
        },
      ),
    );
    // Reached from another page (Edit, then the panel's menu or the toolbar), not by address.
    paths.push("/dashboards/d/panels/p1/edit", "/dashboards/d/settings");
    const unknown = appRoutes()
      .filter((route) => !route.redirectOnly && UNVISITED_ROUTES[route.pattern] === undefined)
      .filter((route) => !paths.some((path) => matchesRoute(route.pattern, path)))
      .map((route) => `${route.pattern} (${route.file})`);
    // A new route gets a page in sweep/pages.ts, or a reason in UNVISITED_ROUTES.
    expect(unknown).toEqual([]);
    expect(appRoutes().length).toBeGreaterThan(50);
  });

  /**
   * Probes that each check can find something: a page gets one fault of every kind, and the
   * audit has to name them all.
   */
  test("each check catches its probe", async ({ page }) => {
    await signInOwner(page);
    await page.goto("/admin/members");
    await expect(page.locator("main h1").first()).toBeVisible();
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.className = "sweep-probe";
      const add = <K extends keyof HTMLElementTagNameMap>(
        tag: K,
        style: Partial<CSSStyleDeclaration>,
        text = "",
        parent: Element = host,
      ) => {
        const element = document.createElement(tag);
        Object.assign(element.style, style);
        element.textContent = text;
        parent.append(element);
        return element;
      };
      const box = { border: "1px solid black", background: "white", padding: "0" };
      // Cut text without an ellipsis, and a label cut with one.
      add(
        "div",
        { width: "80px", overflow: "hidden", whiteSpace: "nowrap" },
        "Benachrichtigungsrichtlinien bearbeiten",
      );
      add(
        "h3",
        { width: "80px", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" },
        "Benachrichtigungsrichtlinien",
      );
      // Two buttons on top of each other.
      const stack = add("div", { position: "relative", height: "40px" });
      add(
        "button",
        { ...box, position: "absolute", left: "0", width: "120px", height: "32px" },
        "Speichern",
        stack,
      );
      add(
        "button",
        { ...box, position: "absolute", left: "60px", width: "120px", height: "32px" },
        "Verwerfen",
        stack,
      );
      // Two small targets side by side, without names.
      const tight = add("div", { display: "block" });
      add("button", { ...box, width: "16px", height: "16px", display: "inline-block" }, "", tight);
      add("button", { ...box, width: "16px", height: "16px", display: "inline-block" }, "", tight);
      // One row, two heights.
      const row = add("div", { display: "flex", gap: "8px", alignItems: "center" });
      add("button", { ...box, height: "32px", width: "90px" }, "Filter", row);
      add("button", { ...box, height: "40px", width: "90px" }, "Export", row);
      // Light grey on white.
      add("p", { color: "rgb(170, 170, 170)", background: "white" }, "Kaum zu lesen");
      // A current item framed in color.
      const current = add("div", { border: "2px solid orange", width: "120px" }, "Aktuell");
      current.setAttribute("aria-current", "page");
      // A control that shows no focus, and one with a colored ring.
      const blind = add(
        "button",
        { ...box, outline: "none", width: "90px", height: "32px" },
        "Ohne Ring",
      );
      blind.className = "probe-blind";
      const loud = add("button", { ...box, width: "90px", height: "32px" }, "Bunter Ring");
      loud.addEventListener("focus", () => {
        loud.style.outline = "2px solid rgb(0, 120, 255)";
      });
      document.querySelector("main")?.prepend(host);
    });
    const findings = [
      ...(await auditLayout(page, "probe", [])),
      ...(await auditFocus(page, "probe", [])),
    ].filter((finding) => finding.element.includes("sweep-probe"));
    const kinds = (check: string) =>
      findings.filter((finding) => finding.check === check).map((finding) => finding.kind);
    expect(kinds("clipped-text")).toContain("text cut off at the side without an ellipsis");
    expect(kinds("truncated")).toContain("label cut with an ellipsis, no title");
    expect(kinds("overlap").join()).toContain("overlaps");
    expect(kinds("target-size")).toContain("target under 24 px with another target next to it");
    expect(kinds("row-height")).toContain("controls of one row differ in height");
    expect(kinds("contrast")).toContain("text below 4.5:1");
    expect(kinds("name")).toContain("control without an accessible name");
    expect(kinds("state-frame")).toContain("selected or current state drawn with a colored border");
    expect(kinds("focus")).toContain("no visible keyboard focus");
    expect(kinds("focus")).toContain("focus ring is not neutral");
    // Every check of the list has a probe above.
    expect(new Set(findings.map((finding) => finding.check))).toEqual(
      new Set(CHECKS.filter((check) => check !== "overflow")),
    );
  });
});
