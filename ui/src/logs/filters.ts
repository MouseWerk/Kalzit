import { isRecord } from "../api/client";
import { toExtendedJson } from "../documents/filter";
import { isTyped } from "../documents/values";
import { parseSearchQuery } from "../features/datasources/editors/searchQuery";
import { addMatch, isMongoQuery, parseMongoQuery } from "../features/datasources/mongoQuery";
import { familyOf, parseLokiQuery } from "../features/datasources/queryKinds";
import type { LogField } from "./model";

/**
 * "Filter for" and "Filter out" (board Logs.dc.html, frame 2) change the Explore query visibly in
 * the source's own language and run it: a LogQL label filter (`| host = "web-3"`), a Lucene clause
 * (`AND host:"web-3"`) or a MongoDB condition. Whoever clicks sees how the filter is written. A
 * query the filter cannot be added to safely is never rewritten; the view says why instead.
 */

export type FilterMode = "include" | "exclude";

export type FilterRefusal =
  /** A LogQL metric query (`rate(...)`) answers no lines. */
  | "metric"
  /** A Query DSL body: Kalzit does not rewrite JSON it did not write. */
  | "dsl"
  /** A MongoDB filter or pipeline that does not parse. */
  | "filter"
  | "pipeline"
  /** A field name the language cannot write. */
  | "key"
  /** A value that is no single value (an object or a list). */
  | "value"
  /** A source without a filter the view knows how to write. */
  | "kind";

export type FilterOutcome = { query: unknown } | { refused: FilterRefusal };

/** Whether the view can write filters into queries of this kind at all. */
export function filtersKind(kind: string): boolean {
  const family = familyOf(kind);
  return family === "logql" || family === "search" || family === "mongo";
}

/** A LogQL string literal: backslashes and double quotes escaped. */
function logqlString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** A parser stage in a LogQL pipeline, after which fields of the line are labels. */
const PARSER = /\|\s*(json|logfmt|pattern|regexp|unpack)\b/;

/**
 * The LogQL with a label filter appended. Labels of the stream filter as they are; a field read
 * from the line needs a parser first, so `| json` or `| logfmt` is added when the query has none,
 * where everyone sees it. LogQL names a nested JSON field with underscores (`a.b` is `a_b`).
 */
export function lokiFilter(
  logql: string,
  field: LogField,
  mode: FilterMode,
  lineIsJson: boolean,
): { logql: string } | { refused: FilterRefusal } {
  const text = logql.trimEnd();
  if (!/^\s*\{/.test(text)) {
    return { refused: "metric" };
  }
  const key = field.origin === "line" ? field.key.replace(/[^A-Za-z0-9_]/g, "_") : field.key;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return { refused: "key" };
  }
  if (isRecord(field.value) && !isTyped(field.value)) {
    return { refused: "value" };
  }
  const parts: string[] = [];
  if (field.origin === "line" && !PARSER.test(text)) {
    parts.push(lineIsJson ? "| json" : "| logfmt");
  }
  parts.push(`| ${key} ${mode === "include" ? "=" : "!="} ${logqlString(field.text)}`);
  // A comment on the last line would swallow what is added on that line.
  const lastLine = text.slice(text.lastIndexOf("\n") + 1);
  const joint = lastLine.includes("#") ? "\n" : " ";
  return { logql: `${text}${joint}${parts.join(" ")}` };
}

/** Lucene's special characters, escaped in a field name. */
const LUCENE_SPECIAL = /([+\-&|!(){}[\]^"~*?:\\/\s])/g;

/** The Lucene query with a clause for the field joined by AND (or AND NOT). */
export function luceneFilter(
  lucene: string,
  field: LogField,
  mode: FilterMode,
): { lucene: string } | { refused: FilterRefusal } {
  if (isRecord(field.value) && !isTyped(field.value)) {
    return { refused: "value" };
  }
  const name = field.key.replace(LUCENE_SPECIAL, "\\$1");
  if (name === "") {
    return { refused: "key" };
  }
  const clause = `${name}:"${field.text.replace(/[\\"]/g, "\\$&")}"`;
  const old = lucene.trim();
  if (old === "" || old === "*" || old === "*:*") {
    return { lucene: mode === "include" ? clause : `NOT ${clause}` };
  }
  // Clauses joined by OR keep their meaning only inside parentheses.
  const base = /\bOR\b|\|\|/.test(old) ? `(${old})` : old;
  return { lucene: `${base} AND ${mode === "include" ? "" : "NOT "}${clause}` };
}

/** The query of a kind with the filter added, or why it was not. */
export function filterQuery(
  kind: string,
  query: unknown,
  field: LogField,
  mode: FilterMode,
  lineIsJson: boolean,
): FilterOutcome {
  const family = familyOf(kind);
  if (family === "logql") {
    const parsed = parseLokiQuery(query);
    const next = lokiFilter(parsed.logql, field, mode, lineIsJson);
    return "refused" in next ? next : { query: { ...(query as object), logql: next.logql } };
  }
  if (family === "search") {
    const parsed = parseSearchQuery(query);
    if (parsed.dsl !== undefined) {
      return { refused: "dsl" };
    }
    const next = luceneFilter(parsed.lucene ?? "", field, mode);
    return "refused" in next ? next : { query: { ...(query as object), lucene: next.lucene } };
  }
  if (family === "mongo" && isMongoQuery(query)) {
    if (field.origin === "line" || (isRecord(field.value) && !isTyped(field.value))) {
      return { refused: field.origin === "line" ? "kind" : "value" };
    }
    const value = mode === "include" ? field.value : { $nin: [toExtendedJson(field.value)] };
    const added = addMatch(parseMongoQuery(query), field.path, value);
    return "refused" in added ? { refused: added.refused } : { query: added.query };
  }
  return { refused: "kind" };
}
