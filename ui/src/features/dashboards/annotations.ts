import { type UseQueryResult, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Frame, QueryResponse, TimeRange } from "../../api/generated/shapes";
import { BUSY_RETRY } from "../../api/retry";
import type { PanelAnnotation } from "../../panels/annotations";
import { dayStarts } from "../../panels/frame";
import {
  ANNOTATIONS_KEY,
  type Annotation,
  fetchAnnotations,
  runAnnotationQuery,
} from "./featuresApi";
import {
  type AnnotationQueryModel,
  type PanelModel,
  type RowModel,
  storedQueryVariables,
  type VariableModel,
  type VariableValues,
} from "./model";
import { panelRange, TIME_PANELS } from "./panelTime";

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
    const found = fields.find(
      (field) => (field.type === "time" || field.type === "date") && field.name !== "timeEnd",
    );
    // A day marks its midnight on the dashboard's wall clock, not midnight UTC.
    const time = found?.type === "date" ? dayStarts(found) : found;
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
   * The ranges time panels show, the dashboard's own first, then those of panels with a range or
   * shift of their own (see `annotationRanges`). Written annotations are read per range, the
   * dashboard's first, so a wide range of one panel never pushes the dashboard's own out of the
   * page limit; each annotation query runs once per range.
   */
  ranges: readonly TimeRange[];
  /** The saved dashboard: only its annotation queries can run through the server. */
  saved: { annotations?: AnnotationQueryModel[] | undefined; variables: readonly VariableModel[] };
  values: VariableValues;
  run: number;
}

/**
 * The ranges annotations are read for: the dashboard's first, then the own ranges (time range or
 * shift) of time panels that are drawn, so panels without a time axis and panels in collapsed
 * rows ask for nothing. `panels` are resolved (a library panel's content in its slot).
 */
export function annotationRanges(
  panels: readonly PanelModel[],
  rows: readonly RowModel[],
  collapsed: (row: RowModel) => boolean,
  range: TimeRange,
  now: number,
): TimeRange[] {
  const hidden = new Set(rows.filter(collapsed).map((r) => r.id));
  const own = panels
    .filter((p) => TIME_PANELS.has(p.type) && (p.rowId === undefined || !hidden.has(p.rowId)))
    .map((p) => panelRange(p, range, now));
  return distinctRanges([range, ...own]);
}

/**
 * At most this many ranges are read: the dashboard's and seven of panels with their own, so
 * annotation queries do not fan out to every panel times every query. A time panel whose own
 * range is beyond the seventh distinct one gets annotations only where its range overlaps one
 * that was read; a dashboard with that many different panel ranges is rare.
 */
export const MAX_ANNOTATION_RANGES = 8;

/** The distinct ranges in the given order (the dashboard's first), at most `MAX_ANNOTATION_RANGES`. */
export function distinctRanges(ranges: readonly TimeRange[]): TimeRange[] {
  return [...new Map(ranges.map((r) => [`${r.from}:${r.to}`, r])).values()].slice(
    0,
    MAX_ANNOTATION_RANGES,
  );
}

/**
 * The marks of one annotation query, from the answers for several ranges. A row counted in two
 * overlapping ranges is one mark; rows that really repeat within one answer stay as many as the
 * most any one answer had.
 */
export function mergeQueryMarks(perRange: readonly (readonly DashboardMark[])[]): DashboardMark[] {
  const most = new Map<string, DashboardMark[]>();
  for (const marks of perRange) {
    const here = new Map<string, DashboardMark[]>();
    for (const mark of marks) {
      const identity = `${mark.time}:${mark.timeEnd}:${mark.text}:${mark.tags.join(",")}`;
      here.set(identity, [...(here.get(identity) ?? []), mark]);
    }
    for (const [identity, list] of here) {
      if (list.length > (most.get(identity)?.length ?? 0)) {
        most.set(identity, list);
      }
    }
  }
  return [...most.entries()].flatMap(([identity, list]) =>
    list.map((mark, index) => ({ ...mark, key: `${identity}:${index}` })),
  );
}

/** Each written annotation once, whichever range found it; the same object while nothing changed. */
function combineWritten(results: UseQueryResult<Annotation[]>[]) {
  const byId = new Map<string, Annotation>();
  for (const result of results) {
    for (const a of result.data ?? []) {
      byId.set(a.id, a);
    }
  }
  return { data: [...byId.values()], error: results.find((r) => r.error)?.error ?? null };
}

/** The answers of the annotation queries, in the order they were asked. */
function combineAnswers(results: UseQueryResult<QueryResponse>[]) {
  return results.map((result) => result.data);
}

/**
 * The marks of the dashboard's annotations. The result keeps its identity while the ranges and
 * the answers stay the same, so a dashboard edit that leaves them alone (moving a panel) does not
 * hand every panel new marks and draw it again.
 */
export function useDashboardAnnotations({ orgId, dashboardId, ranges, saved, values, run }: Input) {
  // The ranges as text, and read back from it: the same ranges give the same list.
  const rangeKey = distinctRanges(ranges)
    .map((r) => `${r.from}:${r.to}`)
    .join(",");
  const distinct = useMemo(
    (): TimeRange[] =>
      rangeKey === ""
        ? []
        : rangeKey.split(",").map((pair) => {
            const [from = 0, to = 0] = pair.split(":").map(Number);
            return { from, to };
          }),
    [rangeKey],
  );
  const manual = useQueries({
    queries: distinct.map((range) => ({
      queryKey: [ANNOTATIONS_KEY, orgId, dashboardId, range.from, range.to, run],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchAnnotations(orgId, dashboardId, range, signal),
      staleTime: Number.POSITIVE_INFINITY,
      ...BUSY_RETRY,
    })),
    combine: combineWritten,
  });
  const variables = storedQueryVariables(values, saved.variables);
  const enabled = useMemo(
    () => (saved.annotations ?? []).filter((q) => q.enabled),
    [saved.annotations],
  );
  const runs = useMemo(
    () => enabled.flatMap((query) => distinct.map((range) => ({ query, range }))),
    [enabled, distinct],
  );
  const answers = useQueries({
    combine: combineAnswers,
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
  const marks = useMemo(() => {
    const list: DashboardMark[] = manual.data.map((a) => ({
      key: a.id,
      time: a.time,
      timeEnd: a.timeEnd,
      text: a.text,
      tags: a.tags,
      panelId: a.panelId,
      annotation: a,
    }));
    for (const query of enabled) {
      const perRange = runs.flatMap((r, index) => {
        const data = answers[index];
        return r.query === query && data !== undefined
          ? [marksFromFrames(framesOfResponse(data), query)]
          : [];
      });
      list.push(...mergeQueryMarks(perRange).map((m) => ({ ...m, key: `${query.id}:${m.key}` })));
    }
    return list;
  }, [manual.data, enabled, runs, answers]);
  return { marks, error: manual.error };
}
