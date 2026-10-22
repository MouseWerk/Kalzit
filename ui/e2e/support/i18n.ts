import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Language = "de" | "en";

const I18N_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "i18n");

function load(language: Language): Record<string, string> {
  const dir = join(I18N_DIR, language);
  const merged: Record<string, string> = {};
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    Object.assign(merged, JSON.parse(readFileSync(join(dir, file), "utf8")));
  }
  return merged;
}

const catalogs: Record<Language, Record<string, string>> = { de: load("de"), en: load("en") };

/**
 * The UI text for a key, read from the same catalogs the app ships, so the tests find elements
 * by what people see without repeating the wording. Fails on an unknown key or placeholder.
 */
export function t(
  key: string,
  params: Readonly<Record<string, string | number>> = {},
  language: Language = "en",
): string {
  const message = catalogs[language][key];
  if (message === undefined) {
    throw new Error(`unknown message key ${key}`);
  }
  return message.replace(/\{(\w+)\}/g, (_whole, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`message ${key} needs the parameter ${name}`);
    }
    return String(value);
  });
}

/** The German text for a key. */
export function de(key: string, params: Readonly<Record<string, string | number>> = {}): string {
  return t(key, params, "de");
}

/** A message with any values in its placeholders, as a pattern ("Connected in 12 ms"). */
export function pattern(key: string, language: Language = "en"): RegExp {
  const message = catalogs[language][key];
  if (message === undefined) {
    throw new Error(`unknown message key ${key}`);
  }
  const parts = message.split(/\{\w+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(parts.join(".+?"));
}
