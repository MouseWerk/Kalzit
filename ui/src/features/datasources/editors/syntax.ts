/**
 * Small tokenizers for highlighting SQL and PromQL in the fallback editor. They only color text;
 * the server parses queries for real. Every character of the input ends up in exactly one token,
 * so the highlight layer lines up with the text area character for character.
 */

export type TokenKind =
  | "keyword"
  | "function"
  | "string"
  | "number"
  | "comment"
  | "macro"
  | "operator"
  | "duration"
  | "label"
  | "plain";

export interface Token {
  kind: TokenKind;
  text: string;
}

export const SQL_KEYWORDS = [
  "select",
  "from",
  "where",
  "and",
  "or",
  "not",
  "in",
  "is",
  "null",
  "as",
  "on",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "cross",
  "group",
  "by",
  "order",
  "having",
  "limit",
  "offset",
  "top",
  "distinct",
  "union",
  "all",
  "with",
  "case",
  "when",
  "then",
  "else",
  "end",
  "asc",
  "desc",
  "between",
  "like",
  "ilike",
  "exists",
  "over",
  "partition",
  "true",
  "false",
  "interval",
  "cast",
] as const;

export const SQL_FUNCTIONS = [
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "coalesce",
  "date_trunc",
  "extract",
  "now",
  "lower",
  "upper",
  "round",
  "floor",
  "ceil",
  "abs",
  "length",
  "substring",
  "row_number",
  "rank",
] as const;

export const PROMQL_FUNCTIONS = [
  "rate",
  "irate",
  "increase",
  "delta",
  "idelta",
  "deriv",
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "stddev",
  "topk",
  "bottomk",
  "quantile",
  "histogram_quantile",
  "avg_over_time",
  "max_over_time",
  "min_over_time",
  "sum_over_time",
  "count_over_time",
  "quantile_over_time",
  "abs",
  "absent",
  "ceil",
  "floor",
  "round",
  "clamp_min",
  "clamp_max",
  "label_replace",
  "label_join",
  "time",
  "vector",
  "scalar",
  "sort",
  "sort_desc",
] as const;

export const PROMQL_KEYWORDS = [
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "offset",
  "bool",
  "and",
  "or",
  "unless",
] as const;

/** Cypher clauses and operators (Neo4j, Memgraph); compared without case, as Cypher does. */
export const CYPHER_KEYWORDS = [
  "match",
  "optional",
  "where",
  "return",
  "with",
  "unwind",
  "order",
  "by",
  "skip",
  "limit",
  "as",
  "distinct",
  "and",
  "or",
  "xor",
  "not",
  "in",
  "is",
  "null",
  "true",
  "false",
  "case",
  "when",
  "then",
  "else",
  "end",
  "call",
  "yield",
  "union",
  "all",
  "asc",
  "desc",
  "starts",
  "ends",
  "contains",
  "exists",
] as const;

export const CYPHER_FUNCTIONS = [
  "count",
  "collect",
  "sum",
  "avg",
  "min",
  "max",
  "size",
  "length",
  "nodes",
  "relationships",
  "labels",
  "type",
  "id",
  "elementId",
  "properties",
  "keys",
  "coalesce",
  "toInteger",
  "toFloat",
  "toString",
  "toLower",
  "toUpper",
  "trim",
  "split",
  "substring",
  "replace",
  "startNode",
  "endNode",
  "head",
  "last",
  "range",
  "abs",
  "round",
  "date",
  "datetime",
  "duration",
  "timestamp",
  "shortestPath",
  "allShortestPaths",
] as const;

const SQL_KEYWORD_SET = new Set<string>(SQL_KEYWORDS);
const SQL_FUNCTION_SET = new Set<string>(SQL_FUNCTIONS);
const PROMQL_FUNCTION_SET = new Set<string>(PROMQL_FUNCTIONS);
const PROMQL_KEYWORD_SET = new Set<string>(PROMQL_KEYWORDS);
const CYPHER_KEYWORD_SET = new Set<string>(CYPHER_KEYWORDS);
const CYPHER_FUNCTION_SET = new Set<string>(CYPHER_FUNCTIONS.map((f) => f.toLowerCase()));

interface Rule {
  kind: TokenKind;
  pattern: RegExp;
}

// Sticky patterns, tried in order at the current position.
const SQL_RULES: Rule[] = [
  { kind: "comment", pattern: /--[^\n]*/y },
  { kind: "comment", pattern: /\/\*[\s\S]*?(\*\/|$)/y },
  { kind: "string", pattern: /'(?:[^']|'')*'?/y },
  { kind: "plain", pattern: /"(?:[^"]|"")*"?/y },
  { kind: "plain", pattern: /\[[^\]\n]*\]?/y },
  { kind: "macro", pattern: /\$__\w+|\$\{?\w+\}?/y },
  { kind: "number", pattern: /\d+(\.\d+)?([eE][+-]?\d+)?\b/y },
  { kind: "plain", pattern: /[A-Za-z_][\w$]*/y },
  { kind: "operator", pattern: /[<>=!]=?|[-+*/%,;().|]/y },
  { kind: "plain", pattern: /\s+/y },
];

const PROMQL_RULES: Rule[] = [
  { kind: "comment", pattern: /#[^\n]*/y },
  { kind: "string", pattern: /"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`[^`]*`?/y },
  { kind: "duration", pattern: /\d+(ms|[smhdwy])(\d+(ms|[smhdwy]))*\b/y },
  { kind: "number", pattern: /\d+(\.\d+)?([eE][+-]?\d+)?\b/y },
  { kind: "macro", pattern: /\$__\w+|\$\{?\w+\}?/y },
  { kind: "plain", pattern: /[A-Za-z_:][\w:]*/y },
  { kind: "operator", pattern: /=~|!~|[<>=!]=?|[-+*/%^,(){}[\]]/y },
  { kind: "plain", pattern: /\s+/y },
];

// A label or edge type follows a colon (`(c:Customer)`, `[:BOUGHT]`); parameters start with $.
const CYPHER_RULES: Rule[] = [
  { kind: "comment", pattern: /\/\/[^\n]*/y },
  { kind: "comment", pattern: /\/\*[\s\S]*?(\*\/|$)/y },
  { kind: "string", pattern: /'(?:[^'\\]|\\.)*'?|"(?:[^"\\]|\\.)*"?/y },
  { kind: "label", pattern: /:\s*(?:[A-Za-z_]\w*|`[^`]*`?)/y },
  { kind: "plain", pattern: /`[^`]*`?/y },
  { kind: "macro", pattern: /\$\{?\w+\}?/y },
  { kind: "number", pattern: /\d+(\.\d+)?([eE][+-]?\d+)?\b/y },
  { kind: "plain", pattern: /[A-Za-z_][\w]*/y },
  { kind: "operator", pattern: /=~|<>|[<>=!]=?|<?-+>?|[-+*/%^,;().|{}[\]:]/y },
  { kind: "plain", pattern: /\s+/y },
];

function tokenize(
  text: string,
  rules: Rule[],
  classify: (word: string, rest: string) => TokenKind,
) {
  const tokens: Token[] = [];
  let index = 0;
  const push = (kind: TokenKind, value: string) => {
    const last = tokens.at(-1);
    if (last !== undefined && last.kind === kind) {
      last.text += value;
    } else {
      tokens.push({ kind, text: value });
    }
  };
  while (index < text.length) {
    let matched = false;
    for (const rule of rules) {
      rule.pattern.lastIndex = index;
      const match = rule.pattern.exec(text);
      if (match !== null && match[0] !== "") {
        const value = match[0];
        const isWord = rule.kind === "plain" && /^[A-Za-z_:]/.test(value);
        push(isWord ? classify(value, text.slice(index + value.length)) : rule.kind, value);
        index += value.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      push("plain", text.charAt(index));
      index++;
    }
  }
  return tokens;
}

export function tokenizeSql(text: string): Token[] {
  return tokenize(text, SQL_RULES, (word, rest) => {
    const lower = word.toLowerCase();
    if (SQL_KEYWORD_SET.has(lower)) {
      return "keyword";
    }
    return SQL_FUNCTION_SET.has(lower) && /^\s*\(/.test(rest) ? "function" : "plain";
  });
}

export function tokenizePromql(text: string): Token[] {
  return tokenize(text, PROMQL_RULES, (word, rest) => {
    if (PROMQL_KEYWORD_SET.has(word)) {
      return "keyword";
    }
    if (PROMQL_FUNCTION_SET.has(word) && /^\s*\(/.test(rest)) {
      return "function";
    }
    // A label name inside a matcher: followed by an operator such as = or =~.
    return /^\s*(=~|!~|!=|=)/.test(rest) ? "label" : "plain";
  });
}

export function tokenizeCypher(text: string): Token[] {
  return tokenize(text, CYPHER_RULES, (word, rest) => {
    const lower = word.toLowerCase();
    if (CYPHER_FUNCTION_SET.has(lower) && /^\s*\(/.test(rest)) {
      return "function";
    }
    return CYPHER_KEYWORD_SET.has(lower) ? "keyword" : "plain";
  });
}

/** GSQL clauses (TigerGraph), compared without case. */
export const GSQL_KEYWORDS = [
  "interpret",
  "create",
  "query",
  "for",
  "graph",
  "select",
  "from",
  "where",
  "accum",
  "post-accum",
  "having",
  "order",
  "by",
  "limit",
  "print",
  "if",
  "then",
  "else",
  "end",
  "while",
  "foreach",
  "in",
  "do",
  "case",
  "when",
  "return",
  "and",
  "or",
  "not",
  "true",
  "false",
  "int",
  "uint",
  "float",
  "double",
  "bool",
  "string",
  "datetime",
  "vertex",
  "edge",
  "set",
  "bag",
  "list",
] as const;

const GSQL_KEYWORD_SET = new Set<string>(GSQL_KEYWORDS);

const GSQL_RULES: Rule[] = [
  { kind: "comment", pattern: /\/\/[^\n]*|#[^\n]*/y },
  { kind: "comment", pattern: /\/\*[\s\S]*?(\*\/|$)/y },
  { kind: "string", pattern: /"(?:[^"\\]|\\.)*"?/y },
  { kind: "macro", pattern: /@@?\w+/y },
  { kind: "number", pattern: /\d+(\.\d+)?([eE][+-]?\d+)?\b/y },
  { kind: "plain", pattern: /[A-Za-z_][\w-]*/y },
  { kind: "operator", pattern: /[<>=!]=?|[-+*/%,;().:{}[\]]/y },
  { kind: "plain", pattern: /\s+/y },
];

export function tokenizeGsql(text: string): Token[] {
  return tokenize(text, GSQL_RULES, (word) =>
    GSQL_KEYWORD_SET.has(word.toLowerCase()) ? "keyword" : "plain",
  );
}
