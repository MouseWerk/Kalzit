import type { SpanKind, SpanStatus } from "../api/generated/shapes";
import type { PropertyFilter } from "./graphSteps";

/**
 * Trace steps (docs/guide/traces.md, "Steps on a trace"): they read a `trace` result and keep it
 * a trace, or make a table or a graph of it. The server runs them with the query; the browser
 * has no engine for them, so a step shows its result once the server answered.
 */
export type TraceStepKind =
  | {
      type: "filterSpans";
      frame: string;
      services?: string[];
      operations?: string[];
      kinds?: SpanKind[];
      status?: SpanStatus;
      minDurationMs?: number;
      maxDurationMs?: number;
      attribute?: PropertyFilter;
    }
  | { type: "criticalPath"; frame: string }
  | { type: "spanTable"; frame: string; attributes?: string[] }
  | { type: "traceTable"; frame: string }
  | { type: "serviceMap"; frame: string; confirmLarge?: boolean }
  | { type: "spanTree"; frame: string; confirmLarge?: boolean };

export const TRACE_STEP_TYPES = [
  "filterSpans",
  "criticalPath",
  "spanTable",
  "traceTable",
  "serviceMap",
  "spanTree",
] as const;

export type TraceStepType = (typeof TRACE_STEP_TYPES)[number];

/** The shape each trace step makes. */
export const TRACE_STEP_OUT: Record<TraceStepType, "trace" | "frame" | "graph"> = {
  filterSpans: "trace",
  criticalPath: "trace",
  spanTable: "frame",
  traceTable: "frame",
  serviceMap: "graph",
  spanTree: "graph",
};

/** The server's bound for the lists of a step (services, operations, attribute columns). */
export const MAX_TRACE_LIST = 50;

export const SPAN_KINDS: readonly SpanKind[] = [
  "server",
  "client",
  "producer",
  "consumer",
  "internal",
  "unspecified",
];

/** Whether a trace step passes the server's checks of its form. */
export function traceStepComplete(step: TraceStepKind): boolean {
  if (step.type !== "filterSpans") return true;
  const { minDurationMs: min, maxDurationMs: max, attribute: f } = step;
  if (min !== undefined && max !== undefined && min > max) return false;
  if (f === undefined) return true;
  if (f.key.trim() === "") return false;
  if (f.op === "exists") return f.value === undefined;
  if (f.op === "contains") return typeof f.value === "string" && f.value !== "";
  if (f.op === "eq" || f.op === "ne") return f.value !== undefined && f.value !== "";
  return typeof f.value === "number";
}
