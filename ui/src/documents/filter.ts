import { isContainer, isTyped } from "./values";

/**
 * Click-to-filter: a value from a result goes back into the query as MongoDB Extended JSON
 * (relaxed v2), so its type survives: an ObjectId stays `{"$oid": ...}`, a date `{"$date": ...}`,
 * and the server reads the text with the same rules (docs/api/datasources.md, MongoDB).
 */

/** Typed values that have an Extended JSON form a filter can match exactly. */
const FILTERABLE_TYPES = new Set([
  "objectId",
  "date",
  "decimal",
  "int64",
  "double",
  "uuid",
  "timestamp",
]);

/** Leaves a filter can match exactly; not hidden binary data, code, or values without a form. */
export function filterable(value: unknown): boolean {
  if (value === undefined || isContainer(value)) {
    return false;
  }
  if (isTyped(value)) {
    return value.value !== null && FILTERABLE_TYPES.has(value.$type);
  }
  return true;
}

export function toExtendedJson(value: unknown): unknown {
  if (!isTyped(value) || value.value === null) {
    return value;
  }
  const text = value.value;
  switch (value.$type) {
    case "objectId":
      return { $oid: text };
    case "date":
      // Milliseconds as canonical Extended JSON stay exact, also outside JavaScript's date range.
      return /^-?\d+$/.test(text.trim())
        ? { $date: { $numberLong: text.trim() } }
        : { $date: text };
    case "decimal":
      return { $numberDecimal: text };
    case "int64":
      return { $numberLong: text };
    case "double":
      return { $numberDouble: text };
    case "uuid":
      return { $uuid: text };
    case "timestamp": {
      const [t = "0", i = "0"] = text.split(":");
      return { $timestamp: { t: Number(t), i: Number(i) } };
    }
    default:
      return value;
  }
}
