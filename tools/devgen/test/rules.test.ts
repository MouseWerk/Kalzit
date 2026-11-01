import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHOR, checklist, drift, lint, lintBranch, parseDiff } from "../src/lib/rules.ts";
import { REPO } from "./helpers.ts";

/** A unified diff that adds `added` lines to `file` after one context line. */
function diff(file: string, added: string[], context = ".row {"): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -10,1 +10,${added.length + 1} @@`,
    ` ${context}`,
    ...added.map((line) => `+${line}`),
  ].join("\n");
}

const rules = (diffText: string, extra: Parameters<typeof lint>[0] = { diff: "" }) =>
  lint({ ...extra, diff: diffText }).map((f) => `${f.severity} ${f.rule} ${f.file}:${f.line}`);

describe("rules checklist", () => {
  it("still matches CLAUDE.md", () => {
    expect(drift(readFileSync(join(REPO, "CLAUDE.md"), "utf8")).map((r) => r.source)).toEqual([]);
  });

  it("lists the rules as unchecked items, the commit author first", () => {
    const text = checklist();
    expect(text.split("\n")[1]).toBe(`- [ ] Commits are authored as ${AUTHOR}.`);
    expect(text).toContain(":focus-visible");
  });

  it("names a rule as stale when CLAUDE.md drops its phrase", () => {
    expect(drift("nothing here").length).toBeGreaterThan(10);
  });
});

describe("rules lint", () => {
  it("keeps line numbers of the new file", () => {
    const lines = parseDiff(diff("ui/src/a.css", ["  color: red;"]));
    expect(lines).toEqual([
      { file: "ui/src/a.css", line: 10, text: ".row {", added: false },
      { file: "ui/src/a.css", line: 11, text: "  color: red;", added: true },
    ]);
  });

  it("flags literal colors and sizes outside the tokens, but not in tokens.css", () => {
    const css = [
      "  color: #ff0000;",
      "  padding: 12px;",
      "  font-size: 13px;",
      "  gap: var(--space-2);",
    ];
    expect(rules(diff("ui/src/features/x/x.css", css))).toEqual([
      "error tokens-color ui/src/features/x/x.css:11",
      "error tokens-size ui/src/features/x/x.css:12",
      "error tokens-size ui/src/features/x/x.css:13",
    ]);
    expect(
      rules(diff("ui/src/styles/tokens.css", ["  --accent: #2563eb;", "  color: #fff;"])),
    ).toEqual([]);
  });

  it("flags accent frames for states and colored left bars", () => {
    expect(
      rules(
        diff("ui/src/a.css", ["  border-color: var(--accent);"], '.tab[aria-selected="true"] {'),
      ),
    ).toEqual(["error accent-frame ui/src/a.css:11"]);
    expect(rules(diff("ui/src/a.css", ["  border-left: 3px solid var(--border);"]))).toEqual([
      "error left-bar ui/src/a.css:11",
    ]);
    expect(
      rules(diff("ui/src/a.css", ["  background: var(--surface-selected);"], ".tab--active {")),
    ).toEqual([]);
  });

  it("flags :focus without -visible", () => {
    expect(
      rules(diff("ui/src/a.css", [".button:focus {", "  outline: var(--focus-outline);"])),
    ).toEqual(["error focus-visible ui/src/a.css:11"]);
    expect(
      rules(diff("ui/src/a.css", [".button:focus-visible {", "  outline: var(--focus-outline);"])),
    ).toEqual([]);
  });

  it("flags untranslated JSX text, not translated text or tests", () => {
    const tsx = [
      "      <h2>Recent sign-ins</h2>",
      '      <button aria-label="Close dialog">',
      '      <p>{t("x.y")}</p>',
    ];
    expect(rules(diff("ui/src/features/x/Page.tsx", tsx, "return ("))).toEqual([
      "error i18n-jsx ui/src/features/x/Page.tsx:11",
      "warning i18n-jsx ui/src/features/x/Page.tsx:12",
    ]);
    expect(rules(diff("ui/src/features/x/Page.test.tsx", tsx, "return ("))).toEqual([]);
  });

  it("does not take arrow functions, comparisons, code, values or keys for JSX text", () => {
    const code = [
      "  submit: (proof: Proof) => Promise<void>;",
      "  if (port > 0 && port < 65536) {",
      "  const inside = x >= plot.left && x <= plot.right;",
      '  <option value="max_tokens">max_tokens</option>',
      '  <pre className="mono">kalzit update apply</pre>',
      '  <span className="mono">.kalzit-update</span>',
      '  <Card title="usage.dashboards.title" lead="usage.dashboards.lead">',
      '  <input placeholder="https://ca.example.com/acme" />',
      '  <input placeholder="xxxx-xxxx-xxxx" />',
      '  <span translate="no">Kalzit Server</span>',
    ];
    expect(rules(diff("ui/src/features/x/Page.tsx", code, "return ("))).toEqual([]);
  });

  it("finds no untranslated JSX in the UI as it is today", () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (name.endsWith(".tsx")) {
          const file = relative(REPO, path).replace(/\\/g, "/");
          const text = readFileSync(path, "utf8").split(/\r?\n/);
          const whole = [
            `+++ b/${file}`,
            `@@ -0,0 +1,${text.length} @@`,
            ...text.map((l) => `+${l}`),
          ];
          for (const f of lint({ diff: whole.join("\n") })) {
            if (f.rule === "i18n-jsx") {
              found.push(`${file}:${f.line} ${f.message}`);
            }
          }
        }
      }
    };
    walk(join(REPO, "ui", "src"));
    expect(found).toEqual([]);
  });

  it("refuses a base that is not a commit or looks like an option", () => {
    expect(() => lintBranch(REPO, { base: "--output=x" })).toThrow(/not a commit/);
    expect(() => lintBranch(REPO, { base: "no-such-ref-anywhere" })).toThrow(/not a commit/);
  });

  it("flags emojis and lines added to released notes", () => {
    expect(rules(diff("docs/guide/x.md", ["Done \u{2705}"], "text"))).toEqual([
      "error no-emoji docs/guide/x.md:11",
    ]);
    expect(
      rules(diff("docs/releases/v0.4.2.md", ["- Something new."], "## Fixed"), {
        diff: "",
        releasedVersions: ["0.4.2"],
      }),
    ).toEqual(["error release-notes docs/releases/v0.4.2.md:11"]);
  });

  it("flags a Generated-with line in the PR body, trailers and a wrong commit author", () => {
    const generated = ["Generated", "with"].join(" ");
    const found = rules("", {
      diff: "",
      prBody: `Summary\n\n${generated} a tool`,
      commits: [
        { author: AUTHOR, message: "M6: fine" },
        { author: "Someone <a@b.c>", message: "fix\n\nCo-Authored-By: x <y@z>" },
      ],
    });
    expect(found).toEqual([
      "error pr-body PR body:0",
      "error commit-author commit 2: fix:0",
      "error commit-message commit 2: fix:0",
    ]);
  });
});
