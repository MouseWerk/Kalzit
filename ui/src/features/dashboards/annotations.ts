import { useQueries, useQuery } from "@tanstack/react-query";
import type { Frame, QueryResponse, TimeRange } from "../../api/generated/shapes";
import { BUSY_RETRY } from "../../api/retry";
import type { PanelAnnotation } from "../../panels/annotations";
import {
  ANNOTATIONS_KEY,
  type Annotation,
  fetchAnnotations,
  runAnnotationQuery,
} from "./featuresApi";
import {
  type AnnotationQueryModel,
  storedQueryVariables,
  type VariableModel,
  type VariableValues,
} from "./model";

/**
 * The annotations of a dashboard for one range: the ones people wrote, and the rows of its
 * enabled annotation queries. A query's frame is read as it is, nothing is converted on the
 * server: the first time field is the time, a field named `timeEnd` the end of a span, `text` (or
 * the first text field) the text and `tags` the tags.
 */

/** A mark with where it came from: a written annotation can be opened to change it. */
export interface DashboardMark extends PanelAnnotation {
  /** The written annotation, for changing it; absent for query results. */
  annotation?: Annotation | undefined;
  /** `null`: every time panel. */
  panelId: string | null;
}

function toTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Date.parse(value);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function tagsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value !== "") {
    return value
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
  }
  return [];
}

/** The rows of one annotation query's frames as marks. */
export function marksFromFrames(
  frames: readonly Frame[],
  query: AnnotationQueryModel,
): DashboardMark[] {
  const marks: DashboardMark[] = [];
  for (const [f, frame] of frames.entries()) {
    const fields = frame.fields;
    const time = fields.find((field) => field.type === "time" && field.name !== "timeEnd");
    if (time === undefined) continue;
    const end = fields.find((field) => field.name === "timeEnd");
    const text =
      fields.find((field) => field.name === "text") ??
      fields.find((field) => field.type === "string");
    const tags = fields.find((field) => field.name === "tags");
    time.values.forEach((raw, row) => {
      const at = toTime(raw);
      if (at === null) return;
      const until = end === undefined ? null : toTime(end.values[row]);
      marks.push({
        key: `${query.id}:${f}:${row}`,
        time: at,
        timeEnd: until !== null && until > at ? until : null,
        text: text === undefined ? query.name : String(text.values[row] ?? ""),
        tags: tags === undefined ? [] : tagsOf(tags.values[row]),
        color: query.color,
        panelId: null,
      });
    });
  }
  return marks;
}

function framesOfResponse(response: QueryResponse): Frame[] {
  return Object.values(response.results).flatMap((outcome) =>
    "result" in outcome && outcome.result.shape === "frame" ? [outcome.result.frame] : [],
  );
}

interface Input {
  orgId: string;
  dashboardId: string;
  /**
   * Every range a panel shows: the dashboard's, and those of panels with a range or shift of
   * their own. Written annotations are read once for their union; each annotation query runs
   * once per distinct range.
   */
  ranges: readonly TimeRange[];
  /** The saved dashboard: only its annotation queries can run through the server. */
  saved: { annotations?: AnnotationQueryModel[] | undefined; variables: readonly VariableModel[] };
  values: VariableValues;
  run: number;
}

/** The distinct ranges, in a stable order, and the range that covers them all. */
export function coverRanges(ranges: readonly TimeRange[]): {
  distinct: TimeRange[];
  union: TimeRange;
} {
  const distinct = [...new Map(ranges.map((r) => [`${r.from}:${r.to}`, r])).values()].sort(
    (a, b) => a.from - b.from || a.to - b.to,
  );
  const union = distinct.reduce(
    (all, r) => ({ from: Math.min(all.from, r.from), to: Math.max(all.to, r.to) }),
    distinct[0] ?? { from: 0, to: 0 },
  );
  return { distinct, union };
}

export function useDashboardAnnotations({ orgId, dashboardId, ranges, saved, values, run }: Input) {
  const { distinct, union } = coverRanges(ranges);
  const manual = useQuery({
    queryKey: [ANNOTATIONS_KEY, orgId, dashboardId, union.from, union.to, run],
    queryFn: ({ signal }) => fetchAnnotations(orgId, dashboardId, union, signal),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: distinct.length > 0,
    ...BUSY_RETRY,
  });
  const variables = storedQueryVariables(values, saved.variables);
  const enabled = (saved.annotations ?? []).filter((q) => q.enabled);
  const runs = enabled.flatMap((query) => distinct.map((range) => ({ query, range })));
  const fromQueries = useQueries({
    queries: runs.map(({ query, range }) => ({
      queryKey: [
        ANNOTATIONS_KEY,
        orgId,
        dashboardId,
        "query",
        query.id,
        range.from,
        range.to,
        variables,
        run,
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        runAnnotationQuery(orgId, dashboardId, query.id, { timeRange: range, variables }, signal),
      staleTime: Number.POSITIVE_INFINITY,
      ...BUSY_RETRY,
    })),
  });
  const marks: DashboardMark[] = (manual.data ?? []).map((a) => ({
    key: a.id,
    time: a.time,
    timeEnd: a.timeEnd,
    text: a.text,
    tags: a.tags,
    panelId: a.panelId,
    annotation: a,
  }));
  // A row found in two overlapping ranges is one mark.
  const seen = new Set<string>();
  fromQueries.forEach((result, index) => {
    const query = runs[index]?.query;
    if (result.data === undefined || query === undefined) {
      return;
    }
    for (const mark of marksFromFrames(framesOfResponse(result.data), query)) {
      const identity = `${query.id}:${mark.time}:${mark.timeEnd}:${mark.text}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        marks.push({ ...mark, key: identity });
      }
    }
  });
  return { marks, error: manual.error };
}
