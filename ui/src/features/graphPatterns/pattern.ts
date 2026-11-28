import { isRecord } from "../../api/client";
import type {
  Condition,
  ElementSchema,
  GraphSourceSchema,
  Operand,
  Operator,
  ParameterType,
  Pattern,
  PatternEdge,
  PatternNode,
  PatternParameter,
} from "../../api/generated/shapes";

/*
 * The graph pattern as the builder edits it (board Graph083.dc.html, frames 1 to 10; the form is
 * docs/api/datasources.md, "Graph patterns"). Everything here is pure: the builder, the list, the
 * sentence and the tests share it. The server compiles, checks and runs the pattern; these
 * functions only keep it well formed while it is drawn.
 */

/** The language a source's patterns compile to: Cypher (Neo4j, Memgraph) or GSQL (TigerGraph). */
export type PatternDialect = "cypher" | "gsql";

export function dialectOf(kind: string): PatternDialect | undefined {
  if (kind === "neo4j" || kind === "memgraph") return "cypher";
  if (kind === "tigergraph") return "gsql";
  return undefined;
}

/** The selected node or edge of the pattern. */
export type Selection = { kind: "node" | "edge"; id: string } | null;

/** The limit a pattern has without one (`pattern::DEFAULT_LIMIT`). */
export const DEFAULT_LIMIT = 500;
/** The longest path the server takes unless an admin changed it (`datasources.pattern_max_hops`). */
export const DEFAULT_MAX_HOPS = 6;
/** The default path length when a path is asked for (decision 9: 1 to 3). */
export const DEFAULT_PATH = { min: 1, max: 3 } as const;
/** The most values in one list unless an admin changed it (`datasources.pattern_max_values`). */
export const DEFAULT_MAX_VALUES = 10_000;
/** The server's own name prefix; aliases and parameters may not start with it. */
const RESERVED = "kz_";

const ALIAS = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/** Words Cypher or GSQL do not take as a name; a short list for the builder's own suggestions. */
const KEYWORDS = new Set([
  "all",
  "and",
  "any",
  "as",
  "by",
  "case",
  "create",
  "delete",
  "desc",
  "distinct",
  "else",
  "end",
  "false",
  "from",
  "in",
  "is",
  "limit",
  "match",
  "merge",
  "not",
  "null",
  "or",
  "order",
  "print",
  "return",
  "select",
  "set",
  "skip",
  "then",
  "to",
  "true",
  "union",
  "where",
  "with",
]);

/** A name in the query (node, edge, parameter): letters, digits and `_`, starting with a letter. */
export function isAlias(name: string): boolean {
  return (
    ALIAS.test(name) &&
    !name.toLowerCase().startsWith(RESERVED) &&
    !KEYWORDS.has(name.toLowerCase())
  );
}

/** The pattern of a query (`{"pattern": {...}}`), or undefined when the query is another form. */
export function patternOf(query: unknown): Pattern | undefined {
  if (!isRecord(query) || !isRecord(query.pattern)) return undefined;
  const raw = query.pattern;
  if (!Array.isArray(raw.nodes)) return undefined;
  return raw as unknown as Pattern;
}

export function emptyPattern(): Pattern {
  return { nodes: [] };
}

export function edgesOf(pattern: Pattern): PatternEdge[] {
  return pattern.edges ?? [];
}

function names(pattern: Pattern): Set<string> {
  return new Set(
    [
      ...pattern.nodes.map((n) => n.id),
      ...edgesOf(pattern).map((e) => e.id),
      ...(pattern.parameters ?? []).map((p) => p.name),
    ].map((n) => n.toLowerCase()),
  );
}

/** A free name: the label's first letter, else `n`, then with a number. */
export function nextNodeId(pattern: Pattern, label?: string): string {
  const taken = names(pattern);
  const first = label?.match(/[A-Za-z]/)?.[0]?.toLowerCase() ?? "n";
  const base = isAlias(first) ? first : "n";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const name = `${base}${i}`;
    if (!taken.has(name)) return name;
  }
}

export function nextEdgeId(pattern: Pattern): string {
  const taken = names(pattern);
  for (let i = 1; ; i++) {
    const name = `e${i}`;
    if (!taken.has(name)) return name;
  }
}

export function addNode(pattern: Pattern, labels: string[] = []): { pattern: Pattern; id: string } {
  const id = nextNodeId(pattern, labels[0]);
  const node: PatternNode = labels.length === 0 ? { id } : { id, labels };
  return { pattern: { ...pattern, nodes: [...pattern.nodes, node] }, id };
}

export function addEdge(
  pattern: Pattern,
  from: string,
  to: string,
  types: string[] = [],
): { pattern: Pattern; id: string } {
  const id = nextEdgeId(pattern);
  const edge: PatternEdge =
    types.length === 0
      ? { id, from, to, direction: "out" }
      : { id, from, to, types, direction: "out" };
  return { pattern: { ...pattern, edges: [...edgesOf(pattern), edge] }, id };
}

export function nodeById(pattern: Pattern, id: string): PatternNode | undefined {
  return pattern.nodes.find((n) => n.id === id);
}

export function edgeById(pattern: Pattern, id: string): PatternEdge | undefined {
  return edgesOf(pattern).find((e) => e.id === id);
}

/*
 * The changes below leave `parameters` as they are; the builder brings them in step with the
 * schema at hand (`withParameters`), so a new parameter is typed by its property.
 */

export function updateNode(pattern: Pattern, id: string, patch: Partial<PatternNode>): Pattern {
  return {
    ...pattern,
    nodes: pattern.nodes.map((n) => (n.id === id ? clean({ ...n, ...patch }) : n)),
  };
}

export function updateEdge(pattern: Pattern, id: string, patch: Partial<PatternEdge>): Pattern {
  return {
    ...pattern,
    edges: edgesOf(pattern).map((e) => (e.id === id ? clean({ ...e, ...patch }) : e)),
  };
}

/** Leaves out what equals the default, so a stored pattern stays as small as the drawing. */
function clean<T extends PatternNode | PatternEdge>(element: T): T {
  const out = { ...element } as Record<string, unknown>;
  for (const key of ["labels", "types", "conditions"]) {
    if (Array.isArray(out[key]) && (out[key] as unknown[]).length === 0) delete out[key];
  }
  if (out.matches === "all") delete out.matches;
  if (out.optional === false) delete out.optional;
  if (out.minHops === 1 && out.maxHops === 1) {
    delete out.minHops;
    delete out.maxHops;
  }
  if (out.ids === undefined) delete out.ids;
  return out as T;
}

/** Renames a node or edge everywhere it is named. */
export function renameElement(pattern: Pattern, from: string, to: string): Pattern {
  return {
    ...pattern,
    nodes: pattern.nodes.map((n) => (n.id === from ? { ...n, id: to } : n)),
    ...(pattern.edges === undefined
      ? {}
      : {
          edges: pattern.edges.map((e) => ({
            ...e,
            id: e.id === from ? to : e.id,
            from: e.from === from ? to : e.from,
            to: e.to === from ? to : e.to,
          })),
        }),
  };
}

/** Removes a node with the edges at it, or an edge; parameters no one uses go with them. */
export function removeElement(pattern: Pattern, selection: Selection): Pattern {
  if (selection === null) return pattern;
  if (selection.kind === "edge") {
    return withParameters({
      ...pattern,
      edges: edgesOf(pattern).filter((e) => e.id !== selection.id),
    });
  }
  return withParameters({
    ...pattern,
    nodes: pattern.nodes.filter((n) => n.id !== selection.id),
    edges: edgesOf(pattern).filter((e) => e.from !== selection.id && e.to !== selection.id),
  });
}

/** Turns an edge around: out becomes in and back; "either way" stays. */
export function reverseEdge(pattern: Pattern, id: string): Pattern {
  const edge = edgeById(pattern, id);
  if (edge === undefined || edge.direction === "both") return pattern;
  return updateEdge(pattern, id, { direction: edge.direction === "out" ? "in" : "out" });
}

// ---- conditions, values and parameters ----

/** What kind of value a property holds, from the schema's types. */
export type ValueKind = "text" | "number" | "date" | "boolean" | "list" | "unknown";

export function valueKind(types: readonly string[] | undefined): ValueKind {
  if (types === undefined || types.length !== 1) return "unknown";
  switch (types[0]) {
    case "string":
    case "enum":
      return "text";
    case "integer":
    case "float":
      return "number";
    case "date":
    case "dateTime":
    case "localDateTime":
    case "time":
    case "localTime":
      return "date";
    case "boolean":
      return "boolean";
    case "list":
      return "list";
    default:
      return "unknown";
  }
}

/** The comparisons a property of this kind offers (frame 4), in the language's subset. */
export function operatorsFor(kind: ValueKind, dialect: PatternDialect): Operator[] {
  const all: Record<ValueKind, Operator[]> = {
    text: ["eq", "ne", "contains", "startsWith", "endsWith", "in", "isNotNull", "isNull"],
    number: ["eq", "ne", "lt", "le", "gt", "ge", "in", "isNotNull", "isNull"],
    date: ["lt", "gt", "le", "ge", "isNotNull", "isNull"],
    boolean: ["eq", "isNotNull", "isNull"],
    list: ["isNotNull", "isNull"],
    unknown: [
      "eq",
      "ne",
      "lt",
      "le",
      "gt",
      "ge",
      "contains",
      "startsWith",
      "endsWith",
      "in",
      "isNotNull",
      "isNull",
    ],
  };
  // GSQL has no text search and no test for a missing value (`pattern.gsql_operator`).
  const gsqlLacks: Operator[] = ["contains", "startsWith", "endsWith", "isNull", "isNotNull"];
  return dialect === "gsql" ? all[kind].filter((op) => !gsqlLacks.includes(op)) : all[kind];
}

export function takesValue(op: Operator): boolean {
  return op !== "isNull" && op !== "isNotNull";
}

export function isParam(operand: Operand | undefined): operand is { param: string } {
  return isRecord(operand) && typeof (operand as { param?: unknown }).param === "string";
}

export function literalOf(operand: Operand | undefined): unknown {
  return isRecord(operand) && "value" in operand
    ? (operand as { value: unknown }).value
    : undefined;
}

/** The parameter type a value of this kind has, as one value or as a list (`in`). */
export function parameterType(kind: ValueKind, list: boolean, integer: boolean): ParameterType {
  if (kind === "number") {
    return list ? (integer ? "integerList" : "floatList") : integer ? "integer" : "float";
  }
  if (kind === "boolean" && !list) return "boolean";
  return list ? "stringList" : "string";
}

export function isListType(type: ParameterType): boolean {
  return type.endsWith("List");
}

/** Every parameter a condition or `ids` names, in the order they appear. */
export function usedParameters(pattern: Pattern): string[] {
  const out: string[] = [];
  const see = (operand: Operand | undefined) => {
    if (isParam(operand) && !out.includes(operand.param)) out.push(operand.param);
  };
  for (const node of pattern.nodes) {
    for (const c of node.conditions ?? []) see(c.value);
    see(node.ids);
  }
  for (const edge of edgesOf(pattern)) {
    for (const c of edge.conditions ?? []) see(c.value);
  }
  return out;
}

/** Where a parameter is first used: its element, the condition and whether it stands for a list. */
function firstUse(
  pattern: Pattern,
  name: string,
): { condition?: Condition; ids?: boolean; element: string } | undefined {
  for (const node of pattern.nodes) {
    if (isParam(node.ids) && node.ids.param === name) return { ids: true, element: node.id };
    for (const c of node.conditions ?? []) {
      if (isParam(c.value) && c.value.param === name) return { condition: c, element: node.id };
    }
  }
  for (const edge of edgesOf(pattern)) {
    for (const c of edge.conditions ?? []) {
      if (isParam(c.value) && c.value.param === name) return { condition: c, element: edge.id };
    }
  }
  return undefined;
}

/**
 * Keeps `parameters` in step with the conditions: one declared parameter per used name, those no
 * one uses left out, a new one typed by where it is used (the list form after `in`).
 */
export function withParameters(pattern: Pattern, schema?: GraphSourceSchema): Pattern {
  const used = usedParameters(pattern);
  const declared = pattern.parameters ?? [];
  const parameters: PatternParameter[] = used.map((name) => {
    const use = firstUse(pattern, name);
    const list = use?.ids === true || use?.condition?.op === "in";
    const known = declared.find((p) => p.name === name);
    if (known !== undefined && isListType(known.type) === list) return known;
    if (use?.ids === true) return { ...known, name, type: "idList" };
    const types =
      use?.condition === undefined
        ? undefined
        : propertyTypes(pattern, schema, use.element, use.condition.property);
    const kind = valueKind(types);
    const type = parameterType(kind, list, types?.[0] === "integer");
    return known === undefined ? { name, type } : { ...known, type };
  });
  const next = { ...pattern };
  if (parameters.length === 0) {
    delete next.parameters;
  } else {
    next.parameters = parameters;
  }
  return next;
}

/** The schema's types of a property on an element, through its labels or types. */
export function propertyTypes(
  pattern: Pattern,
  schema: GraphSourceSchema | undefined,
  element: string,
  property: string,
): string[] | undefined {
  if (schema === undefined) return undefined;
  const node = nodeById(pattern, element);
  const owners: ElementSchema[] =
    node !== undefined
      ? schema.labels.filter((l) => (node.labels ?? []).includes(l.name))
      : schema.edgeTypes.filter((t) => (edgeById(pattern, element)?.types ?? []).includes(t.name));
  const types = new Set<string>();
  for (const owner of owners) {
    for (const p of owner.properties) {
      if (p.name === property) for (const t of p.types) types.add(t);
    }
  }
  return types.size === 0 ? undefined : [...types];
}

/** The properties an element offers in the schema, each with its types, by name. */
export function propertiesOf(
  pattern: Pattern,
  schema: GraphSourceSchema | undefined,
  selection: Selection,
): { name: string; types: string[] }[] {
  if (schema === undefined || selection === null) return [];
  const owners =
    selection.kind === "node"
      ? (() => {
          const labels = nodeById(pattern, selection.id)?.labels ?? [];
          return labels.length === 0
            ? schema.labels
            : schema.labels.filter((l) => labels.includes(l.name));
        })()
      : (() => {
          const types = edgeById(pattern, selection.id)?.types ?? [];
          return types.length === 0
            ? schema.edgeTypes
            : schema.edgeTypes.filter((t) => types.includes(t.name));
        })();
  const byName = new Map<string, Set<string>>();
  for (const owner of owners) {
    for (const p of owner.properties) {
      const seen = byName.get(p.name) ?? new Set<string>();
      for (const t of p.types) seen.add(t);
      byName.set(p.name, seen);
    }
  }
  return [...byName]
    .map(([name, types]) => ({ name, types: [...types] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A typed value as the field reads it: `$name` is a parameter, a number property takes numbers,
 * `in` takes a comma-separated list. `error` says what does not fit ("viel" is no number).
 */
export function readValue(
  text: string,
  kind: ValueKind,
  op: Operator,
): { operand?: Operand; error?: "number" | "empty" | "alias" } {
  const trimmed = text.trim();
  if (trimmed.startsWith("$")) {
    const name = trimmed.slice(1);
    return isAlias(name) ? { operand: { param: name } } : { error: "alias" };
  }
  if (trimmed === "") return { error: "empty" };
  if (op === "in") {
    const parts = trimmed
      .split(/[,;\n\t]/)
      .map((p) => p.trim())
      .filter((p) => p !== "");
    if (kind === "number") {
      const numbers = parts.map(Number);
      if (numbers.some((n) => !Number.isFinite(n))) return { error: "number" };
      return { operand: { value: numbers } };
    }
    return { operand: { value: parts } };
  }
  if (kind === "number") {
    const n = Number(trimmed.replace(",", "."));
    return Number.isFinite(n) ? { operand: { value: n } } : { error: "number" };
  }
  return { operand: { value: trimmed } };
}

/** The value of an operand as the field shows it. */
export function valueText(operand: Operand | undefined): string {
  if (operand === undefined) return "";
  if (isParam(operand)) return `$${operand.param}`;
  const value = literalOf(operand);
  if (Array.isArray(value)) return value.map(String).join(", ");
  return value === undefined || value === null ? "" : String(value);
}

// ---- values given for a run (Probewert) and pasted lists ----

export interface ListReading {
  values: string[];
  duplicates: number;
  empty: number;
  /** Values that are not of the list's type, as typed. */
  wrong: string[];
}

/**
 * Pasted values as the server reads them (`pattern::split_values`): one per line, comma,
 * semicolon or tab, ids also by spaces; repeats and empty entries are left out and counted.
 */
export function readList(text: string, type: ParameterType): ListReading {
  const separators = type === "idList" ? /[\n\r,;\t ]/ : /[\n\r,;\t]/;
  const parts = text.split(separators).map((p) => p.trim());
  // A trailing line break is no empty line a person meant.
  const meant =
    text.trimEnd() === ""
      ? []
      : text
          .trimEnd()
          .split(separators)
          .map((p) => p.trim());
  const empty = meant.filter((p) => p === "").length;
  const seen = new Set<string>();
  const values: string[] = [];
  let duplicates = 0;
  for (const part of parts) {
    if (part === "") continue;
    if (seen.has(part)) {
      duplicates++;
      continue;
    }
    seen.add(part);
    values.push(part);
  }
  const numeric = type === "integerList" || type === "floatList";
  const wrong = numeric
    ? values.filter((v) =>
        type === "integerList" ? !/^-?\d+$/.test(v) : !Number.isFinite(Number(v)),
      )
    : [];
  return { values, duplicates, empty, wrong };
}

/** A sample value as a typed variable, or undefined when it does not fit (or is missing). */
export function typedSample(type: ParameterType, value: unknown): unknown {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value.length === 0 ? undefined : value;
  const text = String(value).trim();
  switch (type) {
    case "integer":
      return /^-?\d+$/.test(text) ? Number(text) : undefined;
    case "float": {
      const n = Number(text.replace(",", "."));
      return text !== "" && Number.isFinite(n) ? n : undefined;
    }
    case "boolean":
      return value === true || value === false ? value : undefined;
    case "string":
      return text === "" ? undefined : String(value);
    default: {
      const read = readList(text, type);
      if (read.values.length === 0 || read.wrong.length > 0) return undefined;
      return type === "integerList" || type === "floatList" ? read.values.map(Number) : read.values;
    }
  }
}

/** The variables of a run: each parameter's sample value in its type, missing ones left out. */
export function sampleVariables(
  parameters: readonly PatternParameter[],
  samples: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of parameters) {
    const v = typedSample(p.type, samples[p.name]);
    if (v !== undefined) out[p.name] = v;
  }
  return out;
}

// ---- checks before a run ----

export type Warning =
  | { kind: "open" }
  | { kind: "edgeNotInSchema"; edge: string; type: string; from: string; to: string }
  | { kind: "gsqlOptional"; edge: string }
  | { kind: "condition"; element: string; property: string; error: "number" | "empty" | "alias" }
  | { kind: "parameter"; name: string };

/**
 * What the builder says before a run (frames 8 and 24): a pattern without any restriction, an
 * edge type the schema does not have between its labels, an optional part GSQL cannot say. They
 * do not hold the run up, except an optional part in GSQL (nothing to run) and a value that does
 * not fit.
 */
export function warningsOf(
  pattern: Pattern,
  schema: GraphSourceSchema | undefined,
  dialect: PatternDialect,
): Warning[] {
  const out: Warning[] = [];
  const edges = edgesOf(pattern);
  const restricted =
    pattern.nodes.some(
      (n) => (n.labels ?? []).length > 0 || (n.conditions ?? []).length > 0 || n.ids !== undefined,
    ) || edges.some((e) => (e.types ?? []).length > 0 || (e.conditions ?? []).length > 0);
  if (pattern.nodes.length > 0 && !restricted) out.push({ kind: "open" });
  if (schema !== undefined && schema.links.length > 0) {
    for (const edge of edges) {
      const from = nodeById(pattern, edge.from)?.labels ?? [];
      const to = nodeById(pattern, edge.to)?.labels ?? [];
      const [type] = edge.types ?? [];
      if (type === undefined || edge.types?.length !== 1 || from.length !== 1 || to.length !== 1) {
        continue;
      }
      const [a, b] = edge.direction === "in" ? [to[0], from[0]] : [from[0], to[0]];
      const found = schema.links.some(
        (l) =>
          l.type === type &&
          ((l.from === a && l.to === b) ||
            (edge.direction === "both" && l.from === b && l.to === a) ||
            l.from === "" ||
            l.to === ""),
      );
      if (!found) {
        out.push({
          kind: "edgeNotInSchema",
          edge: edge.id,
          type,
          from: from[0] ?? "",
          to: to[0] ?? "",
        });
      }
    }
  }
  if (dialect === "gsql") {
    for (const edge of edges) {
      if (edge.optional === true) out.push({ kind: "gsqlOptional", edge: edge.id });
    }
  }
  return out;
}

/** The edge types the schema has between two labels, and the others (frame 3). */
export function edgeTypeChoices(
  schema: GraphSourceSchema | undefined,
  from: readonly string[],
  to: readonly string[],
): { between: { type: string; from: string; to: string; count?: number }[]; other: string[] } {
  if (schema === undefined) return { between: [], other: [] };
  // A side without a label takes any; "" in the schema is an end of any type (TigerGraph).
  const at = (ends: readonly string[], label: string) =>
    ends.length === 0 || label === "" || ends.includes(label);
  const between = schema.links
    .filter((l) => (at(from, l.from) && at(to, l.to)) || (at(to, l.from) && at(from, l.to)))
    .map((l) => ({
      type: l.type,
      from: l.from,
      to: l.to,
      ...(l.count === undefined ? {} : { count: l.count }),
    }));
  const named = new Set(between.map((b) => b.type));
  const other = schema.edgeTypes.map((t) => t.name).filter((name) => !named.has(name));
  return { between, other };
}

// ---- drawing ----

export interface Placed {
  id: string;
  x: number;
  y: number;
}

/** Column and row spacing of the drawing, in the drawing's own units. */
export const DRAWING = { column: 200, row: 110, margin: 70 } as const;

/**
 * Where each node of the pattern is drawn: in columns along the edges (the first node left, what
 * it reaches next to it), several in a column one under another. Stable for the same pattern, so
 * adding an element moves no other.
 */
export function layoutPattern(pattern: Pattern): {
  nodes: Placed[];
  width: number;
  height: number;
} {
  const depth = new Map<string, number>();
  const neighbours = new Map<string, string[]>();
  for (const e of edgesOf(pattern)) {
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
  }
  let start = 0;
  for (const node of pattern.nodes) {
    if (depth.has(node.id)) continue;
    // Each part on its own starts one column after the widest part so far.
    depth.set(node.id, start);
    const queue = [node.id];
    let widest = start;
    while (queue.length > 0) {
      const id = queue.shift() as string;
      const d = depth.get(id) ?? 0;
      widest = Math.max(widest, d);
      for (const next of neighbours.get(id) ?? []) {
        if (!depth.has(next)) {
          depth.set(next, d + 1);
          queue.push(next);
        }
      }
    }
    start = widest + 1;
  }
  const rows = new Map<number, number>();
  const nodes = pattern.nodes.map((node) => {
    const column = depth.get(node.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return {
      id: node.id,
      x: DRAWING.margin + column * DRAWING.column,
      y: DRAWING.margin + row * DRAWING.row,
    };
  });
  const columns = Math.max(1, ...[...rows.keys()].map((c) => c + 1));
  const tallest = Math.max(1, ...rows.values());
  return {
    nodes,
    width: DRAWING.margin * 2 + (columns - 1) * DRAWING.column,
    height: DRAWING.margin * 2 + (tallest - 1) * DRAWING.row,
  };
}

/** The elements in the order of the query: nodes and edges along the drawing (frame 25). */
export function elementOrder(pattern: Pattern): Exclude<Selection, null>[] {
  const out: Exclude<Selection, null>[] = [];
  const edges = edgesOf(pattern);
  const placed = new Set<string>();
  for (const node of pattern.nodes) {
    if (!placed.has(node.id)) {
      out.push({ kind: "node", id: node.id });
      placed.add(node.id);
    }
    for (const edge of edges.filter((e) => e.from === node.id || e.to === node.id)) {
      if (out.some((o) => o.kind === "edge" && o.id === edge.id)) continue;
      out.push({ kind: "edge", id: edge.id });
      const other = edge.from === node.id ? edge.to : edge.from;
      if (!placed.has(other)) {
        out.push({ kind: "node", id: other });
        placed.add(other);
      }
    }
  }
  return out;
}

/** The label's colour slot (1 to 8) in the schema's order, as the result's canvas colours labels. */
export function labelSlot(
  schema: GraphSourceSchema | undefined,
  label: string | undefined,
): number {
  if (label === undefined) return 0;
  const index = schema?.labels.findIndex((l) => l.name === label) ?? -1;
  if (index >= 0) return (index % 8) + 1;
  let hash = 0;
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (hash % 8) + 1;
}

// ---- the way to the text ----

/** A Cypher literal for a value: text quoted and escaped, numbers and true/false as they are. */
export function cypherLiteral(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(cypherLiteral).join(", ")}]`;
  if (value === null || value === undefined) return "null";
  const text = String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${text}'`;
}

/**
 * The compiled text as the text editor takes it over: Kalzit's own literal parameters (`$kz_v0`)
 * written back as the literals they stand for, since nobody else gives them a value; the
 * template's own parameters stay `$name`. GSQL keeps its header and takes the values as the
 * query's parameters instead.
 */
export function textForEditing(
  text: string,
  parameters: Readonly<Record<string, unknown>>,
  dialect: PatternDialect,
): { text: string; params?: Record<string, unknown> } {
  if (dialect === "gsql") {
    const params: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(parameters)) {
      if (name.startsWith(RESERVED)) params[name] = value;
    }
    return Object.keys(params).length === 0 ? { text } : { text, params };
  }
  // Longest names first, so `$kz_v10` is not read as `$kz_v1` followed by a zero.
  const own = Object.keys(parameters)
    .filter((name) => name.startsWith(RESERVED))
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const name of own) {
    out = out.replace(
      new RegExp(`\\$${name}(?![A-Za-z0-9_])`, "g"),
      cypherLiteral(parameters[name]),
    );
  }
  return { text: out };
}

/** `$name` parameters of a Cypher text (macros `$__x` left out), for a template from the text. */
export function textParameters(text: string): string[] {
  const out: string[] = [];
  // Strings and comments do not name parameters.
  const code = text
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''")
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
  for (const [, name] of code.matchAll(/\$([A-Za-z][A-Za-z0-9_]*)/g)) {
    if (name !== undefined && isAlias(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The pattern's parameters, or none. */
export function parametersOf(pattern: Pattern | undefined): PatternParameter[] {
  return pattern?.parameters ?? [];
}

/** Replaces `$name` in a template's title with the values given ("Kunden von Nordhandel GmbH"). */
export function fillTitle(title: string, values: Readonly<Record<string, unknown>>): string {
  return title.replace(/\$([A-Za-z][A-Za-z0-9_]*)/g, (whole, name: string) => {
    const value = values[name];
    if (value === undefined || value === null || value === "") return whole;
    return Array.isArray(value) ? value.join(", ") : String(value);
  });
}
