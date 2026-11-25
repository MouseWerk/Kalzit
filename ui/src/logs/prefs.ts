import { isRecord } from "../api/client";
import { readPreference, writePreference } from "../lib/storage";
import { DEDUP_MODES, type DedupMode, type LogFieldChoice, type LogOrder } from "./model";

/**
 * The bar of the logs view acts at once and only on the view (board Logs.dc.html, frame 3); in
 * Explore each person's choice is remembered in this browser. The field choice is remembered per
 * data source, since it names that source's fields. A panel will store both with itself.
 */

export const TIME_FORMATS = ["ms", "date", "time", "relative", "off"] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

export interface LogViewPrefs {
  time: TimeFormat;
  wrap: boolean;
  prettify: boolean;
  dedup: DedupMode;
  order: LogOrder;
  /** Fields shown as columns before the text, in this order (frame 3, "Spalten"). */
  columns: string[];
}

export const DEFAULT_PREFS: LogViewPrefs = {
  time: "ms",
  wrap: false,
  prettify: false,
  dedup: "none",
  order: "newest",
  columns: [],
};

const VIEW_KEY = "kalzit.logs.view";
const FIELDS_KEY = "kalzit.logs.fields.";

function parse(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function readViewPrefs(): LogViewPrefs {
  const value = parse(readPreference(VIEW_KEY));
  if (!isRecord(value)) {
    return DEFAULT_PREFS;
  }
  return {
    time: (TIME_FORMATS as readonly unknown[]).includes(value.time)
      ? (value.time as TimeFormat)
      : DEFAULT_PREFS.time,
    wrap: value.wrap === true,
    prettify: value.prettify === true,
    dedup: (DEDUP_MODES as readonly unknown[]).includes(value.dedup)
      ? (value.dedup as DedupMode)
      : DEFAULT_PREFS.dedup,
    order: value.order === "oldest" ? "oldest" : "newest",
    columns: Array.isArray(value.columns)
      ? value.columns.filter((c): c is string => typeof c === "string").slice(0, 8)
      : [],
  };
}

export function writeViewPrefs(prefs: LogViewPrefs): void {
  writePreference(VIEW_KEY, JSON.stringify(prefs));
}

export function readFieldChoice(datasourceId: string): LogFieldChoice {
  const value = parse(readPreference(FIELDS_KEY + datasourceId));
  if (!isRecord(value)) {
    return {};
  }
  const choice: LogFieldChoice = {};
  for (const key of ["time", "text", "level"] as const) {
    const path = value[key];
    if (typeof path === "string" && path !== "") {
      choice[key] = path;
    }
  }
  return choice;
}

export function writeFieldChoice(datasourceId: string, choice: LogFieldChoice): void {
  writePreference(FIELDS_KEY + datasourceId, JSON.stringify(choice));
}
