import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { insertEntry, LANGUAGES, type Language, messageProblems } from "./i18n.ts";
import { readText, writeText } from "./repo.ts";
import type { ScaffoldResult } from "./routeScaffold.ts";
import {
  addNotReason,
  DETAIL,
  formatRust,
  formatUi,
  namespaces,
  registryKeys,
  SETTINGS,
  SHAPES,
  setUnion,
} from "./rust.ts";

/**
 * A new runtime setting in one step: the registry entry and its validation rule, the generated
 * SettingKey, the UI texts in German and English, its row in a settings section (the shared
 * `SettingRow`, which brings the source badge, the lock for values from kalzit.toml or the
 * environment, and undo through `useSettingChanges`), the search index (built from the section
 * and the texts), the docs table row and tests on both sides.
 *
 * Settings of forms with dependent fields (mail server, OpenID Connect, LDAP, SAML) are saved
 * together with one explicit Save after a connection test, with a check token; they are not
 * registry rows, so this scaffold refuses their areas.
 */

export const SETTING_TYPES = ["bool", "int", "choice", "text"] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

export interface SettingRequest {
  /** `area.name`, lower case with underscores. */
  key: string;
  scope: "server" | "org";
  type: SettingType;
  /** The default: true/false, a whole number, one of the choices or a text. */
  default: string;
  min?: number;
  max?: number;
  choices?: string[];
  /** For a choice: the UI's name of each value, same order as `choices`. */
  choiceEn?: string[];
  choiceDe?: string[];
  maxChars?: number;
  multiline?: boolean;
  /** English, for the registry; the UI shows its own texts. */
  description: string;
  labelEn: string;
  labelDe: string;
  descriptionEn: string;
  descriptionDe: string;
  /** Id of the settings section (`general`, `security`, `datasources`, `storage`, `organization`, ...). */
  section: string;
  /** What else the docs row says after the accepted values. */
  docs?: string;
  /** Words that find the section in search, appended to its keywords. */
  keywordsEn?: string;
  keywordsDe?: string;
  /** False keeps it file or environment only (settings that could lock an admin out). */
  uiEditable?: boolean;
  format?: boolean;
}

const KEY = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const EXPLICIT_SAVE = ["mail", "smtp", "sso", "oidc", "ldap", "saml", "scim"];
/** Sections whose page lists registry rows with the shared row component. */
const GENERIC_KINDS = ["settings", "network", "appearance"];

interface Typed {
  rustDefault: string;
  jsonDefault: string;
  rule: string;
  accepts: string;
  bad: string[];
}

function rustString(text: string): string {
  return JSON.stringify(text);
}

function typed(request: SettingRequest): Typed {
  const raw = request.default.trim();
  switch (request.type) {
    case "bool": {
      if (raw !== "true" && raw !== "false") {
        throw new Error("a bool setting's default is true or false");
      }
      return {
        rustDefault: `json!(${raw})`,
        jsonDefault: raw,
        rule: "Rule::Bool",
        accepts: "`true`, `false`",
        bad: ['json!("yes")', "json!(1)"],
      };
    }
    case "int": {
      const { min, max } = request;
      const value = Number(raw);
      if (
        min === undefined ||
        max === undefined ||
        !Number.isInteger(min) ||
        !Number.isInteger(max) ||
        min > max
      ) {
        throw new Error("a whole-number setting needs min and max (min <= max)");
      }
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`the default ${raw} is not a whole number from ${min} to ${max}`);
      }
      return {
        rustDefault: `json!(${value})`,
        jsonDefault: String(value),
        rule: `Rule::Int { min: ${min}, max: ${max} }`,
        accepts: `whole number ${min} to ${max}`,
        bad: [`json!(${min - 1})`, `json!(${max + 1})`, `json!("${value}")`],
      };
    }
    case "choice": {
      const choices = request.choices ?? [];
      if (choices.length < 2 || choices.some((c) => !/^[a-z0-9_-]+$/.test(c))) {
        throw new Error(
          "a choice setting needs at least two choices of lower-case letters, digits, - or _",
        );
      }
      if (!choices.includes(raw)) {
        throw new Error(`the default ${raw} is not one of ${choices.join(", ")}`);
      }
      if (
        request.choiceEn?.length !== choices.length ||
        request.choiceDe?.length !== choices.length
      ) {
        throw new Error("a choice setting needs choiceEn and choiceDe, one name per choice");
      }
      return {
        rustDefault: `json!(${rustString(raw)})`,
        jsonDefault: JSON.stringify(raw),
        rule: `Rule::OneOf(&[${choices.map(rustString).join(", ")}])`,
        accepts: choices.map((c) => `\`"${c}"\``).join(", "),
        bad: ['json!("none-of-them")', "json!(1)"],
      };
    }
    case "text": {
      const maxChars = request.maxChars;
      if (maxChars === undefined || !Number.isInteger(maxChars) || maxChars < 1) {
        throw new Error("a text setting needs maxChars");
      }
      if (raw.length > maxChars) {
        throw new Error(`the default is longer than ${maxChars} characters`);
      }
      const multiline = request.multiline === true;
      return {
        rustDefault: `json!(${rustString(raw)})`,
        jsonDefault: JSON.stringify(raw),
        rule: `Rule::Text { max_chars: ${maxChars}, multiline: ${multiline}, required: false }`,
        accepts: `text of up to ${maxChars} characters${multiline ? ", several lines" : ", one line"}`,
        bad: [`json!("x".repeat(${maxChars + 1}))`, "json!(1)"],
      };
    }
    default:
      throw new Error(`type is one of ${SETTING_TYPES.join(", ")}`);
  }
}

/** Inserts the registry entry after the last one of the same area and scope. */
export function insertRegistryEntry(
  settings: string,
  key: string,
  scope: "server" | "org",
  entry: string,
): string {
  const start = settings.indexOf("pub const REGISTRY: &[SettingDef] = &[");
  const end = settings.indexOf("\n];", start);
  if (start === -1 || end === -1) {
    throw new Error(`REGISTRY not found in ${SETTINGS}`);
  }
  const area = key.split(".")[0];
  const scopeRust = scope === "server" ? "Scope::Server" : "Scope::Org";
  const block = settings.slice(start, end);
  const defs = [...block.matchAll(/\n {4}SettingDef \{\n[\s\S]*?\n {4}\},/g)];
  let at = -1;
  for (const def of defs) {
    const text = def[0];
    const defKey = /key: "([\w.]+)"/.exec(text)?.[1] ?? "";
    if (defKey.split(".")[0] === area && text.includes(scopeRust)) {
      at = start + (def.index ?? 0) + text.length;
    }
  }
  if (at === -1) {
    // Before the settings that live in the configuration, which close the list.
    const config = defs.find((def) => def[0].includes('key: "server.http_addr"'));
    at = config === undefined ? end : start + (config.index ?? 0);
  }
  return `${settings.slice(0, at)}\n${entry}${settings.slice(at)}`;
}

/** Adds the rule's match arm before the catch-all of `fn rule`. */
export function insertRule(settings: string, key: string, rule: string): string {
  const fn = settings.indexOf("fn rule(key: &str) -> Option<Rule> {");
  const fallback = settings.indexOf("        _ => return None,", fn);
  if (fn === -1 || fallback === -1) {
    throw new Error(`fn rule with its catch-all not found in ${SETTINGS}`);
  }
  return `${settings.slice(0, fallback)}        "${key}" => ${rule},\n${settings.slice(fallback)}`;
}

/** Adds a key to the `keys` list of a section in sections.ts. */
export function addToSection(sections: string, sectionId: string, key: string): string {
  const at = sections.indexOf(`    id: "${sectionId}",`);
  if (at === -1) {
    throw new Error(`no section ${sectionId} in ui/src/features/settings/sections.ts`);
  }
  const next = sections.indexOf("\n  },", at);
  const keysAt = sections.indexOf("keys: [", at);
  if (keysAt === -1 || keysAt > next) {
    throw new Error(
      `section ${sectionId} has no keys list; pick a section that lists registry rows`,
    );
  }
  const open = keysAt + "keys: ".length;
  const close = sections.indexOf("]", open);
  const inner = sections.slice(open + 1, close);
  if (inner.includes("\n")) {
    const trimmed = inner.trimEnd();
    const separator = trimmed.endsWith(",") || trimmed === "" ? "" : ",";
    return `${sections.slice(0, open + 1)}${trimmed}${separator}\n      "${key}",\n    ${sections.slice(close)}`;
  }
  const separator = inner.trim() === "" ? "" : ", ";
  return `${sections.slice(0, close)}${separator}"${key}"${sections.slice(close)}`;
}

/** The kind of a section, read from sections.ts. */
export function sectionKind(sections: string, sectionId: string): string | undefined {
  const at = sections.indexOf(`    id: "${sectionId}",`);
  return at === -1 ? undefined : /kind: "(\w+)"/.exec(sections.slice(at, at + 400))?.[1];
}

/** Adds a `case` with the choices' names to `choicesOf` in rows.tsx. */
export function addChoices(rows: string, key: string, values: string[]): string {
  const fn = rows.indexOf("function choicesOf(");
  const fallback = rows.indexOf("    default:\n      return undefined;", fn);
  if (fn === -1 || fallback === -1) {
    throw new Error("choicesOf with its default not found in ui/src/features/settings/rows.tsx");
  }
  const items = values
    .map(
      (value) =>
        `        { value: "${value}", label: t("admin.settings.${key}.choice.${value}") },`,
    )
    .join("\n");
  return `${rows.slice(0, fallback)}    case "${key}":\n      return [\n${items}\n      ];\n${rows.slice(fallback)}`;
}

/** Replaces one catalog value in place (the rest of the file keeps its form). */
export function appendToEntry(source: string, key: string, extra: string): string {
  const parsed = JSON.parse(source) as Record<string, string>;
  const current = parsed[key];
  if (current === undefined) {
    throw new Error(`${key} not found`);
  }
  const lines = source.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`  ${JSON.stringify(key)}:`));
  const comma = (lines[at] ?? "").trimEnd().endsWith(",") ? "," : "";
  lines[at] =
    `  ${JSON.stringify(key)}: ${JSON.stringify(`${current} ${extra.trim()}`.trim())}${comma}`;
  return lines.join("\n");
}

/** Adds the docs row to the server or organization settings table. */
export function insertDocsRow(
  doc: string,
  scope: "server" | "org",
  key: string,
  row: string,
): string {
  const marker = scope === "server" ? "Server settings:" : "Organization settings:";
  const lines = doc.split("\n");
  const start = lines.indexOf(marker);
  if (start === -1) {
    throw new Error(`"${marker}" not found in docs/api/settings-dashboards.md`);
  }
  let first = start + 1;
  while (first < lines.length && !(lines[first] ?? "").startsWith("|")) {
    first++;
  }
  let end = first;
  while (end < lines.length && (lines[end] ?? "").startsWith("|")) {
    end++;
  }
  const area = key.split(".")[0];
  let at = end;
  for (let i = first + 2; i < end; i++) {
    if ((lines[i] ?? "").startsWith(`| \`${area}.`)) {
      at = i + 1;
    }
  }
  lines.splice(at, 0, row);
  return lines.join("\n");
}

function testSnake(key: string): string {
  return key.replace(/\./g, "_");
}

function serverTest(request: SettingRequest, t: Typed): string {
  const name = testSnake(request.key);
  const scope = request.scope === "server" ? "Scope::Server" : "Scope::Org";
  const editable = request.uiEditable !== false;
  const lines = [
    `//! The \`${request.key}\` setting (docs/api/settings-dashboards.md, "Settings"): registered with`,
    "//! its default and rule; values outside the rule are refused.",
    "",
    "use kalzit::settings::{self, Scope};",
    "use serde_json::json;",
    "",
    "#[test]",
    `fn ${name}_is_registered_with_a_valid_default() {`,
    `    let def = settings::find("${request.key}", ${scope}).expect("registered");`,
    `    assert!(${editable ? "" : "!"}def.ui_editable);`,
    `    assert_eq!((def.default)(), json!(${t.jsonDefault}));`,
    "    assert!(settings::validate(def, &(def.default)()).is_ok());",
    "}",
    "",
    "#[test]",
    `fn ${name}_refuses_values_outside_its_rule() {`,
    `    let def = settings::find("${request.key}", ${scope}).expect("registered");`,
    `    for bad in [${t.bad.join(", ")}] {`,
    '        assert!(settings::validate(def, &bad).is_err(), "{bad}");',
    "    }",
    "}",
  ];
  if (request.scope === "server") {
    lines.push(
      "",
      "/// A value from the environment locks the setting in the UI (`source` is `environment`).",
      "#[test]",
      `fn ${name}_can_be_set_from_the_environment() {`,
      `    assert_eq!(settings::env_var_name("${request.key}"), "KALZIT_SETTING_${request.key.replace(/\./g, "_").toUpperCase()}");`,
      "}",
    );
  }
  return `${lines.join("\n")}\n`;
}

function uiTest(request: SettingRequest): string {
  const label = `admin.settings.${request.key}.label`;
  return `import { describe, expect, it } from "vitest";
import { de, en } from "../../../i18n/catalogs";
import { buildIndex, search } from "../search";
import { findSection, rowId, SECTIONS } from "../sections";

/** The \`${request.key}\` setting: placed in its section and found by its name in both languages. */
describe("${request.key}", () => {
  const section = findSection("${request.section}");
  const access = {
    permissions: { has: () => true, isServerAdmin: true, loaded: true },
    orgId: "00000000-0000-7000-8000-000000000001",
  };

  it("sits in the ${request.section} section", () => {
    expect(section?.keys).toContain("${request.key}");
  });

  it.each([
    ["de", de["${label}"]],
    ["en", en["${label}"]],
  ])("is found by its %s name", (_language, name) => {
    const index = buildIndex(SECTIONS, access);
    const id = section === undefined ? "" : rowId(section, "${request.key}");
    expect(search(index, name).map((entry) => entry.rowId)).toContain(id);
  });
});
`;
}

export function scaffoldSetting(root: string, input: SettingRequest): ScaffoldResult {
  // Texts end up in Rust literals, Markdown table cells and JSON: one line each.
  const line = (text: string) => text.replace(/\s+/g, " ").trim();
  const request: SettingRequest = {
    ...input,
    description: line(input.description),
    labelEn: line(input.labelEn),
    labelDe: line(input.labelDe),
    descriptionEn: line(input.descriptionEn),
    descriptionDe: line(input.descriptionDe),
    ...(input.docs === undefined ? {} : { docs: line(input.docs).replace(/\|/g, "\\|") }),
  };
  if (!KEY.test(request.key)) {
    throw new Error(`${request.key} is not a setting key like audit.retention_days`);
  }
  const area = request.key.split(".")[0] ?? "";
  if (EXPLICIT_SAVE.includes(area)) {
    throw new Error(
      `${area}.* settings belong to a form with dependent fields: one explicit Save after a connection test, with a check token (see MailSection and the SSO pages), not a registry row`,
    );
  }
  if (request.scope !== "server" && request.scope !== "org") {
    throw new Error("scope is server or org");
  }
  const settingsFile = join(root, SETTINGS);
  let settings = readText(settingsFile);
  if (registryKeys(settings).includes(request.key)) {
    throw new Error(`${request.key} is in the registry already`);
  }
  const t = typed(request);
  const warnings: string[] = [];
  const changed: string[] = [];
  const created: string[] = [];

  const sectionsFile = join(root, "ui", "src", "features", "settings", "sections.ts");
  const sections = readText(sectionsFile);
  const kind = sectionKind(sections, request.section);
  if (kind === undefined) {
    throw new Error(`no section ${request.section} in sections.ts`);
  }
  if (!GENERIC_KINDS.includes(kind)) {
    warnings.push(
      `section ${request.section} is drawn by its own component (kind ${kind}); make sure it renders the new row with SettingRow`,
    );
  }

  // Texts first: nothing is written when one breaks the translation rules.
  const texts: [string, Record<Language, string>][] = [
    [`admin.settings.${request.key}.label`, { de: request.labelDe, en: request.labelEn }],
    [
      `admin.settings.${request.key}.description`,
      { de: request.descriptionDe, en: request.descriptionEn },
    ],
  ];
  if (request.type === "choice") {
    (request.choices ?? []).forEach((value, i) => {
      texts.push([
        `admin.settings.${request.key}.choice.${value}`,
        { de: request.choiceDe?.[i] ?? "", en: request.choiceEn?.[i] ?? "" },
      ]);
    });
  }
  const problems = texts.flatMap(([key, value]) => messageProblems(root, key, value));
  if (problems.length > 0) {
    throw new Error(`the texts break the translation rules:\n- ${problems.join("\n- ")}`);
  }

  // 1. Registry entry and rule.
  const scopeRust = request.scope === "server" ? "Scope::Server" : "Scope::Org";
  const entry = [
    "    SettingDef {",
    `        key: "${request.key}",`,
    `        scope: ${scopeRust},`,
    `        default: || ${t.rustDefault},`,
    `        ui_editable: ${request.uiEditable !== false},`,
    `        description: ${rustString(request.description.trim())},`,
    "    },",
  ].join("\n");
  settings = insertRegistryEntry(settings, request.key, request.scope, entry);
  settings = insertRule(settings, request.key, t.rule);
  writeText(settingsFile, settings);
  changed.push(SETTINGS);

  // 2. A key whose area is a reasons namespace looks like a reason to the reasons check.
  const detailFile = join(root, DETAIL);
  const detail = readText(detailFile);
  if (namespaces(detail).includes(area)) {
    writeText(detailFile, addNotReason(detail, request.key, "Setting key, written like a reason."));
    changed.push(DETAIL);
  }

  // 3. The generated SettingKey union, as the shapes test writes it.
  const shapesFile = join(root, SHAPES);
  writeText(shapesFile, setUnion(readText(shapesFile), "SettingKey", registryKeys(settings)));
  changed.push(SHAPES);

  // 4. UI texts, section row, choices and search words.
  const uiFiles: string[] = [];
  for (const language of LANGUAGES) {
    const file = join(root, "ui", "src", "i18n", language, "admin.json");
    let source = readText(file);
    for (const [key, value] of texts) {
      source = insertEntry(source, key, value[language]);
    }
    writeText(file, source);
    changed.push(`ui/src/i18n/${language}/admin.json`);
    uiFiles.push(file);
  }
  writeText(sectionsFile, addToSection(sections, request.section, request.key));
  changed.push("ui/src/features/settings/sections.ts");
  uiFiles.push(sectionsFile);
  if (request.type === "choice") {
    const rowsFile = join(root, "ui", "src", "features", "settings", "rows.tsx");
    writeText(rowsFile, addChoices(readText(rowsFile), request.key, request.choices ?? []));
    changed.push("ui/src/features/settings/rows.tsx");
    uiFiles.push(rowsFile);
  }
  if (request.keywordsEn !== undefined || request.keywordsDe !== undefined) {
    for (const language of LANGUAGES) {
      const words = language === "de" ? request.keywordsDe : request.keywordsEn;
      if (words === undefined || words.trim() === "") {
        continue;
      }
      const file = join(root, "ui", "src", "i18n", language, "settings.json");
      writeText(
        file,
        appendToEntry(
          readText(file),
          `settings.section.${request.section}.keywords`,
          words.toLowerCase(),
        ),
      );
      changed.push(`ui/src/i18n/${language}/settings.json`);
      uiFiles.push(file);
    }
  }

  // 5. Docs.
  const docsFile = join(root, "docs", "api", "settings-dashboards.md");
  const extra =
    request.docs === undefined || request.docs.trim() === ""
      ? ""
      : `; ${request.docs.trim().replace(/\.$/, "")}`;
  const row = `| \`${request.key}\` | \`${t.jsonDefault}\` | ${t.accepts}${extra} |`;
  writeText(docsFile, insertDocsRow(readText(docsFile), request.scope, request.key, row));
  changed.push("docs/api/settings-dashboards.md");

  // 6. Tests.
  const serverTestFile = join(root, "server", "tests", `setting_${testSnake(request.key)}.rs`);
  if (existsSync(serverTestFile)) {
    throw new Error(`server/tests/setting_${testSnake(request.key)}.rs exists already`);
  }
  writeText(serverTestFile, serverTest(request, t));
  created.push(`server/tests/setting_${testSnake(request.key)}.rs`);
  const uiDir = join(root, "ui", "src", "features", "settings", "settingTests");
  mkdirSync(uiDir, { recursive: true });
  const uiTestFile = join(uiDir, `${request.key}.test.ts`);
  writeText(uiTestFile, uiTest(request));
  created.push(`ui/src/features/settings/settingTests/${request.key}.test.ts`);
  uiFiles.push(uiTestFile);

  if (request.format !== false) {
    const rust = formatRust(root, [
      settingsFile,
      serverTestFile,
      ...(changed.includes(DETAIL) ? [detailFile] : []),
    ]);
    if (rust !== undefined) {
      warnings.push(rust);
    }
    const ui = formatUi(root, uiFiles);
    if (ui !== undefined) {
      warnings.push(ui);
    }
  }
  return {
    changed: [...new Set(changed)],
    created,
    next: [
      `read the value where it takes effect: crate::settings::get(&state, "${request.key}")`,
      `cargo test --test setting_${testSnake(request.key)} and cargo test generated_typescript_is_current`,
      `npm test -- src/features/settings src/features/admin/settingTexts.test.ts src/i18n (in ui)`,
    ],
    warnings,
  };
}
