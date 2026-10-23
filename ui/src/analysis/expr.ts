import type { Field } from "../api/generated/shapes";

/**
 * The expression language of calculated fields (docs/api/settings-dashboards.md, "Analysis steps"), the same as the server's
 * `server/src/analysis/expr.rs`: parsed into a tree and type-checked against the frame's fields,
 * never evaluated as code. Both engines pass the cases of `server/src/analysis/conformance.json`.
 *
 * Positions count characters (code points), as the server does. Calendar functions use UTC.
 */

export const MAX_CHARS = 2000;
export const MAX_DEPTH = 64;
/** Highest tree an expression may build (chains inside parentheses grow it past `MAX_DEPTH`). */
export const MAX_HEIGHT = 128;
/** Longest text an expression may make, in UTF-16 units (Excel's limit for a cell). */
export const MAX_TEXT_UNITS = 32_767;
const MAX_ARGS = 100;
export const MIN_TIME_MS = -62_135_596_800_000;
export const MAX_TIME_MS = 253_402_300_799_999;
export const DAY_MS = 86_400_000;

/** A stable reason with its params, as the server sends them; `message` is English. */
export interface Detail {
  reason: string;
  params: Record<string, string>;
  message: string;
}

export class DetailError extends Error {
  readonly detail: Detail;
  constructor(detail: Detail) {
    super(detail.message);
    this.detail = detail;
  }
}

export function detail(
  reason: string,
  message: string,
  params: Record<string, string | number> = {},
): DetailError {
  return new DetailError({
    reason,
    message,
    params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
}

export type Type = "number" | "text" | "bool" | "time" | "null";

// ---- tokens ----

type Tok =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "field"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string }
  | { kind: "end" };

interface Token {
  tok: Tok;
  at: number;
}

const OPERATORS = [
  "==",
  "!=",
  "<>",
  "<=",
  ">=",
  "&&",
  "||",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "(",
  ")",
  ",",
  "=",
  "<",
  ">",
  "!",
];

const ALPHABETIC = /^\p{Alphabetic}$/u;
const WHITE_SPACE = /^\p{White_Space}$/u;
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isIdentStart = (c: string) => ALPHABETIC.test(c) || c === "_";
const isIdentChar = (c: string | undefined) =>
  c !== undefined && (ALPHABETIC.test(c) || isDigit(c) || c === "_" || c === ".");

const syntax = (at: number) => detail("expression.syntax", `unexpected input at ${at}`, { at });
const unclosed = (at: number) =>
  detail("expression.unclosed", `what starts at ${at} is not closed`, { at });

function lex(chars: string[]): Token[] {
  // The server reads only well-formed text; a lone surrogate, anywhere, cannot reach it.
  chars.forEach((c, k) => {
    if (c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff) {
      throw syntax(k + 1);
    }
  });
  const out: Token[] = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i] as string;
    const at = i + 1;
    if (WHITE_SPACE.test(c)) {
      i++;
      continue;
    }
    if (isDigit(c)) {
      const start = i;
      while (isDigit(chars[i])) i++;
      if (chars[i] === ".") {
        i++;
        const digits = i;
        while (isDigit(chars[i])) i++;
        if (i === digits) throw syntax(i + 1);
      }
      if (chars[i] === "e" || chars[i] === "E") {
        let j = i + 1;
        if (chars[j] === "+" || chars[j] === "-") j++;
        const digits = j;
        while (isDigit(chars[j])) j++;
        if (j === digits) throw syntax(j + 1);
        i = j;
      }
      if (isIdentChar(chars[i])) throw syntax(i + 1);
      const value = Number(chars.slice(start, i).join(""));
      if (!Number.isFinite(value)) {
        throw detail("expression.number", `the number at ${at} is too large`, { at });
      }
      out.push({ tok: { kind: "num", value }, at });
      continue;
    }
    if (c === '"' || c === "'") {
      let text = "";
      i++;
      for (;;) {
        const d = chars[i];
        if (d === undefined) throw unclosed(at);
        i++;
        if (d === c) break;
        if (d === "\\") {
          const e = chars[i];
          if (e === undefined) throw unclosed(at);
          i++;
          if (e === "n") text += "\n";
          else if (e === "t") text += "\t";
          else if (e === "\\" || e === "'" || e === '"') text += e;
          else throw syntax(i);
        } else {
          text += d;
        }
      }
      out.push({ tok: { kind: "str", value: text }, at });
      continue;
    }
    if (c === "[") {
      let name = "";
      i++;
      for (;;) {
        const d = chars[i];
        if (d === undefined) throw unclosed(at);
        i++;
        if (d === "]") {
          if (chars[i] === "]") {
            name += "]";
            i++;
            continue;
          }
          break;
        }
        name += d;
      }
      if (name === "") throw syntax(at);
      out.push({ tok: { kind: "field", value: name }, at });
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (isIdentChar(chars[i])) i++;
      out.push({ tok: { kind: "ident", value: chars.slice(start, i).join("") }, at });
      continue;
    }
    const op = OPERATORS.find((o) => [...o].every((ch, k) => chars[i + k] === ch));
    if (op === undefined) throw syntax(at);
    out.push({ tok: { kind: "op", value: op }, at });
    i += op.length;
  }
  out.push({ tok: { kind: "end" }, at: chars.length + 1 });
  return out;
}

// ---- syntax tree ----

export type BinOp =
  | "or"
  | "and"
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "^";

export type Unit = "minute" | "hour" | "day" | "week" | "month" | "quarter" | "year";
const UNITS: readonly Unit[] = ["minute", "hour", "day", "week", "month", "quarter", "year"];

/** Name (lower case), fewest and most arguments (null: no upper bound). */
export const FUNCTIONS: readonly (readonly [string, number, number | null])[] = [
  ["if", 3, 3],
  ["coalesce", 1, null],
  ["isnull", 1, 1],
  ["round", 1, 2],
  ["floor", 1, 1],
  ["ceil", 1, 1],
  ["abs", 1, 1],
  ["sqrt", 1, 1],
  ["exp", 1, 1],
  ["ln", 1, 1],
  ["log10", 1, 1],
  ["pow", 2, 2],
  ["min", 2, null],
  ["max", 2, null],
  ["year", 1, 1],
  ["month", 1, 1],
  ["day", 1, 1],
  ["hour", 1, 1],
  ["minute", 1, 1],
  ["second", 1, 1],
  ["weekday", 1, 1],
  ["startof", 2, 2],
  ["concat", 1, null],
  ["text", 1, 1],
  ["number", 1, 1],
  ["lower", 1, 1],
  ["upper", 1, 1],
  ["length", 1, 1],
  ["contains", 2, 2],
];

export type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "field"; name: string; at: number }
  | { kind: "neg"; inner: Expr; height: number }
  | { kind: "not"; inner: Expr; height: number }
  | { kind: "bin"; op: BinOp; left: Expr; right: Expr; height: number }
  | { kind: "call"; name: string; args: Expr[]; unit: Unit | null; height: number };

/** The height of the tree: 1 for a leaf. Known from building it, without walking it. */
export function height(e: Expr): number {
  return "height" in e ? e.height : 1;
}

/**
 * A node's height from its children's, refused above `MAX_HEIGHT` (as the server): nested
 * parentheses around operator chains build trees far deeper than the parser's own nesting.
 */
function grown(children: readonly Expr[]): number {
  const h = 1 + children.reduce((m, c) => Math.max(m, height(c)), 0);
  if (h > MAX_HEIGHT) {
    throw detail("expression.too_deep", `the expression nests deeper than ${MAX_HEIGHT} levels`, {
      max: MAX_HEIGHT,
    });
  }
  return h;
}

function bin(op: BinOp, left: Expr, right: Expr): Expr {
  return { kind: "bin", op, left, right, height: grown([left, right]) };
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

function argumentsError(name: string, min: number, max: number | null): DetailError {
  if (max === min) {
    return detail("expression.arguments_exact", `${name} takes ${min} values`, {
      name,
      count: min,
    });
  }
  if (max !== null) {
    return detail("expression.arguments_range", `${name} takes ${min} to ${max} values`, {
      name,
      min,
      max,
    });
  }
  return detail("expression.arguments_min", `${name} takes at least ${min} values`, {
    name,
    min,
  });
}

const COMPARISONS: Record<string, BinOp> = {
  "=": "=",
  "==": "=",
  "!=": "!=",
  "<>": "!=",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(): Token {
    return this.tokens[Math.min(this.pos, this.tokens.length - 1)] as Token;
  }

  next(): Token {
    const t = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  isOp(op: string): boolean {
    const t = this.peek().tok;
    return t.kind === "op" && t.value === op;
  }

  isWord(word: string): boolean {
    const t = this.peek().tok;
    return t.kind === "ident" && asciiLower(t.value) === word;
  }

  enter(): void {
    this.depth++;
    if (this.depth > MAX_DEPTH) {
      throw detail("expression.too_deep", `the expression nests deeper than ${MAX_DEPTH} levels`, {
        max: MAX_DEPTH,
      });
    }
  }

  nested(f: () => Expr): Expr {
    this.enter();
    const e = f();
    this.depth--;
    return e;
  }

  expr(): Expr {
    return this.nested(() => this.or());
  }

  or(): Expr {
    let left = this.and();
    const mark = this.depth;
    while (this.isWord("or") || this.isOp("||")) {
      this.next();
      this.enter();
      left = bin("or", left, this.and());
    }
    this.depth = mark;
    return left;
  }

  and(): Expr {
    let left = this.not();
    const mark = this.depth;
    while (this.isWord("and") || this.isOp("&&")) {
      this.next();
      this.enter();
      left = bin("and", left, this.not());
    }
    this.depth = mark;
    return left;
  }

  not(): Expr {
    if (this.isWord("not") || this.isOp("!")) {
      this.next();
      const inner = this.nested(() => this.not());
      return { kind: "not", inner, height: grown([inner]) };
    }
    return this.comparison();
  }

  comparison(): Expr {
    const left = this.additive();
    const t = this.peek().tok;
    const op = t.kind === "op" ? COMPARISONS[t.value] : undefined;
    if (op === undefined) return left;
    this.next();
    const right = this.nested(() => this.additive());
    const after = this.peek().tok;
    if (after.kind === "op" && COMPARISONS[after.value] !== undefined) {
      throw syntax(this.peek().at);
    }
    return bin(op, left, right);
  }

  additive(): Expr {
    let left = this.multiplicative();
    const mark = this.depth;
    for (;;) {
      const op = this.isOp("+") ? "+" : this.isOp("-") ? "-" : null;
      if (op === null) break;
      this.next();
      this.enter();
      left = bin(op, left, this.multiplicative());
    }
    this.depth = mark;
    return left;
  }

  multiplicative(): Expr {
    let left = this.unary();
    const mark = this.depth;
    for (;;) {
      const op = this.isOp("*") ? "*" : this.isOp("/") ? "/" : this.isOp("%") ? "%" : null;
      if (op === null) break;
      this.next();
      this.enter();
      left = bin(op, left, this.unary());
    }
    this.depth = mark;
    return left;
  }

  unary(): Expr {
    if (this.isOp("-")) {
      this.next();
      const inner = this.nested(() => this.unary());
      return { kind: "neg", inner, height: grown([inner]) };
    }
    return this.power();
  }

  power(): Expr {
    const base = this.primary();
    if (this.isOp("^")) {
      this.next();
      return bin(
        "^",
        base,
        this.nested(() => this.unary()),
      );
    }
    return base;
  }

  primary(): Expr {
    const token = this.next();
    const t = token.tok;
    switch (t.kind) {
      case "num":
        return { kind: "num", value: t.value };
      case "str":
        return { kind: "str", value: t.value };
      case "field":
        return { kind: "field", name: t.value, at: token.at };
      case "op": {
        if (t.value !== "(") throw syntax(token.at);
        const inner = this.expr();
        if (!this.isOp(")")) {
          throw this.peek().tok.kind === "end" ? unclosed(token.at) : syntax(this.peek().at);
        }
        this.next();
        return inner;
      }
      case "ident": {
        if (this.isOp("(")) return this.call(t.value);
        const word = asciiLower(t.value);
        if (word === "true") return { kind: "bool", value: true };
        if (word === "false") return { kind: "bool", value: false };
        if (word === "null") return { kind: "null" };
        if (word === "and" || word === "or" || word === "not") throw syntax(token.at);
        return { kind: "field", name: t.value, at: token.at };
      }
      case "end":
        throw this.tokens.length === 1
          ? detail("expression.empty", "the expression is empty")
          : syntax(token.at);
    }
  }

  call(word: string): Expr {
    const lower = word.toLowerCase();
    const entry = FUNCTIONS.find((f) => f[0] === lower);
    if (entry === undefined) {
      throw detail("expression.unknown_function", `there is no function ${word}`, { name: word });
    }
    const [name, min, max] = entry;
    const open = this.next().at;
    const args: Expr[] = [];
    if (!this.isOp(")")) {
      for (;;) {
        args.push(this.expr());
        if (args.length > MAX_ARGS) throw argumentsError(name, min, MAX_ARGS);
        if (this.isOp(",")) {
          this.next();
          continue;
        }
        break;
      }
    }
    if (!this.isOp(")")) {
      throw this.peek().tok.kind === "end" ? unclosed(open) : syntax(this.peek().at);
    }
    this.next();
    if (args.length < min || (max !== null && args.length > max)) {
      throw argumentsError(name, min, max);
    }
    let unit: Unit | null = null;
    if (name === "startof") {
      const arg = args[1];
      unit =
        arg?.kind === "str" ? (UNITS.find((u) => u === arg.value.toLowerCase()) ?? null) : null;
      if (unit === null) {
        throw detail(
          "expression.unit",
          "startOf takes a unit in quotes: minute, hour, day, week, month, quarter or year",
        );
      }
    }
    return { kind: "call", name, args, unit, height: grown(args) };
  }
}

/** Parses an expression; the syntax only, field names are checked against a frame later. */
export function parse(text: string): Expr {
  const chars = Array.from(text);
  if (chars.length > MAX_CHARS) {
    throw detail("expression.too_long", `the expression has more than ${MAX_CHARS} characters`, {
      max: MAX_CHARS,
    });
  }
  const parser = new Parser(lex(chars));
  const expr = parser.expr();
  if (parser.peek().tok.kind !== "end") throw syntax(parser.peek().at);
  return expr;
}

// ---- values and helpers shared with the steps ----

/** A number, or empty when it is not finite. */
export const num = (x: number): number | null => (Number.isFinite(x) ? x : null);

/** A time, or empty outside the years 1 to 9999. */
export function time(ms: number): number | null {
  if (!Number.isFinite(ms)) return null;
  const f = Math.floor(ms);
  return f >= MIN_TIME_MS && f <= MAX_TIME_MS ? ms : null;
}

const POW10 = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15];

function roundHalfAway(x: number): number {
  let r = Math.floor(Math.abs(x));
  if (Math.abs(x) - r >= 0.5) r += 1;
  return x < 0 ? -r : r;
}

const remEuclid = (a: number, b: number) => {
  const r = a % b;
  return r < 0 ? r + Math.abs(b) : r;
};
const floorDiv = (a: number, b: number) => Math.floor(a / b);

/** Compares text by code points, as the server does (not by UTF-16 units). */
export function compareText(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(j) as number;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}

/** A number as JavaScript writes it; the server writes the same digits. */
export function numberText(x: number): string {
  if (!Number.isFinite(x)) return "";
  return x === 0 ? "0" : String(x);
}

const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** A number written in text (sign, digits, fraction, exponent; spaces around it allowed). */
export function parseNumber(text: string): number | null {
  const s = text.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  if (!PLAIN_NUMBER.test(s)) return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
}

export interface Civil {
  year: number;
  month: number;
  day: number;
}

/** Days since 1970-01-01 to a date (Howard Hinnant's algorithm), as the server computes it. */
export function civilFromDays(days: number): Civil {
  const z = days + 719_468;
  const era = floorDiv(z, 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day };
}

export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = floorDiv(y, 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

const civilOf = (ms: number) => civilFromDays(Math.floor(ms / DAY_MS));

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** ISO weekday of a day number: 1 Monday to 7 Sunday. */
export const weekday = (days: number) => remEuclid(days + 3, 7) + 1;

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Unix ms as `2026-10-21T08:15:00.000Z`. */
export function isoTime(ms: number): string {
  const c = civilOf(ms);
  const inDay = remEuclid(ms, DAY_MS);
  return `${pad(c.year, 4)}-${pad(c.month, 2)}-${pad(c.day, 2)}T${pad(Math.floor(inDay / 3_600_000), 2)}:${pad(
    Math.floor((inDay % 3_600_000) / 60_000),
    2,
  )}:${pad(Math.floor((inDay % 60_000) / 1000), 2)}.${pad(inDay % 1000, 3)}Z`;
}

function startOf(t: number, unit: Unit): number {
  const floorTo = (step: number) => Math.floor(t / step) * step;
  switch (unit) {
    case "minute":
      return floorTo(60_000);
    case "hour":
      return floorTo(3_600_000);
    case "day":
      return floorTo(DAY_MS);
    case "week": {
      const days = Math.floor(t / DAY_MS);
      return (days - (weekday(days) - 1)) * DAY_MS;
    }
    default: {
      const c = civilOf(t);
      const month =
        unit === "month" ? c.month : unit === "quarter" ? Math.floor((c.month - 1) / 3) * 3 + 1 : 1;
      return daysFromCivil(c.year, month, 1) * DAY_MS;
    }
  }
}

/** Moves a time by whole calendar months in UTC; a missing day becomes the month's last. */
export function addMonths(t: number, months: number): number {
  const days = Math.floor(t / DAY_MS);
  const inDay = t - days * DAY_MS;
  const c = civilFromDays(days);
  const index = c.year * 12 + (c.month - 1) + months;
  const year = floorDiv(index, 12);
  const month = remEuclid(index, 12) + 1;
  const day = Math.min(c.day, daysInMonth(year, month));
  return daysFromCivil(year, month, day) * DAY_MS + inDay;
}

/** A value of a type as text: numbers as JavaScript writes them, times as ISO 8601 in UTC. */
function textOf(type: Type, v: unknown): string | null {
  if (v === null) return null;
  switch (type) {
    case "number":
      return numberText(v as number);
    case "time":
      return isoTime(Math.floor(v as number));
    case "bool":
      return v ? "true" : "false";
    default:
      return v as string;
  }
}

// ---- type check and compile ----

/** Computes one row; values are numbers, text, booleans, times (ms) or null by `result`. */
type Fn = (row: number) => unknown;

export interface Compiled {
  result: Type;
  eval: Fn;
}

const FIELD_TYPES: Record<string, Type | undefined> = {
  number: "number",
  int64: "number",
  time: "time",
  string: "text",
  bool: "bool",
};

/** Exactly one field of the frame must have the name. */
export function findField(fields: readonly Field[], name: string): number {
  let found = -1;
  for (let i = 0; i < fields.length; i++) {
    if (fields[i]?.name !== name) continue;
    if (found >= 0) {
      throw detail("expression.ambiguous_field", `several fields are named ${name}`, {
        field: name,
      });
    }
    found = i;
  }
  if (found < 0) {
    throw detail("expression.unknown_field", `there is no field ${name}`, { field: name });
  }
  return found;
}

function unify(a: Type, b: Type): Type | null {
  if (a === "null") return b;
  if (b === "null") return a;
  return a === b ? a : null;
}

const SYMBOL: Record<BinOp, string> = {
  or: "or",
  and: "and",
  "=": "=",
  "!=": "!=",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "%": "%",
  "^": "^",
};

const operands = (op: BinOp | "-" | "not", l: Type, r: Type) =>
  detail(
    "expression.operand_types",
    `${op in SYMBOL ? SYMBOL[op as BinOp] : op} cannot combine ${l} and ${r}`,
    { operator: op in SYMBOL ? SYMBOL[op as BinOp] : op, left: l, right: r },
  );

const mixed = (name: string, a: Type, b: Type) =>
  detail("expression.mixed_types", `${name} mixes ${a} and ${b}`, { name, first: a, second: b });

/** A numeric cell: JSON numbers, and int64 digits. */
function readNumber(v: unknown): number | null {
  if (typeof v === "number") return num(v);
  if (typeof v === "string") return parseNumber(v);
  return null;
}

/** Type-checks `expr` against the fields of a frame and compiles it to a row function. */
/** Set when a text result went past `MAX_TEXT_UNITS` during one evaluation. */
let tooLong = false;

/** Text within the limit, else empty and the evaluation is marked as failed. */
function capped(text: string): string | null {
  if (text.length > MAX_TEXT_UNITS) {
    tooLong = true;
    return null;
  }
  return text;
}

export const textTooLong = () =>
  detail(
    "expression.text_too_long",
    `the expression makes text longer than ${MAX_TEXT_UNITS} characters`,
    { max: MAX_TEXT_UNITS },
  );

/** Compiles; `eval` throws `expression.text_too_long` for a row whose text grows too long. */
export function compile(expr: Expr, fields: readonly Field[]): Compiled {
  const [fn, result] = check(expr, fields);
  if (result === "null") throw detail("expression.no_type", "the expression is always empty");
  return {
    result,
    eval: (row) => {
      tooLong = false;
      const v = fn(row);
      const over = tooLong;
      tooLong = false;
      if (over || (typeof v === "string" && v.length > MAX_TEXT_UNITS)) throw textTooLong();
      return v;
    },
  };
}

function check(expr: Expr, fields: readonly Field[]): [Fn, Type] {
  switch (expr.kind) {
    case "num":
      return [() => expr.value, "number"];
    case "str":
      return [() => expr.value, "text"];
    case "bool":
      return [() => expr.value, "bool"];
    case "null":
      return [() => null, "null"];
    case "field": {
      const index = findField(fields, expr.name);
      const field = fields[index] as Field;
      const type = FIELD_TYPES[field.type];
      if (type === undefined) {
        throw detail(
          "expression.field_type",
          `field ${expr.name} holds JSON, which has no type here`,
          { field: expr.name, type: "json" },
        );
      }
      const values = field.values;
      switch (field.type) {
        case "number":
          return [(r) => (typeof values[r] === "number" ? num(values[r] as number) : null), type];
        case "int64":
          return [(r) => readNumber(values[r]), type];
        case "time":
          return [(r) => (typeof values[r] === "number" ? time(values[r] as number) : null), type];
        case "string":
          return [(r) => (typeof values[r] === "string" ? values[r] : null), type];
        default:
          return [(r) => (typeof values[r] === "boolean" ? values[r] : null), type];
      }
    }
    case "neg": {
      const [f, t] = check(expr.inner, fields);
      if (t !== "number" && t !== "null") throw operands("-", t, t);
      return [
        (r) => {
          const v = f(r);
          return v === null ? null : num(-(v as number));
        },
        "number",
      ];
    }
    case "not": {
      const [f, t] = check(expr.inner, fields);
      if (t !== "bool" && t !== "null") throw operands("not", t, t);
      return [
        (r) => {
          const v = f(r);
          return v === null ? null : !v;
        },
        "bool",
      ];
    }
    case "bin":
      return binary(expr.op, expr.left, expr.right, fields);
    case "call":
      return call(expr.name, expr.unit, expr.args, fields);
  }
}

type Kind = "number" | "text" | "bool" | "time" | "timeDiff" | "timeShift";

function binTypes(op: BinOp, l: Type, r: Type, left: Expr, right: Expr): [Kind, Type] {
  const both = unify(l, r);
  switch (op) {
    case "or":
    case "and":
      if (both === "bool" || both === "null") return ["bool", "bool"];
      throw operands(op, l, r);
    case "=":
    case "!=":
    case "<":
    case "<=":
    case ">":
    case ">=": {
      if (left.kind === "null" || right.kind === "null") {
        throw detail(
          "expression.null_compare",
          "a comparison with null is always empty; use isnull(...)",
        );
      }
      const ordered = op !== "=" && op !== "!=";
      if (both === "number" || both === "null") return ["number", "bool"];
      if (both === "text") return ["text", "bool"];
      if (both === "time") return ["time", "bool"];
      if (both === "bool" && !ordered) return ["bool", "bool"];
      throw operands(op, l, r);
    }
    case "+":
      if (
        (l === "time" && (r === "number" || r === "null")) ||
        ((l === "number" || l === "null") && r === "time")
      ) {
        return ["timeShift", "time"];
      }
      if (both === "number" || both === "null") return ["number", "number"];
      if (both === "text") return ["text", "text"];
      throw operands(op, l, r);
    case "-":
      if (l === "time" && r === "time") return ["timeDiff", "number"];
      if (l === "time" && (r === "number" || r === "null")) return ["timeShift", "time"];
      if (l === "null" && r === "time") return ["timeDiff", "number"];
      if (both === "number" || both === "null") return ["number", "number"];
      throw operands(op, l, r);
    default:
      if (both === "number" || both === "null") return ["number", "number"];
      throw operands(op, l, r);
  }
}

function compareValues(kind: Kind, a: unknown, b: unknown): number {
  if (kind === "text") return compareText(a as string, b as string);
  if (kind === "bool") return Number(a) - Number(b);
  const x = a as number;
  const y = b as number;
  return x < y ? -1 : x > y ? 1 : 0;
}

function binary(op: BinOp, left: Expr, right: Expr, fields: readonly Field[]): [Fn, Type] {
  const [lf, lt] = check(left, fields);
  const [rf, rt] = check(right, fields);
  const [kind, result] = binTypes(op, lt, rt, left, right);
  if (op === "and" || op === "or") {
    const stop = op === "or";
    return [
      (row) => {
        const a = lf(row);
        if (a === stop) return stop;
        const b = rf(row);
        if (b === stop) return stop;
        return a === null || b === null ? null : b;
      },
      result,
    ];
  }
  const compute = (a: unknown, b: unknown): unknown => {
    switch (op) {
      case "=":
        return compareValues(kind, a, b) === 0;
      case "!=":
        return compareValues(kind, a, b) !== 0;
      case "<":
        return compareValues(kind, a, b) < 0;
      case "<=":
        return compareValues(kind, a, b) <= 0;
      case ">":
        return compareValues(kind, a, b) > 0;
      case ">=":
        return compareValues(kind, a, b) >= 0;
      default:
        break;
    }
    if (kind === "text") {
      const x = a as string;
      const y = b as string;
      if (x.length + y.length > MAX_TEXT_UNITS) {
        tooLong = true;
        return null;
      }
      return x + y;
    }
    if (kind === "timeDiff") return num((a as number) - (b as number));
    if (kind === "timeShift") {
      const [t, n] = lt === "time" ? [a as number, b as number] : [b as number, a as number];
      return time(op === "-" ? t - n : t + n);
    }
    const x = a as number;
    const y = b as number;
    switch (op) {
      case "+":
        return num(x + y);
      case "-":
        return num(x - y);
      case "*":
        return num(x * y);
      case "/":
        return y === 0 ? null : num(x / y);
      case "%":
        return y === 0 ? null : num(x % y);
      default:
        return num(x ** y);
    }
  };
  return [
    (row) => {
      const a = lf(row);
      const b = rf(row);
      return a === null || b === null ? null : compute(a, b);
    },
    result,
  ];
}

function argumentType(name: string, position: number, expected: string, found: Type) {
  return detail(
    "expression.argument_type",
    `value ${position} of ${name} must be ${expected}, not ${found}`,
    { name, position, expected, found },
  );
}

function call(name: string, unit: Unit | null, args: Expr[], fields: readonly Field[]): [Fn, Type] {
  const checked = args.map((a) => check(a, fields));
  const fns = checked.map((c) => c[0]);
  const types = checked.map((c) => c[1]);
  const want = (i: number, allowed: Type[], expected: string) => {
    const t = types[i] as Type;
    if (t !== "null" && !allowed.includes(t)) throw argumentType(name, i + 1, expected, t);
  };
  const f0 = fns[0] as Fn;
  const f1 = fns[1] as Fn;
  const math = (f: (x: number) => number | null): [Fn, Type] => {
    want(0, ["number"], "number");
    return [
      (r) => {
        const x = f0(r);
        return x === null ? null : f(x as number);
      },
      "number",
    ];
  };
  const calendar = (f: (t: number) => number): [Fn, Type] => {
    want(0, ["time"], "time");
    return [
      (r) => {
        const t = f0(r);
        return t === null ? null : num(f(Math.floor(t as number)));
      },
      "number",
    ];
  };
  switch (name) {
    case "if": {
      want(0, ["bool"], "bool");
      const t = unify(types[1] as Type, types[2] as Type);
      if (t === null) throw mixed(name, types[1] as Type, types[2] as Type);
      const f2 = fns[2] as Fn;
      return [(r) => (f0(r) === true ? f1(r) : f2(r)), t];
    }
    case "coalesce": {
      let t: Type = "null";
      for (const a of types) {
        const u = unify(t, a);
        if (u === null) throw mixed(name, t, a);
        t = u;
      }
      return [
        (r) => {
          for (const f of fns) {
            const v = f(r);
            if (v !== null) return v;
          }
          return null;
        },
        t,
      ];
    }
    case "isnull":
      return [(r) => f0(r) === null, "bool"];
    case "round": {
      want(0, ["number"], "number");
      if (types.length === 2) want(1, ["number"], "number");
      return [
        (r) => {
          const x = f0(r);
          if (x === null) return null;
          let digits = 0;
          if (fns.length === 2) {
            const d = f1(r);
            if (d === null) return null;
            digits = Math.min(Math.max(Math.trunc(d as number), 0), 15);
          }
          const factor = POW10[digits] as number;
          return num(roundHalfAway((x as number) * factor) / factor);
        },
        "number",
      ];
    }
    case "floor":
      return math((x) => num(Math.floor(x)));
    case "ceil":
      return math((x) => num(Math.ceil(x)));
    case "abs":
      return math((x) => num(Math.abs(x)));
    case "sqrt":
      return math((x) => (x < 0 ? null : num(Math.sqrt(x))));
    case "exp":
      return math((x) => num(Math.exp(x)));
    case "ln":
      return math((x) => (x <= 0 ? null : num(Math.log(x))));
    case "log10":
      return math((x) => (x <= 0 ? null : num(Math.log10(x))));
    case "pow":
      want(0, ["number"], "number");
      want(1, ["number"], "number");
      return [
        (r) => {
          const x = f0(r);
          const y = f1(r);
          return x === null || y === null ? null : num((x as number) ** (y as number));
        },
        "number",
      ];
    case "min":
    case "max": {
      let t: Type = "null";
      for (const [i, a] of types.entries()) {
        want(i, ["number", "text", "time"], "a number, text or time");
        const u = unify(t, a);
        if (u === null) throw mixed(name, t, a);
        t = u;
      }
      const kind: Kind = t === "text" ? "text" : "number";
      const wantMin = name === "min";
      return [
        (r) => {
          let best: unknown = null;
          for (const f of fns) {
            const v = f(r);
            if (v === null) continue;
            if (best === null) {
              best = v;
              continue;
            }
            const c = compareValues(kind, v, best);
            if (wantMin ? c < 0 : c > 0) best = v;
          }
          return best;
        },
        t,
      ];
    }
    case "year":
      return calendar((t) => civilOf(t).year);
    case "month":
      return calendar((t) => civilOf(t).month);
    case "day":
      return calendar((t) => civilOf(t).day);
    case "hour":
      return calendar((t) => Math.floor(remEuclid(t, DAY_MS) / 3_600_000));
    case "minute":
      return calendar((t) => Math.floor(remEuclid(t, 3_600_000) / 60_000));
    case "second":
      return calendar((t) => Math.floor(remEuclid(t, 60_000) / 1000));
    case "weekday":
      return calendar((t) => weekday(Math.floor(t / DAY_MS)));
    case "startof":
      want(0, ["time"], "time");
      return [
        (r) => {
          const t = f0(r);
          return t === null ? null : time(startOf(Math.floor(t as number), unit ?? "day"));
        },
        "time",
      ];
    case "concat":
      return [
        (r) => {
          let out = "";
          for (const [i, f] of fns.entries()) {
            const s = textOf(types[i] as Type, f(r));
            if (s === null) continue;
            if (out.length + s.length > MAX_TEXT_UNITS) {
              // Stops before building anything longer.
              tooLong = true;
              return null;
            }
            out += s;
          }
          return out;
        },
        "text",
      ];
    case "text":
      return [(r) => textOf(types[0] as Type, f0(r)), "text"];
    case "number": {
      want(0, ["number", "text", "bool", "time"], "a value");
      const t = types[0] as Type;
      return [
        (r) => {
          const v = f0(r);
          if (v === null) return null;
          if (t === "time") return num(Math.floor(v as number));
          if (t === "bool") return v ? 1 : 0;
          if (t === "text") return parseNumber(v as string);
          return v;
        },
        "number",
      ];
    }
    case "lower":
    case "upper":
      want(0, ["text"], "text");
      return [
        (r) => {
          const v = f0(r);
          if (v === null) return null;
          return capped(
            name === "lower" ? (v as string).toLowerCase() : (v as string).toUpperCase(),
          );
        },
        "text",
      ];
    case "length":
      want(0, ["text"], "text");
      return [
        (r) => {
          const v = f0(r);
          return v === null ? null : Array.from(v as string).length;
        },
        "number",
      ];
    default:
      want(0, ["text"], "text");
      want(1, ["text"], "text");
      return [
        (r) => {
          const a = f0(r);
          const b = f1(r);
          return a === null || b === null ? null : (a as string).includes(b as string);
        },
        "bool",
      ];
  }
}

/** The value as a cell of the result field: -0 as 0, times as whole ms. */
export function toCell(type: Type, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (type === "number") return (v as number) === 0 ? 0 : v;
  if (type === "time") return Math.floor(v as number);
  return v;
}

export const FIELD_TYPE_OF: Record<Exclude<Type, "null">, Field["type"]> = {
  number: "number",
  text: "string",
  bool: "bool",
  time: "time",
};
