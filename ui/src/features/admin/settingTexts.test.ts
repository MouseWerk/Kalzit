import { describe, expect, it } from "vitest";
import { de, en } from "../../i18n/catalogs";
import { generatedUnion } from "../../test/generated";

/** The settings registry of the server (server/src/settings.rs), read from the generated types. */
const KEYS = generatedUnion("SettingKey");
const PREFIX = "admin.settings.";
const PARTS = ["label", "description"] as const;
const catalogs: Record<string, Record<string, string>> = { de, en };

describe("setting texts", () => {
  // The UI shows its own label and description per setting, never the server's English text.
  it.each(KEYS)("has a label and a description in German and English for %s", (key) => {
    for (const [language, catalog] of Object.entries(catalogs)) {
      for (const part of PARTS) {
        const message = catalog[`${PREFIX}${key}.${part}`];
        expect(message?.trim() ?? "", `${language}:${key}.${part}`).not.toBe("");
      }
    }
  });

  it("keeps no texts for settings the server does not have", () => {
    const part = new RegExp(`\\.(${PARTS.join("|")})$`);
    for (const [language, catalog] of Object.entries(catalogs)) {
      const leftover = Object.keys(catalog)
        .filter((key) => key.startsWith(PREFIX) && part.test(key))
        .map((key) => key.slice(PREFIX.length).replace(part, ""))
        .filter((key) => !KEYS.includes(key));
      expect(leftover, language).toEqual([]);
    }
  });

  it("gives every setting its own label", () => {
    for (const [language, catalog] of Object.entries(catalogs)) {
      const labels = KEYS.map((key) => catalog[`${PREFIX}${key}.label`]);
      expect(new Set(labels).size, language).toBe(KEYS.length);
    }
  });
});
