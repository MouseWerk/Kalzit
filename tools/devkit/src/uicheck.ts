import { writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "playwright";
import { type Locale, launch, openVariant, settle, type Theme, variants } from "./browser.ts";
import { resetPreferences } from "./capture.ts";
import { findInstance } from "./instance/manager.ts";
import { outDir, stamp } from "./paths.ts";
import { resolvePath, selectScreens } from "./screens.ts";

/** The axe rule sets of ui/e2e/support/axe.ts. */
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

export type FindingKind = "axe" | "overflow" | "clipped" | "console";

export interface Finding {
  kind: FindingKind;
  screen: string;
  path: string;
  locale: Locale;
  theme: Theme;
  width: number;
  /** The axe rule, or the kind of console message. */
  rule?: string;
  impact?: string;
  selector?: string;
  message: string;
}

export interface UiCheckOptions {
  instance?: string;
  screens?: string[];
  locales?: Locale[];
  themes?: Theme[];
  widths?: number[];
  height?: number;
  /** Which checks to run (default all four). */
  checks?: FindingKind[];
  /** axe impacts to report (default serious and critical). */
  impacts?: string[];
}

export interface UiCheckReport {
  instance: string;
  url: string;
  pagesChecked: number;
  counts: Record<FindingKind, number>;
  findings: Finding[];
  json: string;
  markdown: string;
}

interface LayoutProblem {
  selector: string;
  message: string;
}

/**
 * Runs in the page: elements that stick out to the right of the viewport (or their dialog)
 * without an ancestor that clips or scrolls them on purpose (the rule of
 * ui/e2e/support/overflow.ts), and text cut off by a box that hides its overflow without an
 * ellipsis or line clamp.
 */
function inspectLayout(): { overflow: LayoutProblem[]; clipped: LayoutProblem[] } {
  const cssPath = (element: Element): string => {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node !== null && node !== document.body && parts.length < 5) {
      if (node.id !== "") {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const classes = [...node.classList]
        .slice(0, 2)
        .map((c) => `.${CSS.escape(c)}`)
        .join("");
      part += classes;
      const parent: Element | null = node.parentElement;
      if (parent !== null) {
        const same = [...parent.children].filter((c) => c.tagName === node?.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  const width = document.documentElement.clientWidth;
  const dialogs = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"]')];
  const bodies = ".dialog__body, .admin-dialog__body";
  const found: { element: Element; message: string; by: number }[] = [];
  const clipped: LayoutProblem[] = [];
  for (const element of document.querySelectorAll<HTMLElement>("body *")) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const dialog = dialogs.find((d) => d !== element && d.contains(element));
    const limit =
      dialog === undefined ? width : Math.min(width, dialog.getBoundingClientRect().right);
    let exempt = false;
    const isDialog = dialogs.includes(element);
    for (
      let a = isDialog ? null : element.parentElement;
      a !== null && a !== dialog;
      a = a.parentElement
    ) {
      if (dialog !== undefined && a.matches(bodies)) continue;
      const overflowX = getComputedStyle(a).overflowX;
      if (
        overflowX === "auto" ||
        overflowX === "scroll" ||
        (dialog === undefined && overflowX !== "visible")
      ) {
        exempt = true;
        break;
      }
    }
    if (!exempt && rect.right > limit + 0.5) {
      found.push({
        element,
        message: `reaches ${Math.round(rect.right)} px, allowed ${Math.round(limit)} px`,
        by: rect.right - limit,
      });
    }
    // Clipped text: a box with its own text that hides overflow and is smaller than its content.
    const style = getComputedStyle(element);
    const hides = (v: string) => v === "hidden" || v === "clip";
    const ownText = [...element.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "",
    );
    if (
      ownText &&
      style.textOverflow !== "ellipsis" &&
      style.webkitLineClamp === "none" &&
      ((hides(style.overflowX) && element.scrollWidth > element.clientWidth + 1) ||
        (hides(style.overflowY) && element.scrollHeight > element.clientHeight + 1))
    ) {
      const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
      clipped.push({
        selector: cssPath(element),
        message: `text "${text}" is cut off: ${element.scrollWidth}x${element.scrollHeight} px of content in ${element.clientWidth}x${element.clientHeight} px`,
      });
    }
  }
  for (const dialog of dialogs) {
    for (const body of dialog.querySelectorAll<HTMLElement>(bodies)) {
      if (body.scrollWidth > body.clientWidth + 1) {
        found.push({
          element: body,
          message: `dialog body scrolls sideways: ${body.scrollWidth} px of content in ${body.clientWidth} px`,
          by: body.scrollWidth - body.clientWidth,
        });
      }
    }
  }
  const innermost = (f: (typeof found)[number]) =>
    !found.some((other) => other !== f && f.element.contains(other.element));
  return {
    overflow: found
      .filter(innermost)
      .sort((a, b) => b.by - a.by)
      .slice(0, 10)
      .map((f) => ({ selector: cssPath(f.element), message: f.message })),
    clipped: clipped.slice(0, 20),
  };
}

async function axeFindings(
  page: Page,
  impacts: readonly string[],
): Promise<Omit<Finding, "screen" | "path" | "locale" | "theme" | "width">[]> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations
    .filter((v) => impacts.includes(v.impact ?? ""))
    .flatMap((v) =>
      v.nodes.slice(0, 5).map((n) => {
        const finding: Omit<Finding, "screen" | "path" | "locale" | "theme" | "width"> = {
          kind: "axe",
          rule: v.id,
          selector: n.target.join(" "),
          message: `${v.help}: ${(n.failureSummary ?? "").replace(/\s+/g, " ").trim()}`,
        };
        if (v.impact != null) finding.impact = v.impact;
        return finding;
      }),
    );
}

export async function uiCheck(options: UiCheckOptions): Promise<UiCheckReport> {
  const { state, credentials } = findInstance(options.instance);
  const checks = new Set<FindingKind>(options.checks ?? ["axe", "overflow", "clipped", "console"]);
  const impacts = options.impacts ?? ["serious", "critical"];
  const screens = selectScreens(options.screens, state);
  const findings: Finding[] = [];
  let pagesChecked = 0;
  const browser = await launch();
  try {
    for (const variant of variants(
      options.locales ?? ["en"],
      options.themes ?? ["light"],
      options.widths ?? [1440, 1024],
      options.height ?? 900,
    )) {
      // One signed-in and one signed-out page per variant, so a run signs in once per variant.
      const consoleErrors: string[] = [];
      const sessions = await Promise.all(
        [false, true].map((signedOut) =>
          openVariant(browser, state, credentials, variant, signedOut),
        ),
      );
      for (const { page } of sessions) {
        page.on("console", (message) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        });
        page.on("pageerror", (error) => consoleErrors.push(`uncaught: ${error.message}`));
      }
      for (const screen of screens) {
        const page = (screen.signedOut === true ? sessions[1] : sessions[0])?.page;
        if (page === undefined) continue;
        consoleErrors.length = 0;
        const base = {
          screen: screen.name,
          path: screen.path,
          locale: variant.locale,
          theme: variant.theme,
          width: variant.width,
        };
        try {
          base.path = resolvePath(screen.path, state);
          await page.goto(base.path);
          await settle(page);
          pagesChecked += 1;
          if (checks.has("axe")) {
            for (const f of await axeFindings(page, impacts)) findings.push({ ...base, ...f });
          }
          if (checks.has("overflow") || checks.has("clipped")) {
            const layout = await page.evaluate(inspectLayout);
            if (checks.has("overflow")) {
              for (const p of layout.overflow) findings.push({ ...base, kind: "overflow", ...p });
            }
            if (checks.has("clipped")) {
              for (const p of layout.clipped) findings.push({ ...base, kind: "clipped", ...p });
            }
          }
          if (checks.has("console")) {
            for (const message of consoleErrors) {
              findings.push({
                ...base,
                kind: "console",
                rule: "error",
                message: message.slice(0, 500),
              });
            }
          }
        } catch (error) {
          findings.push({
            ...base,
            kind: "console",
            rule: "navigation",
            message: (error as Error).message.split("\n")[0] ?? "error",
          });
        }
      }
      for (const { context } of sessions) await context.close();
    }
  } finally {
    await browser.close();
    await resetPreferences(state.url, credentials.owner);
  }
  const dir = outDir("checks", stamp());
  const counts = { axe: 0, overflow: 0, clipped: 0, console: 0 };
  for (const f of findings) counts[f.kind] += 1;
  const report: UiCheckReport = {
    instance: state.id,
    url: state.url,
    pagesChecked,
    counts,
    findings,
    json: join(dir, "findings.json"),
    markdown: join(dir, "findings.md"),
  };
  writeFileSync(report.json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(report.markdown, markdown(report));
  return report;
}

function markdown(report: UiCheckReport): string {
  const lines = [
    "# UI check",
    "",
    `${report.pagesChecked} pages on ${report.url}: ${report.counts.axe} axe, ${report.counts.overflow} overflow, ${report.counts.clipped} clipped, ${report.counts.console} console.`,
    "",
  ];
  for (const f of report.findings) {
    const where = `${f.screen} (${f.locale}, ${f.theme}, ${f.width} px)`;
    const rule =
      f.rule === undefined ? "" : ` ${f.rule}${f.impact === undefined ? "" : ` [${f.impact}]`}`;
    const selector = f.selector === undefined ? "" : ` \`${f.selector}\``;
    lines.push(`- **${f.kind}**${rule} on ${where}${selector}: ${f.message}`);
  }
  return `${lines.join("\n")}\n`;
}
