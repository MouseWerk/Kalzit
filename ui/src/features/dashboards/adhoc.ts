import { isRecord } from "../../api/client";
import type { AdhocFilter, FilterOperator } from "../../api/generated/shapes";

/**
 * Ad hoc filters ("Freie Filter", board ParityEditors frame 10): a variable of type `adhoc` holds
 * filters of `{ key, operator, value }` the server builds into every stored query of its source
 * (docs/api/datasources.md, "Ad hoc filters"). In the bar they live among the other variable
 * values as a list of texts, one per filter (`encodeFilter`), so picks, the address and "save as
 * default" treat them like any other list; `storedQueryVariables` turns them back into filters
 * before a request.
 */

export type { AdhocFilter, FilterOperator };

/** Every operator the model allows, in the order the editor offers them. */
export const FILTER_OPERATORS: readonly FilterOperator[] = ["=", "!=", "=~", "!~", "<", ">"];

/** The most filters a dashboard holds, over all its ad hoc variables (the server's limit). */
export const MAX_FILTERS = 20;
/** The longest key and value the server takes. */
export const MAX_FILTER_KEY = 200;
export const MAX_FILTER_VALUE = 1000;

const LABEL_KINDS = new Set(["prometheus", "loki"]);
const SEARCH_KINDS = new Set(["elasticsearch", "opensearch"]);
const SQL_KINDS = new Set([
  "postgres",
  "mysql",
  "sqlite",
  "mssql",
  "clickhouse",
  "clickhouse_native",
  "oracle",
  "bigquery",
  "snowflake",
  "databricks",
]);

/**
 * The operators a source of `kind` can apply, as the server allows them: label matchers for
 * Prometheus and Loki (no `<` or `>`), all of them for Elasticsearch and OpenSearch, comparisons
 * without patterns for SQL. A kind that cannot apply filters gets none.
 */
export function operatorsFor(kind: string | undefined): readonly FilterOperator[] {
  if (kind === undefined) return FILTER_OPERATORS;
  if (LABEL_KINDS.has(kind)) return ["=", "!=", "=~", "!~"];
  if (SEARCH_KINDS.has(kind)) return FILTER_OPERATORS;
  if (SQL_KINDS.has(kind)) return ["=", "!=", "<", ">"];
  return [];
}

/** Whether sources of `kind` can apply ad hoc filters at all. */
export function filtersSupported(kind: string): boolean {
  return operatorsFor(kind).length > 0;
}

/** Whether a typed query of this kind takes filters only where it writes `$__filter` (SQL). */
export function isTypedSqlKind(kind: string | undefined): boolean {
  return kind !== undefined && SQL_KINDS.has(kind);
}

/** One filter as the text the bar keeps it as. */
export function encodeFilter(filter: AdhocFilter): string {
  return JSON.stringify([filter.key, filter.operator, filter.value]);
}

/** A kept text back as a filter; null for anything that is not one. */
export function decodeFilter(text: string): AdhocFilter | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [key, operator, value] = parsed;
  const op = FILTER_OPERATORS.find((o) => o === operator);
  if (typeof key !== "string" || typeof value !== "string" || op === undefined) return null;
  return { key, operator: op, value };
}

/** Kept texts as filters, dropping any that are not one. */
export function decodeFilters(texts: readonly string[]): AdhocFilter[] {
  return texts.map(decodeFilter).filter((f): f is AdhocFilter => f !== null);
}

/** A stored `current` (a list of filter objects) as filters, dropping malformed entries. */
export function storedFilters(current: unknown): AdhocFilter[] {
  if (!Array.isArray(current)) return [];
  const out: AdhocFilter[] = [];
  for (const item of current) {
    if (!isRecord(item) || typeof item.key !== "string") continue;
    const operator = FILTER_OPERATORS.find((o) => o === item.operator);
    const value =
      typeof item.value === "string"
        ? item.value
        : typeof item.value === "number" || typeof item.value === "boolean"
          ? String(item.value)
          : null;
    if (operator === undefined || value === null) continue;
    out.push({ key: item.key, operator, value });
  }
  return out;
}

/** The sign an operator is shown with: ≠ for `!=`, words for the patterns. */
export function operatorKey(
  operator: FilterOperator,
): "eq" | "ne" | "match" | "notMatch" | "lt" | "gt" {
  switch (operator) {
    case "=":
      return "eq";
    case "!=":
      return "ne";
    case "=~":
      return "match";
    case "!~":
      return "notMatch";
    case "<":
      return "lt";
    case ">":
      return "gt";
  }
}
