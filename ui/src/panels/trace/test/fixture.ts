import type { Frame, Span, TraceSet } from "../../../api/generated/shapes";

/** Start of the sample trace, Unix microseconds (2026-11-14 14:37:12.018 UTC). */
export const TRACE_START = 1_794_667_032_018_000;
export const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

function span(
  id: string,
  parent: string | undefined,
  service: string,
  operation: string,
  startMs: number,
  durationMs: number,
  extra: Partial<Span> = {},
): Span {
  return {
    traceId: TRACE_ID,
    spanId: id,
    ...(parent === undefined ? {} : { parentSpanId: parent }),
    service,
    operation,
    start: TRACE_START + startMs * 1000,
    duration: durationMs * 1000,
    status: "unset",
    kind: "internal",
    attributes: {},
    events: [],
    links: [],
    ...extra,
  };
}

/** The checkout request of the board (Traces.dc.html, frame 2): twelve spans, three failed. */
export function checkoutSpans(): Span[] {
  return [
    span("b7ad6b7169203331", undefined, "frontend", "GET /checkout", 0, 1240, { kind: "server" }),
    span("5f2a90c1d4e8b001", "b7ad6b7169203331", "checkout", "POST /api/checkout", 12, 1210, {
      kind: "server",
      status: "error",
    }),
    span("a1cart0000000001", "5f2a90c1d4e8b001", "checkout", "cart.load", 20, 85),
    span("a1redis000000001", "a1cart0000000001", "redis", "GET cart:8812", 30, 6, {
      kind: "client",
    }),
    span("a1inv00000000001", "5f2a90c1d4e8b001", "inventory", "ReserveItems", 110, 310, {
      kind: "server",
    }),
    span("a1inv00000000002", "a1inv00000000001", "inventory", "stock.lookup", 120, 140),
    span("a1inv00000000003", "a1inv00000000001", "postgres", "UPDATE stock", 270, 120, {
      kind: "client",
    }),
    span("a1pay00000000001", "5f2a90c1d4e8b001", "payment", "Charge", 430, 640, {
      kind: "server",
      status: "error",
    }),
    span("00f067aa0ba902b7", "a1pay00000000001", "payment", "psp.authorize", 440, 600, {
      kind: "client",
      status: "error",
      statusMessage: "upstream timeout after 3 retries",
      attributes: {
        "http.request.method": "POST",
        "http.response.status_code": 504,
        "url.full": "https://psp.example/v2/authorize",
        "retry.count": 3,
        "order.id": "A-2026-118204",
      },
      resource: { "service.version": "4.12.0", "host.name": "pay-7c9f4-2" },
      scope: { name: "io.opentelemetry.okhttp-3.0", version: "2.9.0" },
      events: [
        {
          time: TRACE_START + 470_000,
          name: "retry",
          attributes: { "retry.attempt": 1, "retry.reason": "connect timeout" },
        },
        {
          time: TRACE_START + 1_040_000,
          name: "exception",
          attributes: {
            "exception.type": "PspTimeoutError",
            "exception.stacktrace": "PspTimeoutError: timeout\n  at authorize\n  at charge",
          },
        },
      ],
      links: [
        {
          traceId: "9e1d0c2b5a6f47d08c3e1b2a4d6f71f4",
          spanId: "c4a17d5e2f9009be",
          attributes: { "link.reason": "queued for settlement" },
        },
      ],
    }),
    span("a1pay00000000002", "a1pay00000000001", "payment", "fraud.score", 1045, 18),
    span("a1ord00000000001", "5f2a90c1d4e8b001", "checkout", "order.create", 1080, 110),
    span("a1render00000001", "b7ad6b7169203331", "frontend", "render checkout", 1225, 12),
  ];
}

export function checkoutTrace(): TraceSet {
  return { spans: checkoutSpans() };
}

/** A search's answer: one row per trace, as Jaeger counts them (spans, errors, services). */
export function searchFrame(): Frame {
  const at = TRACE_START / 1000;
  return {
    fields: [
      { name: "traceId", type: "string", values: [TRACE_ID, "a3c01e77aa11bb22cc33dd44ee55ff66"] },
      { name: "rootService", type: "string", values: ["frontend", "frontend"] },
      { name: "rootOperation", type: "string", values: ["GET /checkout", "GET /cart"] },
      { name: "start", type: "time", values: [at, at - 932_000] },
      { name: "duration", type: "number", unit: "ms", values: [1240, 180] },
      { name: "spans", type: "number", values: [12, 4] },
      { name: "errors", type: "number", values: [3, 0] },
      { name: "services", type: "number", values: [6, 2] },
    ],
    meta: {
      rowsTruncated: false,
      notices: [
        {
          severity: "info",
          code: "trace.search_limit",
          params: { limit: "2" },
          text: "the search asked for 2 traces; there may be more",
        },
      ],
      executedQuery: '{ resource.service.name = "frontend" }',
    },
  };
}
