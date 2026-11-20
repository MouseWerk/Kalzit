import { isRecord } from "../../api/client";
import type { SpanStatus } from "../../api/generated/shapes";

/**
 * The query forms of the trace kinds (docs/api/datasources.md, "Tempo and Jaeger"): a search
 * without a query language, TraceQL written by hand (Tempo only) and one trace by its id.
 */
export type TraceMode = "search" | "traceql" | "traceId";

export interface TraceSearch {
  service: string;
  operation: string;
  /** In the order they were added; the server sorts them by name. */
  tags: [string, string][];
  minDuration: string;
  maxDuration: string;
  status: SpanStatus | "";
  /** Empty: the source's default (100 for Tempo, 20 for Jaeger). */
  limit: string;
}

export const MAX_TAGS = 20;
export const MAX_SEARCH_LIMIT = 1000;
export const DEFAULT_LIMIT = { tempo: 100, jaeger: 20 } as const;

export const EMPTY_SEARCH: TraceSearch = {
  service: "",
  operation: "",
  tags: [],
  minDuration: "",
  maxDuration: "",
  status: "",
  limit: "",
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Which form a stored query has; anything that names neither TraceQL nor an id is a search. */
export function traceMode(query: unknown): TraceMode {
  if (isRecord(query) && typeof query.traceql === "string") return "traceql";
  if (isRecord(query) && typeof query.traceId === "string") return "traceId";
  return "search";
}

export function parseTraceSearch(query: unknown): TraceSearch {
  if (!isRecord(query)) return EMPTY_SEARCH;
  const status = query.status;
  return {
    service: text(query.service),
    operation: text(query.operation),
    tags: isRecord(query.tags)
      ? Object.entries(query.tags).map(([key, value]): [string, string] => [key, text(value)])
      : [],
    minDuration: text(query.minDuration),
    maxDuration: text(query.maxDuration),
    status: status === "ok" || status === "error" || status === "unset" ? status : "",
    limit: typeof query.limit === "number" ? String(query.limit) : "",
  };
}

/** The search as the query the server takes: only the fields that are filled in. */
export function traceSearchQuery(search: TraceSearch): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  // A search always names its service, even an empty one: `{service: ""}` is the empty query.
  query.service = search.service.trim();
  if (search.operation.trim() !== "") query.operation = search.operation.trim();
  const tags = search.tags.filter(([key]) => key.trim() !== "");
  if (tags.length > 0) {
    query.tags = Object.fromEntries(tags.map(([key, value]) => [key.trim(), value]));
  }
  if (search.minDuration.trim() !== "") query.minDuration = search.minDuration.trim();
  if (search.maxDuration.trim() !== "") query.maxDuration = search.maxDuration.trim();
  if (search.status !== "") query.status = search.status;
  const limit = Number(search.limit);
  if (search.limit.trim() !== "" && Number.isInteger(limit) && limit > 0) {
    query.limit = Math.min(limit, MAX_SEARCH_LIMIT);
  }
  if (query.service === "" && Object.keys(query).length > 1) delete query.service;
  return query;
}

/** A duration as the server reads it: a number with us, µs, ms, s, m or h. */
export function validDuration(value: string): boolean {
  return value.trim() === "" || /^\d+(\.\d+)?(us|µs|ms|s|m|h)$/.test(value.trim());
}

/** A tag name: letters, digits and `._-:/`. */
export function validTagName(name: string): boolean {
  return /^[A-Za-z0-9._\-:/]+$/.test(name);
}

function quoted(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t");
  return `"${escaped}"`;
}

function tagValue(value: string): string {
  const trimmed = value.trim();
  const plain =
    trimmed === "true" ||
    trimmed === "false" ||
    (trimmed !== "" && /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(trimmed));
  return plain ? trimmed : quoted(value);
}

/**
 * The TraceQL a search stands for, written as the server writes it (`traces::traceql`): one span
 * set whose span passes every field. The answer's `executedQuery` is the one that ran; this is
 * what the form shows before a run and what "Open in TraceQL" puts into the editor.
 */
export function searchTraceQl(search: TraceSearch): string {
  const conditions: string[] = [];
  if (search.service.trim() !== "") {
    conditions.push(`resource.service.name = ${quoted(search.service.trim())}`);
  }
  if (search.operation.trim() !== "") {
    conditions.push(`name = ${quoted(search.operation.trim())}`);
  }
  const tags = search.tags
    .filter(([key]) => key.trim() !== "")
    .map(([key, value]): [string, string] => [key.trim(), value])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, value] of tags) {
    const scoped = ["resource.", "span.", "."].some((prefix) => key.startsWith(prefix));
    conditions.push(`${scoped ? key : `.${key}`} = ${tagValue(value)}`);
  }
  if (search.minDuration.trim() !== "") conditions.push(`duration >= ${search.minDuration.trim()}`);
  if (search.maxDuration.trim() !== "") conditions.push(`duration <= ${search.maxDuration.trim()}`);
  if (search.status !== "") conditions.push(`status = ${search.status}`);
  return conditions.length === 0 ? "{}" : `{ ${conditions.join(" && ")} }`;
}

/** A trace id as the server takes it: 1 to 32 hex digits. */
export function validTraceId(id: string): boolean {
  return /^[0-9a-fA-F]{1,32}$/.test(id.trim());
}
