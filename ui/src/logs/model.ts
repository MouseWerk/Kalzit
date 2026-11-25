import { isRecord } from "../api/client";
import { dateMs, isTyped, unwrap } from "../documents/values";
import { type Level, levelFromText, normalizeLevel } from "./levels";

/**
 * Logs are a view on the documents shape (board Logs.dc.html, frame 7), not a shape of their own
 * and not a conversion: the view reads a time, a text and, where there is one, a level from each
 * document, by a field mapping that is visible and can be changed. The documents themselves stay
 * as the query answered them; switching between "Logs" and "Documents" shows the same documents
 * in the same number.
 */

/** How the view finds its fields: Loki's documents, Elasticsearch and OpenSearch hits, or any other documents. */
export type LogSource = "loki" | "search" | "documents";

export function logSourceOf(kind: string): LogSource {
  if (kind === "loki") {
    return "loki";
  }
  return kind === "elasticsearch" ? "search" : "documents";
}

/** The text field choice "the whole document as one line" (board frame 10). */
export const WHOLE_DOCUMENT = "$document";

/** A person's choice of fields; a missing one is "Auto". */
export interface LogFieldChoice {
  time?: string;
  text?: string;
  level?: string;
}

/** The fields the view reads; `auto` says which were found rather than chosen. */
export interface ResolvedFields {
  time: string | null;
  text: string | null;
  /** The level paths tried in order on each line; empty: the level comes from the text. */
  levels: string[];
  auto: { time: boolean; text: boolean; level: boolean };
}

/** Field names that read as a time, a text or a level in documents of any source (frame 7). */
const DOCUMENT_TIME = ["timestamp", "@timestamp", "time", "ts", "createdAt", "created_at", "date"];
const DOCUMENT_TEXT = ["message", "msg", "line", "log"];
const DOCUMENT_LEVEL = ["level", "severity", "lvl", "loglevel"];

/** Loki's documents (docs/api/datasources.md, "Loki"): the line, its time and its stream labels. */
const LOKI_LEVEL = [
  "labels.level",
  "labels.severity",
  "labels.lvl",
  "labels.detected_level",
  "metadata.level",
  "metadata.detected_level",
];

/** Documents looked at to find the fields; the view itself reads every line. */
const SAMPLE = 50;

/**
 * The value at a dotted path. Objects are followed by name; a key with dots in it, as
 * Elasticsearch documents often have (`"log.level": "error"`), is found as well.
 */
export function fieldValue(document: unknown, path: string): unknown {
  return lookup(document, path.split("."));
}

function lookup(value: unknown, parts: readonly string[]): unknown {
  if (parts.length === 0) {
    return value;
  }
  const object = unwrap(value);
  if (!isRecord(object) || isTyped(object) || Array.isArray(object)) {
    return undefined;
  }
  for (let n = parts.length; n >= 1; n -= 1) {
    const key = parts.slice(0, n).join(".");
    if (Object.hasOwn(object, key)) {
      const found = lookup(object[key], parts.slice(n));
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/**
 * Unix ms of a time value: a typed date, RFC 3339 text, or a number in seconds, milliseconds,
 * microseconds or nanoseconds (told apart by size). Anything else is no time.
 */
export function timeMs(value: unknown): number | null {
  if (isTyped(value)) {
    return value.$type === "date" ? dateMs(value) : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return epochMs(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (/^\d{9,20}(\.\d+)?$/.test(text)) {
      return epochMs(Number(text));
    }
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
      const ms = Date.parse(text.replace(" ", "T"));
      return Number.isNaN(ms) ? null : ms;
    }
  }
  return null;
}

function epochMs(value: number): number | null {
  const abs = Math.abs(value);
  if (abs < 1e11) return Math.round(value * 1_000);
  if (abs < 1e14) return Math.round(value);
  if (abs < 1e17) return Math.round(value / 1_000);
  return Math.round(value / 1_000_000);
}

function sample(documents: readonly unknown[]): unknown[] {
  return documents.length > SAMPLE ? documents.slice(0, SAMPLE) : [...documents];
}

function firstPath(
  documents: readonly unknown[],
  paths: readonly string[],
  accept: (value: unknown) => boolean,
): string | null {
  for (const path of paths) {
    if (documents.some((document) => accept(fieldValue(document, path)))) {
      return path;
    }
  }
  return null;
}

const isText = (value: unknown) => typeof value === "string";
const isTime = (value: unknown) => timeMs(value) !== null;
const isLevel = (value: unknown) => typeof value === "string" || typeof value === "number";

/** Top-level names of the documents, matched without regard to case, in the order of `names`. */
function named(documents: readonly unknown[], names: readonly string[], prefix = ""): string[] {
  const keys = new Set<string>();
  for (const document of documents) {
    const inner = unwrap(prefix === "" ? document : fieldValue(document, prefix.slice(0, -1)));
    if (isRecord(inner) && !isTyped(inner)) {
      for (const key of Object.keys(inner)) {
        keys.add(key);
      }
    }
  }
  return names.flatMap((name) =>
    [...keys].filter((key) => key.toLowerCase() === name.toLowerCase()).map((key) => prefix + key),
  );
}

/** Every top-level path whose value is a time, for document sources without a named one. */
function anyTime(documents: readonly unknown[], prefix = ""): string | null {
  for (const document of documents) {
    const inner = unwrap(prefix === "" ? document : fieldValue(document, prefix.slice(0, -1)));
    if (isRecord(inner) && !isTyped(inner)) {
      for (const [key, value] of Object.entries(inner)) {
        if (isTyped(value) && value.$type === "date" && dateMs(value) !== null) {
          return prefix + key;
        }
      }
    }
  }
  return null;
}

/**
 * The fields the view reads from these documents: the person's choice where there is one, else
 * what the source's documents name (board frame 7, the table "Die Ansicht liest").
 * `timeField` is the time field of an Elasticsearch or OpenSearch query or source.
 */
export function resolveFields(
  source: LogSource,
  documents: readonly unknown[],
  choice: LogFieldChoice = {},
  timeField?: string,
): ResolvedFields {
  const docs = sample(documents);
  const prefix = source === "search" ? "_source." : "";
  let time: string | null;
  let text: string | null;
  let levels: string[];
  if (source === "loki") {
    time = "time";
    text = "line";
    levels = LOKI_LEVEL;
  } else {
    const times = [
      ...(timeField === undefined || timeField.trim() === "" ? [] : [prefix + timeField]),
      ...named(docs, DOCUMENT_TIME, prefix),
    ];
    time = firstPath(docs, times, isTime) ?? anyTime(docs, prefix);
    text = firstPath(docs, named(docs, DOCUMENT_TEXT, prefix), isText);
    levels = [
      ...(source === "search" ? ["_source.log.level"] : []),
      ...named(docs, DOCUMENT_LEVEL, prefix),
    ];
    const found = firstPath(docs, levels, isLevel);
    levels = found === null ? [] : [found];
  }
  return {
    time: choice.time ?? time,
    text: choice.text ?? text,
    levels: choice.level === undefined ? levels : [choice.level],
    auto: {
      time: choice.time === undefined,
      text: choice.text === undefined,
      level: choice.level === undefined,
    },
  };
}

/**
 * Whether the "Logs" tab is there and chosen first (frame 7, row "Reiter Logs"): always and first
 * for Loki; always for Elasticsearch and OpenSearch, first where the hits have a time and a text;
 * offered for other documents with a time (the view then asks for the text), never first.
 */
export function logsOfferFor(
  source: LogSource,
  fields: ResolvedFields,
): "preselect" | "offer" | "none" {
  if (source === "loki") {
    return "preselect";
  }
  if (source === "search") {
    return fields.time !== null && fields.text !== null ? "preselect" : "offer";
  }
  return fields.time === null ? "none" : "offer";
}

/** One field of a line, as its details show it. */
export interface LogField {
  /** The name shown, and the name a filter uses (a label, a key in the line, a document field). */
  key: string;
  /** Where the value is in the document; for fields read from the line, the key in the line. */
  path: string;
  value: unknown;
  text: string;
  origin: "label" | "line" | "document";
}

export interface LogLine {
  /** The position of the document in the result, which stays the line's identity. */
  id: number;
  document: unknown;
  timeMs: number | null;
  text: string;
  level: Level;
  /** The level as the source wrote it, for the details; null where none was found. */
  levelRaw: string | null;
  labels: LogField[];
  fields: LogField[];
  /** The text parsed as JSON when it is a JSON object, for "Prettify JSON". */
  json: Record<string, unknown> | null;
}

/** Lines longer than this are not parsed as JSON; they stay raw and say so (frame 14). */
export const MAX_JSON_CHARS = 100_000;
/** Nested fields are listed down to this depth. */
const MAX_DEPTH = 4;

/** A value as text: strings as they are, typed values by their value, the rest as JSON. */
export function valueText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isTyped(value)) {
    return value.value ?? "";
  }
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(value) ?? "";
}

function leaves(
  value: unknown,
  path: string,
  depth: number,
  out: { path: string; value: unknown }[],
): void {
  const inner = unwrap(value);
  if (depth < MAX_DEPTH && isRecord(inner) && !isTyped(inner) && !Array.isArray(inner)) {
    for (const [key, child] of Object.entries(inner)) {
      leaves(child, path === "" ? key : `${path}.${key}`, depth + 1, out);
    }
    return;
  }
  if (path !== "") {
    out.push({ path, value: inner });
  }
}

/** `key=value` pairs as logfmt writes them, values quoted or bare. */
const LOGFMT = /(?:^|\s)([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|[^\s"]*)/g;

export function logfmtFields(text: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [, key, raw] of text.matchAll(LOGFMT)) {
    if (key === undefined || raw === undefined) continue;
    const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw;
    pairs.push([key, value]);
  }
  return pairs;
}

export function jsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || trimmed.length > MAX_JSON_CHARS) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function lineFields(text: string, json: Record<string, unknown> | null): LogField[] {
  if (json !== null) {
    const out: { path: string; value: unknown }[] = [];
    leaves(json, "", 0, out);
    return out.map(({ path, value }) => ({
      key: path,
      path,
      value,
      text: valueText(value),
      origin: "line",
    }));
  }
  return logfmtFields(text).map(([key, value]) => ({
    key,
    path: key,
    value,
    text: value,
    origin: "line",
  }));
}

function lokiLabels(document: unknown): LogField[] {
  const out: LogField[] = [];
  for (const group of ["labels", "metadata"]) {
    const labels = fieldValue(document, group);
    if (isRecord(labels)) {
      for (const [key, value] of Object.entries(labels)) {
        out.push({ key, path: `${group}.${key}`, value, text: valueText(value), origin: "label" });
      }
    }
  }
  return out;
}

/** Elasticsearch's own fields of a hit (`_index`, `_id`) are the "labels" of its line. */
const SEARCH_META = ["_index", "_id"];

function documentFields(
  document: unknown,
  source: LogSource,
  skip: ReadonlySet<string>,
): { labels: LogField[]; fields: LogField[] } {
  const labels: LogField[] = [];
  const out: { path: string; value: unknown }[] = [];
  if (source === "search") {
    for (const key of SEARCH_META) {
      const value = fieldValue(document, key);
      if (value !== undefined) {
        labels.push({ key, path: key, value, text: valueText(value), origin: "label" });
      }
    }
    leaves(fieldValue(document, "_source"), "_source", 1, out);
  } else {
    leaves(document, "", 0, out);
  }
  const fields = out
    .filter(({ path }) => !skip.has(path))
    .map(({ path, value }) => ({
      key: source === "search" ? path.replace(/^_source\./, "") : path,
      path,
      value,
      text: valueText(value),
      origin: "document" as const,
    }));
  return { labels, fields };
}

/** The documents as log lines, in the order the query answered them. */
export function toLogLines(
  documents: readonly unknown[],
  source: LogSource,
  fields: ResolvedFields,
): LogLine[] {
  const skip = new Set<string>(
    [fields.time, fields.text, ...fields.levels].filter((path): path is string => path !== null),
  );
  return documents.map((document, id) => {
    const time = fields.time === null ? undefined : fieldValue(document, fields.time);
    const rawText =
      fields.text === WHOLE_DOCUMENT
        ? JSON.stringify(unwrap(document))
        : fields.text === null
          ? ""
          : valueText(fieldValue(document, fields.text));
    const json = jsonObject(rawText);
    let level: Level = "unknown";
    let levelRaw: string | null = null;
    for (const path of fields.levels) {
      const value = fieldValue(document, path);
      if (value !== undefined && value !== null && value !== "") {
        level = normalizeLevel(isTyped(value) ? value.value : value);
        levelRaw = valueText(value);
        break;
      }
    }
    if (levelRaw === null && (fields.auto.level || fields.levels.length === 0)) {
      const found = levelFromText(rawText);
      if (found !== null) {
        level = found.level;
        levelRaw = found.raw;
      }
    }
    const parts =
      source === "loki"
        ? { labels: lokiLabels(document), fields: lineFields(rawText, json) }
        : documentFields(document, source, skip);
    return {
      id,
      document,
      timeMs: time === undefined ? null : timeMs(time),
      text: rawText,
      level,
      levelRaw,
      labels: parts.labels,
      fields: parts.fields,
      json,
    };
  });
}

export type LogOrder = "newest" | "oldest";

/** The lines by time, newest or oldest first; lines without a time keep their place at the end. */
export function sortLines(lines: readonly LogLine[], order: LogOrder): LogLine[] {
  const sign = order === "newest" ? -1 : 1;
  return [...lines].sort((a, b) => {
    if (a.timeMs === null || b.timeMs === null) {
      return a.timeMs === null ? (b.timeMs === null ? a.id - b.id : 1) : -1;
    }
    return a.timeMs === b.timeMs ? a.id - b.id : sign * (a.timeMs - b.timeMs);
  });
}

/** The four ways of merging duplicates (frame 3). */
export const DEDUP_MODES = ["none", "exact", "numbers", "signature"] as const;
export type DedupMode = (typeof DEDUP_MODES)[number];

/** What two lines must share to count as the same under a mode; their level always counts. */
export function dedupKey(line: LogLine, mode: DedupMode): string {
  switch (mode) {
    case "none":
      return `${line.id}`;
    case "exact":
      return `${line.level}\u0000${line.text}`;
    case "numbers":
      // IDs, durations and counters do not count: hex ids and numbers become one placeholder.
      return `${line.level}\u0000${line.text
        .replace(/\b[0-9a-f]{8,}\b/gi, "#")
        .replace(/\d+(?:[.,]\d+)?/g, "#")}`;
    case "signature":
      // Only words and signs: values after `=`, quoted text and numbers drop out.
      return `${line.level}\u0000${line.text
        .replace(/=("(?:[^"\\]|\\.)*"|\S*)/g, "=")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/[0-9]+/g, "")
        .replace(/\s+/g, " ")
        .trim()}`;
  }
}

export interface LogGroup {
  /** The first line of the run, as shown. */
  line: LogLine;
  /** The lines that count as the same, the first included. */
  members: LogLine[];
}

/** Consecutive lines that count as the same become one group with their count. */
export function dedupe(lines: readonly LogLine[], mode: DedupMode): LogGroup[] {
  const groups: LogGroup[] = [];
  let last: string | null = null;
  for (const line of lines) {
    const key = dedupKey(line, mode);
    const open = groups[groups.length - 1];
    if (mode !== "none" && open !== undefined && key === last) {
      open.members.push(line);
    } else {
      groups.push({ line, members: [line] });
    }
    last = key;
  }
  return groups;
}

/** The share of loaded lines with the same value for a field (details, "18 %"). */
export function valueShare(lines: readonly LogLine[], field: LogField): number {
  if (lines.length === 0) {
    return 0;
  }
  let same = 0;
  for (const line of lines) {
    const list = field.origin === "label" ? line.labels : line.fields;
    if (list.some((other) => other.key === field.key && other.text === field.text)) {
      same += 1;
    }
  }
  return same / lines.length;
}

/** Candidate paths for the field choice: the paths of the documents, top level first. */
export function fieldPaths(documents: readonly unknown[]): string[] {
  const paths = new Set<string>();
  for (const document of sample(documents)) {
    const out: { path: string; value: unknown }[] = [];
    leaves(document, "", 0, out);
    for (const { path } of out) {
      paths.add(path);
    }
  }
  return [...paths].sort((a, b) => a.split(".").length - b.split(".").length || a.localeCompare(b));
}
