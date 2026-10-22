import { en } from "../i18n/catalogs";
import type { MessageKey, MessageParams, Translate } from "../i18n/i18n";
import { entriesOf, formatLeaf, isTyped } from "./values";

/** The name of a value type: BSON's names where Kalzit knows them, the server's own otherwise. */
export function typeLabel(t: Translate, type: string): string {
  const key = `documents.type.${type}`;
  return Object.hasOwn(en, key) ? t(key as MessageKey) : type;
}

/**
 * A text that names a count, from the key with `One` for exactly one and `Many` otherwise
 * (`documents.tree.itemsOne`, `documents.tree.itemsMany`). `{count}` is the count unless the
 * params bring a formatted one.
 */
export function plural(
  t: Translate,
  key: string,
  count: number,
  params: MessageParams = {},
): string {
  return t(`${key}${count === 1 ? "One" : "Many"}` as MessageKey, { count, ...params });
}

/** A value in one line: leaves as text, objects and arrays by their size. */
export function valueSummary(t: Translate, value: unknown, language: string): string {
  if (Array.isArray(value)) {
    return plural(t, "documents.tree.items", value.length);
  }
  if (value !== null && typeof value === "object" && !isTyped(value)) {
    return plural(t, "documents.tree.fields", entriesOf(value).length);
  }
  if (isTyped(value) && value.value === null) {
    // The server leaves binary data out of the answer and says so in a notice.
    return t("documents.tree.hidden");
  }
  return formatLeaf(value, language);
}
