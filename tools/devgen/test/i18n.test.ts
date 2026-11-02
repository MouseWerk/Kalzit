import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codeReferences,
  glossaryAvoid,
  i18nAdd,
  i18nCheck,
  insertEntry,
  isReferenced,
  readRules,
} from "../src/lib/i18n.ts";
import { REPO, tempTree } from "./helpers.ts";

const GLOSSARY = `| Deutsch | English | Bedeutung / Meaning | Nicht verwenden / Avoid |
|---|---|---|---|
| Organisation | Organization | Oberste Einheit. | Mandant, Tenant |
| Konto | Account | Die Anmeldedaten. | Account (im Deutschen) |
| Abfrage | Query | Eine Anfrage. | Query (im Deutschen) |
`;

const json = (entries: Record<string, string>) => `${JSON.stringify(entries, null, 2)}\n`;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function fixture(de: Record<string, string>, en: Record<string, string>, code = "") {
  const tree = tempTree({
    "docs/glossary.md": GLOSSARY,
    "ui/src/i18n/de/admin.json": json(de),
    "ui/src/i18n/en/admin.json": json(en),
    "ui/src/i18n/de/core.json": json({ "core.ok": "In Ordnung" }),
    "ui/src/i18n/en/core.json": json({ "core.ok": "Okay" }),
    "ui/src/app.tsx": code,
  });
  cleanup = tree.done;
  return tree.dir;
}

describe("i18n_check", () => {
  it("passes on the real catalogs, with the rules read from the translation test", () => {
    const result = i18nCheck(REPO);
    expect(result.rulesFrom).toBe("test");
    expect(result.errors).toEqual([]);
    expect(result.checkedKeys).toBeGreaterThan(1000);
  });

  it("finds missing keys, Sie, glossary words, quotes and placeholders", () => {
    const root = fixture(
      {
        "admin.users.title": "Benutzer",
        "admin.users.lead": "Hier verwalten Sie Ihre Benutzer.",
        "admin.users.tenant": "Neuer Mandant",
        "admin.users.query": "Neue Query",
        "admin.users.quote": 'Der "Name"',
        "admin.users.count": "{count} Benutzer",
      },
      {
        "admin.users.title": "Users",
        "admin.users.lead": "Manage the users here.",
        "admin.users.tenant": "New organization",
        "admin.users.query": "New query",
        "admin.users.quote": "The “name”",
        "admin.users.count": "{n} users",
        "admin.users.extra": "Only in English",
      },
      'export const x = t("admin.users.title") + t("admin.users.gone");',
    );
    const { errors } = i18nCheck(root);
    const text = errors.join("\n");
    expect(text).toContain("de: admin.users.extra is missing");
    expect(text).toContain("de:admin.users.lead addresses the user with Sie");
    expect(text).toContain('de:admin.users.tenant uses "Mandant"');
    expect(text).toContain('de:admin.users.query uses "Query"');
    expect(text).not.toContain('en:admin.users.query uses "Query"');
    expect(text).toContain("de:admin.users.quote uses straight or English quotes");
    expect(text).toContain("admin.users.count: the placeholders differ");
    expect(text).toContain('t("admin.users.gone") has no catalog entry');
  });

  it("reads the glossary's words to avoid with their language qualifiers", () => {
    expect(glossaryAvoid(GLOSSARY)).toEqual([
      { word: "Mandant", languages: ["de", "en"] },
      { word: "Tenant", languages: ["de", "en"] },
      { word: "Account", languages: ["de"] },
      { word: "Query", languages: ["de"] },
    ]);
  });

  it("takes the language rules from ui/src/i18n/i18n.test.ts", () => {
    const rules = readRules(REPO);
    expect(rules.source).toBe("test");
    expect(rules.formal.test("Bitte melden Sie sich an")).toBe(true);
    expect(rules.same.has("Dashboard")).toBe(true);
    expect(rules.german.test("Open the Datenquelle")).toBe(true);
  });

  it("counts keys the UI builds at runtime as used", () => {
    const refs = codeReferences([
      `plural(t, "documents.tree.items", n); t(\`settings.density.${"$"}{value}\`); const PREFIX = "datasources.reason.";`,
    ]);
    expect(isReferenced("documents.tree.itemsOne", refs)).toBe(true);
    expect(isReferenced("settings.density.compact", refs)).toBe(true);
    expect(isReferenced("datasources.reason.sql.syntax", refs)).toBe(true);
    expect(isReferenced("admin.never.named", refs)).toBe(false);
  });
});

describe("i18n_add", () => {
  it("inserts next to the key's siblings and keeps the rest of the file as it was", () => {
    const source = json({
      "admin.users.title": "Users",
      "admin.teams.title": "Teams",
      "admin.roles.title": "Roles",
    });
    const out = insertEntry(source, "admin.users.lead", "Manage people.");
    expect(Object.keys(JSON.parse(out))).toEqual([
      "admin.users.title",
      "admin.users.lead",
      "admin.teams.title",
      "admin.roles.title",
    ]);
    expect(out.replace('  "admin.users.lead": "Manage people.",\n', "")).toBe(source);
  });

  it("adds after the last entry with the right commas", () => {
    const out = insertEntry(json({ "a.b": "x", "c.d": "y" }), "c.e", "z");
    expect(JSON.parse(out)).toEqual({ "a.b": "x", "c.d": "y", "c.e": "z" });
    expect(out.endsWith('  "c.e": "z"\n}\n')).toBe(true);
  });

  it("adds a key in both languages in the area of its siblings, and plural forms", () => {
    const root = fixture({ "admin.users.title": "Benutzer" }, { "admin.users.title": "Users" });
    const result = i18nAdd(root, {
      key: "admin.users.member",
      en: "{count} members",
      de: "{count} Mitglieder",
      plural: { enOne: "{count} member", deOne: "{count} Mitglied" },
    });
    expect(result.area).toBe("admin");
    expect(result.keys).toEqual(["admin.users.memberOne", "admin.users.memberMany"]);
    expect(result.problems).toEqual([]);
    const de = JSON.parse(readFileSync(join(root, "ui/src/i18n/de/admin.json"), "utf8"));
    expect(de["admin.users.memberOne"]).toBe("{count} Mitglied");
    expect(i18nCheck(root).errors).toEqual([]);
  });

  it("reports texts that would fail the translation tests", () => {
    const root = fixture({ "admin.users.title": "Benutzer" }, { "admin.users.title": "Users" });
    const result = i18nAdd(root, {
      key: "admin.users.hint",
      en: "Sign in again",
      de: "Melden Sie sich an",
    });
    expect(result.problems.join()).toContain("Sie");
  });

  it("refuses a key that exists", () => {
    const root = fixture({ "admin.users.title": "Benutzer" }, { "admin.users.title": "Users" });
    expect(() => i18nAdd(root, { key: "admin.users.title", en: "x", de: "y" })).toThrow(/exists/);
  });
});

describe("i18n_check, further rules", () => {
  it("checks that a fooNamed accessible name contains the visible text of foo", () => {
    const root = fixture(
      {
        "admin.users.remove": "Entfernen",
        "admin.users.removeNamed": "{name} löschen",
        "admin.users.edit": "Bearbeiten",
        "admin.users.editNamed": "{name} bearbeiten",
      },
      {
        "admin.users.remove": "Remove",
        "admin.users.removeNamed": "Remove {name}",
        "admin.users.edit": "Edit",
        "admin.users.editNamed": "Edit {name}",
      },
    );
    const named = i18nCheck(root).errors.filter((e) => e.includes("Named"));
    expect(named).toEqual([
      'de:admin.users.removeNamed does not contain its visible text "Entfernen": {name} löschen',
    ]);
  });

  it("fails loudly when the translation test changed its form", () => {
    const root = fixture({ "admin.users.title": "Benutzer" }, { "admin.users.title": "Users" });
    writeFileSync(join(root, "ui/src/i18n/i18n.test.ts"), "// rules moved elsewhere\n");
    expect(() => i18nCheck(root)).toThrow(/i18n\.test\.ts; the test changed its form/);
  });

  it("reads the rules again when the translation test changes", () => {
    const root = fixture({ "admin.users.title": "Benutzer" }, { "admin.users.title": "Users" });
    expect(i18nCheck(root).rulesFrom).toBe("fallback");
    const test = readFileSync(join(REPO, "ui/src/i18n/i18n.test.ts"), "utf8");
    writeFileSync(join(root, "ui/src/i18n/i18n.test.ts"), test);
    expect(i18nCheck(root).rulesFrom).toBe("test");
  });
});
