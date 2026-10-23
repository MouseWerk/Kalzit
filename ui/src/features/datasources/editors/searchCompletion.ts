import type { MessageKey } from "../../../i18n/i18n";
import type { IndicesSchema } from "../api";
import type { Completion, CompletionResult } from "./completion";
import { jsonContext } from "./mongoCompletion";
import { DSL_KEYS, indexMatches } from "./searchQuery";
import { LUCENE_KEYWORDS } from "./syntax";

/**
 * Completion for Elasticsearch and OpenSearch queries: the mapped fields of the chosen index (or
 * of every index its pattern covers), the Query DSL's keys where they belong, and the macros.
 */

const MAX_OPTIONS = 50;

/** The macros of the search form; in Query DSL a string that is exactly one of them. */
export const SEARCH_MACROS: { name: string; help: MessageKey; dslOnly?: true }[] = [
  { name: "$__timeFrom", help: "datasources.editor.macro.timeFromMs" },
  { name: "$__timeTo", help: "datasources.editor.macro.timeToMs" },
  { name: "$__interval", help: "datasources.editor.macro.interval", dslOnly: true },
  { name: "$__interval_ms", help: "datasources.editor.macro.intervalMs", dslOnly: true },
];

/** The common query clauses, offered where a query goes. */
const QUERY_CLAUSES = [
  "bool",
  "match",
  "match_all",
  "match_phrase",
  "multi_match",
  "query_string",
  "simple_query_string",
  "term",
  "terms",
  "range",
  "exists",
  "prefix",
  "wildcard",
  "regexp",
  "fuzzy",
  "ids",
  "nested",
];
const BOOL_CLAUSES = ["must", "filter", "should", "must_not", "minimum_should_match"];
/** Keys under which a query clause is written. */
const QUERY_PLACES = new Set(["query", "post_filter", "filter", "must", "should", "must_not"]);
/** Clauses whose keys are field names: `{"term": {"land": "AT"}}`. */
const FIELD_KEYED = new Set([
  "match",
  "match_phrase",
  "match_phrase_prefix",
  "term",
  "terms",
  "range",
  "prefix",
  "wildcard",
  "regexp",
  "fuzzy",
]);
/** Keys whose value names a field: `{"field": "land"}`. */
const FIELD_VALUES = new Set(["field", "default_field", "path"]);
/** Arrays of field names. */
const FIELD_LISTS = new Set(["_source", "fields", "docvalue_fields", "stored_fields", "sort"]);
const AGGREGATIONS = [
  "terms",
  "date_histogram",
  "auto_date_histogram",
  "histogram",
  "range",
  "date_range",
  "filter",
  "filters",
  "composite",
  "avg",
  "sum",
  "min",
  "max",
  "cardinality",
  "value_count",
  "stats",
  "extended_stats",
  "percentiles",
  "aggs",
];

/** The fields of the indices the query reads: one index, or every index its pattern covers. */
export function searchFields(
  schema: IndicesSchema | undefined,
  index: string | undefined,
): { name: string; type: string }[] {
  if (schema === undefined) {
    return [];
  }
  const indices =
    index === undefined || index.trim() === ""
      ? schema.indices
      : schema.indices.filter((candidate) => indexMatches(index, candidate.name));
  const fields = new Map<string, string>();
  for (const { columns } of indices) {
    for (const column of columns) {
      if (!fields.has(column.name)) {
        fields.set(column.name, column.type);
      }
    }
  }
  return [...fields].map(([name, type]) => ({ name, type }));
}

function matching(options: Completion[], word: string): Completion[] {
  const lower = word.toLowerCase();
  const unique = new Map<string, Completion>();
  for (const option of options) {
    if (option.label.toLowerCase().startsWith(lower) && !unique.has(option.label)) {
      unique.set(option.label, option);
    }
  }
  return [...unique.values()].slice(0, MAX_OPTIONS);
}

const fieldOptions = (fields: readonly { name: string; type: string }[]): Completion[] =>
  fields.map((field) => ({ label: field.name, kind: "column", detail: field.type }));

/** Completions in a Lucene query string: field names, AND/OR/NOT and the two time macros. */
export function luceneCompletions(
  text: string,
  cursor: number,
  fields: readonly { name: string; type: string }[],
  explicit = false,
): CompletionResult | null {
  const before = text.slice(0, cursor);
  // Inside a phrase nothing is offered: it is text to match.
  if ((before.match(/(?<!\\)"/g) ?? []).length % 2 === 1) {
    return null;
  }
  const word = /[\w.@$]*$/.exec(before)?.[0] ?? "";
  if (word === "" && !explicit) {
    return null;
  }
  const options: Completion[] = word.startsWith("$")
    ? SEARCH_MACROS.filter((m) => m.dslOnly !== true).map((m) => ({
        label: m.name,
        kind: "macro",
      }))
    : [
        ...fieldOptions(fields),
        ...LUCENE_KEYWORDS.filter((k) => k !== "TO").map((k) => ({
          label: k,
          kind: "keyword" as const,
        })),
      ];
  const found = matching(options, word);
  return found.length === 0 ? null : { from: cursor - word.length, to: cursor, options: found };
}

/** Completions in a Query DSL body, by where the cursor sits in the JSON. */
export function dslCompletions(
  text: string,
  cursor: number,
  fields: readonly { name: string; type: string }[],
  explicit = false,
): CompletionResult | null {
  const context = jsonContext(text, cursor);
  if (context.outside || (context.word === "" && !context.quoted && !explicit)) {
    return null;
  }
  const { path } = context;
  const last = path.at(-1);
  const parent = path.at(-2);
  let options: Completion[] = [];
  if (context.quoted && context.word.startsWith("$")) {
    options = SEARCH_MACROS.map((m) => ({ label: m.name, kind: "macro" }));
  } else if (context.inKey) {
    if (last === undefined) {
      options = DSL_KEYS.map((key) => ({ label: key, kind: "keyword" }));
    } else if (QUERY_PLACES.has(last)) {
      options = QUERY_CLAUSES.map((key) => ({ label: key, kind: "keyword" }));
    } else if (last === "bool") {
      options = BOOL_CLAUSES.map((key) => ({ label: key, kind: "keyword" }));
    } else if (FIELD_KEYED.has(last) || last === "sort") {
      options = fieldOptions(fields);
    } else if (parent === "aggs" || parent === "aggregations") {
      options = AGGREGATIONS.map((key) => ({ label: key, kind: "function" }));
    }
  } else if (context.quoted && last !== undefined) {
    if (FIELD_VALUES.has(last) || FIELD_LISTS.has(last)) {
      options = fieldOptions(fields);
    }
  }
  const found = matching(options, context.word);
  return found.length === 0 ? null : { from: context.from, to: cursor, options: found };
}
