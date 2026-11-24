## Improved

- Query variables on Prometheus sources offer four helpers instead of a typed query: label
  values, label names, metrics and query result. The query behind the helper stays visible.
- The Grafana import takes over `label_values(...)`, `label_names(...)`, `metrics(...)` and
  `query_result(...)` on Prometheus sources, data source variables, ad hoc filters, and custom
  variables with two values such as `true, false` as switches. The report says what changed.

## Checklist for Windows (manual)

- Create a query variable on a Prometheus source with "Label-Werte" and check the preview.
- Import a Grafana dashboard with a `label_values(...)` variable and an ad hoc filter.
