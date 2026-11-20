import type {
  ErrorBody,
  GraphSet,
  QueryItem,
  QueryOutcome,
  QueryResult,
  StepPlace,
} from "../../../api/generated/shapes";
import {
  checkoutTrace,
  searchFrame,
  TRACE_ID,
  TRACE_START,
} from "../../../panels/trace/test/fixture";
import type { FakeDatasourcesState, WireKind } from "./fakeDatasources";

export const TEMPO_ID = "ds-tempo";
export const JAEGER_ID = "ds-jaeger";

const traceKind = (kind: string, name: string): WireKind => ({
  kind,
  name,
  shapes: ["trace", "frame"],
  hintKey: `datasources.kinds.${kind}.hint`,
  settings: [],
});

/** The service map of the checkout trace, as the server's step answers it. */
export const SERVICE_MAP: GraphSet = {
  nodes: ["checkout", "frontend", "payment"].map((name) => ({
    id: name,
    labels: ["Service"],
    properties: { name, spans: 3, errors: name === "frontend" ? 0 : 1 },
  })),
  edges: [
    {
      id: "frontend -> checkout",
      type: "CALLS",
      from: "frontend",
      to: "checkout",
      properties: { calls: 1, errors: 1, durationMeanMs: 1210 },
    },
    {
      id: "checkout -> payment",
      type: "CALLS",
      from: "checkout",
      to: "payment",
      properties: { calls: 1, errors: 1, durationMeanMs: 640 },
    },
  ],
  schema: {
    labels: ["Service"],
    edgeTypes: ["CALLS"],
    propertyKeys: { Service: ["name", "spans", "errors"] },
  },
};

const stepError = (reason: string, params: Record<string, string>): ErrorBody => ({
  code: "query_rejected",
  message: reason,
  reason,
  params,
});

/** What a trace step makes of a result, the few cases the tests need. */
function applyStep(step: Record<string, unknown>, result: QueryResult): QueryResult | ErrorBody {
  if (result.shape !== "trace") {
    return stepError("steps.not_trace", { frame: String(step.frame) });
  }
  const { spans } = result.trace;
  switch (step.type) {
    case "filterSpans":
      return {
        shape: "trace",
        trace: {
          ...result.trace,
          spans: spans.filter(
            (span) =>
              (step.status === undefined || span.status === step.status) &&
              (!Array.isArray(step.services) || step.services.includes(span.service)),
          ),
        },
      };
    case "criticalPath":
      return result;
    case "spanTable":
      return {
        shape: "frame",
        frame: {
          fields: [
            { name: "service", type: "string", values: spans.map((span) => span.service) },
            { name: "operation", type: "string", values: spans.map((span) => span.operation) },
            {
              name: "duration",
              type: "number",
              unit: "ms",
              values: spans.map((span) => span.duration / 1000),
            },
            ...(Array.isArray(step.attributes) ? (step.attributes as string[]) : []).map((key) => ({
              name: key,
              type: "string" as const,
              values: spans.map((span) => span.attributes[key] ?? null),
            })),
          ],
          meta: { rowsTruncated: false, notices: [] },
        },
      };
    case "traceTable":
      return { shape: "frame", frame: searchFrame() };
    case "serviceMap":
    case "spanTree":
      // The fake asks before it draws a graph of the "large" trace, as the server above 100,000.
      return spans.length > 12 && step.confirmLarge !== true
        ? stepError("steps.trace_graph_large", {
            step: String(step.type),
            spans: "120000",
            limit: "100000",
          })
        : { shape: "graph", graph: SERVICE_MAP };
    default:
      return stepError("steps.unknown", {});
  }
}

/** Answers a query of a trace source: a search as a table, a trace id as a trace, with steps. */
export function traceOutcome(item: QueryItem): QueryOutcome {
  const query = (item.query ?? {}) as Record<string, unknown>;
  if (typeof query.list === "string" || typeof query.tagValues === "string") {
    return {
      result: {
        shape: "frame",
        frame: {
          fields: [{ name: "service", type: "string", values: ["frontend", "checkout"] }],
          meta: { rowsTruncated: false, notices: [] },
        },
      },
    };
  }
  if (typeof query.traceId !== "string") {
    // A search for a service nobody runs finds nothing; the answer keeps its columns.
    const frame = searchFrame();
    return {
      result: {
        shape: "frame",
        frame:
          query.service === "nobody"
            ? {
                fields: frame.fields.map((field) => ({ ...field, values: [] })),
                meta: { rowsTruncated: false, notices: [] },
              }
            : frame,
      },
    };
  }
  if (!TRACE_ID.startsWith(query.traceId) && query.traceId !== "b16") {
    return {
      error: {
        code: "datasource_error",
        message: `no trace ${query.traceId}`,
        reason: "trace.not_found",
        params: { id: query.traceId },
      },
    };
  }
  const trace = checkoutTrace();
  if (query.traceId === "b16") {
    // A second, larger trace: the service map asks before it runs.
    trace.spans = [
      ...trace.spans.map((span) => ({ ...span, traceId: "b16" })),
      {
        ...(trace.spans[0] as (typeof trace.spans)[number]),
        traceId: "b16",
        spanId: "extra",
        parentSpanId: "b7ad6b7169203331",
        start: TRACE_START + 1000,
        duration: 1000,
      },
    ];
  }
  let result: QueryResult = { shape: "trace", trace };
  const places: StepPlace[] = [];
  for (const raw of (item.steps ?? []) as Record<string, unknown>[]) {
    const next = applyStep(raw, result);
    if ("shape" in next) {
      result = next;
      places.push({ id: String(raw.id), ranIn: "server" });
    } else {
      places.push({ id: String(raw.id), ranIn: "server", error: next });
      break;
    }
  }
  return places.length === 0 ? { result } : { result, steps: places };
}

/** Adds a Tempo and a Jaeger source (TEMPO_ID, JAEGER_ID) with their schemas and answers. */
export function addTraceSources(state: FakeDatasourcesState): void {
  const created = Date.UTC(2026, 10, 14);
  state.pluginKinds.push(traceKind("tempo", "Tempo"), traceKind("jaeger", "Jaeger"));
  state.datasources.push(
    {
      id: TEMPO_ID,
      name: "Tempo prod",
      kind: "tempo",
      settings: { url: "http://tempo.internal:3200" },
      secrets: {},
      createdAt: created,
      updatedAt: created,
    },
    {
      id: JAEGER_ID,
      name: "Jaeger store",
      kind: "jaeger",
      settings: { url: "http://jaeger.internal:16686" },
      secrets: {},
      createdAt: created,
      updatedAt: created,
    },
  );
  state.schemas[TEMPO_ID] = {
    kind: "labels",
    labels: ["resource.service.name", "name", "span.http.status_code"],
    values: { "resource.service.name": ["frontend", "checkout"], name: ["GET /checkout"] },
  };
  state.schemas[JAEGER_ID] = {
    kind: "labels",
    labels: ["frontend", "checkout"],
    values: { frontend: ["GET /checkout"], checkout: ["POST /api/checkout"] },
  };
  const otherwise = state.respond;
  state.respond = (item, range, variables) => {
    const kind = state.datasources.find((source) => source.id === item.datasourceId)?.kind;
    return kind === "tempo" || kind === "jaeger"
      ? traceOutcome(item)
      : otherwise(item, range, variables);
  };
}
