import { isRecord } from "../../api/client";
import { clickOption, MAX_VARIABLE_CHARS } from "../variableClick";

export type TraceViewMode = "auto" | "list" | "waterfall";

/** The list's columns after the trace id, which is always shown. */
export const TRACE_COLUMNS = ["root", "spans", "services", "duration", "start", "status"] as const;
export type TraceColumn = (typeof TRACE_COLUMNS)[number];

export interface TracePanelOptions {
  /** The list of traces, the waterfall of one, or by how many traces the result holds. */
  view: TraceViewMode;
  columns: TraceColumn[];
  /** Duration over time above the list. */
  chart: boolean;
  /** Dashboard variable a click sets; empty sets none. */
  variable: string;
  /** What the variable takes: empty the trace id, else a span attribute's value. */
  variableSource: string;
  /** Spans at this depth and below start closed; 0 opens everything. */
  collapseDepth: number;
  /** Marks a span's events in its bar. */
  events: boolean;
}

export const MAX_COLLAPSE_DEPTH = 50;
/** Longest attribute name the click option stores (the server's limit for option texts). */
export const MAX_SOURCE_CHARS = 200;

export function parseTraceOptions(stored: unknown): TracePanelOptions {
  const value = isRecord(stored) ? stored : {};
  const columns = Array.isArray(value.columns)
    ? TRACE_COLUMNS.filter((column) => (value.columns as unknown[]).includes(column))
    : [...TRACE_COLUMNS];
  const depth = typeof value.collapseDepth === "number" ? Math.round(value.collapseDepth) : 0;
  return {
    view: value.view === "list" || value.view === "waterfall" ? value.view : "auto",
    columns,
    chart: value.chart !== false,
    variable: clickOption(value.variable, MAX_VARIABLE_CHARS, true),
    variableSource: clickOption(value.variableSource, MAX_SOURCE_CHARS),
    collapseDepth: Math.min(Math.max(depth, 0), MAX_COLLAPSE_DEPTH),
    events: value.events !== false,
  };
}
