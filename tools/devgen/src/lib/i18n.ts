import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readText, slash, writeText } from "./repo.ts";

/**
 * The UI catalogs (`ui/src/i18n/<language>/<area>.json`): adding a key in both languages at once,
 * and the checks of the translation tests before CI runs them. The language rules are read from
 * `ui/src/i18n/i18n.test.ts` where they are written as data (the formal-address pattern, the
 * German and English word lists, the names allowed to be the same in both languages), so the
 * test stays the one place they are defined; built-in copies are only a fallback.
 */

export const I18N_DIR = "ui/src/i18n";
export const LANGUAGES = ["de", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export type AreaCatalog = { area: string; entries: [string, string][] };
export type Catalogs = Record<Language, AreaCatalog[]>;

export function readCatalogs(root: string): Catalogs {
  const out = { de: [], en: [] } as Catalogs;
  for (const language of LANGUAGES) {
    const dir = join(root, I18N_DIR, language);
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const parsed = JSON.parse(readText(join(dir, name))) as Record<string, string>;
      out[language].push({ area: name.replace(/\.json$/, ""), entries: Object.entries(parsed) });
    }
  }
  return out;
}

export function flat(catalogs: Catalogs, language: Language): Map<string, string> {
  const map = new Map<string, string>();
  for (const { entries } of catalogs[language]) {
    for (const [key, value] of entries) {
      map.set(key, value);
    }
  }
  return map;
}

/** The number of leading dot-separated segments two keys share. */
function sharedSegments(a: string, b: string): number {
  const x = a.split(".");
  const y = b.split(".");
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) {
    n++;
  }
  return n;
}

/** The area file whose keys share the most leading segments with `key` (`admin.users.x` -> admin). */
export function areaFor(catalogs: Catalogs, key: string): string {
  let best = { area: "core", score: 0 };
  for (const { area, entries } of catalogs.en) {
    for (const [existing] of entries) {
      const score = sharedSegments(existing, key);
      if (score > best.score) {
        best = { area, score };
      }
    }
  }
  return best.area;
}

/**
 * The catalog text with `key: value` inserted after the last key that shares the most leading
 * segments with it, so a key lands next to its siblings. Edited as text, so the rest of the file
 * keeps its exact form.
 */
export function insertEntry(source: string, key: string, value: string): string {
  const text = source.replace(/\r\n/g, "\n");
  const parsed = JSON.parse(text) as Record<string, string>;
  if (Object.hasOwn(parsed, key)) {
    throw new Error(`${key} exists already`);
  }
  const keys = Object.keys(parsed);
  const entry = `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  if (keys.length === 0) {
    return `{\n${entry}\n}\n`;
  }
  let anchor = keys[keys.length - 1] ?? "";
  let best = -1;
  for (const existing of keys) {
    const score = sharedSegments(existing, key);
    if (score >= best && score > 0) {
      if (score > best) {
        best = score;
      }
      anchor = existing;
    }
  }
  if (best <= 0) {
    anchor = keys[keys.length - 1] ?? "";
  }
  const lines = text.split("\n");
  const prefix = `  ${JSON.stringify(anchor)}:`;
  const at = lines.findIndex((line) => line.startsWith(prefix));
  if (at === -1) {
    throw new Error(`cannot find the line of ${anchor}; is the file formatted (one key per line)?`);
  }
  const anchorLine = lines[at] ?? "";
  const isLast = !anchorLine.trimEnd().endsWith(",");
  if (isLast) {
    lines[at] = `${anchorLine.trimEnd()},`;
    lines.splice(at + 1, 0, entry);
  } else {
    lines.splice(at + 1, 0, `${entry},`);
  }
  const out = lines.join("\n");
  JSON.parse(out);
  return out.endsWith("\n") ? out : `${out}\n`;
}

export interface AddRequest {
  key: string;
  de: string;
  en: string;
  /** Area file name without `.json`; found from the key's siblings when left out. */
  area?: string;
  /** Adds `<key>One` and `<key>Many` (the UI's `plural`), with these as the texts for one. */
  plural?: { deOne: string; enOne: string };
}

export interface AddResult {
  area: string;
  keys: string[];
  files: string[];
  problems: string[];
}

const KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+)+$/;

/** Adds a key in German and English, next to its siblings, and checks the texts right away. */
export function i18nAdd(root: string, request: AddRequest): AddResult {
  if (!KEY.test(request.key)) {
    throw new Error(`${request.key} is not a catalog key such as admin.users.title`);
  }
  const catalogs = readCatalogs(root);
  const area = request.area ?? areaFor(catalogs, request.key);
  const additions: [string, Record<Language, string>][] =
    request.plural === undefined
      ? [[request.key, { de: request.de, en: request.en }]]
      : [
          [`${request.key}One`, { de: request.plural.deOne, en: request.plural.enOne }],
          [`${request.key}Many`, { de: request.de, en: request.en }],
        ];
  for (const language of LANGUAGES) {
    const existing = flat(catalogs, language);
    for (const [key] of additions) {
      if (existing.has(key)) {
        throw new Error(`${language}: ${key} exists already`);
      }
    }
  }
  const problems: string[] = [];
  for (const [key, texts] of additions) {
    problems.push(...messageProblems(root, key, texts));
    if (request.plural !== undefined && !texts.en.includes("{count}")) {
      problems.push(`${key}: a plural text names the count with {count}`);
    }
  }
  const files: string[] = [];
  for (const language of LANGUAGES) {
    const path = join(root, I18N_DIR, language, `${area}.json`);
    if (!existsSync(path)) {
      throw new Error(`${slash(relative(root, path))} does not exist; pick an existing area`);
    }
    let source = readText(path);
    for (const [key, texts] of additions) {
      source = insertEntry(source, key, texts[language]);
    }
    writeText(path, source);
    files.push(slash(relative(root, path)));
  }
  return { area, keys: additions.map(([key]) => key), files, problems };
}

// ---------------------------------------------------------------------------------------------
// Checks

interface Rules {
  formal: RegExp;
  german: RegExp;
  english: RegExp;
  same: Set<string>;
  source: "test" | "fallback";
}

const FALLBACK_RULES: Rules = {
  formal: /\b(Sie|Ihnen|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)\b/,
  german:
    /[äöüÄÖÜß]|\b(und|oder|nicht|mit|für|der|die|das|ein|eine|du|dein|deine|Datenquelle|Datenquellen|Einstellungen|Anmelden|Abmelden|Passwort|Konto|Verwaltung|Organisation|Einrichtungscode|Wird)\b/,
  english:
    /\b(the|and|or|not|with|your|you|Sign in|Sign out|Settings|Password|Email|Loading|Setup|Data sources|Try again|Theme|Language)\b/,
  same: new Set(),
  source: "fallback",
};

/** The rules as `ui/src/i18n/i18n.test.ts` writes them. */
export function readRules(root: string): Rules {
  const path = join(root, I18N_DIR, "i18n.test.ts");
  if (!existsSync(path)) {
    return FALLBACK_RULES;
  }
  const test = readText(path);
  const pattern = (name: string): RegExp | undefined => {
    const match = new RegExp(`const ${name} =\\s*\\/(.+?)\\/([a-z]*);`).exec(test);
    if (match === null) {
      return undefined;
    }
    try {
      return new RegExp(match[1] ?? "", match[2] ?? "");
    } catch {
      return undefined;
    }
  };
  const sameBlock = /const same = new Set\(\[([\s\S]*?)\]\);/.exec(test)?.[1];
  const same = new Set(
    [...(sameBlock ?? "").matchAll(/^\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)].map((m) =>
      JSON.parse(`"${m[1] ?? ""}"`),
    ),
  );
  const formal = pattern("formal");
  const german = pattern("german");
  const english = pattern("english");
  if (formal === undefined || german === undefined || english === undefined) {
    return { ...FALLBACK_RULES, same };
  }
  return { formal, german, english, same, source: "test" };
}

export interface AvoidWord {
  word: string;
  languages: Language[];
}

/** The "Avoid" column of docs/glossary.md, parsed as the glossary test does. */
export function glossaryAvoid(glossary: string): AvoidWord[] {
  const avoid: AvoidWord[] = [];
  for (const line of glossary.replace(/\r\n/g, "\n").split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length !== 6 || cells[1] === "Deutsch" || cells[1]?.startsWith("---")) {
      continue;
    }
    for (const raw of (cells[4] ?? "").split(",").map((part) => part.trim())) {
      if (raw === "") {
        continue;
      }
      const qualified = /^(.*?)\s*\((.+)\)$/.exec(raw);
      if (qualified === null) {
        avoid.push({ word: raw, languages: ["de", "en"] });
      } else if (qualified[2] === "im Deutschen") {
        avoid.push({ word: qualified[1] ?? "", languages: ["de"] });
      } else if (qualified[2] === "in English") {
        avoid.push({ word: qualified[1] ?? "", languages: ["en"] });
      }
    }
  }
  return avoid;
}

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function avoidPattern(word: string): RegExp {
  const edge = "[^\\p{L}\\p{N}-]";
  return new RegExp(`(^|${edge})${escapeRegExp(word)}($|${edge})`, "u");
}

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
}

let cachedContext: { root: string; rules: Rules; avoid: AvoidWord[] } | undefined;
function context(root: string) {
  if (cachedContext?.root !== root) {
    const glossaryPath = join(root, "docs", "glossary.md");
    const avoid = existsSync(glossaryPath) ? glossaryAvoid(readText(glossaryPath)) : [];
    cachedContext = { root, rules: readRules(root), avoid };
  }
  return cachedContext;
}

/** What the translation tests would say about one key's German and English text. */
export function messageProblems(
  root: string,
  key: string,
  texts: Record<Language, string>,
): string[] {
  const { rules, avoid } = context(root);
  const problems: string[] = [];
  for (const language of LANGUAGES) {
    const message = texts[language];
    const at = `${language}:${key}`;
    if (message.trim() === "") {
      problems.push(`${at} is empty`);
      continue;
    }
    if (/\p{Extended_Pictographic}/u.test(message)) {
      problems.push(`${at} contains an emoji`);
    }
    if (/\s…/.test(message)) {
      problems.push(`${at} has a space before …`);
    }
    if (message.includes("...")) {
      problems.push(`${at} uses ... instead of …`);
    }
    if (message.includes("'")) {
      problems.push(`${at} uses ' instead of ’`);
    }
    for (const { word, languages } of avoid) {
      if (languages.includes(language) && avoidPattern(word).test(message)) {
        problems.push(`${at} uses "${word}", which docs/glossary.md says to avoid`);
      }
    }
  }
  const de = texts.de;
  const en = texts.en;
  if (/["”]/.test(de)) {
    problems.push(`de:${key} uses straight or English quotes; German uses „…“`);
  }
  if ((de.match(/„/g) ?? []).length !== (de.match(/“/g) ?? []).length) {
    problems.push(`de:${key} has unbalanced „…“`);
  }
  if (/["„]/.test(en)) {
    problems.push(`en:${key} uses straight or German quotes; English uses “…”`);
  }
  if ((en.match(/“/g) ?? []).length !== (en.match(/”/g) ?? []).length) {
    problems.push(`en:${key} has unbalanced “…”`);
  }
  if (rules.formal.test(de)) {
    problems.push(`de:${key} addresses the user with Sie; use du`);
  }
  if (key !== "language.en" && rules.english.test(de)) {
    problems.push(`de:${key} still contains English words`);
  }
  if (key !== "language.de" && rules.german.test(en)) {
    problems.push(`en:${key} contains German words`);
  }
  if (placeholders(de).join() !== placeholders(en).join()) {
    problems.push(`${key}: the placeholders differ between German and English`);
  }
  const words = de.replace(/\{\w+\}/g, "").replace(/[^\p{L}]+/gu, "");
  if (words.length >= 3 && de === en && !rules.same.has(de)) {
    problems.push(
      `de:${key} is the same as English; translate it (or add a real loanword to "same" in i18n.test.ts)`,
    );
  }
  return problems;
}

export interface CheckResult {
  errors: string[];
  /** Keys no source file names, with the families the UI builds at runtime taken into account. */
  unused: string[];
  warnings: string[];
  checkedKeys: number;
  rulesFrom: "test" | "fallback";
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules" && name !== "generated") {
        sourceFiles(path, out);
      }
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** String literals and template-literal heads in the UI's non-test code. */
export function codeReferences(sources: string[]): { literals: Set<string>; prefixes: string[] } {
  const literals = new Set<string>();
  const prefixes = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/"([A-Za-z][\w.-]*)"|'([A-Za-z][\w.-]*)'/g)) {
      const value = match[1] ?? match[2] ?? "";
      literals.add(value);
      if (value.endsWith(".")) {
        prefixes.add(value);
      }
    }
    for (const match of source.matchAll(/`([A-Za-z][\w.-]*)\$\{/g)) {
      prefixes.add(match[1] ?? "");
    }
    for (const match of source.matchAll(/`([A-Za-z][\w.-]*)`/g)) {
      literals.add(match[1] ?? "");
    }
  }
  return { literals, prefixes: [...prefixes].filter((p) => p.includes(".")) };
}

export function isReferenced(
  key: string,
  refs: { literals: Set<string>; prefixes: string[] },
): boolean {
  if (refs.literals.has(key)) {
    return true;
  }
  // `plural(t, "x.items", n)` reads x.itemsOne and x.itemsMany; `fooNamed` pairs with `foo`.
  for (const suffix of ["One", "Many", "Named"]) {
    if (key.endsWith(suffix) && refs.literals.has(key.slice(0, -suffix.length))) {
      return true;
    }
  }
  return refs.prefixes.some((prefix) => key.startsWith(prefix));
}

/** The translation tests' checks over every catalog, plus missing and unused keys. */
export function i18nCheck(root: string, options: { keys?: string[] } = {}): CheckResult {
  const catalogs = readCatalogs(root);
  const de = flat(catalogs, "de");
  const en = flat(catalogs, "en");
  const errors: string[] = [];
  const warnings: string[] = [];
  const only = options.keys === undefined ? undefined : new Set(options.keys);
  const wanted = (key: string) => only === undefined || only.has(key);

  const deAreas = new Set(catalogs.de.map((c) => c.area));
  const enAreas = new Set(catalogs.en.map((c) => c.area));
  for (const area of enAreas) {
    if (!deAreas.has(area)) {
      errors.push(`ui/src/i18n/de/${area}.json is missing`);
    }
  }
  for (const area of deAreas) {
    if (!enAreas.has(area)) {
      errors.push(`ui/src/i18n/en/${area}.json is missing`);
    }
  }
  for (const [key] of en) {
    if (wanted(key) && !de.has(key)) {
      errors.push(`de: ${key} is missing (it is in English)`);
    }
  }
  for (const [key] of de) {
    if (wanted(key) && !en.has(key)) {
      errors.push(`en: ${key} is missing (it is in German)`);
    }
  }
  // The same key in two area files: the later spread in catalogs.ts wins silently.
  for (const language of LANGUAGES) {
    const seen = new Map<string, string>();
    for (const { area, entries } of catalogs[language]) {
      for (const [key] of entries) {
        const before = seen.get(key);
        if (before !== undefined && wanted(key)) {
          errors.push(`${language}: ${key} is in both ${before}.json and ${area}.json`);
        }
        seen.set(key, area);
      }
    }
    // A key belongs in the same area file in both languages.
  }
  const enArea = new Map<string, string>();
  for (const { area, entries } of catalogs.en) {
    for (const [key] of entries) {
      enArea.set(key, area);
    }
  }
  for (const { area, entries } of catalogs.de) {
    for (const [key] of entries) {
      const other = enArea.get(key);
      if (other !== undefined && other !== area && wanted(key)) {
        errors.push(`${key} is in de/${area}.json but en/${other}.json`);
      }
    }
  }

  let checked = 0;
  for (const [key, english] of en) {
    const german = de.get(key);
    if (german === undefined || !wanted(key)) {
      continue;
    }
    checked++;
    errors.push(...messageProblems(root, key, { de: german, en: english }));
  }

  const files = sourceFiles(join(root, "ui", "src"));
  const sources = files.map((file) => readText(file));
  const refs = codeReferences(sources);
  // Keys the code names in t("...") that no catalog has (the typecheck says so too, later).
  for (const [index, source] of sources.entries()) {
    for (const match of source.matchAll(/\bt\(\s*"([a-z][\w.]*)"/g)) {
      const key = match[1] ?? "";
      if (!en.has(key) && wanted(key)) {
        errors.push(
          `${slash(relative(root, files[index] ?? ""))}: t("${key}") has no catalog entry`,
        );
      }
    }
  }
  const unused = [...en.keys()].filter((key) => wanted(key) && !isReferenced(key, refs));
  if (unused.length > 0) {
    warnings.push(
      `${unused.length} keys look unused (no literal, template head or plural base names them); check before removing, the UI may build them`,
    );
  }
  return { errors, unused, warnings, checkedKeys: checked, rulesFrom: context(root).rules.source };
}
