import { isRecord } from "../../api/client";

/**
 * The query forms of the M1 data source kinds (docs/ARCHITECTURE.md, query API): SQL sources
 * take `{sql, format}`, Prometheus takes `{expr, instant?, legend?}`. Everything that knows these
 * forms lives here, so a new kind adds its editor family in one place.
 */

export const SQL_KINDS = ["postgres", "mysql", "mssql", "sqlite"] as const;
export type EditorFamily = "sql" | "promql";

export const SQL_FORMATS = ["table", "timeSeries"] as const;
export type SqlFormat = (typeof SQL_FORMATS)[number];

export interface SqlQuery {
  sql: string;
  format: SqlFormat;
}

export interface PromQuery {
  expr: string;
  instant?: boolean;
  legend?: string;
}

export function familyOf(kind: string): EditorFamily | undefined {
  if ((SQL_KINDS as readonly string[]).includes(kind)) {
    return "sql";
  }
  return kind === "prometheus" ? "promql" : undefined;
}

export function parseSqlQuery(query: unknown): SqlQuery {
  const value = isRecord(query) ? query : {};
  return {
    sql: typeof value.sql === "string" ? value.sql : "",
    format: value.format === "timeSeries" ? "timeSeries" : "table",
  };
}

export function parsePromQuery(query: unknown): PromQuery {
  const value = isRecord(query) ? query : {};
  const parsed: PromQuery = { expr: typeof value.expr === "string" ? value.expr : "" };
  if (value.instant === true) {
    parsed.instant = true;
  }
  if (typeof value.legend === "string" && value.legend !== "") {
    parsed.legend = value.legend;
  }
  return parsed;
}

/** A new, empty query in the form the kind expects. */
export function emptyQuery(kind: string): unknown {
  return familyOf(kind) === "promql" ? { expr: "" } : { sql: "", format: "table" };
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
