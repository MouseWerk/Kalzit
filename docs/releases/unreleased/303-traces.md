## Improved

- New data sources Tempo and Jaeger (its query service). A search needs no query language:
  service, operation, tags, duration and status; it lists the traces found as a table, and for
  Tempo shows the TraceQL Kalzit wrote for it. A trace id shows the whole trace. Services,
  operations and tag values come as tables too, for dashboard variables. Both sources only read:
  Kalzit never reaches their span receivers. See [Data sources](../../guide/data-sources.md#tempo).
- Traces are a shape of their own next to tables, documents and graphs: spans with their service,
  operation, kind, start, duration, status, attributes, events, links, resource and scope. A trace
  keeps up to 10,000 spans and always keeps its root and its error spans. Steps work on it: filter
  spans, the critical path, a span table, a trace table, the service map and the span tree. For
  now they are set in a panel's steps through the API; the trace screens with their own editors
  follow. See [Traces](../../guide/traces.md).
- Traces export as OTLP JSON. An alert rule on a trace source reduces a span table or a trace
  table and says so when the step is missing.
