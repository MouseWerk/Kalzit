import { isRecord } from "../../api/client";
import { toExtendedJson } from "../../documents/filter";
import { type FrameProjection, parseProjection } from "../../documents/projection";

/**
 * The MongoDB query form, as the UI writes it and stores it in panels. The server's kind
 * (branch m2/mongodb) reads the same form; this module is the one place to adjust when they meet.
 *
 * ```ts
 * { collection, mode: "aggregate", pipeline: Stage[], disabledStages?: [{ index, stage }],
 *   toFrame?: { columns: [{ path, name?, type? }] } }
 * { collection, mode: "find", filter, projection?, sort?, limit?, toFrame? }
 * ```
 *
 * - `pipeline` holds exactly the stages that run, so the server never has to know about
 *   disabling. Disabled stages are kept beside it with the place they had in the full list.
 * - Values with database types are MongoDB Extended JSON (`{"$oid"}`, `{"$date"}`,
 *   `{"$numberDecimal"}`, `{"$numberLong"}`).
 * - `toFrame` is the visible projection step (documents/projection.ts).
 */

export type Stage = Record<string, unknown>;

export interface DisabledStage {
  /** The stage's place in the full list of stages, disabled ones counted. */
  index: number;
  stage: Stage;
}

export interface MongoAggregateQuery {
  collection: string;
  mode: "aggregate";
  pipeline: Stage[];
  disabledStages?: DisabledStage[];
  toFrame?: FrameProjection;
}

export interface MongoFindQuery {
  collection: string;
  mode: "find";
  filter: Record<string, unknown>;
  projection?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  limit?: number;
  toFrame?: FrameProjection;
}

export type MongoQuery = MongoAggregateQuery | MongoFindQuery;

/** Stages that write data; the server refuses pipelines with them (docs/PLAN.md, section 5). */
export const WRITE_STAGES = ["$out", "$merge"] as const;

export function emptyMongoQuery(): MongoAggregateQuery {
  return { collection: "", mode: "aggregate", pipeline: [] };
}

/** A stage is an object with exactly one `$` key: `{ "$match": { ... } }`. */
export function isStage(value: unknown): value is Stage {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] ?? "").startsWith("$");
}

export function stageName(stage: Stage): string {
  return Object.keys(stage)[0] ?? "";
}

export function isMongoQuery(query: unknown): boolean {
  return isRecord(query) && typeof query.collection === "string";
}

/** A stored or typed query read defensively: whatever does not fit the form is left out. */
export function parseMongoQuery(query: unknown): MongoQuery {
  const value = isRecord(query) ? query : {};
  const collection = typeof value.collection === "string" ? value.collection : "";
  const toFrame = parseProjection(value.toFrame);
  const withFrame = <Q extends MongoQuery>(parsed: Q): Q =>
    toFrame === undefined ? parsed : { ...parsed, toFrame };
  if (value.mode === "find") {
    const find: MongoFindQuery = {
      collection,
      mode: "find",
      filter: isRecord(value.filter) ? value.filter : {},
    };
    if (isRecord(value.projection)) {
      find.projection = value.projection;
    }
    if (isRecord(value.sort)) {
      find.sort = value.sort;
    }
    if (typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit > 0) {
      find.limit = value.limit;
    }
    return withFrame(find);
  }
  const aggregate: MongoAggregateQuery = {
    collection,
    mode: "aggregate",
    pipeline: Array.isArray(value.pipeline) ? value.pipeline.filter(isStage) : [],
  };
  if (Array.isArray(value.disabledStages)) {
    const disabled = value.disabledStages.flatMap((entry): DisabledStage[] =>
      isRecord(entry) &&
      typeof entry.index === "number" &&
      Number.isInteger(entry.index) &&
      entry.index >= 0 &&
      isStage(entry.stage)
        ? [{ index: entry.index, stage: entry.stage }]
        : [],
    );
    if (disabled.length > 0) {
      aggregate.disabledStages = disabled;
    }
  }
  return withFrame(aggregate);
}

export interface StageEntry {
  stage: Stage;
  enabled: boolean;
}

/** Every stage in its place, the disabled ones included. */
export function allStages(query: MongoAggregateQuery): StageEntry[] {
  const disabled = [...(query.disabledStages ?? [])].sort((a, b) => a.index - b.index);
  const result: StageEntry[] = [];
  const running = [...query.pipeline];
  for (const entry of disabled) {
    while (result.length < entry.index && running.length > 0) {
      result.push({ stage: running.shift() as Stage, enabled: true });
    }
    result.push({ stage: entry.stage, enabled: false });
  }
  for (const stage of running) {
    result.push({ stage, enabled: true });
  }
  return result;
}

/** The stored form of a list of stages: what runs, and the disabled ones with their places. */
export function fromStages(
  base: MongoAggregateQuery,
  entries: readonly StageEntry[],
): MongoAggregateQuery {
  const next: MongoAggregateQuery = {
    collection: base.collection,
    mode: "aggregate",
    pipeline: entries.filter((e) => e.enabled).map((e) => e.stage),
  };
  if (base.toFrame !== undefined) {
    next.toFrame = base.toFrame;
  }
  const disabled = entries.flatMap((e, index) => (e.enabled ? [] : [{ index, stage: e.stage }]));
  if (disabled.length > 0) {
    next.disabledStages = disabled;
  }
  return next;
}

/**
 * The query up to and including stage `index` (of the full list), for the preview after that
 * stage: disabled stages stay out, and so does the projection, since the preview shows documents.
 */
export function previewQuery(query: MongoAggregateQuery, index: number): MongoAggregateQuery {
  return {
    collection: query.collection,
    mode: "aggregate",
    pipeline: allStages(query)
      .slice(0, index + 1)
      .filter((e) => e.enabled)
      .map((e) => e.stage),
  };
}

/**
 * Click-to-filter: adds `{ "$match": { path: value } }` as the last stage of a pipeline, or the
 * condition to the filter in find mode. The value goes in as Extended JSON, typed.
 */
export function addMatch(query: MongoQuery, path: string, value: unknown): MongoQuery {
  const condition = { [path]: toExtendedJson(value) };
  if (query.mode === "find") {
    return { ...query, filter: { ...query.filter, ...condition } };
  }
  return fromStages(query, [...allStages(query), { stage: { $match: condition }, enabled: true }]);
}

/** Text for summaries (the read-only view of a stored target) and the "anything to run" check. */
export function mongoQueryText(query: unknown): string {
  const parsed = parseMongoQuery(query);
  return parsed.collection.trim() === "" ? "" : JSON.stringify(parsed, null, 2);
}
