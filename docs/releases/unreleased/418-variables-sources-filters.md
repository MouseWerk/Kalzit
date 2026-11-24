## Improved

- Dashboards can have a data source variable: panels that use it switch to another source of the
  same kind from the filter bar. Everyone sees the saved default; picking another source needs
  your own right to query it.
- Dashboards can have ad hoc filters: field, comparison and value, built into every query of
  their data source by the server. They work with Prometheus, Loki, Elasticsearch and OpenSearch,
  and with SQL queries that write `$__filter`. Values always go in as parameters or escaped text.
- Dashboards can have a switch variable that sends one of two fixed values.
