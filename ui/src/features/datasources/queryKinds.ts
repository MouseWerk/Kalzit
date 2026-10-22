import { isRecord } from "../../api/client";

/**
 * The query forms of the M1 data source kinds (docs/api/datasources.md): SQL sources take exactly
 * `{sql}`, Prometheus takes `{expr, instant?, minStepMs?}`. Anything else is rejected as a wrong
 * query form, so these are the only shapes the editors produce. Whether a result is drawn as a
 * table or a time series is the panel's choice from the frame, not part of the query.
 */

export const SQL_KINDS = ["postgres", "mysql", "mssql", "sqlite"] as const;
export type EditorFamily = "sql" | "promql";

export interface SqlQuery {
  sql: string;
}

export interface PromQuery {
  expr: string;
  instant?: boolean;
  /** Lower bound of the range query's step, in milliseconds. */
  minStepMs?: number;
}

export function familyOf(kind: string): EditorFamily | undefined {
  if ((SQL_KINDS as readonly string[]).includes(kind)) {
    return "sql";
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

/** A new, empty query in the form the kind expects. */
export function emptyQuery(kind: string): unknown {
  return familyOf(kind) === "promql" ? { expr: "" } : { sql: "" };
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
  }
  return "";
}
