import { en } from "../i18n/catalogs";
import type { MessageKey, Translate } from "../i18n/i18n";
import { entriesOf, formatLeaf, isTyped } from "./values";

/** The name of a value type: BSON's names where Kalzit knows them, the server's own otherwise. */
export function typeLabel(t: Translate, type: string): string {
  const key = `documents.type.${type}`;
  return Object.hasOwn(en, key) ? t(key as MessageKey) : type;
}

/** A value in one line: leaves as text, objects and arrays by their size. */
export function valueSummary(t: Translate, value: unknown, language: string): string {
  if (Array.isArray(value)) {
    return t("documents.tree.items", { count: value.length });
  }
  if (value !== null && typeof value === "object" && !isTyped(value)) {
    return t("documents.tree.fields", { count: entriesOf(value).length });
  }
  if (isTyped(value) && value.value === null) {
    // The server leaves binary data out of the answer and says so in a notice.
    return t("documents.tree.hidden");
  }
  return formatLeaf(value, language);
}
