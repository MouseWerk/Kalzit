import { isRecord } from "../api/client";
import type { FieldSchema } from "../api/generated/shapes";

/**
 * The projection step (docs/PLAN.md, section 1): documents become a frame only through this
 * explicit step, stored with the panel among its `transformations` as a step of one query, in the
 * step form of the analysis steps (docs/api/settings-dashboards.md, "Transformations"):
 *
 * ```json
 * { "id": "<uuid>", "type": "toFrame", "frame": "A", "columns": [{ "path", "name"?, "type"? }],
 *   "disabled"?: true }
 * ```
 *
 * The query stays in the server's form, which takes no other fields. Each column reads one field
 * path per document (array elements by index: `items.0.price`; a path through an array without an
 * index reads nothing); the type is chosen or taken from the first value. Removing or disabling
 * the step brings the documents back. The analysis engine runs it with the panel's other steps
 * (`runPanelSteps`, analysis/panel.ts), never implicitly: a result the server already answered as
 * a frame passes unchanged. This module reads and writes the step and checks its columns.
 */

export const PROJECTION_STEP = "toFrame";

/**
 * The column types a step stores. `json` is not one of them: inference may read an object or an
 * array as JSON for display, but the server refuses it in a stored step.
 */
export const PROJECTION_TYPES = ["time", "number", "int64", "string", "bool"] as const;
export type ProjectionType = (typeof PROJECTION_TYPES)[number];

/** The bounds the server checks for a stored step (docs/api/settings-dashboards.md). */
export const MAX_PROJECTION_COLUMNS = 200;
export const MAX_PATH_CHARS = 500;
export const MAX_COLUMN_NAME_CHARS = 200;

export interface ProjectionColumn {
  /** A dotted MongoDB path, array indexes as numbers (`items.0.price`). */
  path: string;
  /** The column name; the path when left out. */
  name?: string;
  /** The column type; taken from the first value when left out. */
  type?: ProjectionType;
}

export interface FrameProjection {
  columns: ProjectionColumn[];
  /** Kept, but not applied: the query's documents show as they came. */
  disabled?: boolean;
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
      column.type = raw.type as ProjectionType;
    }
    columns.push(column);
  }
  return value.disabled === true ? { columns, disabled: true } : { columns };
}

/** The name a column gives its field: its own, or the path. */
export const outputName = (column: ProjectionColumn) => column.name ?? column.path;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export type ColumnProblem =
  | { field: "path" | "name"; problem: "control" }
  | { field: "path" | "name"; problem: "length"; max: number }
  | { field: "path" | "name"; problem: "duplicate"; name: string };

/**
 * What the server would refuse in each column of a step (`check_steps`, server/src/analysis):
 * control characters, a path over 500 or a name over 200 characters, and two columns with one
 * output name. Columns without a path are left out when the step is stored, so they are no problem.
 */
export function columnProblems(columns: readonly ProjectionColumn[]): (ColumnProblem | null)[] {
  const seen = new Set<string>();
  return columns.map((column) => {
    if (column.path.trim() === "") {
      return null;
    }
    if (CONTROL.test(column.path)) {
      return { field: "path", problem: "control" };
    }
    if ([...column.path].length > MAX_PATH_CHARS) {
      return { field: "path", problem: "length", max: MAX_PATH_CHARS };
    }
    if (column.name !== undefined && CONTROL.test(column.name)) {
      return { field: "name", problem: "control" };
    }
    if (column.name !== undefined && [...column.name].length > MAX_COLUMN_NAME_CHARS) {
      return { field: "name", problem: "length", max: MAX_COLUMN_NAME_CHARS };
    }
    const name = outputName(column);
    if (seen.has(name)) {
      return { field: column.name === undefined ? "path" : "name", problem: "duplicate", name };
    }
    seen.add(name);
    return null;
  });
}

/**
 * Paths a projection column can read: the schema's paths outside arrays as they are, and paths
 * into arrays through their first element (`items[].price` becomes `items.0.price`).
 */
export function projectionPaths(schema: readonly FieldSchema[]): string[] {
  return [
    ...new Set(
      schema
        .map((field) => field.path.replace(/\[\]/g, ".0"))
        .filter((path) => !path.endsWith(".0")),
    ),
  ];
}

/** Whether a stored transformation is the projection step of query `refId`. */
function isStepFor(value: unknown, refId: string): value is Record<string, unknown> {
  return isRecord(value) && value.type === PROJECTION_STEP && value.frame === refId;
}

/** The projection step of the query `refId` among a panel's transformations. */
export function projectionFor(
  transformations: readonly unknown[],
  refId: string,
): FrameProjection | undefined {
  return parseProjection(transformations.find((t) => isStepFor(t, refId)));
}

/** A new step id: a random UUID, also where the browser offers no `randomUUID` (plain HTTP). */
export function newStepId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The transformations with the step of `refId` set or (undefined) removed. A step that is there
 * keeps its id and place; an old draft's step is rewritten in the current shape.
 */
export function withProjection(
  transformations: readonly unknown[],
  refId: string,
  projection: FrameProjection | undefined,
): unknown[] {
  const index = transformations.findIndex((t) => isStepFor(t, refId));
  if (projection === undefined) {
    return transformations.filter((_, i) => i !== index);
  }
  const old = transformations[index];
  const id = isRecord(old) && typeof old.id === "string" ? old.id : newStepId();
  const step: Record<string, unknown> = {
    id,
    type: PROJECTION_STEP,
    frame: refId,
    columns: projection.columns,
  };
  if (projection.disabled === true) {
    step.disabled = true;
  }
  // A new projection goes first: the analysis steps after it read the frame it makes.
  return index === -1
    ? [step, ...transformations]
    : transformations.map((t, i) => (i === index ? step : t));
}

/**
 * The transformations as they are stored with the panel: projection steps without the columns
 * still waiting for a path, and without the steps no column is left in. While editing, such
 * columns stay, so a new column can be filled in.
 */
export function storableTransformations(transformations: readonly unknown[]): unknown[] {
  return transformations.flatMap((t) => {
    if (!isRecord(t) || t.type !== PROJECTION_STEP || !Array.isArray(t.columns)) {
      return [t];
    }
    const columns = t.columns.filter(
      (column) => isRecord(column) && typeof column.path === "string" && column.path.trim() !== "",
    );
    return columns.length === 0 ? [] : [{ ...t, columns }];
  });
}

/** Whether any projection step has a column the server would refuse; saving waits for a fix. */
export function hasProjectionProblems(transformations: readonly unknown[]): boolean {
  return transformations.some((t) => {
    const projection = isRecord(t) && t.type === PROJECTION_STEP ? parseProjection(t) : undefined;
    return (
      projection !== undefined &&
      (projection.columns.length > MAX_PROJECTION_COLUMNS ||
        columnProblems(projection.columns).some((problem) => problem !== null))
    );
  });
}
