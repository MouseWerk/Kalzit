import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generatedUnion } from "../test/generated";
import { de, en } from "./catalogs";
import {
  detectLanguage,
  getLanguage,
  LANGUAGE_STORAGE_KEY,
  type Language,
  setLanguage,
  translate,
} from "./i18n";

const catalogs: Record<Language, Record<string, string>> = { de, en };
const entries = (language: Language) => Object.entries(catalogs[language]);

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
}

describe("catalogs", () => {
  it("have the same keys in both languages", () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
  });

  it("have no empty messages", () => {
    for (const language of ["de", "en"] as const) {
      for (const [key, message] of entries(language)) {
        expect(message.trim(), `${language}:${key}`).not.toBe("");
      }
    }
  });

  it("use the same placeholders in both languages", () => {
    for (const [key, message] of entries("en")) {
      expect(placeholders(catalogs.de[key] ?? ""), key).toEqual(placeholders(message));
    }
  });

  it("contain no emoji", () => {
    for (const language of ["de", "en"] as const) {
      for (const [key, message] of entries(language)) {
        expect(/\p{Extended_Pictographic}/u.test(message), `${language}:${key}`).toBe(false);
      }
    }
  });

  it("put an ellipsis directly after the word and use the ellipsis character", () => {
    for (const language of ["de", "en"] as const) {
      for (const [key, message] of entries(language)) {
        expect(/\s…/.test(message), `${language}:${key} has a space before …`).toBe(false);
        expect(message.includes("..."), `${language}:${key} uses ... instead of …`).toBe(false);
      }
    }
  });

  it("use German quotes „…“ in German and “…” in English, never straight quotes", () => {
    // Apostrophes too: ’ (data source’s), never the typewriter '.
    for (const language of ["de", "en"] as const) {
      for (const [key, message] of entries(language)) {
        expect(message.includes("'"), `${language}:${key} uses ' instead of ’`).toBe(false);
      }
    }
    for (const [key, message] of entries("de")) {
      expect(/["”]/.test(message), `de:${key}`).toBe(false);
      expect((message.match(/„/g) ?? []).length, `de:${key}`).toBe(
        (message.match(/“/g) ?? []).length,
      );
    }
    for (const [key, message] of entries("en")) {
      expect(/["„]/.test(message), `en:${key}`).toBe(false);
      expect((message.match(/“/g) ?? []).length, `en:${key}`).toBe(
        (message.match(/”/g) ?? []).length,
      );
    }
  });

  it("have no German message identical to its English one unless it is a name or loanword", () => {
    // Names, units, technical terms and words that are the same in both languages. Add a word
    // here only when it is really used as is in German; translate everything else.
    const same = new Set([
      "Server",
      "Admin",
      "Teams",
      "Name",
      "Team",
      "Person",
      "Kalzit",
      "HSTS",
      "Updates",
      "Online",
      "Offline",
      "Version",
      "Trend",
      "Median",
      "Minimum",
      "Maximum",
      "JSON",
      "Format",
      "Text",
      "Neutral",
      "System",
      "Deutsch",
      "English",
      "frame",
      "documents",
      "graph",
      "Dashboards",
      "Panel",
      "Dashboard",
      "Panels: {count}",
      "Team {team}",
      "Commit",
      "SQLite",
      "PostgreSQL",
      "GNU Affero General Public License v3.0",
      "Layout",
      "Links",
      "TLS",
      "{label} (optional)",
      "Host",
      "Port",
      "URL",
      "Status",
      "Name A–Z",
      "APIs",
      "Graph",
      "{from} → {to}",
      "{n} {title}",
      "Graph {name}: {size}",
      "API",
      "Details",
      "Median {ms} ms",
      "Lucene",
      "CSV",
      "NDJSON",
      "orders/open",
      "Schema",
      "Collection",
      "Find",
      "Filter",
      "ObjectId",
      "Date",
      "Decimal128",
      "Int64",
      "Double",
      "Number",
      "String",
      "Boolean",
      "Null",
      "Object",
      "Array",
      "Binary",
      "Int32",
      "UUID",
      "Regex",
      "Timestamp",
      "JavaScript",
      "Symbol",
      "MinKey",
      "MaxKey",
      "Undefined",
      "DBPointer",
      "Explore",
      "Community",
      "Labels",
      "Label",
      "Heatmap",
      "Hex",
      "Suffix",
      "Bits",
      "Watt",
      "Volt",
      "Ampere",
      "Hertz",
      "Kelvin",
      "Link",
      "Tooltip",
      "Linear",
      "Filter, >5",
      "Markdown",
      "Normal",
      "Playlists",
      "{n} min",
      "Playlist",
      "Logo",
      "Navigation",
      "Panels",
      "Live",
      "(optional)",
      "Explorer",
      "Property",
      "Properties",
      "Log",
      "Docker",
      "Installation",
      "Plugin",
      "Plugins",
      "Plugin · {publisher}",
      "Sandbox",
      "Beta",
    ]);
    for (const [key, message] of entries("de")) {
      const words = message.replace(/\{\w+\}/g, "").replace(/[^\p{L}]+/gu, "");
      if (words.length < 3 || message !== catalogs.en[key]) continue;
      expect(same.has(message), `de:${key} is still English: "${message}"`).toBe(true);
    }
  });

  it("address the user with du in German, never with Sie", () => {
    // "Sie" could one day mean "they" at the start of a sentence; rephrase rather than loosen.
    const formal = /\b(Sie|Ihnen|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)\b/;
    for (const [key, message] of entries("de")) {
      expect(formal.test(message), `de:${key}: ${message}`).toBe(false);
    }
  });

  it("have no German left in English", () => {
    // Language names are shown in their own language on purpose.
    const ownName = new Set(["language.de"]);
    const german =
      /[äöüÄÖÜß]|\b(und|oder|nicht|mit|für|der|die|das|ein|eine|du|dein|deine|Datenquelle|Datenquellen|Einstellungen|Anmelden|Abmelden|Passwort|Konto|Verwaltung|Organisation|Einrichtungscode|Wird)\b/;
    for (const [key, message] of entries("en")) {
      if (!ownName.has(key)) {
        expect(german.test(message), `en:${key}: ${message}`).toBe(false);
      }
    }
  });

  it("have no English left in German", () => {
    const ownName = new Set(["language.en"]);
    const english =
      /\b(the|and|or|not|with|your|you|Sign in|Sign out|Settings|Password|Email|Loading|Setup|Data sources|Try again|Theme|Language)\b/;
    for (const [key, message] of entries("de")) {
      if (!ownName.has(key)) {
        expect(english.test(message), `de:${key}: ${message}`).toBe(false);
      }
    }
  });

  // `fooNamed` is the accessible name of a control whose visible text is `foo`. Speech input
  // users say what they see, so the name has to contain the visible words in order (WCAG 2.5.3
  // "Label in Name"); axe flags a mismatch as serious.
  it("keep the visible text inside the accessible name of a named control", () => {
    // Named controls whose visible text is a shared key rather than the key without "Named".
    const visibleKey: Record<string, string> = {
      "admin.members.removeNamed": "admin.common.removeAsk",
      "admin.teams.deleteNamed": "admin.common.deleteAsk",
      "admin.teams.removeMemberNamed": "admin.common.removeAsk",
      "admin.roles.deleteNamed": "admin.common.deleteAsk",
      "admin.access.removeNamed": "admin.common.remove",
      "admin.users.renameNamed": "admin.common.rename",
      "admin.orgs.renameNamed": "admin.common.rename",
    };
    const words = (message: string) =>
      message
        .toLowerCase()
        .replace(/\{\w+\}/g, " ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    let checked = 0;
    for (const language of ["en", "de"] as const) {
      const catalog: Record<string, string> = language === "en" ? en : de;
      for (const [key, named] of entries(language)) {
        if (!key.endsWith("Named")) {
          continue;
        }
        const visible = catalog[visibleKey[key] ?? key.slice(0, -"Named".length)];
        expect(visible, `${key} has no visible text key; add it to visibleKey`).toBeDefined();
        expect(` ${words(named)} `, `${language}:${key}: ${named}`).toContain(
          ` ${words(visible ?? "")} `,
        );
        checked += 1;
      }
    }
    // Every named key in both languages; a new one without a visible key fails above.
    expect(checked).toBe(2 * Object.keys(en).filter((key) => key.endsWith("Named")).length);
  });
});

describe("glossary", () => {
  // docs/glossary.md lists words to avoid per concept. A qualifier in parentheses either limits
  // the word to one language ("im Deutschen", "in English") or describes a context the test
  // cannot judge (then the entry is left to review).
  const glossary = readFileSync(resolve(import.meta.dirname, "../../../docs/glossary.md"), "utf8");
  const avoid: { word: string; languages: Language[] }[] = [];
  for (const line of glossary.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    // | Deutsch | English | Bedeutung | Nicht verwenden | -> ["", de, en, meaning, avoid, ""]
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

  it("is parsed into a useful list", () => {
    expect(avoid.length).toBeGreaterThan(20);
    expect(avoid).toContainEqual({ word: "Rechner", languages: ["de", "en"] });
  });

  it("does not use its own words to avoid in its definitions", () => {
    for (const line of glossary.split("\n")) {
      const cells = line.split("|").map((cell) => cell.trim());
      if (cells.length !== 6 || cells[1] === "Deutsch" || cells[1]?.startsWith("---")) {
        continue;
      }
      // Code spans such as `setup-token.txt` are file names, not wording.
      const meaning = (cells[3] ?? "").replace(/`[^`]*`/g, "");
      for (const { word, languages } of avoid) {
        if (languages.length === 2) {
          const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          // Case-insensitive: "einloggen" in a sentence is the avoided "Einloggen".
          const pattern = new RegExp(`(^|[^\\p{L}-])${escaped}($|[^\\p{L}-])`, "iu");
          expect(pattern.test(meaning), `"${word}" in: ${meaning}`).toBe(false);
        }
      }
    }
  });

  it("words to avoid appear in no catalog", () => {
    for (const { word, languages } of avoid) {
      // Whole words only; a hyphen joins words, so "Mail-Adresse" does not match "E-Mail-Adresse".
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const edge = "[^\\p{L}\\p{N}-]";
      const pattern = new RegExp(`(^|${edge})${escaped}($|${edge})`, "u");
      for (const language of languages) {
        for (const [key, message] of entries(language)) {
          expect(pattern.test(message), `${language}:${key} uses "${word}": ${message}`).toBe(
            false,
          );
        }
      }
    }
  });

  it("names the setup code as the glossary does", () => {
    expect(de["access.setup.code.label"]).toBe("Einrichtungscode");
    expect(en["access.setup.code.label"]).toBe("Setup code");
    expect(de["datasources.nav"]).toBe("Datenquellen");
    expect(en["datasources.nav"]).toBe("Data sources");
  });
});

describe("error texts", () => {
  // The UI shows its own text per code, never the server's message alone.
  it.each(generatedUnion("ErrorCode"))("has a German and English text for %s", (code) => {
    expect(de).toHaveProperty([`errors.${code}`]);
    expect(en).toHaveProperty([`errors.${code}`]);
  });

  it.each(["network", "invalid_response"])("has texts for the client code %s", (code) => {
    expect(de).toHaveProperty([`errors.${code}`]);
    expect(en).toHaveProperty([`errors.${code}`]);
  });
});

describe("translate", () => {
  it("fills placeholders and leaves unknown ones visible", () => {
    expect(translate("en", "home.welcome", { name: "Zoë" })).toBe("Welcome, Zoë");
    expect(translate("de", "home.welcome", {})).toBe("Willkommen, {name}");
  });

  it("does not treat a value as a pattern", () => {
    expect(translate("en", "home.welcome", { name: "$& {name}" })).toBe("Welcome, $& {name}");
  });
});

describe("language choice", () => {
  it("follows the browser's first supported language", () => {
    expect(detectLanguage(["de-AT", "en-US"])).toBe("de");
    expect(detectLanguage(["fr-FR", "en-GB", "de"])).toBe("en");
    expect(detectLanguage(["DE"])).toBe("de");
  });

  it("falls back to English", () => {
    expect(detectLanguage(["fr", "ja"])).toBe("en");
    expect(detectLanguage([])).toBe("en");
  });

  it("applies to <html lang> and is remembered", () => {
    setLanguage("de");
    expect(getLanguage()).toBe("de");
    expect(document.documentElement.lang).toBe("de");
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("de");
  });
});
