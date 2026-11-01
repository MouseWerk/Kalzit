import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, readText } from "./repo.ts";

/**
 * The binding rules of CLAUDE.md and the owner decisions as a checklist agents can pull, and a
 * lint over a diff for the violations that keep coming back. Each rule names the CLAUDE.md
 * phrase it condenses; a test fails when CLAUDE.md no longer contains it, so the checklist
 * cannot drift silently.
 */

export interface Rule {
  area: string;
  text: string;
  /** A phrase of CLAUDE.md (or the memory notes) this rule condenses. */
  source: string;
}

export const AUTHOR = "Maurice Kleindienst <kleindiema@gmail.com>";

export const RULES: readonly Rule[] = [
  { area: "git", text: `Commits are authored as ${AUTHOR}.`, source: "Commits are authored as" },
  {
    area: "git",
    text: 'No co-author or session trailers and no assistant or model names in commits, code, comments, docs or PR bodies; no "Generated with" line in a PR.',
    source: "No co-author",
  },
  {
    area: "git",
    text: "Every change goes through a feature branch (m<n>/, fix/, feat/, ux/, docs/) and a pull request into main; squash merge, branch deleted after merge.",
    source: "every change goes through a feature branch",
  },
  {
    area: "git",
    text: "No force push, history rewrite or deletion of unmerged branches without an explicit request.",
    source: "No force push",
  },
  {
    area: "git",
    text: "Merge only with green CI on Windows and Linux.",
    source: "green CI on Windows and",
  },
  {
    area: "security",
    text: "Secrets only in the OS credential store or the environment's secret settings.",
    source: "Secrets only in the OS credential store",
  },
  {
    area: "security",
    text: "Authorization is checked on the server for every request and resource.",
    source: "Authorization is checked on the server",
  },
  {
    area: "security",
    text: "Data sources are read-only by default; write queries are rejected server-side.",
    source: "Data sources are read-only by default",
  },
  {
    area: "security",
    text: "Viewers run only stored queries of dashboards they may read; free queries need datasources:query.",
    source: "Viewers run only the stored queries",
  },
  {
    area: "data",
    text: "Every query result keeps its native shape (frame, documents, graph); conversions are explicit projection steps.",
    source: "Every query result keeps its native shape",
  },
  {
    area: "ui",
    text: "Match the surrounding style and comment density. No emojis anywhere.",
    source: "No emojis anywhere",
  },
  {
    area: "ui",
    text: "UI texts go through the i18n catalogs (de with du, en); docs/glossary.md words to avoid; the translation check must pass.",
    source: "UI texts go through the i18n catalogs",
  },
  {
    area: "ui",
    text: "Use the design tokens; no one-off colors or sizes.",
    source: "Use the design tokens",
  },
  {
    area: "ui",
    text: "No accent-colored borders, outlines, left bars, glows or gradient borders for selected, active or current states; quiet neutral tint and text weight instead. No colored bars on the left anywhere.",
    source: "No accent-colored borders",
  },
  {
    area: "ui",
    text: "Focus visible only on :focus-visible, neutral.",
    source: "Focus visible only on `:focus-visible`",
  },
  {
    area: "ui",
    text: "Follow the design blueprint in docs/design/blueprint/; read the board for a screen before changing it.",
    source: "docs/design/blueprint/",
  },
  {
    area: "ui",
    text: "Settings apply instantly with undo, except forms with dependent fields (SMTP, OIDC, LDAP): one explicit Save with a clear error per field.",
    source: "Settings apply instantly with undo",
  },
  {
    area: "ui",
    text: 'German UI: "Explore" stays untranslated, "Start" for Home, "Verwaltung" for Administration.',
    source: '"Explore" stays untranslated',
  },
  {
    area: "docs",
    text: "Release notes: docs/releases/v<version>.md with ## Improved, ## Fixed and ## Checklist for Windows (manual); user-facing lines only; never into a released version (devgen release_note).",
    source: "Release notes:",
  },
  {
    area: "product",
    text: "Clean-room implementation: no Grafana code, name or logo in the product.",
    source: "Clean-room implementation",
  },
  {
    area: "product",
    text: "Windows and Linux servers are both first-class: CI, e2e and releases run on both.",
    source: "Windows and Linux servers are both first-class",
  },
  {
    area: "work",
    text: "Never kill processes by name or pattern; kill only PIDs you started. Never use port 3000.",
    source: "Never kill processes by name",
  },
  {
    area: "work",
    text: "Prefer root-cause fixes; never skip or weaken a test.",
    source: "never skip or weaken a test",
  },
  {
    area: "work",
    text: "Limit local load: CARGO_BUILD_JOBS=2, a CARGO_TARGET_DIR of your own under C:/Users/klein/kalzit-target-*, cargo clean afterwards; targeted tests locally, full suites in CI; remove merged worktrees (devgen cleanup_storage).",
    source: "Never kill processes by name",
  },
];

export function checklist(): string {
  const areas = [...new Set(RULES.map((r) => r.area))];
  return areas
    .map((area) =>
      [`## ${area}`, ...RULES.filter((r) => r.area === area).map((r) => `- [ ] ${r.text}`)].join(
        "\n",
      ),
    )
    .join("\n\n");
}

/** Rules whose source phrase CLAUDE.md no longer contains. */
export function drift(claudeMd: string): Rule[] {
  const text = claudeMd.replace(/\s+/g, " ");
  return RULES.filter((rule) => !text.includes(rule.source));
}

// ---------------------------------------------------------------------------------------------
// Lint

export interface Finding {
  rule: string;
  severity: "error" | "warning";
  file: string;
  line: number;
  message: string;
}

const TOKENS_FILE = "ui/src/styles/tokens.css";
const LITERAL_COLOR =
  /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(|\b(white|black|red|green|blue|gray|grey|silver|yellow|orange|purple|pink)\b/i;
const STATE =
  /\.(active|selected|sel|current|on|checked|picked|now|today|focused|is-selected|is-editing|recording|running|live|playing)\b|--(active|selected|current|checked)\b|:checked|:hover|:active|:focus(-visible|-within)?\b|\[aria-(selected|current|pressed|checked|expanded)/;
const STATE_FRAME = /^(border(-[\w-]+)?|outline(-color)?|box-shadow|stroke)$/;
const FRAME = /^(border(-[\w-]+)?|outline(-color)?)$/;
const ACCENT =
  /--(accent(-strong|-soft|-text|-hover)?|on-accent|success(-[\w-]+)?|warning(-[\w-]+)?|danger(-[\w-]+)?|info(-[\w-]+)?|tone(-[\w-]+)?|brand-[\w-]+)\b/;
const STATUS = /--(success|warning|danger|info|tone)\b/;
const SPACING = /^(margin|padding|gap|row-gap|column-gap)(-[\w-]+)?$/;
const SPACING_PART = /^(0|auto|var\(--space-[\w-]+\)|calc\(.*var\(--space-[\w-]+\).*\))$/;
const TOKEN_ONLY: Record<string, RegExp> = {
  "font-weight": /^var\(--font-weight-[\w-]+\)$/,
  "z-index": /^var\(--z-[\w-]+\)$/,
  "border-radius": /^(0|var\(--radius-[\w-]+\))( (0|var\(--radius-[\w-]+\)))*$/,
  "font-size": /^(var\(--font-size-[\w-]+\)|100%|\d*\.?\d+em)$/,
};
const LEFT_BAR = /^border-(left|inline-start)(-color|-width|-style)?$/;
// Names of coding assistants and their vendors, stored reversed so that this file, which the
// rule covers too, does not contain them.
const ASSISTANT = new RegExp(
  `\\b(${["edualC", "ciporhtnA", "TPGtahC", "xedoC", "tolipoC", "inimeG"]
    .map((name) => [...name].reverse().join(""))
    .join("|")}|GPT-\\d)\\b`,
);
const TRAILER = /^\s*(Co-Authored-By|Generated-By|Session-Id)\s*:/im;
const GENERATED = /generated with/i;

interface DiffLine {
  file: string;
  line: number;
  text: string;
  added: boolean;
}

/** The lines of a unified diff with their file and new line number. */
export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let file = "";
  let line = 0;
  for (const raw of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "").trim();
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git") || raw.startsWith("index ")) {
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk !== null) {
      line = Number(hunk[1]);
      continue;
    }
    if (file === "" || file === "/dev/null") {
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ file, line, text: raw.slice(1), added: true });
      line++;
    } else if (raw.startsWith(" ")) {
      out.push({ file, line, text: raw.slice(1), added: false });
      line++;
    }
  }
  return out;
}

function declaration(text: string): { property: string; value: string } | undefined {
  const match = /^\s*([a-z-]+)\s*:\s*(.+?)\s*;?\s*$/.exec(text);
  if (match === null || text.includes("{")) {
    return undefined;
  }
  return { property: match[1] ?? "", value: (match[2] ?? "").replace(/\s*!important$/, "") };
}

function isUiSource(file: string): boolean {
  return (
    /^ui\/src\/.*\.tsx?$/.test(file) &&
    !/\.test\.tsx?$/.test(file) &&
    !file.startsWith("ui/src/test/")
  );
}

export interface LintInput {
  diff: string;
  prBody?: string;
  commits?: { author: string; message: string }[];
  /** Versions with a tag or release: their notes files are closed. */
  releasedVersions?: string[];
}

export function lint(input: LintInput): Finding[] {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  let selector = "";
  let selectorFile = "";
  for (const { file, line, text, added } of parseDiff(input.diff)) {
    if (file !== selectorFile) {
      selector = "";
      selectorFile = file;
    }
    const isCss = file.endsWith(".css");
    if (isCss && /\{\s*$/.test(text)) {
      selector = text.replace(/\{\s*$/, "").trim();
    }
    if (!added) {
      continue;
    }
    if (/\p{Emoji_Presentation}/u.test(text)) {
      add({ rule: "no-emoji", severity: "error", file, line, message: "no emojis anywhere" });
    }
    if (isCss) {
      if (/\{\s*$/.test(text) && /:focus(?![-\w])/.test(selector)) {
        add({
          rule: "focus-visible",
          severity: "error",
          file,
          line,
          message: `${selector}: style :focus-visible, never plain :focus`,
        });
      }
      const decl = declaration(text);
      if (decl === undefined) {
        continue;
      }
      const { property, value } = decl;
      if (property.startsWith("--")) {
        continue;
      }
      if (file !== TOKENS_FILE) {
        if (LITERAL_COLOR.test(value)) {
          add({
            rule: "tokens-color",
            severity: "error",
            file,
            line,
            message: `${property}: ${value} - literal colors belong in tokens.css`,
          });
        }
        if (
          SPACING.test(property) &&
          value.split(/ (?![^(]*\))/).some((part) => !SPACING_PART.test(part))
        ) {
          add({
            rule: "tokens-size",
            severity: "error",
            file,
            line,
            message: `${property}: ${value} - spacing comes from var(--space-*)`,
          });
        }
        const pattern = TOKEN_ONLY[property];
        if (pattern !== undefined && !pattern.test(value)) {
          add({
            rule: "tokens-size",
            severity: "error",
            file,
            line,
            message: `${property}: ${value} - take it from the tokens`,
          });
        }
        if (
          property === "outline" &&
          value !== "var(--focus-outline)" &&
          value !== "none" &&
          value !== "0"
        ) {
          add({
            rule: "focus-visible",
            severity: "error",
            file,
            line,
            message: "outline only as var(--focus-outline)",
          });
        }
      }
      if (STATE.test(selector) && STATE_FRAME.test(property) && ACCENT.test(value)) {
        add({
          rule: "accent-frame",
          severity: "error",
          file,
          line,
          message: `${selector} { ${property}: ${value} } - no accent or status frame for a state; use a neutral tint and text weight`,
        });
      } else if (FRAME.test(property) && STATUS.test(value)) {
        add({
          rule: "accent-frame",
          severity: "error",
          file,
          line,
          message: `${property}: ${value} - status colors go into text, icons and fills, never frames`,
        });
      } else if (STATE_FRAME.test(property) && ACCENT.test(value)) {
        add({
          rule: "accent-frame",
          severity: "warning",
          file,
          line,
          message: `${property}: ${value} - an accent-colored frame; fine only if it never marks a state`,
        });
      }
      if (
        LEFT_BAR.test(property) &&
        !/blockquote/.test(selector) &&
        !/^(none|0|0px)$/.test(value)
      ) {
        add({
          rule: "left-bar",
          severity: "error",
          file,
          line,
          message: `${property}: ${value} - no colored bars on the left`,
        });
      }
      continue;
    }
    if (isUiSource(file)) {
      if (/["'`]#[0-9a-fA-F]{3,8}["'`]|\b(rgba?|hsla?|oklch)\(/.test(text)) {
        add({
          rule: "tokens-color",
          severity: "warning",
          file,
          line,
          message: "a literal color in code; use a token (var(--...))",
        });
      }
      if (file.endsWith(".tsx") && !/^\s*(\/\/|\*|\/\*)/.test(text)) {
        const node = />([^<>{}]*)</.exec(text)?.[1]?.trim() ?? "";
        if (/\p{L}{2,}/u.test(node) && !/^[\p{Lu}\d\s.-]{2,6}$/u.test(node)) {
          add({
            rule: "i18n-jsx",
            severity: "error",
            file,
            line,
            message: `untranslated JSX text "${node}"; use t("...")`,
          });
        }
        const attr = /\b(aria-label|title|placeholder|alt|label)="([^"]*\p{L}{2,}[^"]*)"/u.exec(
          text,
        );
        if (attr !== null) {
          add({
            rule: "i18n-jsx",
            severity: "warning",
            file,
            line,
            message: `${attr[1]}="${attr[2]}" looks untranslated; use t("...")`,
          });
        }
      }
    }
    const released = /^docs\/releases\/v([\d.]+)\.md$/.exec(file)?.[1];
    if (released !== undefined && (input.releasedVersions ?? []).includes(released)) {
      add({
        rule: "release-notes",
        severity: "error",
        file,
        line,
        message: `v${released} is released; add the line with devgen release_note instead`,
      });
    }
  }
  if (input.prBody !== undefined) {
    const body = input.prBody;
    if (GENERATED.test(body)) {
      add({
        rule: "pr-body",
        severity: "error",
        file: "PR body",
        line: 0,
        message: 'remove the "Generated with" line',
      });
    }
    if (TRAILER.test(body)) {
      add({
        rule: "pr-body",
        severity: "error",
        file: "PR body",
        line: 0,
        message: "no co-author or session trailers",
      });
    }
    const name = ASSISTANT.exec(body)?.[0];
    if (name !== undefined) {
      add({
        rule: "pr-body",
        severity: "error",
        file: "PR body",
        line: 0,
        message: `no assistant or model names (${name})`,
      });
    }
  }
  for (const [i, commit] of (input.commits ?? []).entries()) {
    const where = `commit ${i + 1}: ${commit.message.split("\n")[0]}`;
    if (commit.author !== AUTHOR) {
      add({
        rule: "commit-author",
        severity: "error",
        file: where,
        line: 0,
        message: `authored by ${commit.author}, not ${AUTHOR}`,
      });
    }
    if (TRAILER.test(commit.message) || GENERATED.test(commit.message)) {
      add({
        rule: "commit-message",
        severity: "error",
        file: where,
        line: 0,
        message: "no co-author, session or generated-with lines",
      });
    }
    const name = ASSISTANT.exec(commit.message)?.[0];
    if (name !== undefined) {
      add({
        rule: "commit-message",
        severity: "error",
        file: where,
        line: 0,
        message: `no assistant or model names (${name})`,
      });
    }
  }
  return findings;
}

/** Lints this branch against a base: its diff, its commits and optionally a PR body file. */
export function lintBranch(
  root: string,
  options: { base?: string; prBody?: string; prBodyFile?: string; releasedVersions?: string[] },
): Finding[] {
  const base = options.base ?? "origin/main";
  const diff = git(root, "diff", "--no-color", "--no-renames", "-U3", `${base}...HEAD`);
  if (!diff.ok) {
    throw new Error(`git diff ${base}...HEAD failed: ${diff.stderr.trim()}`);
  }
  const log = git(root, "log", "--format=%an <%ae>%x1f%B%x1e", `${base}..HEAD`);
  const commits = log.stdout
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [author, message] = entry.split("\x1f");
      return { author: (author ?? "").trim(), message: (message ?? "").trim() };
    });
  let prBody = options.prBody;
  if (options.prBodyFile !== undefined) {
    const path = join(root, options.prBodyFile);
    prBody = readText(existsSync(path) ? path : options.prBodyFile);
  }
  return lint({
    diff: diff.stdout,
    commits,
    ...(prBody === undefined ? {} : { prBody }),
    ...(options.releasedVersions === undefined
      ? {}
      : { releasedVersions: options.releasedVersions }),
  });
}
