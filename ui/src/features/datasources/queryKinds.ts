import { isRecord } from "../../api/client";

/**
 * The query forms of the M1 data source kinds (docs/api/datasources.md): SQL sources take exactly
 * `{sql}`, Prometheus takes `{expr, instant?, minStepMs?}`. Anything else is rejected as a wrong
 * query form, so these are the only shapes the editors produce. Whether a result is drawn as a
 * table or a time series is the panel's choice from the frame, not part of the query.
 */

export const SQL_KINDS = ["postgres", "mysql", "mssql", "sqlite"] as const;
/** Graph sources queried in Cypher; their query form is `{cypher}` (panels/graph/adapter.ts). */
export const CYPHER_KINDS = ["neo4j", "memgraph"] as const;
export type EditorFamily = "sql" | "promql" | "cypher" | "gsql";

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
  if ((CYPHER_KINDS as readonly string[]).includes(kind)) {
    return "cypher";
  }
  if (kind === "tigergraph") {
    return "gsql";
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
    case "cypher":
      return { cypher: "" };
    case "gsql":
      return { gsql: "" };
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
  }
  return "";
}
