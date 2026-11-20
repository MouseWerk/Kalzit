import type { Frame, Span, TraceSet } from "../../api/generated/shapes";

/** One trace of a result: its spans in start order, with what the header and the list show. */
export interface TraceView {
  traceId: string;
  spans: readonly Span[];
  /** The earliest span without a parent in the trace; the earliest span when none is a root. */
  root: Span;
  /** Unix microseconds. */
  start: number;
  /** Microseconds from the first start to the last end. */
  duration: number;
  services: string[];
  errors: number;
}

/** One line of the waterfall: a span at its depth in the tree. */
export interface SpanRow {
  span: Span;
  depth: number;
  children: number;
  /** Spans below this one, at any depth. */
  descendants: number;
  /** The span's parent is named but not in the result (cut, or never sent). */
  orphan: boolean;
}

export const spanEnd = (span: Span) => span.start + span.duration;

/** The traces of a result, in the order the server sent them (by trace id). */
export function tracesOf(set: TraceSet): TraceView[] {
  const byTrace = new Map<string, Span[]>();
  for (const span of set.spans) {
    const list = byTrace.get(span.traceId);
    if (list === undefined) byTrace.set(span.traceId, [span]);
    else list.push(span);
  }
  return [...byTrace.entries()].map(([traceId, spans]) => {
    const ids = new Set(spans.map((span) => span.spanId));
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    const root =
      sorted.find((span) => span.parentSpanId === undefined || !ids.has(span.parentSpanId)) ??
      (sorted[0] as Span);
    const start = sorted[0]?.start ?? 0;
    const end = sorted.reduce((max, span) => Math.max(max, spanEnd(span)), start);
    return {
      traceId,
      spans: sorted,
      root,
      start,
      duration: end - start,
      services: [...new Set(sorted.map((span) => span.service))],
      errors: sorted.filter((span) => span.status === "error").length,
    };
  });
}

/**
 * The spans of one trace as a tree in display order: children under their parent by start time.
 * A span whose parent is missing, or that names itself or a cycle, starts at the top level, so
 * every span is shown exactly once.
 */
export function spanRows(spans: readonly Span[]): SpanRow[] {
  const ids = new Set(spans.map((span) => span.spanId));
  const children = new Map<string, Span[]>();
  const tops: Span[] = [];
  for (const span of spans) {
    const parent = span.parentSpanId;
    if (parent === undefined || parent === span.spanId || !ids.has(parent)) {
      tops.push(span);
    } else {
      const list = children.get(parent);
      if (list === undefined) children.set(parent, [span]);
      else list.push(span);
    }
  }
  const rows: SpanRow[] = [];
  const seen = new Set<string>();
  // Walked with a stack of its own, not by recursion: a trace may be thousands of spans deep.
  const place = (top: Span) => {
    const open: { row: SpanRow; next: Span[] }[] = [];
    const enter = (span: Span, depth: number) => {
      seen.add(span.spanId);
      const own = (children.get(span.spanId) ?? []).filter((child) => !seen.has(child.spanId));
      // A child is another span's only once: marked here, so a cycle cannot claim it twice.
      for (const child of own) seen.add(child.spanId);
      const row: SpanRow = {
        span,
        depth,
        children: own.length,
        descendants: 0,
        orphan: span.parentSpanId !== undefined && !ids.has(span.parentSpanId),
      };
      rows.push(row);
      open.push({ row, next: own.reverse() });
    };
    enter(top, 0);
    while (open.length > 0) {
      const at = open[open.length - 1] as { row: SpanRow; next: Span[] };
      const child = at.next.pop();
      if (child !== undefined) {
        enter(child, at.row.depth + 1);
        continue;
      }
      open.pop();
      const parent = open[open.length - 1];
      if (parent !== undefined) parent.row.descendants += 1 + at.row.descendants;
    }
  };
  for (const top of tops) place(top);
  // Spans of a parent cycle have no top: each cycle starts at its earliest span.
  for (const span of spans) {
    if (!seen.has(span.spanId)) place(span);
  }
  return rows;
}

/** The depth of the deepest span, counting the top level as 1. */
export function treeDepth(rows: readonly SpanRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.depth + 1), 0);
}

/**
 * The spans that decide how long the trace takes, as the server's critical path step picks them
 * (docs/api/datasources.md): from the earliest root, going back from its end, the child that
 * ended last before the time reached, then that child's own critical path; the time moves to
 * that child's start.
 */
export function criticalPath(spans: readonly Span[]): Set<string> {
  const ids = new Set(spans.map((span) => span.spanId));
  const children = new Map<string, Span[]>();
  for (const span of spans) {
    const parent = span.parentSpanId;
    if (parent !== undefined && parent !== span.spanId && ids.has(parent)) {
      const list = children.get(parent);
      if (list === undefined) children.set(parent, [span]);
      else list.push(span);
    }
  }
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const root =
    sorted.find((span) => span.parentSpanId === undefined || !ids.has(span.parentSpanId)) ??
    sorted[0];
  const path = new Set<string>();
  // Each entry: a span on the path, its children by end time (latest first), and the time
  // reached going back from its end. A stack of its own, so depth is no limit.
  const open: { reached: number; next: Span[] }[] = [];
  const enter = (span: Span) => {
    path.add(span.spanId);
    const own = [...(children.get(span.spanId) ?? [])].sort((a, b) => spanEnd(a) - spanEnd(b));
    open.push({ reached: spanEnd(span), next: own });
  };
  if (root !== undefined) enter(root);
  while (open.length > 0) {
    const at = open[open.length - 1] as { reached: number; next: Span[] };
    const child = at.next.pop();
    if (child === undefined) {
      open.pop();
    } else if (spanEnd(child) <= at.reached && !path.has(child.spanId)) {
      at.reached = child.start;
      enter(child);
    }
  }
  return path;
}

/** One row of the trace list. Counts the source did not send are undefined, never guessed. */
export interface TraceSummary {
  traceId: string;
  rootService: string;
  rootOperation: string;
  /** Unix milliseconds. */
  start: number;
  /** Milliseconds. */
  duration: number;
  spans?: number | undefined;
  errors?: number | undefined;
  services?: number | undefined;
}

export function summariesOfTraces(traces: readonly TraceView[]): TraceSummary[] {
  return traces.map((trace) => ({
    traceId: trace.traceId,
    rootService: trace.root.service,
    rootOperation: trace.root.operation,
    start: trace.start / 1000,
    duration: trace.duration / 1000,
    spans: trace.spans.length,
    errors: trace.errors,
    services: trace.services.length,
  }));
}

/**
 * The rows of a search's answer or of a trace table step: a frame with `traceId`, `rootService`,
 * `rootOperation`, `start` and `duration` (ms) and the counts the source gave. Null for a frame
 * that is no list of traces.
 */
export function summariesOfFrame(frame: Frame): TraceSummary[] | null {
  const field = (name: string) => frame.fields.find((f) => f.name === name)?.values;
  const ids = field("traceId");
  const starts = field("start");
  const durations = field("duration");
  if (ids === undefined || starts === undefined || durations === undefined) return null;
  const services = field("rootService");
  const operations = field("rootOperation");
  const count = (name: string, row: number) => {
    const value = field(name)?.[row];
    return typeof value === "number" ? value : undefined;
  };
  return ids.map((id, row) => ({
    traceId: String(id ?? ""),
    rootService: String(services?.[row] ?? ""),
    rootOperation: String(operations?.[row] ?? ""),
    start: Number(starts[row] ?? 0),
    duration: Number(durations[row] ?? 0),
    spans: count("spans", row) ?? count("matchedSpans", row),
    errors: count("errors", row),
    services: count("services", row),
  }));
}

/** A duration in microseconds as people read it: "1,24 s", "85 ms", "420 µs". */
export function formatDuration(micros: number, language: string): string {
  const number = (value: number, digits: number) =>
    new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value);
  const abs = Math.abs(micros);
  // The start of an axis reads in the unit of the ticks after it.
  if (abs === 0) return `0 ms`;
  if (abs >= 60_000_000) return `${number(micros / 60_000_000, 1)} min`;
  if (abs >= 1_000_000) return `${number(micros / 1_000_000, 2)} s`;
  if (abs >= 1000) return `${number(micros / 1000, abs >= 100_000 ? 0 : 1)} ms`;
  return `${number(micros, 0)} µs`;
}

/** Up to `count` even steps from 0 to `total` for the time axis, both ends included. */
export function axisTicks(total: number, count = 4): number[] {
  if (total <= 0) return [0];
  return Array.from({ length: count + 1 }, (_, i) => (total * i) / count);
}

/** A span's value for a key: its own attribute first, then its resource's. */
export function spanValue(span: Span, key: string): unknown {
  if (key === "traceId") return span.traceId;
  if (key === "spanId") return span.spanId;
  if (key === "service") return span.service;
  if (key === "operation") return span.operation;
  return span.attributes[key] ?? span.resource?.[key];
}

/** An attribute value as one line of text. */
export function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
