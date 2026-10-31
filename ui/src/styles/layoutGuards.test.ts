import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCss, type StyleRule } from "../test/cssParse";

/**
 * Layout defects found on the screens and fixed at their root, kept as rules of the stylesheets
 * so they do not come back.
 */

const SRC_DIR = resolve(import.meta.dirname, "..");

function rules(file: string): StyleRule[] {
  return parseCss(readFileSync(resolve(SRC_DIR, file), "utf8"));
}

function value(file: string, selector: string, property: string, context?: RegExp): string[] {
  return rules(file)
    .filter((rule) =>
      rule.selector
        .split(/,(?![^()]*\))/)
        .map((part) => part.trim().replace(/\s+/g, " "))
        .includes(selector),
    )
    .filter((rule) => context === undefined || rule.context.some((c) => context.test(c)))
    .flatMap((rule) => rule.declarations)
    .filter((declaration) => declaration.property === property)
    .map((declaration) => declaration.value);
}

describe("layout guards", () => {
  it("keeps a graph panel's step bar inside the panel, its list scrolling", () => {
    expect(value("panels/graph/graph.css", ".graph-steps", "grid-template-columns")).toContain(
      "minmax(0, 1fr)",
    );
  });

  it("gives the graph layout choice a ghost button's inset, so a wrapped label is not cut", () => {
    expect(value("panels/graph/graph.css", ".graph__layout", "padding-inline-start")).toContain(
      "var(--space-ghost-inset)",
    );
  });

  it("lines the outer cells of the AI tables up with the card's inset", () => {
    const head = value("features/ai/admin/ai-admin.css", ".ai-card__head", "padding")[0];
    const inset = head?.split(" ")[1];
    expect(inset).toBe("var(--space-4)");
    expect(
      value(
        "features/ai/admin/ai-admin.css",
        ".ai-table :is(th, td):first-child",
        "padding-inline-start",
      ),
    ).toContain(inset);
    expect(
      value(
        "features/ai/admin/ai-admin.css",
        ".ai-table :is(th, td):last-child",
        "padding-inline-end",
      ),
    ).toContain(inset);
  });

  it("lets the step type give up width before its button wraps", () => {
    expect(value("analysis/analysis.css", ".steps__add > .select", "flex")).toContain("1 1 10rem");
    expect(value("analysis/analysis.css", ".steps__add > .button", "flex")).toContain("none");
    // Wide enough for the longest step name while closed.
    expect(value("analysis/analysis.css", ".steps__add > .select", "max-width")).toContain(
      "var(--size-column)",
    );
  });

  it("stacks only fields in a narrow settings section; switches stay beside their text", () => {
    expect(value("features/settings/settings.css", ".settings-main", "container")).toContain(
      "settings-main / inline-size",
    );
    const narrow = rules("features/settings/settings.css").filter((rule) =>
      rule.context.some((c) => /@container settings-main \(width < 32rem\)/.test(c)),
    );
    const stacked = narrow.filter((rule) =>
      rule.declarations.some((d) => d.property === "flex-basis" && d.value === "100%"),
    );
    expect(stacked.length).toBeGreaterThan(0);
    for (const rule of stacked) {
      const selector = rule.selector.replace(/\s+/g, " ");
      // Never every row: only those whose control is a field, a select or a text area.
      expect(selector).toMatch(/:has\(.*select.*textarea.*\) > \.settings-row__text$/);
      expect(selector).toContain(':not([type="checkbox"], [type="radio"])');
    }
  });

  it("fits Ask to the window on desktop, so the composer stays in view", () => {
    expect(
      value(
        "features/ai/chat/chat.css",
        ".shell__main:has(.ask)",
        "height",
        /not \(max-width: 64rem\)/,
      ),
    ).toContain("100dvh");
    expect(
      value(
        "features/ai/chat/chat.css",
        ".ask__messages",
        "overflow-y",
        /not \(max-width: 64rem\)/,
      ),
    ).toContain("auto");
  });

  it("keeps ids and keys in the plugin table on one line instead of crushing the name column", () => {
    expect(
      value("features/plugins/plugins.css", ".plugins-table .plugins-mono", "white-space"),
    ).toContain("nowrap");
  });

  it("squares the toolbar group's inner corners, so no seam shows between its controls", () => {
    const css = "features/dashboards/toolbar.css";
    expect(
      value(css, ".dash-toolbar :where(.time-controls, .split-control) .button", "border-radius"),
    ).toContain("0");
    expect(
      value(
        css,
        ".dash-toolbar :where(.time-controls, .split-control) > :where(:first-child) .button",
        "border-radius",
      ),
    ).toContain("var(--radius-md-inner) 0 0 var(--radius-md-inner)");
  });

  it("drops the catalog status separators where the line wraps", () => {
    expect(
      value("features/plugins/catalog.css", ".catalog-status__sep", "display", /@container/),
    ).toContain("none");
  });
});
