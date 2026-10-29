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

export const SQL_KINDS = ["postgres", "mysql", "mssql", "sqlite", "clickhouse"] as const;
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
  | "influx"
  | "logql"
  | "mongo"
  | "cypher"
  | "gsql"
  | "search"
  | "file"
  | "http"
  | "plugin";

export interface SqlQuery {
  sql: string;
}

export interface PromQuery {
  expr: string;
  instant?: boolean;
  /** Lower bound of the range query's step, in milliseconds. */
  minStepMs?: number;
}

/** InfluxDB: one language per query; which ones the source answers depends on its version. */
export type InfluxLanguage = "flux" | "influxql" | "sql";
export const INFLUX_LANGUAGES: readonly InfluxLanguage[] = ["flux", "influxql", "sql"];

export type InfluxQuery = { flux: string } | { influxql: string } | { sql: string };

/** Loki: LogQL with the line limit and direction of log queries. */
export interface LokiQuery {
  logql: string;
  limit?: number;
  direction?: "backward" | "forward";
  instant?: boolean;
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
  // A plugin's kind is its id, a reverse domain name; built-in kinds never have a dot. Its query
  // form is the plugin's own, edited as JSON.
  if (kind.includes(".")) {
    return "plugin";
  }
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
  if (kind === "influxdb") {
    return "influx";
  }
  if (kind === "loki") {
    return "logql";
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

/** The language and text of an InfluxDB query; InfluxQL when the form names none. */
export function parseInfluxQuery(query: unknown): { language: InfluxLanguage; text: string } {
  const value = isRecord(query) ? query : {};
  for (const language of INFLUX_LANGUAGES) {
    const text = value[language];
    if (typeof text === "string") {
      return { language, text };
    }
  }
  return { language: "influxql", text: "" };
}

export function influxQuery(language: InfluxLanguage, text: string): InfluxQuery {
  switch (language) {
    case "flux":
      return { flux: text };
    case "sql":
      return { sql: text };
    default:
      return { influxql: text };
  }
}

export function parseLokiQuery(query: unknown): LokiQuery {
  const value = isRecord(query) ? query : {};
  const parsed: LokiQuery = { logql: typeof value.logql === "string" ? value.logql : "" };
  if (typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit > 0) {
    parsed.limit = value.limit;
  }
  if (value.direction === "forward" || value.direction === "backward") {
    parsed.direction = value.direction;
  }
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
    case "influx":
      return { influxql: "" };
    case "logql":
      return { logql: "" };
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
    case "plugin":
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
    if (typeof query.flux === "string") {
      return query.flux;
    }
    if (typeof query.influxql === "string") {
      return query.influxql;
    }
    if (typeof query.logql === "string") {
      return query.logql;
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
    // HTTP JSON by its path; parameters alone could be TigerGraph's.
    if (typeof query.path === "string" || typeof query.documentsPath === "string") {
      return httpQueryText(parseHttpQuery(query));
    }
  }
  return "";
}

/** The text forms: a query of these runs only with text in it. */
const TEXT_FAMILIES: readonly (EditorFamily | undefined)[] = [
  "sql",
  "promql",
  "influx",
  "logql",
  "mongo",
  "cypher",
  "gsql",
];
const TEXT_KEYS = ["sql", "expr", "flux", "influxql", "logql", "cypher", "gsql", "installed"];

/**
 * Whether a query has something to run, by the form of its data source's kind. The text forms
 * need text. The search, file and HTTP JSON forms run as they are: `{}` reads the file or
 * requests the source's URL, and a search without a query matches every document in the time
 * range; a stored search or HTTP query with fields the server refuses does not run.
 *
 * Without the kind (a source the caller cannot see) the form is told by its fields, and only a
 * query that names itself counts: text, a Lucene or DSL search, an HTTP path. `{}` does not, since
 * it is also what an unfinished query of any other kind looks like.
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
    // Any other form is replaced by `{}` before it is sent (normalizeQuery).
    return true;
  }
  if (family === "plugin") {
    // The plugin decides what its query needs; `{}` may well be a whole query.
    return true;
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
  if (typeof query.lucene === "string" || isRecord(query.dsl)) {
    return isSearchQuery(query);
  }
  return typeof query.path === "string" && isHttpQuery(query);
}

/**
 * The query as it is sent. A file query has no fields, so whatever a target kept from another
 * kind is sent as `{}`; the stored target is left as it is until it is saved again.
 */
export function normalizeQuery(query: unknown, kind: string | undefined): unknown {
  return kind !== undefined && familyOf(kind) === "file" ? {} : query;
}
