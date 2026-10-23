import { isRecord } from "../../api/client";
import { httpQueryText, isHttpQuery, parseHttpQuery } from "./editors/httpQuery";
import { isSearchQuery, parseSearchQuery, searchQueryText } from "./editors/searchQuery";
import { emptyMongoQuery, isMongoQuery, mongoQueryText } from "./mongoQuery";

/**
 * The query forms of the M1 data source kinds (docs/api/datasources.md): SQL sources take exactly
 * `{sql}`, Prometheus takes `{expr, instant?, minStepMs?}`. Anything else is rejected as a wrong
 * query form, so these are the only shapes the editors produce. Whether a result is drawn as a
 * table or a time series is the panel's choice from the frame, not part of the query.
 */

export const SQL_KINDS = ["postgres", "mysql", "mssql", "sqlite"] as const;
/** Graph sources queried in Cypher; their query form is `{cypher}` (panels/graph/adapter.ts). */
export const CYPHER_KINDS = ["neo4j", "memgraph"] as const;
/** Kinds whose results are documents and whose queries are pipelines (mongoQuery.ts). */
export const MONGO_KINDS = ["mongodb"] as const;
/**
 * Elasticsearch and OpenSearch (`{lucene}` or `{dsl}`), CSV and JSON files (`{}`: the source names
 * the file) and HTTP JSON (`{path?, params?, documentsPath?}`).
 */
export const SEARCH_KINDS = ["elasticsearch"] as const;
export type EditorFamily =
  | "sql"
  | "promql"
  | "mongo"
  | "cypher"
  | "gsql"
  | "search"
  | "file"
  | "http";

export interface SqlQuery {
  sql: string;
}

export interface PromQuery {
  expr: string;
  instant?: boolean;
  /** Lower bound of the range query's step, in milliseconds. */
  minStepMs?: number;
}

export interface CypherQuery {
  cypher: string;
}

/**
 * TigerGraph: an interpreted GSQL query, or an installed query by name, each with typed
 * parameters; a declared parameter without one takes the dashboard variable of its name.
 */
export type GsqlQuery =
  | { gsql: string; params?: Record<string, unknown> }
  | { installed: string; params?: Record<string, unknown> };

export function familyOf(kind: string): EditorFamily | undefined {
  if ((SQL_KINDS as readonly string[]).includes(kind)) {
    return "sql";
  }
  if ((MONGO_KINDS as readonly string[]).includes(kind)) {
    return "mongo";
  }
  if ((CYPHER_KINDS as readonly string[]).includes(kind)) {
    return "cypher";
  }
  if (kind === "tigergraph") {
    return "gsql";
  }
  if ((SEARCH_KINDS as readonly string[]).includes(kind)) {
    return "search";
  }
  if (kind === "file") {
    return "file";
  }
  if (kind === "http_json") {
    return "http";
  }
  return kind === "prometheus" ? "promql" : undefined;
}

export function parseSqlQuery(query: unknown): SqlQuery {
  const value = isRecord(query) ? query : {};
  return { sql: typeof value.sql === "string" ? value.sql : "" };
}

export function parsePromQuery(query: unknown): PromQuery {
  const value = isRecord(query) ? query : {};
  const parsed: PromQuery = { expr: typeof value.expr === "string" ? value.expr : "" };
  if (value.instant === true) {
    parsed.instant = true;
  }
  if (
    typeof value.minStepMs === "number" &&
    Number.isInteger(value.minStepMs) &&
    value.minStepMs > 0
  ) {
    parsed.minStepMs = value.minStepMs;
  }
  return parsed;
}

export function parseCypherQuery(query: unknown): CypherQuery {
  const value = isRecord(query) ? query : {};
  return { cypher: typeof value.cypher === "string" ? value.cypher : "" };
}

export function parseGsqlQuery(query: unknown): GsqlQuery {
  const value = isRecord(query) ? query : {};
  const params = isRecord(value.params) ? { params: value.params } : {};
  if (typeof value.installed === "string") {
    return { installed: value.installed, ...params };
  }
  return { gsql: typeof value.gsql === "string" ? value.gsql : "", ...params };
}

/** A new, empty query in the form the kind expects. */
export function emptyQuery(kind: string): unknown {
  switch (familyOf(kind)) {
    case "promql":
      return { expr: "" };
    case "mongo":
      return emptyMongoQuery();
    case "cypher":
      return { cypher: "" };
    case "gsql":
      return { gsql: "" };
    case "search":
      return { lucene: "" };
    case "file":
    case "http":
      return {};
    default:
      return { sql: "" };
  }
}

/** The query text alone, for summaries and for deciding whether there is anything to run. */
export function queryText(query: unknown): string {
  if (isRecord(query)) {
    if (typeof query.sql === "string") {
      return query.sql;
    }
    if (typeof query.expr === "string") {
      return query.expr;
    }
    if (isMongoQuery(query)) {
      return mongoQueryText(query);
    }
    if (typeof query.cypher === "string") {
      return query.cypher;
    }
    // TigerGraph: interpreted GSQL, or the name of an installed query.
    if (typeof query.gsql === "string") {
      return query.gsql;
    }
    if (typeof query.installed === "string") {
      return query.installed;
    }
    if (typeof query.lucene === "string" || isRecord(query.dsl)) {
      return searchQueryText(parseSearchQuery(query));
    }
    if (typeof query.path === "string" || isRecord(query.params)) {
      return httpQueryText(parseHttpQuery(query));
    }
  }
  return "";
}

/** The text forms: a query of these runs only with text in it. */
const TEXT_FAMILIES: readonly (EditorFamily | undefined)[] = [
  "sql",
  "promql",
  "mongo",
  "cypher",
  "gsql",
];
const TEXT_KEYS = ["sql", "expr", "cypher", "gsql", "installed"];

/**
 * Whether a query has something to run. The text forms need text. The search, file and HTTP JSON
 * forms run as they are: `{}` reads the file or requests the source's URL, and a search without a
 * query matches every document in the time range. Without the kind (a stored panel target), the
 * form is told by its fields, so `{}` counts as a query and `{sql: ""}` does not.
 */
export function hasQuery(query: unknown, kind?: string): boolean {
  if (!isRecord(query)) {
    return false;
  }
  const family = kind === undefined ? undefined : familyOf(kind);
  if (family === "search") {
    return isSearchQuery(query);
  }
  if (family === "file") {
    return Object.keys(query).length === 0;
  }
  if (family === "http") {
    return isHttpQuery(query);
  }
  if (
    (family !== undefined && TEXT_FAMILIES.includes(family)) ||
    TEXT_KEYS.some((key) => key in query) ||
    isMongoQuery(query)
  ) {
    return queryText(query).trim() !== "";
  }
  return isSearchQuery(query) || isHttpQuery(query);
}
