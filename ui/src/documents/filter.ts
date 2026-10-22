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

/**
 * Whether a value at these path segments can become a filter: a filter path is dotted, so a key
 * with a dot, or one starting with `$` (an operator there), cannot be named in it.
 */
export function filterablePath(segments: readonly (string | number)[]): boolean {
  return segments.every(
    (segment) =>
      typeof segment === "number" || (!segment.startsWith("$") && !segment.includes(".")),
  );
}

/**
 * Text the server would read as a macro or a variable (`$__timeFrom`, `${name}`) if it went in as
 * a plain string. Such a value goes in as an anchored, escaped regular expression instead, which
 * the server binds as it is and which matches exactly that text.
 */
function looksBound(text: string): boolean {
  return text.includes("${") || text.startsWith("$__");
}

const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|/]/g;

function escapeRegex(text: string): string {
  return text.replace(REGEX_SPECIAL, (char) => `\\${char}`);
}

export function toExtendedJson(value: unknown): unknown {
  if (typeof value === "string" && looksBound(value)) {
    return { $regularExpression: { pattern: `^${escapeRegex(value)}$`, options: "" } };
  }
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
