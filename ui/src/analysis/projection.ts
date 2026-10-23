import type { DocumentSet, Field, FieldType, Frame } from "../api/generated/shapes";
import { daysFromCivil, daysInMonth, numberText, parseNumber } from "./expr";

/**
 * The projection step (`toFrame`): a `documents` result as a frame, one column per field path,
 * stored by the documents UI as `{ "type": "toFrame", "refId", "columns": [{ path, name?, type? }] }`
 * (docs/PLAN.md, section 1). The rules are those of the documents UI and of the server
 * (`server/src/analysis/projection.rs`); both engines pass `conformance.json`.
 */

export interface ProjectionColumn {
  /** A dotted MongoDB path, array indexes as numbers (`items.0.price`). */
  path: string;
  name?: string;
  type?: FieldType;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The typed wrapper `{"$type", "value"}` exactly. */
function typed(value: unknown): { kind: string; value: string | null } | null {
  if (
    isRecord(value) &&
    typeof value.$type === "string" &&
    value.$type !== "document" &&
    (typeof value.value === "string" || value.value === null) &&
    Object.keys(value).length === 2
  ) {
    return { kind: value.$type, value: value.value };
  }
  return null;
}

function unwrap(value: unknown): unknown {
  if (
    isRecord(value) &&
    value.$type === "document" &&
    isRecord(value.value) &&
    Object.keys(value).length === 2
  ) {
    return value.value;
  }
  return value;
}

const isObject = (v: unknown): v is Record<string, unknown> => isRecord(v) && typed(v) === null;

/** The one value at a dotted path; undefined when the document has no such field. */
export function valueAt(document: unknown, path: string): unknown {
  let current: unknown = document;
  for (const part of path.split(".")) {
    const value = unwrap(current);
    if (Array.isArray(value) && /^\d+$/.test(part)) {
      current = value[Number(part)];
    } else if (isObject(value) && Object.hasOwn(value, part)) {
      current = value[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function typeFor(value: unknown): FieldType {
  const t = typed(value);
  const kind =
    t?.kind ??
    (Array.isArray(value)
      ? "array"
      : typeof value === "boolean"
        ? "bool"
        : typeof value === "object"
          ? "object"
          : typeof value);
  switch (kind) {
    case "date":
      return "time";
    case "number":
    case "decimal":
    case "double":
    case "int32":
      return "number";
    case "int64":
      return "int64";
    case "bool":
      return "bool";
    case "object":
    case "array":
    case "binary":
      return "json";
    default:
      return "string";
  }
}

/** Text as JavaScript's `Number(text)` reads it, as the server mirrors it. */
function jsNumber(text: string): number | null {
  const t = trimAscii(text);
  if (t === "") return 0;
  if (/^0[xX][0-9a-fA-F]{1,16}$/.test(t)) return Number(BigInt(t));
  return parseNumber(t);
}

/** Spaces around a value, as the server trims them (ASCII only). */
function trimAscii(t: string): string {
  return t.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
}

/**
 * RFC 3339 (`2026-01-02T03:04:05.678Z`, `t` or a space between, `Z` or `±hh:mm`) as Unix ms;
 * fractions past the millisecond are cut. The server reads exactly the same forms.
 */
export function rfc3339Ms(text: string): number | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/.exec(
      text,
    );
  if (m === null) return null;
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i]));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const millis = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, "0"));
  let offset = 0;
  if (m[8] === undefined) {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 23 || om > 59) return null;
    offset = (m[9] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const days = daysFromCivil(year, month, day);
  return ((days * 24 + hour) * 60 + minute - offset) * 60_000 + second * 1000 + millis;
}

/** A typed date's ms: its value is a decimal count of ms or an RFC 3339 time, nothing else. */
function dateMs(text: string | null): number | null {
  const t = trimAscii(text ?? "");
  if (/^-?\d+$/.test(t)) {
    const ms = Number(t);
    return Number.isFinite(ms) ? ms : null;
  }
  return rfc3339Ms(t);
}

function convert(value: unknown, type: FieldType): unknown {
  if (value === null || value === undefined) return null;
  const t = typed(value);
  switch (type) {
    case "time":
      if (t?.kind === "date") return dateMs(t.value);
      return t === null && typeof value === "number" && Number.isFinite(value) ? value : null;
    case "number": {
      if (t === null && typeof value === "number") return Number.isFinite(value) ? value : null;
      if (t !== null && (t.kind === "decimal" || t.kind === "int64")) {
        const n = jsNumber(t.value ?? "");
        return n === null || !Number.isFinite(n) ? null : n;
      }
      return null;
    }
    case "int64":
      if (t?.kind === "int64") return t.value;
      return t === null && typeof value === "number" && Number.isInteger(value)
        ? numberText(value)
        : null;
    case "bool":
      return typeof value === "boolean" ? value : null;
    case "json":
      return value;
    default:
      if (t !== null) return t.value;
      if (Array.isArray(value) || isRecord(value)) return JSON.stringify(value);
      return typeof value === "number" ? numberText(value) : String(value);
  }
}

/** The documents as a frame: one column per path, typed as named or by its first value. */
export function projectDocuments(set: DocumentSet, columns: readonly ProjectionColumn[]): Frame {
  const fields: Field[] = columns
    .filter((c) => c.path.trim() !== "")
    .map((c) => {
      const raw = set.documents.map((d) => valueAt(d, c.path));
      const first = raw.find((v) => v !== null && v !== undefined);
      const type = c.type ?? (first === undefined ? "string" : typeFor(first));
      return {
        name: c.name !== undefined && c.name !== "" ? c.name : c.path,
        type,
        values: raw.map((v) => convert(v, type)),
      };
    });
  // The source's notices (a cut, hidden values) and the query as it ran stay with the frame, so
  // the panel and the inspector still show them.
  return {
    fields,
    meta: {
      rowsTruncated: set.truncated !== undefined,
      notices: set.notices,
      ...(set.executedQuery === undefined ? {} : { executedQuery: set.executedQuery }),
    },
  };
}
