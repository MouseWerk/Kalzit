import { catalogs, LANGUAGES, type Language, type MessageKey } from "../../i18n/i18n";
import { isKnownSetting, settingMessage } from "../admin/catalog";
import {
  LOGO_ROW,
  rowId,
  type SectionDef,
  type SettingsAccess,
  SIGN_IN_ROW,
  UPDATES_PAGE_KEYS,
} from "./sections";

/**
 * Search across every setting the user may open: its title and description in German and English,
 * its key (as in kalzit.toml and KALZIT_SETTING_*), and the section's words, so "SSO", "Farbe" or
 * "smtp" all find their place whatever language the UI is in.
 */

export interface SearchEntry {
  sectionId: string;
  rowId: string;
  /** Catalog key of the row's title; the section's own label for a section entry. */
  title: MessageKey;
  /** Catalog key of the section's label, shown next to the title. */
  section: MessageKey;
  /** Lower-case text of both languages to match against. */
  haystack: string;
  /** Lower-case titles of both languages, for ranking. */
  titles: string;
  /** Set for a setting kept on a page of its own: the result opens that page at the row. */
  page?: "/admin/server/updates";
}

export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function inAll(keys: readonly MessageKey[]): string {
  return keys
    .flatMap((key) => LANGUAGES.map((language: Language) => catalogs[language][key]))
    .join(" ");
}

const EXTRA_ROWS: Record<string, { label: MessageKey; description: MessageKey }> = {
  [LOGO_ROW]: { label: "settings.logo.label", description: "settings.logo.description" },
  [SIGN_IN_ROW]: {
    label: "settings.signInPage.label",
    description: "settings.signInPage.description",
  },
};

export function buildIndex(sections: readonly SectionDef[], access: SettingsAccess): SearchEntry[] {
  const entries: SearchEntry[] = [];
  for (const section of sections) {
    if (!section.visible(access)) {
      continue;
    }
    const sectionLabel: MessageKey =
      section.id === "organization" ? "settings.section.organization.labelPlain" : section.label;
    entries.push({
      sectionId: section.id,
      rowId: "",
      title: sectionLabel,
      section: sectionLabel,
      haystack: normalize(`${inAll([sectionLabel, section.lead, section.keywords])} ${section.id}`),
      titles: normalize(inAll([sectionLabel])),
    });
    const seen = new Set<string>();
    const rows: { id: string; label: MessageKey; description: MessageKey; key: string }[] = [];
    for (const key of section.keys ?? []) {
      const id = rowId(section, key);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const extra = EXTRA_ROWS[id];
      if (extra !== undefined) {
        rows.push({ ...extra, id, key: `${key} signin.welcome signin.notice` });
      } else if (isKnownSetting(key)) {
        rows.push({
          id,
          label: settingMessage(key, "label"),
          description: settingMessage(key, "description"),
          key,
        });
      }
    }
    if (section.kind === "appearance") {
      const logo = EXTRA_ROWS[LOGO_ROW];
      if (logo !== undefined) {
        rows.push({ ...logo, id: LOGO_ROW, key: "logo" });
      }
    }
    for (const row of rows) {
      entries.push({
        sectionId: section.id,
        rowId: row.id,
        title: row.label,
        section: sectionLabel,
        haystack: normalize(
          `${inAll([row.label, row.description, section.keywords])} ${row.key} ${row.key.replaceAll(/[._]/g, " ")}`,
        ),
        titles: normalize(inAll([row.label])),
        ...(UPDATES_PAGE_KEYS.includes(row.key) ? { page: "/admin/server/updates" as const } : {}),
      });
    }
  }
  return entries;
}

/** Entries matching every word of the query; titles first, then rows before sections. */
export function search(index: readonly SearchEntry[], query: string, limit = 12): SearchEntry[] {
  const words = normalize(query)
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) {
    return [];
  }
  const scored = index
    .filter((entry) => words.every((word) => entry.haystack.includes(word)))
    .map((entry) => {
      const inTitle = words.filter((word) => entry.titles.includes(word)).length;
      return { entry, score: inTitle * 10 + (entry.rowId === "" ? 0 : 1) };
    });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ entry }) => entry);
}
