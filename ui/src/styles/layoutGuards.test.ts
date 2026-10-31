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
    .filter((rule) => rule.selector === selector)
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
    expect(value("analysis/analysis.css", ".steps__add > .select", "flex")).toContain("0 1 auto");
    expect(value("analysis/analysis.css", ".steps__add > .button", "flex")).toContain("none");
  });

  it("stacks every settings row in a narrow section, switches as well as fields", () => {
    expect(value("features/settings/settings.css", ".settings-main", "container")).toContain(
      "settings-main / inline-size",
    );
    expect(
      value(
        "features/settings/settings.css",
        ".settings-row__text",
        "flex-basis",
        /@container settings-main/,
      ),
    ).toContain("100%");
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

  it("drops the catalog status separators where the line wraps", () => {
    expect(
      value("features/plugins/catalog.css", ".catalog-status__sep", "display", /@container/),
    ).toContain("none");
  });
});
