import { join } from "node:path";
import { z } from "zod";
import { cleanupStorage, formatBytes, worktreeLines } from "./lib/cleanup.ts";
import { type Forge, realForge } from "./lib/forge.ts";
import { i18nAdd, i18nCheck } from "./lib/i18n.ts";
import { checkMigrations, nextMigration } from "./lib/migrations.ts";
import { prOverlap } from "./lib/overlap.ts";
import { addReleaseNote, notesTarget, type Section } from "./lib/releases.ts";
import { readText, repoRoot } from "./lib/repo.ts";
import {
  METHODS,
  type RouteRequest,
  type ScaffoldResult,
  scaffoldRoute,
} from "./lib/routeScaffold.ts";
import { checklist, drift, type Finding, lintBranch } from "./lib/rules.ts";
import { SETTING_TYPES, type SettingRequest, scaffoldSetting } from "./lib/settingScaffold.ts";

/**
 * The tools, defined once for the MCP server and the CLI: each has typed fields (the MCP input
 * schema and the CLI flags are built from them) and returns a text for people plus the data.
 */

type FieldType = "string" | "number" | "boolean" | "list";

export interface Field {
  name: string;
  type: FieldType;
  description: string;
  required?: boolean;
  choices?: readonly string[];
}

export interface Context {
  root: string;
  forge: Forge;
}

export interface Output {
  text: string;
  data: unknown;
}

export interface Tool {
  name: string;
  description: string;
  fields: Field[];
  run(input: Record<string, unknown>, context: Context): Output;
}

export function zodShape(fields: Field[]): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    let type: z.ZodType;
    if (field.choices !== undefined) {
      type = z.enum(field.choices as [string, ...string[]]);
    } else if (field.type === "number") {
      type = z.number();
    } else if (field.type === "boolean") {
      type = z.boolean();
    } else if (field.type === "list") {
      type = z.array(z.string());
    } else {
      type = z.string();
    }
    type = type.describe(field.description);
    shape[field.name] = field.required === true ? type : type.optional();
  }
  return shape;
}

const str = (input: Record<string, unknown>, name: string) =>
  typeof input[name] === "string" ? (input[name] as string) : undefined;
const num = (input: Record<string, unknown>, name: string) =>
  typeof input[name] === "number" ? (input[name] as number) : undefined;
const bool = (input: Record<string, unknown>, name: string) => input[name] === true;
const list = (input: Record<string, unknown>, name: string) =>
  Array.isArray(input[name]) ? (input[name] as string[]) : undefined;

function need(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drops undefined values, for the optional properties of the request types. */
function defined<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Defined<T>;
}

function warningsText(warnings: string[]): string {
  return warnings.length === 0 ? "" : `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`;
}

function scaffoldText(result: ScaffoldResult): string {
  return [
    result.created.length > 0 ? `Created:\n${result.created.map((f) => `- ${f}`).join("\n")}` : "",
    result.changed.length > 0 ? `Changed:\n${result.changed.map((f) => `- ${f}`).join("\n")}` : "",
    `Next:\n${result.next.map((n) => `- ${n}`).join("\n")}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n")
    .concat(warningsText(result.warnings));
}

function findingsText(findings: Finding[]): string {
  if (findings.length === 0) {
    return "No findings.";
  }
  const errors = findings.filter((f) => f.severity === "error").length;
  return [
    `${errors} errors, ${findings.length - errors} warnings`,
    ...findings.map(
      (f) =>
        `${f.severity.padEnd(7)} ${f.rule.padEnd(15)} ${f.file}${f.line > 0 ? `:${f.line}` : ""}  ${f.message}`,
    ),
  ].join("\n");
}

export const TOOLS: Tool[] = [
  {
    name: "next_migration",
    description:
      "The next free server/migrations number, counting main, this checkout and every open pull request; optionally creates the file with a header.",
    fields: [
      {
        name: "name",
        type: "string",
        description: "File name part, such as sign_ins (needed with create)",
      },
      {
        name: "description",
        type: "string",
        description: "What the migration changes, for the header comment",
      },
      { name: "create", type: "boolean", description: "Create server/migrations/00NN_<name>.sql" },
    ],
    run(input, { root, forge }) {
      const result = nextMigration(
        root,
        forge,
        defined({
          name: str(input, "name"),
          description: str(input, "description"),
          create: bool(input, "create"),
        }),
      );
      const taken = result.newest.map((t) => `  ${t.file} (${t.where})`).join("\n");
      return {
        text: `Next free migration: ${result.padded}${result.created === undefined ? "" : `\nCreated ${result.created}`}\nHighest in use:\n${taken}${warningsText(result.warnings)}`,
        data: result,
      };
    },
  },
  {
    name: "check_migrations",
    description:
      "Reports clashes of a branch's new migrations with main, open pull requests and each other.",
    fields: [
      { name: "branch", type: "string", description: "Branch to check (default: the current one)" },
    ],
    run(input, { root, forge }) {
      const branch = str(input, "branch") ?? forge.currentBranch();
      const result = checkMigrations(root, forge, branch);
      const lines = [
        `${branch} adds ${result.added.length === 0 ? "no migrations" : result.added.join(", ")}`,
      ];
      for (const clash of result.clashes) {
        lines.push(
          `CLASH ${clash.file}: number ${clash.number} also in ${clash.with.map((w) => `${w.file} (${w.where})`).join(", ")}`,
        );
      }
      for (const file of result.belowMain) {
        lines.push(
          `ORDER ${file}: numbered at or below main's newest migration; take the next free number`,
        );
      }
      if (result.clashes.length === 0 && result.belowMain.length === 0) {
        lines.push("No clashes.");
      }
      return { text: lines.join("\n") + warningsText(result.warnings), data: result };
    },
  },
  {
    name: "release_note",
    description:
      "Adds a user-facing line to the unreleased notes file (newest docs/releases file without tag or GitHub release) under Improved, Fixed or the Windows checklist; creates the file when missing and warns when another open PR creates it too. Without text it only names the file.",
    fields: [
      {
        name: "section",
        type: "string",
        description: "Where the line goes",
        choices: ["improved", "fixed", "windows"],
      },
      {
        name: "text",
        type: "string",
        description: "The line, user-facing, without the leading dash",
      },
      { name: "version", type: "string", description: "Override the version, such as 0.6.0" },
    ],
    run(input, { root, forge }) {
      const text = str(input, "text");
      const version = str(input, "version");
      if (text === undefined) {
        const target = notesTarget(root, forge, defined({ version }));
        const others = target.othersCreating.map((pr) => `#${pr.number} ${pr.headRefName}`);
        return {
          text: `${target.file} (${target.reason}${target.exists ? "" : ", not created yet"})${others.length > 0 ? `\nAlso created by: ${others.join(", ")}` : ""}${warningsText(target.warnings)}`,
          data: target,
        };
      }
      const section = (str(input, "section") ?? "improved") as Section;
      const result = addReleaseNote(root, forge, defined({ section, text, version }));
      return {
        text: `${result.created ? "Created" : "Updated"} ${result.file} (${result.reason}), section ${section}${warningsText(result.warnings)}`,
        data: result,
      };
    },
  },
  {
    name: "i18n_add",
    description:
      "Adds a UI text key in German and English at once, next to its siblings in the right area catalog; with plural, adds <key>One and <key>Many. Checks the texts against the translation rules.",
    fields: [
      {
        name: "key",
        type: "string",
        description: "Catalog key, such as admin.users.title",
        required: true,
      },
      {
        name: "en",
        type: "string",
        description: "English text (the Many form with plural)",
        required: true,
      },
      {
        name: "de",
        type: "string",
        description: "German text with du (the Many form with plural)",
        required: true,
      },
      {
        name: "area",
        type: "string",
        description: "Area file without .json; found from the siblings when left out",
      },
      {
        name: "enOne",
        type: "string",
        description: "English text for exactly one (makes it a plural)",
      },
      {
        name: "deOne",
        type: "string",
        description: "German text for exactly one (makes it a plural)",
      },
    ],
    run(input, { root }) {
      const enOne = str(input, "enOne");
      const deOne = str(input, "deOne");
      const result = i18nAdd(
        root,
        defined({
          key: need(str(input, "key"), "key"),
          en: need(str(input, "en"), "en"),
          de: need(str(input, "de"), "de"),
          area: str(input, "area"),
          plural:
            enOne !== undefined || deOne !== undefined
              ? { enOne: need(enOne, "enOne"), deOne: need(deOne, "deOne") }
              : undefined,
        }),
      );
      return {
        text: `Added ${result.keys.join(", ")} to ${result.files.join(" and ")}${result.problems.length > 0 ? `\n\nThe translation tests will fail:\n${result.problems.map((p) => `- ${p}`).join("\n")}` : ""}`,
        data: result,
      };
    },
  },
  {
    name: "i18n_check",
    description:
      "The translation tests' checks before CI: missing keys in either language, keys the code names without a catalog entry, glossary words to avoid, Sie instead of du, quotes, placeholders, and keys that look unused.",
    fields: [
      { name: "keys", type: "list", description: "Check only these keys" },
      { name: "showUnused", type: "boolean", description: "List every key that looks unused" },
    ],
    run(input, { root }) {
      const keys = list(input, "keys");
      const result = i18nCheck(root, defined({ keys }));
      const unused = bool(input, "showUnused")
        ? `\n\nLook unused:\n${result.unused.map((k) => `- ${k}`).join("\n")}`
        : "";
      return {
        text: `${result.checkedKeys} keys checked (rules from ${result.rulesFrom === "test" ? "ui/src/i18n/i18n.test.ts" : "built-in copies"}): ${result.errors.length} errors${result.errors.length > 0 ? `\n${result.errors.map((e) => `- ${e}`).join("\n")}` : ""}${unused}${warningsText(result.warnings)}`,
        data: result,
      };
    },
  },
  {
    name: "scaffold_route",
    description:
      "Generates an API route: route table entry with its Access, a handler with an explicit authorization check, the reason (and a new error code if asked) with docs row and UI texts, a docs/api section and an integration test for allowed, forbidden and unauthenticated callers.",
    fields: [
      {
        name: "module",
        type: "string",
        description: "Module under server/src/routes (created when missing)",
        required: true,
      },
      {
        name: "method",
        type: "string",
        description: "HTTP method",
        choices: METHODS,
        required: true,
      },
      {
        name: "path",
        type: "string",
        description: "Path relative to /api, such as /orgs/{orgId}/widgets",
        required: true,
      },
      {
        name: "access",
        type: "string",
        description:
          "Authenticated, ServerAdmin, OrgMember, Public or a permission like dashboards:write",
        required: true,
      },
      { name: "handler", type: "string", description: "snake_case handler name", required: true },
      {
        name: "summary",
        type: "string",
        description: "One English sentence: what the route does",
        required: true,
      },
      {
        name: "docs",
        type: "string",
        description: "File under docs/api, such as dashboard-features.md",
        required: true,
      },
      {
        name: "title",
        type: "string",
        description: "Heading for the reasons table (default from the module)",
      },
      {
        name: "reason",
        type: "string",
        description: "Reason code for an empty name, such as widgets.name_missing",
      },
      { name: "reasonEn", type: "string", description: "English UI text of the reason" },
      { name: "reasonDe", type: "string", description: "German UI text of the reason, with du" },
      {
        name: "reasonDocs",
        type: "string",
        description: "Docs file whose Reasons table lists it (default: docs)",
      },
      {
        name: "errorCode",
        type: "string",
        description: "Error code of the refusal (default validation); a new one is registered",
      },
      { name: "errorStatus", type: "number", description: "HTTP status of a new error code" },
      { name: "errorEn", type: "string", description: "English UI text of a new error code" },
      { name: "errorDe", type: "string", description: "German UI text of a new error code" },
    ],
    run(input, { root }) {
      const request = defined({
        module: need(str(input, "module"), "module"),
        method: need(str(input, "method"), "method") as RouteRequest["method"],
        path: need(str(input, "path"), "path"),
        access: need(str(input, "access"), "access"),
        handler: need(str(input, "handler"), "handler"),
        summary: need(str(input, "summary"), "summary"),
        docs: need(str(input, "docs"), "docs"),
        title: str(input, "title"),
        reason: str(input, "reason"),
        reasonEn: str(input, "reasonEn"),
        reasonDe: str(input, "reasonDe"),
        reasonDocs: str(input, "reasonDocs"),
        errorCode: str(input, "errorCode"),
        errorStatus: num(input, "errorStatus"),
        errorEn: str(input, "errorEn"),
        errorDe: str(input, "errorDe"),
      }) as RouteRequest;
      const result = scaffoldRoute(root, request);
      return { text: scaffoldText(result), data: result };
    },
  },
  {
    name: "scaffold_setting",
    description:
      "Generates a runtime setting: registry entry and rule, generated SettingKey, de/en texts, the row in a settings section (shared row with source badge, lock and undo), search words, docs row and server and UI tests. Refuses areas of explicit-Save forms (mail, SSO, LDAP, SAML).",
    fields: [
      {
        name: "key",
        type: "string",
        description: "area.name, such as audit.retention_days",
        required: true,
      },
      {
        name: "scope",
        type: "string",
        description: "server or org",
        choices: ["server", "org"],
        required: true,
      },
      {
        name: "type",
        type: "string",
        description: "Value type",
        choices: SETTING_TYPES,
        required: true,
      },
      {
        name: "default",
        type: "string",
        description: "Default: true/false, a number, a choice or a text",
        required: true,
      },
      { name: "min", type: "number", description: "Smallest whole number (int)" },
      { name: "max", type: "number", description: "Largest whole number (int)" },
      { name: "choices", type: "list", description: "Allowed values (choice)" },
      { name: "choiceEn", type: "list", description: "English names of the choices, same order" },
      { name: "choiceDe", type: "list", description: "German names of the choices, same order" },
      { name: "maxChars", type: "number", description: "Longest text (text)" },
      { name: "multiline", type: "boolean", description: "Text may have several lines (text)" },
      {
        name: "description",
        type: "string",
        description: "English registry description",
        required: true,
      },
      { name: "labelEn", type: "string", description: "English UI label", required: true },
      { name: "labelDe", type: "string", description: "German UI label", required: true },
      {
        name: "descriptionEn",
        type: "string",
        description: "English UI description",
        required: true,
      },
      {
        name: "descriptionDe",
        type: "string",
        description: "German UI description, with du",
        required: true,
      },
      {
        name: "section",
        type: "string",
        description: "Settings section id, such as general or storage",
        required: true,
      },
      {
        name: "docs",
        type: "string",
        description: "What the docs row adds after the accepted values",
      },
      { name: "keywordsEn", type: "string", description: "English search words for the section" },
      { name: "keywordsDe", type: "string", description: "German search words for the section" },
      {
        name: "fileOnly",
        type: "boolean",
        description: "Not editable in the UI (kalzit.toml or environment only)",
      },
    ],
    run(input, { root }) {
      const request = defined({
        key: need(str(input, "key"), "key"),
        scope: need(str(input, "scope"), "scope") as SettingRequest["scope"],
        type: need(str(input, "type"), "type") as SettingRequest["type"],
        default: need(str(input, "default"), "default"),
        min: num(input, "min"),
        max: num(input, "max"),
        choices: list(input, "choices"),
        choiceEn: list(input, "choiceEn"),
        choiceDe: list(input, "choiceDe"),
        maxChars: num(input, "maxChars"),
        multiline: input.multiline === true ? true : undefined,
        description: need(str(input, "description"), "description"),
        labelEn: need(str(input, "labelEn"), "labelEn"),
        labelDe: need(str(input, "labelDe"), "labelDe"),
        descriptionEn: need(str(input, "descriptionEn"), "descriptionEn"),
        descriptionDe: need(str(input, "descriptionDe"), "descriptionDe"),
        section: need(str(input, "section"), "section"),
        docs: str(input, "docs"),
        keywordsEn: str(input, "keywordsEn"),
        keywordsDe: str(input, "keywordsDe"),
        uiEditable: bool(input, "fileOnly") ? false : undefined,
      }) as SettingRequest;
      const result = scaffoldSetting(root, request);
      return { text: scaffoldText(result), data: result };
    },
  },
  {
    name: "pr_overlap",
    description:
      "Files that open pull requests (or one branch or PR) share with other open pull requests, with a hint at likely conflicts, and migration numbers taken twice.",
    fields: [
      {
        name: "branch",
        type: "string",
        description: "Compare this branch with the open pull requests",
      },
      { name: "pr", type: "number", description: "Compare this open pull request with the others" },
    ],
    run(input, { forge }) {
      const report = prOverlap(
        forge,
        defined({ branch: str(input, "branch"), pr: num(input, "pr") }),
      );
      const lines = [`Overlap of ${report.subject}:`];
      if (report.shared.length === 0 && report.migrationClashes.length === 0) {
        lines.push("No shared files.");
      }
      for (const s of report.shared) {
        lines.push(
          `${s.likelyConflict ? "likely conflict" : "shared"}  ${s.file}  [${s.by.join(", ")}]  ${s.hint}`,
        );
      }
      for (const clash of report.migrationClashes) {
        lines.push(`migration ${clash.number} taken twice: ${clash.files.join(", ")}`);
      }
      return { text: lines.join("\n") + warningsText(report.warnings), data: report };
    },
  },
  {
    name: "rules",
    description:
      "The condensed binding rules of CLAUDE.md and the owner decisions as a checklist to follow before writing code, committing or opening a PR.",
    fields: [],
    run(_input, { root }) {
      const claude = join(root, "CLAUDE.md");
      const stale = drift(readText(claude));
      const note =
        stale.length === 0
          ? ""
          : `\n\nCLAUDE.md changed; these rules may be stale: ${stale.map((r) => r.source).join("; ")}`;
      return { text: `${checklist()}${note}`, data: { checklist: checklist(), stale } };
    },
  },
  {
    name: "rules_lint",
    description:
      "Lints this branch's diff against a base for common rule violations: literal colors and sizes outside the tokens, accent frames for states, left bars, :focus without -visible, untranslated JSX text, emojis, lines in released notes, a Generated-with line or assistant names in the PR body, and the commit author and trailers.",
    fields: [
      { name: "base", type: "string", description: "Base to diff against (default origin/main)" },
      { name: "prBody", type: "string", description: "PR body text to check" },
      { name: "prBodyFile", type: "string", description: "File with the PR body to check" },
    ],
    run(input, { root, forge }) {
      const released = [...forge.tags(), ...forge.releaseTags()].map((t) => t.replace(/^v/, ""));
      const findings = lintBranch(
        root,
        defined({
          base: str(input, "base"),
          prBody: str(input, "prBody"),
          prBodyFile: str(input, "prBodyFile"),
          releasedVersions: released,
        }),
      );
      return { text: findingsText(findings), data: findings };
    },
  },
  {
    name: "cleanup_storage",
    description:
      "Lists worktrees under .claude/worktrees and cargo target dirs (<home>/kalzit-target-*) with sizes. With apply, removes only worktrees whose own commits are merged (a merged PR's head is the worktree's commit, or all own commits are in origin/main) and that are unlocked, clean and idle, and idle target dirs; never fresh or running worktrees, unmerged work or the main checkout.",
    fields: [
      { name: "apply", type: "boolean", description: "Remove what is safe to remove" },
      {
        name: "idleHours",
        type: "number",
        description:
          "Worktrees and target dirs changed within this many hours are kept (default 2, at least 1)",
      },
    ],
    run(input, { root, forge }) {
      const report = cleanupStorage(
        root,
        forge,
        defined({ apply: bool(input, "apply"), idleHours: num(input, "idleHours") }),
      );
      const targets = report.targets.map(
        (t) =>
          `${t.removed === true ? "removed" : t.removable ? "removable" : "kept"}  ${formatBytes(t.bytes).padStart(10)}  ${t.path}  (${t.note}, ${t.idleHours} h)`,
      );
      return {
        text:
          [
            "Worktrees:",
            ...(report.worktrees.length === 0
              ? ["  none"]
              : worktreeLines(report).map((l) => `  ${l}`)),
            "Cargo target dirs:",
            ...(targets.length === 0 ? ["  none"] : targets.map((l) => `  ${l}`)),
            `${report.applied ? "Freed" : "Removable with apply"}: ${formatBytes(report.reclaimable)}`,
          ].join("\n") + warningsText(report.warnings),
        data: report,
      };
    },
  },
];

export function defaultContext(): Context {
  const root = repoRoot();
  return { root, forge: realForge(root) };
}
