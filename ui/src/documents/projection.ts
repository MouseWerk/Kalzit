import { isRecord } from "../api/client";
import type { DocumentSet, Field, FieldType, Frame } from "../api/generated/shapes";
import { valueAt } from "./paths";
import { dateMs, isContainer, isTyped, typeOf } from "./values";

/**
 * The projection step (docs/PLAN.md, section 1): documents become a frame only through this
 * explicit step, stored with the panel as a transformation of one query:
 * `{ "type": "toFrame", "refId": "A", "columns": [{ path, name?, type? }] }`. The query itself
 * stays in the server's form, which takes no other fields. Each column reads one field path per
 * document; the type is chosen or taken from the first value. Removing the step brings the
 * documents back. Applied in `projectOutcomes` (dashboards/results.ts), never implicitly: a
 * result the server already answered as a frame passes unchanged.
 */

export const PROJECTION_STEP = "toFrame";

export const PROJECTION_TYPES = ["time", "number", "int64", "string", "bool", "json"] as const;

export interface ProjectionColumn {
  /** A dotted MongoDB path, array indexes as numbers (`items.0.price`). */
  path: string;
  /** The column name; the path when left out. */
  name?: string;
  /** The column type; taken from the first value when left out. */
  type?: FieldType;
}

export interface FrameProjection {
  columns: ProjectionColumn[];
}

export function parseProjection(value: unknown): FrameProjection | undefined {
  if (!isRecord(value) || !Array.isArray(value.columns)) {
    return undefined;
  }
  const columns: ProjectionColumn[] = [];
  for (const raw of value.columns) {
    if (!isRecord(raw) || typeof raw.path !== "string") {
      continue;
    }
    const column: ProjectionColumn = { path: raw.path };
    if (typeof raw.name === "string" && raw.name !== "") {
      column.name = raw.name;
    }
    if ((PROJECTION_TYPES as readonly unknown[]).includes(raw.type)) {
      column.type = raw.type as FieldType;
    }
    columns.push(column);
  }
  return { columns };
}

/** The frame type a value reads as when the column does not name one. */
function typeFor(value: unknown): FieldType {
  switch (typeOf(value)) {
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

/** One value converted to a column type; null where it does not fit (and nothing is guessed). */
function convert(value: unknown, type: FieldType): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  switch (type) {
    case "time":
      if (isTyped(value) && value.$type === "date") {
        return dateMs(value);
      }
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    case "number": {
      if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
      }
      if (isTyped(value) && (value.$type === "decimal" || value.$type === "int64")) {
        const number = Number(value.value);
        return Number.isFinite(number) ? number : null;
      }
      return null;
    }
    case "int64":
      if (isTyped(value) && value.$type === "int64") {
        return value.value;
      }
      return typeof value === "number" && Number.isInteger(value) ? String(value) : null;
    case "bool":
      return typeof value === "boolean" ? value : null;
    case "json":
      return value;
    default:
      if (isTyped(value)) {
        return value.value;
      }
      return isContainer(value) ? JSON.stringify(value) : String(value);
  }
}

export function projectDocuments(set: DocumentSet, projection: FrameProjection): Frame {
  // A column still being filled in (no path yet) is left out rather than drawn empty.
  const columns = projection.columns.filter((column) => column.path.trim() !== "");
  const fields: Field[] = columns.map((column) => {
    const raw = set.documents.map((document) => valueAt(document, column.path));
    const first = raw.find((value) => value !== null && value !== undefined);
    const type = column.type ?? (first === undefined ? "string" : typeFor(first));
    return {
      name: column.name ?? column.path,
      type,
      values: raw.map((value) => convert(value, type)),
    };
  });
  return {
    fields,
    meta: { rowsTruncated: set.truncated !== undefined, notices: [] },
  };
}

/** The projection step of the query `refId` among a panel's transformations. */
export function projectionFor(
  transformations: readonly unknown[],
  refId: string,
): FrameProjection | undefined {
  const step = transformations.find(
    (t) => isRecord(t) && t.type === PROJECTION_STEP && t.refId === refId,
  );
  return parseProjection(step);
}

/** The transformations with the step of `refId` set, replaced or (undefined) removed. */
export function withProjection(
  transformations: readonly unknown[],
  refId: string,
  projection: FrameProjection | undefined,
): unknown[] {
  const others = transformations.filter(
    (t) => !(isRecord(t) && t.type === PROJECTION_STEP && t.refId === refId),
  );
  return projection === undefined
    ? others
    : [...others, { type: PROJECTION_STEP, refId, columns: projection.columns }];
}
