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
  range: TimeRange;
  /** The saved dashboard: only its annotation queries can run through the server. */
  saved: { annotations?: AnnotationQueryModel[] | undefined; variables: readonly VariableModel[] };
  values: VariableValues;
  run: number;
}

export function useDashboardAnnotations({ orgId, dashboardId, range, saved, values, run }: Input) {
  const manual = useQuery({
    queryKey: [ANNOTATIONS_KEY, orgId, dashboardId, range.from, range.to, run],
    queryFn: ({ signal }) => fetchAnnotations(orgId, dashboardId, range, signal),
    staleTime: Number.POSITIVE_INFINITY,
    ...BUSY_RETRY,
  });
  const variables = storedQueryVariables(values, saved.variables);
  const enabled = (saved.annotations ?? []).filter((q) => q.enabled);
  const fromQueries = useQueries({
    queries: enabled.map((query) => ({
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
  fromQueries.forEach((result, index) => {
    const query = enabled[index];
    if (result.data !== undefined && query !== undefined) {
      marks.push(...marksFromFrames(framesOfResponse(result.data), query));
    }
  });
  return { marks, error: manual.error };
}
