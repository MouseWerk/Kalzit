import type { MessageKey, MessageParams } from "../../i18n/i18n";

/**
 * Plain-language hints for failed queries: what probably went wrong and where the cheat sheet
 * shows the fix. A hint is derived from the server's reason code where one fits, else from the
 * database's own message (an unknown table, a syntax error near a word); without either there is
 * no hint, and the error stands alone as before.
 */
export interface QueryProblem {
  code: string;
  reason?: string | undefined;
  message: string;
  params?: Readonly<Record<string, string>> | undefined;
}

export interface Hint {
  id: string;
  text: MessageKey;
  params: MessageParams;
  /** The cheat sheet topic that shows the fix. */
  topic?: string | undefined;
  /** Whether the schema list helps (an unknown name). */
  schema?: boolean;
}

export interface ErrorRule {
  id: string;
  hint: MessageKey;
  /** The hint when the database names no word (`name` is empty). */
  plain?: MessageKey;
  topic?: string;
  schema?: boolean;
  /** The values of the hint's placeholders, or null when the rule does not apply. */
  match: (problem: QueryProblem) => MessageParams | null;
}

const byReason =
  (test: (reason: string) => boolean) =>
  (problem: QueryProblem): MessageParams | null =>
    problem.reason !== undefined && test(problem.reason) ? {} : null;

const reasons = (...names: string[]) => byReason((reason) => names.includes(reason));

/** The database's text: the error's message and the detail a source error carries. */
const textOf = (problem: QueryProblem) =>
  [problem.message, problem.params?.detail ?? ""].join("\n");

/** The first pattern that matches the database's text, with its first group as `name`. */
const byText =
  (...patterns: RegExp[]) =>
  (problem: QueryProblem): MessageParams | null => {
    const text = textOf(problem);
    for (const pattern of patterns) {
      const found = pattern.exec(text);
      if (found !== null) {
        return { name: (found[1] ?? "").trim() };
      }
    }
    return null;
  };

const COMMON: readonly ErrorRule[] = [
  {
    id: "readOnly",
    hint: "help.hint.readOnly",
    topic: "basics",
    match: reasons(
      "query.write_refused",
      "sql.not_select",
      "sql.select_into",
      "sql.multiple_statements",
      "cypher.write_clause",
      "cypher.not_read_query",
      "cypher.multiple_statements",
      "gsql.write",
      "gsql.attribute_assignment",
      "mongodb.write_stage",
      "influxql.not_read",
      "influxql.select_into",
      "influxql.multiple_statements",
      "flux.write_refused",
      "elasticsearch.script_writes",
    ),
  },
  {
    id: "timeout",
    hint: "help.hint.timeout",
    topic: "time",
    match: reasons("query.timeout", "query.statement_timeout"),
  },
  {
    id: "variable",
    hint: "help.hint.variable",
    topic: "variables",
    match: (problem) =>
      problem.reason?.endsWith(".variable_missing") === true
        ? { name: problem.params?.name ?? "" }
        : null,
  },
  {
    id: "timeFilter",
    hint: "help.hint.timeFilter",
    topic: "time",
    match: reasons(
      "sql.time_filter_column",
      "sql.unclosed_time_filter",
      "mongodb.time_filter_field",
    ),
  },
  {
    id: "unclosed",
    hint: "help.hint.unclosed",
    topic: "basics",
    match: byReason(
      (reason) =>
        /\.unclosed(_|$)/.test(reason) ||
        reason === "influxdb.unclosed" ||
        reason.endsWith(".unclosed_quote"),
    ),
  },
  {
    id: "empty",
    hint: "help.hint.empty",
    topic: "basics",
    match: byReason((reason) => /\.empty$/.test(reason)),
  },
];

/** A syntax error the checker or the database found, with the word it stopped at if named. */
const syntax = (...patterns: RegExp[]): ErrorRule => ({
  id: "syntax",
  hint: "help.hint.syntax",
  plain: "help.hint.syntaxPlain",
  topic: "basics",
  match: (problem) => {
    const named = byText(...patterns)(problem);
    if (named !== null && named.name !== "") {
      return named;
    }
    return problem.reason !== undefined &&
      /parse_error|json_invalid|unexpected_character/.test(problem.reason)
      ? { name: "" }
      : null;
  },
});

const unknownTable = (...patterns: RegExp[]): ErrorRule => ({
  id: "unknownTable",
  hint: "help.hint.unknownTable",
  schema: true,
  match: byText(...patterns),
});

const unknownColumn = (...patterns: RegExp[]): ErrorRule => ({
  id: "unknownColumn",
  hint: "help.hint.unknownColumn",
  topic: "basics",
  schema: true,
  match: byText(...patterns),
});

export type RuleSet =
  | "sql"
  | "promql"
  | "influx"
  | "logql"
  | "search"
  | "mongo"
  | "cypher"
  | "gsql"
  | "file"
  | "http"
  | "plugin";

export const ERROR_RULES: Record<RuleSet, readonly ErrorRule[]> = {
  sql: [
    ...COMMON,
    unknownTable(
      /relation "([^"]+)" does not exist/i,
      /no such table: ([^\s,;]+)/i,
      /Table '([^']+)' doesn't exist/i,
      /Invalid object name '([^']+)'/i,
      /Table ([\w.`]+) (?:doesn't|does not) exist/i,
      /Unknown table expression identifier '([^']+)'/i,
    ),
    unknownColumn(
      /column "([^"]+)" does not exist/i,
      /column ([\w.]+) does not exist/i,
      /no such column: ([^\s,;]+)/i,
      /Unknown column '([^']+)'/i,
      /Invalid column name '([^']+)'/i,
      /Unknown expression identifier '([^']+)'/i,
      /Missing columns: '([^']+)'/i,
    ),
    syntax(
      /syntax error at or near "([^"]*)"/i,
      /near "([^"]*)": syntax error/i,
      /right syntax to use near '([^']*)'/i,
      /Incorrect syntax near '([^']*)'/i,
      /Syntax error[^:]*: failed at position \d+ \('([^']*)'\)/i,
    ),
  ],
  promql: [
    ...COMMON,
    syntax(/parse error: (?:at char \d+: )?(.+)/i),
    {
      id: "unknownFunction",
      hint: "help.hint.unknownFunction",
      topic: "basics",
      match: byText(/unknown function with name "([^"]+)"/i),
    },
  ],
  influx: [
    ...COMMON,
    {
      id: "language",
      hint: "help.hint.influxLanguage",
      topic: "basics",
      match: reasons("influxdb.language_unavailable"),
    },
    syntax(/error parsing query: (.+)/i, /compilation failed: (.+)/i),
    {
      id: "noDatabase",
      hint: "help.hint.influxDatabase",
      match: reasons("influxdb.database_missing"),
    },
  ],
  logql: [
    ...COMMON,
    {
      id: "selector",
      hint: "help.hint.logqlSelector",
      topic: "basics",
      match: byText(/(queries require at least one regexp or equality matcher.*)/i),
    },
    syntax(/parse error at line \d+, col \d+: (.+)/i, /parse error: (.+)/i),
  ],
  search: [
    ...COMMON,
    {
      id: "unknownIndex",
      hint: "help.hint.unknownIndex",
      schema: true,
      match: (problem) =>
        problem.reason === "elasticsearch.index_missing"
          ? { name: problem.params?.index ?? "" }
          : byText(/no such index \[([^\]]+)\]/i)(problem),
    },
    syntax(/Failed to parse query \[([^\]]*)\]/i, /Cannot parse '([^']*)'/i),
  ],
  mongo: [
    ...COMMON,
    {
      id: "collection",
      hint: "help.hint.mongoCollection",
      schema: true,
      match: reasons("mongodb.collection_invalid", "mongodb.system_collection"),
    },
    {
      id: "stage",
      hint: "help.hint.mongoStage",
      topic: "basics",
      match: reasons(
        "mongodb.stage_not_allowed",
        "mongodb.operator_not_allowed",
        "mongodb.javascript",
      ),
    },
    {
      id: "array",
      hint: "help.hint.mongoArray",
      topic: "basics",
      match: reasons("mongodb.pipeline_not_array", "mongodb.not_a_document"),
    },
    syntax(/Unrecognized pipeline stage name: '([^']+)'/i, /unknown operator: (\S+)/i),
  ],
  cypher: [
    ...COMMON,
    {
      id: "unknownFunction",
      hint: "help.hint.unknownFunction",
      topic: "basics",
      match: byText(/Unknown function '([^']+)'/i),
    },
    {
      id: "undefinedVariable",
      hint: "help.hint.cypherVariable",
      topic: "basics",
      match: byText(/Variable `([^`]+)` not defined/i),
    },
    syntax(
      /Invalid input '([^']*)'/i,
      /mismatched input '([^']*)'/i,
      /no viable alternative at input '([^']*)'/i,
    ),
  ],
  gsql: [
    ...COMMON,
    {
      id: "graph",
      hint: "help.hint.gsqlGraph",
      match: reasons("gsql.other_graph", "gsql.graph_missing"),
    },
    {
      id: "params",
      hint: "help.hint.gsqlVariable",
      topic: "basics",
      match: reasons("gsql.variable_text"),
    },
    syntax(/line \d+:\d+ (.+)/i),
  ],
  file: [
    {
      id: "format",
      hint: "help.hint.fileFormat",
      match: byReason(
        (r) =>
          r.startsWith("csv.") || r === "file.json_invalid" || r === "file.ndjson_line_invalid",
      ),
    },
  ],
  http: [
    {
      id: "documentsPath",
      hint: "help.hint.httpDocumentsPath",
      match: reasons("http_json.path_missing"),
    },
    {
      id: "status",
      hint: "help.hint.httpStatus",
      match: reasons("http_json.status", "http_json.not_json"),
    },
  ],
  plugin: [...COMMON],
};

/** The first hint a guide's rules derive for a problem, or null. */
export function hintFor(rules: readonly ErrorRule[], problem: QueryProblem): Hint | null {
  for (const rule of rules) {
    const params = rule.match(problem);
    if (params !== null) {
      return {
        id: rule.id,
        text: params.name === "" && rule.plain !== undefined ? rule.plain : rule.hint,
        params,
        topic: rule.topic,
        ...(rule.schema === true ? { schema: true } : {}),
      };
    }
  }
  return null;
}

/** The parts of an error a hint is derived from, whatever form it arrived in. */
export function problemOf(error: unknown): QueryProblem | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const value = error as Record<string, unknown>;
  // An ApiError: the body's `error` holds the reason.
  const body =
    typeof value.body === "object" && value.body !== null
      ? ((value.body as Record<string, unknown>).error as Record<string, unknown> | undefined)
      : undefined;
  const source = body ?? value;
  if (typeof source.message !== "string") {
    return null;
  }
  const params =
    typeof source.params === "object" && source.params !== null
      ? (source.params as Record<string, string>)
      : undefined;
  return {
    code: String(source.code ?? value.code ?? ""),
    reason: typeof source.reason === "string" ? source.reason : undefined,
    message: source.message,
    params,
  };
}
