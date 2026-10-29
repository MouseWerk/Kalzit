import type { MessageKey } from "../../../i18n/i18n";
import type { GraphSourceSchema, LabelsSchema, PromSchema, SqlSchema } from "../api";
import {
  CYPHER_FUNCTIONS,
  CYPHER_KEYWORDS,
  FLUX_FUNCTIONS,
  FLUX_KEYWORDS,
  LOGQL_FUNCTIONS,
  LOGQL_KEYWORDS,
  PROMQL_FUNCTIONS,
  PROMQL_KEYWORDS,
  SQL_FUNCTIONS,
  SQL_KEYWORDS,
} from "./syntax";

/**
 * Schema-based completion for the query editors, as pure functions over the text and the cursor,
 * so the same logic can feed the fallback editor and a CodeMirror completion source.
 */

export type CompletionKind =
  | "table"
  | "column"
  | "keyword"
  | "function"
  | "macro"
  | "metric"
  | "label"
  | "duration"
  | "nodeLabel"
  | "edgeType"
  | "property";

export interface Completion {
  label: string;
  kind: CompletionKind;
  /** A column type, a metric's help text. */
  detail?: string;
}

export interface CompletionResult {
  /** The range the chosen option replaces: the word being typed. */
  from: number;
  to: number;
  options: Completion[];
}

/** Enough to choose from without a long list to scroll through. */
const MAX_OPTIONS = 50;

/** The SQL macros of docs/ARCHITECTURE.md; the server turns them into bind parameters. */
export const SQL_MACROS: { name: string; detail: string; help: MessageKey }[] = [
  {
    name: "$__timeFilter",
    detail: "$__timeFilter(column)",
    help: "datasources.editor.macro.timeFilter",
  },
  { name: "$__timeFrom", detail: "$__timeFrom", help: "datasources.editor.macro.timeFrom" },
  { name: "$__timeTo", detail: "$__timeTo", help: "datasources.editor.macro.timeTo" },
  { name: "$__interval", detail: "$__interval", help: "datasources.editor.macro.interval" },
  {
    name: "$__interval_ms",
    detail: "$__interval_ms",
    help: "datasources.editor.macro.intervalMs",
  },
];

function matching(options: Completion[], prefix: string): Completion[] {
  const lower = prefix.toLowerCase();
  const seen = new Set<string>();
  const result: Completion[] = [];
  for (const option of options) {
    const key = `${option.kind}:${option.label}`;
    if (!seen.has(key) && option.label.toLowerCase().startsWith(lower)) {
      seen.add(key);
      result.push(option);
    }
  }
  return result.slice(0, MAX_OPTIONS);
}

type Table = SqlSchema["tables"][number];

function tableNames(table: Table): string[] {
  return table.schema === undefined ? [table.name] : [table.name, `${table.schema}.${table.name}`];
}

/** Tables named after FROM or JOIN, with their aliases, so `o.` completes the columns of orders. */
function referencedTables(text: string, schema: SqlSchema): Map<string, Table> {
  const byName = new Map<string, Table>();
  for (const table of schema.tables) {
    for (const name of tableNames(table)) {
      byName.set(name.toLowerCase(), table);
    }
  }
  const found = new Map<string, Table>();
  const pattern = /\b(?:from|join)\s+([\w.]+)(?:\s+(?:as\s+)?(\w+))?/gi;
  for (const match of text.matchAll(pattern)) {
    const table = byName.get((match[1] ?? "").toLowerCase());
    if (table === undefined) {
      continue;
    }
    found.set(table.name.toLowerCase(), table);
    const alias = match[2]?.toLowerCase();
    if (alias !== undefined && !(SQL_KEYWORDS as readonly string[]).includes(alias)) {
      found.set(alias, table);
    }
  }
  return found;
}

function columnsOf(table: Table): Completion[] {
  return table.columns.map((column) => ({
    label: column.name,
    kind: "column" as const,
    detail: column.type,
  }));
}

/**
 * Completions at `cursor`. Without `explicit` (Ctrl+Space) they appear only once a word has been
 * started, so typing a space or a comma does not pop up a list.
 */
export function sqlCompletions(
  text: string,
  cursor: number,
  schema: SqlSchema | undefined,
  explicit = false,
): CompletionResult | null {
  const before = text.slice(0, cursor);
  const word = /[\w$.]*$/.exec(before)?.[0] ?? "";
  const dot = word.lastIndexOf(".");
  const tables = schema === undefined ? new Map<string, Table>() : referencedTables(text, schema);

  if (dot !== -1) {
    const qualifier = word.slice(0, dot).toLowerCase();
    const prefix = word.slice(dot + 1);
    const table =
      tables.get(qualifier) ??
      schema?.tables.find((t) => tableNames(t).some((name) => name.toLowerCase() === qualifier));
    if (table === undefined) {
      return null;
    }
    const options = matching(columnsOf(table), prefix);
    return options.length === 0 ? null : { from: cursor - prefix.length, to: cursor, options };
  }

  if (word === "" && !explicit) {
    return null;
  }
  const options: Completion[] = [];
  if (word.startsWith("$")) {
    options.push(
      ...SQL_MACROS.map((m) => ({ label: m.name, kind: "macro" as const, detail: m.detail })),
    );
  } else {
    for (const table of new Set(tables.values())) {
      options.push(...columnsOf(table));
    }
    for (const table of schema?.tables ?? []) {
      const option: Completion = { label: table.name, kind: "table" };
      if (table.schema !== undefined) {
        option.detail = table.schema;
      }
      options.push(option);
    }
    options.push(
      ...SQL_KEYWORDS.map((k) => ({ label: k.toUpperCase(), kind: "keyword" as const })),
    );
    options.push(...SQL_FUNCTIONS.map((f) => ({ label: f, kind: "function" as const })));
  }
  const found = matching(options, word);
  return found.length === 0 ? null : { from: cursor - word.length, to: cursor, options: found };
}

const DURATIONS = ["1m", "5m", "10m", "30m", "1h", "6h", "1d", "$__interval", "$__rate_interval"];

/** The PromQL macros of docs/api/datasources.md. */
export const PROMQL_MACROS: { name: string; help: MessageKey }[] = [
  { name: "$__interval", help: "datasources.editor.macro.interval" },
  { name: "$__interval_ms", help: "datasources.editor.macro.intervalMs" },
  { name: "$__rate_interval", help: "datasources.editor.macro.rateInterval" },
  { name: "$__range", help: "datasources.editor.macro.range" },
  { name: "$__timeFrom", help: "datasources.editor.macro.timeFromSeconds" },
  { name: "$__timeTo", help: "datasources.editor.macro.timeToSeconds" },
];

/** Completions for PromQL: metrics, functions, label names inside `{}`, durations inside `[]`. */
export function promqlCompletions(
  text: string,
  cursor: number,
  schema: PromSchema | undefined,
  explicit = false,
): CompletionResult | null {
  const before = text.slice(0, cursor);
  const word = /[\w:$]*$/.exec(before)?.[0] ?? "";
  const from = cursor - word.length;
  const openBrace = before.lastIndexOf("{");
  const insideBraces = openBrace > before.lastIndexOf("}");
  const openBracket = before.lastIndexOf("[");
  const insideBrackets = openBracket > before.lastIndexOf("]");
  let options: Completion[];

  if (insideBrackets) {
    options = DURATIONS.map((d) => ({ label: d, kind: "duration" as const }));
  } else if (insideBraces) {
    // Inside a matcher's quoted value nothing is offered: label values are not in the schema.
    const inMatcher = before.slice(openBrace + 1);
    if ((inMatcher.match(/"/g) ?? []).length % 2 === 1) {
      return null;
    }
    // The schema lists label names for the whole source, not per metric.
    options = (schema?.labels ?? []).map((label) => ({ label, kind: "label" as const }));
  } else {
    if (word === "" && !explicit) {
      return null;
    }
    options = [
      ...(word.startsWith("$")
        ? PROMQL_MACROS.map((m) => ({ label: m.name, kind: "macro" as const }))
        : []),
      ...(schema?.metrics ?? []).map((name) => ({ label: name, kind: "metric" as const })),
      ...PROMQL_FUNCTIONS.map((f) => ({ label: f, kind: "function" as const })),
      ...PROMQL_KEYWORDS.map((k) => ({ label: k, kind: "keyword" as const })),
    ];
  }
  const found = matching(options, word);
  return found.length === 0 ? null : { from, to: cursor, options: found };
}

/** The Cypher macros of docs/api/datasources.md; the server binds them as parameters. */
export const CYPHER_MACROS: { name: string; help: MessageKey }[] = [
  { name: "$__timeFrom", help: "datasources.editor.macro.timeFromDateTime" },
  { name: "$__timeTo", help: "datasources.editor.macro.timeToDateTime" },
  { name: "$__timeFromMs", help: "datasources.editor.macro.timeFromMs" },
  { name: "$__timeToMs", help: "datasources.editor.macro.timeToMs" },
  { name: "$__interval_ms", help: "datasources.editor.macro.intervalMs" },
];

/** The source's property keys; the schema lists them for the whole source, not per label. */
function propertyKeys(schema: GraphSourceSchema | undefined): Completion[] {
  return [...new Set(schema?.propertyKeys ?? [])]
    .sort()
    .map((key) => ({ label: key, kind: "property" as const }));
}

/**
 * Completions for Cypher from the graph schema: labels after a colon in a node pattern
 * (`(c:Cu`), edge types after a colon or a bar in an edge pattern (`[:BO`, `[:A|B`), property
 * keys after a variable and a dot and inside a pattern's braces, macros after `$`, else keywords
 * and functions.
 */
export function cypherCompletions(
  text: string,
  cursor: number,
  schema: GraphSourceSchema | undefined,
  explicit = false,
): CompletionResult | null {
  const before = text.slice(0, cursor);
  const word = /\$?\w*$/.exec(before)?.[0] ?? "";
  const from = cursor - word.length;
  const head = before.slice(0, from);
  let options: Completion[];

  const openParen = head.lastIndexOf("(");
  const openBracket = head.lastIndexOf("[");
  const openBrace = head.lastIndexOf("{");
  const closed = (open: number, close: string) => open > head.lastIndexOf(close);
  if (/:\s*$/.test(head) || (/\|\s*$/.test(head) && closed(openBracket, "]"))) {
    const inEdge = closed(openBracket, "]") && openBracket > openParen;
    options = inEdge
      ? (schema?.edgeTypes ?? []).map((type) => ({ label: type, kind: "edgeType" as const }))
      : (schema?.labels ?? []).map((label) => ({ label, kind: "nodeLabel" as const }));
    // A colon in a map (`{since: 2020}`) is not a label position.
    if (closed(openBrace, "}") && openBrace > Math.max(openParen, openBracket)) {
      return null;
    }
  } else if (word.startsWith("$")) {
    options = CYPHER_MACROS.map((m) => ({ label: m.name, kind: "macro" as const }));
  } else if (/\b\w+\.$/.test(head)) {
    options = propertyKeys(schema);
  } else if (closed(openBrace, "}") && /[{,]\s*$/.test(head)) {
    options = propertyKeys(schema);
  } else {
    if (word === "" && !explicit) {
      return null;
    }
    options = [
      ...CYPHER_KEYWORDS.map((k) => ({ label: k.toUpperCase(), kind: "keyword" as const })),
      ...CYPHER_FUNCTIONS.map((f) => ({ label: f, kind: "function" as const })),
    ];
  }
  const found = matching(options, word);
  return found.length === 0 ? null : { from, to: cursor, options: found };
}

/** LogQL (Loki): the PromQL macros; the server expands them the same way. */
export const LOGQL_MACROS = PROMQL_MACROS;

/**
 * Completions for LogQL: label names inside a stream selector, the label's values inside its
 * quoted value (`{app="`), durations inside `[]`, else functions, parsers and keywords.
 */
export function logqlCompletions(
  text: string,
  cursor: number,
  schema: LabelsSchema | undefined,
  explicit = false,
): CompletionResult | null {
  const before = text.slice(0, cursor);
  const openBrace = before.lastIndexOf("{");
  const insideBraces = openBrace > before.lastIndexOf("}");
  const openBracket = before.lastIndexOf("[");
  const insideBrackets = openBracket > before.lastIndexOf("]");
  if (insideBraces) {
    const inMatcher = before.slice(openBrace + 1);
    if ((inMatcher.match(/"/g) ?? []).length % 2 === 1) {
      // A label's value: `app="ap` offers the values of app.
      const value = /(\w+)\s*(?:=~|!~|!=|=)\s*"([^"]*)$/.exec(inMatcher);
      if (value === null) {
        return null;
      }
      const prefix = value[2] ?? "";
      const options = (schema?.values[value[1] ?? ""] ?? []).map((v) => ({
        label: v,
        kind: "property" as const,
      }));
      const found = matching(options, prefix);
      return found.length === 0
        ? null
        : { from: cursor - prefix.length, to: cursor, options: found };
    }
  }
  const word = /[\w$]*$/.exec(before)?.[0] ?? "";
  const from = cursor - word.length;
  let options: Completion[];
  if (insideBrackets) {
    options = DURATIONS.map((d) => ({ label: d, kind: "duration" as const }));
  } else if (insideBraces) {
    options = (schema?.labels ?? []).map((label) => ({ label, kind: "label" as const }));
  } else {
    if (word === "" && !explicit) {
      return null;
    }
    options = [
      ...(word.startsWith("$")
        ? LOGQL_MACROS.map((m) => ({ label: m.name, kind: "macro" as const }))
        : []),
      ...LOGQL_FUNCTIONS.map((f) => ({ label: f, kind: "function" as const })),
      ...LOGQL_KEYWORDS.map((k) => ({ label: k, kind: "keyword" as const })),
      // Labels a parser extracted, filtered after a pipe (`| level="error"`).
      ...(schema?.labels ?? []).map((label) => ({ label, kind: "label" as const })),
    ];
  }
  const found = matching(options, word);
  return found.length === 0 ? null : { from, to: cursor, options: found };
}

/** The Flux macros of docs/api/datasources.md, and the `v` record of InfluxDB's own tools. */
export const FLUX_MACROS: { name: string; help: MessageKey }[] = [
  { name: "v.timeRangeStart", help: "datasources.editor.macro.timeRangeStart" },
  { name: "v.timeRangeStop", help: "datasources.editor.macro.timeRangeStop" },
  { name: "v.windowPeriod", help: "datasources.editor.macro.windowPeriod" },
  { name: "v.bucket", help: "datasources.editor.macro.bucket" },
  { name: "$__interval", help: "datasources.editor.macro.interval" },
];

/** The InfluxQL macros of docs/api/datasources.md. */
export const INFLUXQL_MACROS: { name: string; help: MessageKey }[] = [
  { name: "$__timeFilter", help: "datasources.editor.macro.influxTimeFilter" },
  { name: "$__interval", help: "datasources.editor.macro.interval" },
  { name: "$__interval_ms", help: "datasources.editor.macro.intervalMs" },
  { name: "$__timeFrom", help: "datasources.editor.macro.timeFrom" },
  { name: "$__timeTo", help: "datasources.editor.macro.timeTo" },
];

/**
 * Completions for Flux: inside a string the measurements and their fields and tags (for
 * `r._measurement == "cpu"`), after `v.` or `$` the macros, else functions, keywords, macros,
 * measurements and keys.
 */
export function fluxCompletions(
  text: string,
  cursor: number,
  schema: SqlSchema | undefined,
  explicit = false,
): CompletionResult | null {
  const before = text.slice(0, cursor);
  const quotes = (before.match(/(?<!\\)"/g) ?? []).length;
  const tables = schema?.tables ?? [];
  const names: Completion[] = [
    ...tables.map((t) => ({ label: t.name, kind: "table" as const })),
    ...tables.flatMap((t) =>
      t.columns.map((c) => ({ label: c.name, kind: "column" as const, detail: c.type })),
    ),
  ];
  if (quotes % 2 === 1) {
    const prefix = /[^"]*$/.exec(before)?.[0] ?? "";
    const found = matching(names, prefix);
    return found.length === 0 ? null : { from: cursor - prefix.length, to: cursor, options: found };
  }
  const word = /[\w$.]*$/.exec(before)?.[0] ?? "";
  if (word === "" && !explicit) {
    return null;
  }
  const options: Completion[] =
    word.startsWith("v.") || word.startsWith("$")
      ? FLUX_MACROS.map((m) => ({ label: m.name, kind: "macro" as const }))
      : [
          ...FLUX_FUNCTIONS.map((f) => ({ label: f, kind: "function" as const })),
          ...FLUX_KEYWORDS.map((k) => ({ label: k, kind: "keyword" as const })),
          ...FLUX_MACROS.map((m) => ({ label: m.name, kind: "macro" as const })),
          ...names,
        ];
  const found = matching(options, word);
  return found.length === 0 ? null : { from: cursor - word.length, to: cursor, options: found };
}
