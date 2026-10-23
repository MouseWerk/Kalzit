import { isRecord } from "../../../api/client";
import type { Reason } from "../reasons";

/**
 * The query form of Elasticsearch and OpenSearch sources (docs/api/datasources.md, "Elasticsearch
 * and OpenSearch"): `{lucene}` or `{dsl}`, each with optional `index`, `timeField` and `size`.
 * Without either every document matches. The server refuses anything else, so these are the only
 * fields the editor writes.
 */
export interface SearchQuery {
  index?: string;
  lucene?: string;
  dsl?: Record<string, unknown>;
  timeField?: string;
  size?: number;
}

export type SearchMode = "lucene" | "dsl";

export const SEARCH_QUERY_KEYS = ["index", "lucene", "dsl", "timeField", "size"] as const;

/** The top-level keys a Query DSL body may have (`DSL_KEYS` in the server's elasticsearch.rs). */
export const DSL_KEYS = [
  "query",
  "aggs",
  "aggregations",
  "sort",
  "_source",
  "fields",
  "docvalue_fields",
  "stored_fields",
  "size",
  "from",
  "track_total_hits",
  "search_after",
  "highlight",
  "post_filter",
  "min_score",
  "script_fields",
  "runtime_mappings",
  "collapse",
  "terminate_after",
  "track_scores",
  "version",
  "seq_no_primary_term",
  "indices_boost",
  "rescore",
] as const;

/** Hits per search: at most this many (and the row limit), 500 when not set. */
export const MAX_SIZE = 10_000;
export const DEFAULT_SIZE = 500;
/** What the server uses when neither the query nor the source names a time field. */
export const DEFAULT_TIME_FIELD = "@timestamp";

/**
 * The query as the editor reads it: the documented fields with their types checked. A field of
 * the wrong type is left out here and named by `searchQueryProblems`, which the editor shows until
 * it is resolved. `null` means "not set", as the server reads it; the index stays as written,
 * since the server checks it untrimmed.
 */
export function parseSearchQuery(query: unknown): SearchQuery {
  const value = isRecord(query) ? query : {};
  const parsed: SearchQuery = {};
  if (typeof value.index === "string" && value.index.trim() !== "") {
    parsed.index = value.index;
  }
  if (isRecord(value.dsl)) {
    parsed.dsl = value.dsl;
  } else if (typeof value.lucene === "string") {
    parsed.lucene = value.lucene;
  }
  if (typeof value.timeField === "string") {
    parsed.timeField = value.timeField;
  }
  if (typeof value.size === "number" && Number.isInteger(value.size) && value.size >= 0) {
    parsed.size = value.size;
  }
  return parsed;
}

const set = (value: unknown) => value !== undefined && value !== null;

/**
 * The fields of a stored query the server would refuse: unknown ones, ones of the wrong type, and
 * `lucene` and `dsl` together. Empty when the query runs as it is.
 */
export function searchQueryProblems(query: unknown): string[] {
  if (!isRecord(query)) {
    return ["query"];
  }
  const problems = Object.keys(query).filter(
    (key) => !(SEARCH_QUERY_KEYS as readonly string[]).includes(key),
  );
  const typed: [string, (value: unknown) => boolean][] = [
    ["index", (v) => typeof v === "string"],
    ["lucene", (v) => typeof v === "string"],
    ["dsl", isRecord],
    ["timeField", (v) => typeof v === "string"],
    ["size", (v) => typeof v === "number" && Number.isInteger(v) && v >= 0],
  ];
  for (const [key, ok] of typed) {
    if (set(query[key]) && !ok(query[key])) {
      problems.push(key);
    }
  }
  if (set(query.lucene) && set(query.dsl) && !problems.includes("lucene")) {
    problems.push("lucene");
  }
  return problems;
}

export function searchMode(query: SearchQuery): SearchMode {
  return query.dsl === undefined ? "lucene" : "dsl";
}

/** Whether a stored query has exactly the search form, so it can run as it is. */
export function isSearchQuery(query: unknown): boolean {
  return searchQueryProblems(query).length === 0;
}
/** Whether the body asks for aggregations: then the answer is a frame and no hits are fetched. */
export function hasAggregations(dsl: Record<string, unknown> | undefined): boolean {
  return dsl !== undefined && (isRecord(dsl.aggs) || isRecord(dsl.aggregations));
}

/**
 * The server's index rule (`check_index`): comma-separated parts of letters, digits and
 * `. _ - * :`, each optionally excluded with a leading `-`, none starting with `_`, none `.` or
 * `..`, and a remote cluster prefix `cluster:index` with a proper index after it.
 */
export function indexProblem(index: string): Reason | null {
  const refused: Reason = { reason: "elasticsearch.index_invalid", params: { index } };
  if (index === "" || index.length > 1024) {
    return refused;
  }
  for (const part of index.split(",")) {
    const name = part.startsWith("-") ? part.slice(1) : part;
    if (
      name === "" ||
      !/^[A-Za-z0-9._\-*:]+$/.test(name) ||
      name.startsWith("_") ||
      name === "." ||
      name === ".."
    ) {
      return refused;
    }
    const colon = name.indexOf(":");
    if (colon >= 0) {
      const rest = name.slice(colon + 1);
      if (rest === "" || rest.startsWith("_") || rest.includes(":")) {
        return refused;
      }
    }
  }
  return null;
}

/** The checks the server makes first on a Query DSL body, with its reasons. */
export function dslProblem(value: unknown): Reason | null {
  if (!isRecord(value)) {
    return { reason: "elasticsearch.dsl_not_object" };
  }
  const key = Object.keys(value).find((name) => !(DSL_KEYS as readonly string[]).includes(name));
  if (key !== undefined) {
    return { reason: "elasticsearch.dsl_key_not_allowed", params: { key } };
  }
  return null;
}

/**
 * The size as typed: `invalid` unless a whole number of at least 0; `capped` above 10,000, which
 * the server lowers (and to the row limit); null when it is sent as it is or empty (500).
 */
export function sizeState(text: string): "invalid" | "capped" | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  if (!/^\d+$/.test(trimmed)) {
    return "invalid";
  }
  return Number(trimmed) > MAX_SIZE ? "capped" : null;
}
/** The query in one line, for summaries. */
export function searchQueryText(query: SearchQuery): string {
  if (query.dsl !== undefined) {
    return JSON.stringify(query.dsl);
  }
  return query.lucene ?? "";
}

/**
 * Whether an index name or pattern list covers an index, as the cluster resolves it: `*` matches
 * any run of characters, a part with a leading `-` excludes, and parts are read in order.
 */
export function indexMatches(pattern: string, name: string): boolean {
  let matched = false;
  for (const raw of pattern.split(",")) {
    const exclude: boolean = raw.startsWith("-") && matched;
    const part = exclude ? raw.slice(1) : raw;
    const regex = new RegExp(
      `^${part
        .split("*")
        .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
    if (regex.test(name)) {
      matched = !exclude;
    }
  }
  return matched;
}
