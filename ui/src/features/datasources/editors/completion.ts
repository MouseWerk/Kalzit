import type { MessageKey } from "../../../i18n/i18n";
import type { PromSchema, SqlSchema } from "../api";
import { PROMQL_FUNCTIONS, PROMQL_KEYWORDS, SQL_FUNCTIONS, SQL_KEYWORDS } from "./syntax";

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
  | "duration";

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

const DURATIONS = ["1m", "5m", "10m", "30m", "1h", "6h", "1d", "$__interval"];

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
    const metricName = /([\w:]+)\s*$/.exec(before.slice(0, openBrace))?.[1];
    const metrics = schema?.metrics ?? [];
    const metric = metrics.find((m) => m.name === metricName);
    const labels = metric?.labels ?? [...new Set(metrics.flatMap((m) => m.labels))].sort();
    options = labels.map((label) => ({ label, kind: "label" as const }));
  } else {
    if (word === "" && !explicit) {
      return null;
    }
    options = [
      ...(schema?.metrics ?? []).map((m) => {
        const option: Completion = { label: m.name, kind: "metric" };
        if (m.help !== undefined && m.help !== "") {
          option.detail = m.help;
        }
        return option;
      }),
      ...PROMQL_FUNCTIONS.map((f) => ({ label: f, kind: "function" as const })),
      ...PROMQL_KEYWORDS.map((k) => ({ label: k, kind: "keyword" as const })),
    ];
  }
  const found = matching(options, word);
  return found.length === 0 ? null : { from, to: cursor, options: found };
}
