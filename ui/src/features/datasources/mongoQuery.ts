import { isRecord } from "../../api/client";
import { toExtendedJson } from "../../documents/filter";

/**
 * The MongoDB query form (docs/api/datasources.md, "MongoDB: a pipeline or find"), exactly as the
 * server takes it and as panels store it:
 *
 * ```ts
 * { collection, pipeline: "[...]" }                                       // aggregate
 * { collection, filter?: "{...}", projection?, sort?, skip?, limit? }     // find
 * ```
 *
 * `pipeline`, `filter`, `projection` and `sort` are text holding MongoDB Extended JSON: text keeps
 * the key order, which `$sort` and exact sub-document matches depend on. So stages are kept as the
 * text that was written, and joined, never parsed and printed again. Other fields are refused by
 * the server; the editor's own state (disabled stages) and the projection step (panel
 * transformations, documents/projection.ts) live elsewhere.
 */

export interface MongoQuery {
  collection: string;
  pipeline?: string;
  filter?: string;
  projection?: string;
  sort?: string;
  skip?: number;
  limit?: number;
}

export type MongoMode = "aggregate" | "find";

/** Stages that write data; the server refuses them (`mongodb.write_stage`). */
export const WRITE_STAGES = ["$out", "$merge"] as const;

export function emptyMongoQuery(): MongoQuery {
  return { collection: "", pipeline: "[]" };
}

export function isMongoQuery(query: unknown): boolean {
  return isRecord(query) && typeof query.collection === "string";
}

/** A pipeline query, or the find form (any of its fields, or none: all documents). */
export function modeOf(query: MongoQuery): MongoMode {
  return query.pipeline === undefined ? "find" : "aggregate";
}

const count = (value: unknown, min: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min ? value : undefined;

/** A stored or typed query read defensively: whatever does not fit the form is left out. */
export function parseMongoQuery(query: unknown): MongoQuery {
  const value = isRecord(query) ? query : {};
  const parsed: MongoQuery = {
    collection: typeof value.collection === "string" ? value.collection : "",
  };
  if (typeof value.pipeline === "string") {
    parsed.pipeline = value.pipeline;
    return parsed;
  }
  for (const field of ["filter", "projection", "sort"] as const) {
    const text = value[field];
    if (typeof text === "string") {
      parsed[field] = text;
    }
  }
  const skip = count(value.skip, 0);
  const limit = count(value.limit, 1);
  if (skip !== undefined) parsed.skip = skip;
  if (limit !== undefined) parsed.limit = limit;
  return parsed;
}

/**
 * The stages of a pipeline as the texts they were written in, split at the top-level commas of
 * the array; null when the text is not one array.
 */
export function splitPipeline(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }
  const inner = trimmed.slice(1, -1);
  const stages: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === '"') {
      i++;
      while (i < inner.length && inner[i] !== '"') {
        i += inner[i] === "\\" ? 2 : 1;
      }
      if (i >= inner.length) {
        return null;
      }
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth < 0) {
        return null;
      }
    } else if (char === "," && depth === 0) {
      stages.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (depth !== 0) {
    return null;
  }
  const last = inner.slice(start).trim();
  if (last !== "" || stages.length > 0) {
    stages.push(last);
  }
  return stages;
}

/** Stage texts joined into the pipeline text, one stage per line. */
export function joinPipeline(stages: readonly string[]): string {
  return stages.length === 0 ? "[]" : `[\n${stages.map((s) => s.trim()).join(",\n")}\n]`;
}

/** The one key of a parsed stage, or null when it is not `{ "$name": ... }`. */
export function stageNameOf(stage: unknown): string | null {
  if (!isRecord(stage)) {
    return null;
  }
  const keys = Object.keys(stage);
  return keys.length === 1 && (keys[0] ?? "").startsWith("$") ? (keys[0] as string) : null;
}

/** The query with only the given stages, for the preview after one of them. */
export function previewQuery(query: MongoQuery, stages: readonly string[]): MongoQuery {
  return { collection: query.collection, pipeline: joinPipeline(stages) };
}

/** `{"a": 1}` plus a condition, as text, so the keys already there keep their order. */
function addCondition(objectText: string | undefined, condition: string): string {
  const text = (objectText ?? "").trim();
  if (text === "" || !text.endsWith("}")) {
    return `{${condition}}`;
  }
  const body = text.slice(0, -1).trimEnd();
  return body.endsWith("{") ? `${body}${condition}}` : `${body}, ${condition}}`;
}

/** The result of click-to-filter: the new query, or why the query was left as it was. */
export type MatchResult =
  | { query: MongoQuery }
  /** The pipeline or the filter text does not parse; it is never replaced. */
  | { refused: "pipeline" | "filter" };

function parsesAs<T>(text: string, check: (value: unknown) => value is T): T | null {
  try {
    const value: unknown = JSON.parse(text);
    return check(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Click-to-filter: adds `{ "$match": { path: value } }` as the last stage of a pipeline, or the
 * condition to the filter of a find. The value goes in as Extended JSON, typed. The query's text
 * is never lost: one that does not parse is refused rather than replaced, and a filter that
 * already names the path keeps its condition, joined with the new one by `$and`.
 */
export function addMatch(query: MongoQuery, path: string, value: unknown): MatchResult {
  const condition = `${JSON.stringify(path)}: ${JSON.stringify(toExtendedJson(value))}`;
  if (modeOf(query) === "find") {
    const old = (query.filter ?? "").trim();
    if (old === "") {
      return { query: { ...query, filter: `{${condition}}` } };
    }
    const filter = parsesAs(old, isRecord);
    if (filter === null) {
      return { refused: "filter" };
    }
    // The path is named already, also by a time filter on it: both conditions must hold.
    const named = Object.hasOwn(filter, path) || filter.$__timeFilter === path;
    const next = named ? `{"$and": [${old}, {${condition}}]}` : addCondition(old, condition);
    return { query: { ...query, filter: next } };
  }
  const pipeline = query.pipeline ?? "[]";
  const stages = splitPipeline(pipeline);
  if (stages === null || parsesAs(pipeline, Array.isArray) === null) {
    return { refused: "pipeline" };
  }
  return {
    query: { ...query, pipeline: joinPipeline([...stages, `{"$match": {${condition}}}`]) },
  };
}

/** Text for summaries (the read-only view of a stored target) and the "anything to run" check. */
export function mongoQueryText(query: unknown): string {
  const parsed = parseMongoQuery(query);
  if (parsed.collection.trim() === "") {
    return "";
  }
  if (parsed.pipeline !== undefined) {
    return `${parsed.collection}.aggregate(${parsed.pipeline})`;
  }
  return `${parsed.collection}.find(${parsed.filter ?? "{}"})`;
}
