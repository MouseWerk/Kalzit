import { isRecord } from "../api/client";
import { dateTimeFormat, formatValue } from "../panels/frame";

/**
 * Values of a `DocumentSet` (docs/ARCHITECTURE.md, result envelope): plain JSON where JSON has the
 * type, and `{"$type": "objectId" | "date" | "decimal" | "binary" | "int64", "value": string}`
 * for database types JSON lacks. Nothing here turns a typed value into a string for good: the
 * type stays visible next to the value, and filters send it back typed.
 */

export interface TypedValue {
  $type: string;
  value: string;
}

/** The typed wrapper exactly: two keys, both strings, so a document field named `$type` is not one. */
export function isTyped(value: unknown): value is TypedValue {
  return (
    isRecord(value) &&
    typeof value.$type === "string" &&
    typeof value.value === "string" &&
    Object.keys(value).length === 2
  );
}

/** Objects and arrays, which the tree opens; typed values are leaves. */
export function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || (isRecord(value) && !isTyped(value));
}

/**
 * The type name of a value: the `$type` of a typed value, else the JSON type (`number` for every
 * plain number: JSON does not say whether the database stored an int32 or a double).
 */
export function typeOf(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (isTyped(value)) {
    return value.$type;
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "bool";
    case "object":
      return "object";
    default:
      return typeof value;
  }
}

/** Type names that count as numbers for statistics, as the server and this module name them. */
export const NUMERIC_TYPES = new Set(["number", "int32", "int64", "double", "decimal", "long"]);

/** A date's Unix milliseconds: the value may be ISO 8601 text or a decimal count of ms. */
export function dateMs(value: TypedValue): number | null {
  const text = value.value.trim();
  const ms = /^-?\d+$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** A value as a number for statistics and charts, or null when it is not numeric. */
export function numericValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (isTyped(value) && (value.$type === "int64" || value.$type === "decimal")) {
    const number = Number(value.value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

/** Bytes of base64 text, for showing the size of binary data instead of its characters. */
export function base64Bytes(text: string): number {
  // Padding and whitespace carry no data: every 4 remaining characters hold 3 bytes.
  return Math.floor((text.replace(/[^A-Za-z0-9+/_-]/g, "").length * 3) / 4);
}

/**
 * A leaf value as text for the tree, a card or a top-values list. Containers are summarized by
 * the caller, which knows the words for them.
 */
export function formatLeaf(value: unknown, language: string): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (isTyped(value)) {
    switch (value.$type) {
      case "date": {
        const ms = dateMs(value);
        return ms === null ? value.value : dateTimeFormat(language).format(ms);
      }
      case "int64":
        return formatValue("int64", value.value, language);
      default:
        return value.value;
    }
  }
  if (typeof value === "number") {
    return formatValue("number", value, language);
  }
  return String(value);
}
