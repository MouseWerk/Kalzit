import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { de, en } from "./catalogs";

/**
 * Rules for the per-area catalog files (`<lang>/<area>.json`), read from disk so a new area file
 * is covered without editing this test. The language rules (parity, typography, glossary) run
 * over the combined catalogs in i18n.test.ts.
 */

const I18N_DIR = import.meta.dirname;
const LANGUAGES = ["de", "en"] as const;
const CORE = "core";

function filesOf(language: string): Map<string, Record<string, string>> {
  const dir = resolve(I18N_DIR, language);
  return new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [
        name.replace(/\.json$/, ""),
        JSON.parse(readFileSync(resolve(dir, name), "utf8")) as Record<string, string>,
      ]),
  );
}

const files = { de: filesOf("de"), en: filesOf("en") };
const areas = [...files.en.keys()].filter((name) => name !== CORE).sort();

describe("area catalogs", () => {
  it("has the same files in every language, including core", () => {
    expect([...files.de.keys()].sort()).toEqual([...files.en.keys()].sort());
    expect(files.en.has(CORE)).toBe(true);
    expect(areas.length).toBeGreaterThan(0);
  });

  it.each(areas)("%s: every key starts with the area name", (area) => {
    for (const language of LANGUAGES) {
      for (const key of Object.keys(files[language].get(area) ?? {})) {
        expect(key.startsWith(`${area}.`), `${language}/${area}.json: ${key}`).toBe(true);
      }
    }
  });

  it.each([CORE, ...areas])("%s: German and English have exactly the same keys", (name) => {
    const german = Object.keys(files.de.get(name) ?? {}).sort();
    const english = Object.keys(files.en.get(name) ?? {}).sort();
    expect(german).toEqual(english);
  });

  it("keeps area keys out of core", () => {
    for (const language of LANGUAGES) {
      for (const key of Object.keys(files[language].get(CORE) ?? {})) {
        const prefix = key.split(".")[0] ?? "";
        expect(areas, `${language}/core.json: ${key} belongs in ${prefix}.json`).not.toContain(
          prefix,
        );
      }
    }
  });

  it("puts no key into two files", () => {
    for (const language of LANGUAGES) {
      const owner = new Map<string, string>();
      for (const [name, catalog] of files[language]) {
        for (const key of Object.keys(catalog)) {
          expect(owner.get(key), `${language}: ${key} in ${name}.json`).toBeUndefined();
          owner.set(key, name);
        }
      }
    }
  });

  it("combines every file into the catalogs (none forgotten in catalogs.ts)", () => {
    const combined = { de, en };
    for (const language of LANGUAGES) {
      const all = [...files[language].values()].flatMap((catalog) => Object.keys(catalog));
      expect(Object.keys(combined[language]).sort()).toEqual(all.sort());
    }
  });
});
