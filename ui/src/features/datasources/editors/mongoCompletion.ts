import type { Completion, CompletionResult } from "./completion";

/**
 * Completion for the MongoDB editors, as pure functions over the text and the cursor like the SQL
 * and PromQL ones. A small scanner finds where the cursor sits in the JSON (which keys enclose
 * it, key or value position, inside quotes or not), and each stage offers what fits there: stage
 * names at the top, field paths and query operators in `$match`, accumulators in `$group`,
 * `"$field"` references where a stage takes expressions.
 */

export const STAGES = [
  "$match",
  "$project",
  "$group",
  "$sort",
  "$limit",
  "$skip",
  "$unwind",
  "$lookup",
  "$addFields",
  "$set",
  "$unset",
  "$count",
  "$facet",
  "$bucket",
  "$bucketAuto",
  "$sortByCount",
  "$replaceRoot",
  "$sample",
  "$densify",
  "$fill",
  "$setWindowFields",
  "$geoNear",
  "$graphLookup",
  "$unionWith",
] as const;

const LOGICAL = ["$and", "$or", "$nor", "$expr", "$text"];
const COMPARISON = [
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$exists",
  "$type",
  "$regex",
  "$elemMatch",
  "$size",
  "$all",
  "$not",
  "$geoWithin",
  "$near",
];
const ACCUMULATORS = [
  "$sum",
  "$avg",
  "$min",
  "$max",
  "$count",
  "$first",
  "$last",
  "$push",
  "$addToSet",
  "$stdDevPop",
  "$stdDevSamp",
  "$median",
  "$percentile",
  "$top",
  "$bottom",
];
const EXPRESSIONS = [
  "$add",
  "$subtract",
  "$multiply",
  "$divide",
  "$round",
  "$concat",
  "$toLower",
  "$toUpper",
  "$substrCP",
  "$dateToString",
  "$dateTrunc",
  "$year",
  "$month",
  "$dayOfMonth",
  "$cond",
  "$ifNull",
  "$size",
  "$arrayElemAt",
  "$filter",
  "$map",
  "$toString",
  "$toDouble",
  "$eq",
  "$gt",
  "$lt",
];
const STAGE_KEYS: Record<string, string[]> = {
  $lookup: ["from", "localField", "foreignField", "as", "let", "pipeline"],
  $unwind: ["path", "includeArrayIndex", "preserveNullAndEmptyArrays"],
  $bucket: ["groupBy", "boundaries", "default", "output"],
  $bucketAuto: ["groupBy", "buckets", "output", "granularity"],
  $replaceRoot: ["newRoot"],
  $sample: ["size"],
  $unionWith: ["coll", "pipeline"],
};

export interface JsonContext {
  /** Keys of the objects around the cursor, outermost first (arrays add none). */
  path: string[];
  /** Whether the cursor is where an object key goes. */
  inKey: boolean;
  /** The cursor is inside a string that is not closed yet. */
  quoted: boolean;
  /** The word being typed and where it starts. */
  word: string;
  from: number;
  /** No object or array is open at the cursor. */
  outside: boolean;
}

interface Level {
  kind: "object" | "array";
  key: string | null;
  expectKey: boolean;
}

/** Where the cursor sits in a JSON text; tolerant of the unfinished text being typed. */
export function jsonContext(text: string, cursor: number): JsonContext {
  const stack: Level[] = [];
  let pendingKey: string | null = null;
  let i = 0;
  while (i < cursor) {
    const char = text[i];
    if (char === '"') {
      let j = i + 1;
      let value = "";
      while (j < cursor && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < cursor) {
          value += text[j + 1];
          j += 2;
        } else {
          value += text[j];
          j++;
        }
      }
      const top = stack.at(-1);
      if (j >= cursor) {
        return {
          path: keysOf(stack),
          inKey: top?.kind === "object" && top.expectKey,
          quoted: true,
          word: value,
          from: i + 1,
          outside: top === undefined,
        };
      }
      if (top?.kind === "object" && top.expectKey) {
        pendingKey = value;
      }
      i = j + 1;
      continue;
    }
    const top = stack.at(-1);
    if (char === "{" || char === "[") {
      stack.push({ kind: char === "{" ? "object" : "array", key: null, expectKey: char === "{" });
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === ":" && top?.kind === "object") {
      top.key = pendingKey;
      top.expectKey = false;
      pendingKey = null;
    } else if (char === "," && top?.kind === "object") {
      top.key = null;
      top.expectKey = true;
    }
    i++;
  }
  const word = /[\w$.]*$/.exec(text.slice(0, cursor))?.[0] ?? "";
  const top = stack.at(-1);
  return {
    path: keysOf(stack),
    inKey: top?.kind === "object" && top.expectKey,
    quoted: false,
    word,
    from: cursor - word.length,
    outside: top === undefined,
  };
}

/** The keys leading to the cursor: each open object's current key, the innermost one included. */
function keysOf(stack: readonly Level[]): string[] {
  return stack.flatMap((level) =>
    level.kind === "object" && level.key !== null ? [level.key] : [],
  );
}

/** Where the editor's text sits in the query: one stage, or one part of a find query. */
export type MongoEditorTarget = "stage" | "filter" | "projection" | "sort";

const MAX_OPTIONS = 50;

function options(
  labels: readonly string[],
  kind: Completion["kind"],
  context: JsonContext,
): Completion[] {
  const lower = context.word.toLowerCase();
  return labels
    .filter((label) => label.toLowerCase().startsWith(lower))
    .map((label) => ({ label: context.quoted ? label : `"${label}"`, kind }));
}

/** Keys and values allowed inside a filter (`$match`, find's filter); `path` starts inside it. */
function filterOptions(path: readonly string[], context: JsonContext, fields: readonly string[]) {
  if (!context.inKey) {
    return [];
  }
  const last = path.at(-1);
  if (last === undefined || LOGICAL.includes(last)) {
    return [...options(fields, "column", context), ...options(LOGICAL, "keyword", context)];
  }
  return options(COMPARISON, "function", context);
}

function references(context: JsonContext, fields: readonly string[]) {
  return context.word.startsWith("$")
    ? options(
        fields.map((field) => `$${field}`),
        "column",
        context,
      )
    : [];
}

function stageOptions(context: JsonContext, fields: readonly string[]): Completion[] {
  const [stage, ...inner] = context.path;
  if (stage === undefined) {
    return context.inKey ? options(STAGES, "keyword", context) : [];
  }
  switch (stage) {
    case "$match":
      return filterOptions(inner, context, fields);
    case "$group":
      if (context.inKey) {
        return inner.length === 0
          ? options(["_id"], "column", context)
          : options(ACCUMULATORS, "function", context);
      }
      return references(context, fields);
    case "$sort":
      return context.inKey && inner.length === 0 ? options(fields, "column", context) : [];
    case "$project":
    case "$addFields":
    case "$set":
      if (context.inKey) {
        return inner.length === 0
          ? options(fields, "column", context)
          : options(EXPRESSIONS, "function", context);
      }
      return context.word.startsWith("$")
        ? [...references(context, fields), ...options(EXPRESSIONS, "function", context)]
        : [];
    case "$limit":
    case "$skip":
    case "$count":
      return [];
    default: {
      const keys = STAGE_KEYS[stage];
      if (context.inKey && inner.length === 0) {
        return options(keys ?? fields, keys === undefined ? "column" : "keyword", context);
      }
      return context.inKey ? [] : references(context, fields);
    }
  }
}

/**
 * Completions at `cursor` for one stage (`target: "stage"`) or one part of a find query. Without
 * `explicit` (Ctrl+Space) they appear only once a word has been started.
 */
export function mongoCompletions(
  text: string,
  cursor: number,
  target: MongoEditorTarget,
  fields: readonly string[],
  explicit = false,
): CompletionResult | null {
  const context = jsonContext(text, cursor);
  if (context.outside || (context.word === "" && !context.quoted && !explicit)) {
    return null;
  }
  let found: Completion[];
  switch (target) {
    case "stage":
      found = stageOptions(context, fields);
      break;
    case "filter":
      found = filterOptions(context.path, context, fields);
      break;
    default:
      found = context.inKey && context.path.length === 0 ? options(fields, "column", context) : [];
  }
  const unique = [...new Map(found.map((option) => [option.label, option])).values()];
  if (unique.length === 0) {
    return null;
  }
  return { from: context.from, to: cursor, options: unique.slice(0, MAX_OPTIONS) };
}
