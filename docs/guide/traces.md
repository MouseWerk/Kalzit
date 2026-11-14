English | [Deutsch](de/traces.md)

# Traces

A trace follows one request through your services: every service it passes records a **span**
with its operation, start, duration and status, and each span names the span that called it.
Kalzit reads traces from [Tempo](data-sources.md#tempo) and [Jaeger](data-sources.md#jaeger) and
keeps them in their own shape, `trace`, next to `frame`, `documents` and `graph`. A trace is not
turned into a table or a graph by itself: every conversion is a step you add, see and turn off.

The trace screens (a waterfall of the spans and a trace view in Explore) come later. Until then a
trace source runs in Explore and on dashboards through its query (written as JSON), and the steps
below are set in a panel's steps through the dashboard model or the API; their editors come with
the trace screens.

## Searching

A search needs no query language. Give any of these fields; a span set matches when one span
passes all of them:

| Field | Example | What it keeps |
|---|---|---|
| `service` | `"shop"` | spans of this service (required for Jaeger) |
| `operation` | `"POST /checkout"` | spans of this operation |
| `tags` | `{"http.status_code": "500"}` | spans with these attribute values |
| `minDuration`, `maxDuration` | `"250ms"`, `"2s"` | spans at least or at most this long |
| `status` | `"error"` | spans with this status (`ok`, `error`, `unset`; Jaeger has no `unset`) |
| `limit` | `20` | traces to ask for: 100 by default for Tempo, 20 for Jaeger, at most 1,000 |

The answer is a **table**, one row per trace: `traceId`, `rootService`, `rootOperation`, `start`,
`duration` (milliseconds) and the source's counts (Tempo: `matchedSpans`; Jaeger: `spans`,
`errors`, `services`). For Tempo, Kalzit writes the TraceQL for the search and shows it with the
answer (`executedQuery`), such as `{ resource.service.name = "shop" && status = error }`; you may
also write TraceQL yourself (`{"traceql": "..."}`). A search that finds as many traces as it
asked for says so (`trace.search_limit`).

A trace id (`{"traceId": "..."}`) answers the whole trace in the `trace` shape. The lists of
services, operations and tag values are tables, so they fill dashboard variables.

## The trace shape

A `trace` result is a list of spans, ordered by trace, then by start time, with the fields of
OpenTelemetry:

| Field | What it holds |
|---|---|
| `traceId` | the trace's id, lower-case hex (32 digits; 16 for 64-bit Jaeger ids) |
| `spanId` | the span's id, lower-case hex (16 digits) |
| `parentSpanId` | the calling span; missing for a root span |
| `service` | the service that recorded the span (`service.name`) |
| `operation` | what the span did (`GET /cart`, `SELECT orders`) |
| `kind` | `server`, `client`, `producer`, `consumer`, `internal` or `unspecified` |
| `start` | when it started, in Unix **microseconds** |
| `duration` | how long it took, in microseconds (fractions keep nanoseconds) |
| `status` | `unset`, `ok` or `error`, with `statusMessage` when the service gave one |
| `attributes` | the span's attributes (Jaeger: tags), with their types |
| `events` | things that happened during the span (Jaeger: logs): `time`, `name`, `attributes` |
| `links` | references to other spans: `traceId`, `spanId`, `attributes` |
| `resource` | the attributes of the process that recorded it (`host.name`, ...) |
| `scope` | the instrumentation library that recorded it: `name`, `version` |

Microseconds are exact in a browser's numbers, nanoseconds are not, so times stay microseconds in
the trace; a table of spans counts time in milliseconds like every other table.

**Limits.** A trace keeps at most 10,000 spans. A larger one keeps exactly 10,000: first its root
spans, then the spans with an error, then the earliest others, and says it was cut and how many
spans it kept (`trace.span_limit`). Two spans of one trace with the same id (a client and a server
span, as some tracers write them) stay apart: the later one gets `#2` (`trace.span_id_duplicate`). The
response size limit can cut a trace too (`trace.size_limit`).

## Steps on a trace

Steps that read a trace run on the server, with the query. They keep it a trace, or make a table
or a graph of it; the steps after them read what they made.

| Step | Makes | What |
|---|---|---|
| **Filter spans** (`filterSpans`) | trace | the spans of some `services`, `operations` or `kinds`, with a `status`, between `minDurationMs` and `maxDurationMs`, or whose `attribute` passes a condition (span attributes, else resource attributes) |
| **Critical path** (`criticalPath`) | trace | per trace, the spans that decide how long it takes: from the root, the child that finished last, then that child's own critical path, and so on; spans running beside a slower one are left out; a trace without a root starts at its earliest span (`trace.no_root`) |
| **Span table** (`spanTable`) | table | one row per span (below) |
| **Trace table** (`traceTable`) | table | one row per trace: `traceId`, `rootService`, `rootOperation`, `start`, `duration` (ms), `spans`, `errors`, `services` |
| **Service map** (`serviceMap`) | graph | the services and the calls between them (below) |
| **Span tree** (`spanTree`) | graph | every span a node (`Span`), every parent an edge `CHILD` to its child; above 100,000 spans it asks first, as the service map does |

### Span table

One row per span: `traceId`, `spanId`, `parentSpanId`, `service`, `operation`, `start` (time),
`duration` (number, milliseconds), `status`, `statusMessage`, `kind`, and `attributes`,
`resource`, `events` and `links` as JSON. Name attribute keys under **Attributes** to get them as
columns of their own, typed by their values: `http.status_code` becomes a number column. Span
attributes come first, then the resource's; a key that is also a fixed column (`service`) is named
`attributes.service`.

```json
{ "id": "s1", "type": "spanTable", "frame": "A", "attributes": ["http.status_code"] }
```

### Service map

The service map is computed on the server:

- every service is a node with the label `Service` and the properties `name`, `spans` (spans it
  recorded) and `errors` (spans with status `error`);
- every call from one service to another is an edge `CALLS` from the caller to the called
  service, with `calls`, `errors` (failed calls) and the called spans' `durationTotalMs`,
  `durationMeanMs` and `durationMaxMs`.

A span counts as a call when its parent is in the result and belongs to another service; calls
inside one service are not edges. Above 100,000 spans the step asks first
(`steps.trace_graph_large`) and runs with `"confirmLarge": true`.

```json
{ "id": "s2", "type": "serviceMap", "frame": "A" }
```

## Example

Two checkout requests, the first through `frontend`, `cart` (with a Redis call inside it) and a
`payment` call that fails, the second through `frontend` and `payment`:

- the span table has seven rows, one per span; the failed payment span has `status` `error` and
  `statusMessage` `card declined`; the trace table has two rows;
- the service map has the nodes `audit`, `cart`, `frontend` and `payment` and two edges:
  `frontend → cart` (one call) and `frontend → payment` (two calls, one error, 50 ms mean
  duration). The Redis call stays inside `cart`, and a span whose parent is missing is no call;
- the critical path of the first trace is the frontend, the payment, the cart and its Redis call:
  each of them was the last to finish before the next.

## Alerts on traces

An alert rule reduces a table, documents or a graph, never a raw trace: a rule whose query answers
a trace stops with "add a table step". Add a span table or a trace table to the rule's query, then
reduce that table.

## Exports

A trace exports as **OTLP JSON**, the format OpenTelemetry tools read back. For CSV or Excel, add a
span table or a trace table first.
