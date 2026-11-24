English | [Deutsch](de/grafana-import.md)

# Importing Grafana dashboards

Kalzit converts dashboards exported from Grafana as JSON into Kalzit dashboards. The import reads
the JSON file only: no query runs and no data source is contacted. Each data source of the
dashboard is mapped to a Kalzit data source by you. The import covers dashboards; alerts, users,
data sources and other Grafana content are not imported.

## What is read

- The classic dashboard JSON, `schemaVersion` 6 to 41: the old layout with `rows` and widths in
  twelfths (before 16) is laid out on the 24-column grid, the `gridPos` layout is taken over as
  it is. An export that wraps the dashboard (`{ "dashboard": ..., "meta": ... }`) works too.
  Grafana's newer schema (v2, `elements` and `layouts`) is refused with a message; export the
  dashboard as classic JSON in Grafana instead.
- **Panels** with a Kalzit counterpart: time series (also the old graph panel), stat (also the
  old singlestat), gauge, bar gauge, table (also the old table), pie chart, bar chart, heatmap,
  histogram, state timeline, status history, text and node graph (as a network panel). Other
  panel types and library panels are skipped, and skipped panels are left out, not kept as
  empty places. A panel none of whose queries could be converted is skipped too.
- **Queries** for Prometheus (PromQL), Loki (LogQL), PostgreSQL, MySQL, SQL Server, SQLite and
  ClickHouse (the SQL text; `$__timeFilter`, `$__timeFrom`, `$__timeTo` and `$__interval` work in
  Kalzit, other macros are reported), Elasticsearch (the Lucene query; aggregations are reported)
  and InfluxDB (InfluxQL or Flux text). Queries made with Grafana's query builders without text
  are skipped. `[[name]]` becomes `$name`; formats such as `${name:csv}` are dropped, since Kalzit
  binds variable values as parameters.
- **Variables**: custom, query (with the query in the mapped source's language), constant,
  textbox and interval, with "All" (`includeAll`, its custom value and a saved selection of
  "All"), typed values (`allowCustomValue`), and for query variables the regex, the sort order
  (natural sorting becomes sorting by name) and when the values are read again. A regex Kalzit
  cannot run (lookaround, backreferences) is left out and reported. Data source and ad hoc
  variables and Grafana's helper functions (`label_values(...)`) are skipped.
- **Rows** with their title, collapsed state and repeat, **repeats** of panels, **annotation
  queries** (not Grafana's built-in ones), **links**, **tags** and the **time settings**: range,
  refresh, time zone, week start, fiscal year, now delay, refresh intervals and the shared
  crosshair or tooltip.
- **Options**: units, decimals, min and max, display name, "no value" text and thresholds
  (colours become the nearest tone); the main options of stat, gauge, bar gauge, pie chart and
  time series legends and tooltips. Value mappings, field overrides and other display options are
  reported as not carried.

## The report

Every item gets a line: **converted**, **approximated** (with what changed) or **skipped** (with
the reason). The report is kept with the dashboard; the API serves it at
`GET /api/orgs/{orgId}/dashboards/{dashboardId}/import-report`. The converted dashboard goes
through the same checks as every save, including the right to query each mapped data source.

## In the interface

**Dashboards > Import from Grafana** leads through three steps. First the file: upload it or
paste its JSON, name the dashboard and choose its folder. Then the data sources: each one the
file names gets one of Kalzit's, proposed by name and kind, or is left out, which skips its
panels. Last the report, before anything exists; **Import** creates the dashboard and opens it
with a line that leads back to the report (the dashboard's address with `/import-report`).

## From the command line

```text
kalzit provision import-grafana lager.json --server https://kalzit.example.com --org ID \
  --map '${DS_LAGER}=0199...' --map prom-uid=0199... [--folder-id ID] [--dry-run] [--output json]
```

`kalzit import grafana` is the same command. `--map` maps a Grafana data source to the id of a Kalzit data source: by its uid, its name, the
`${DS_X}` input of an export, or `default` for panels without one. `--dry-run` converts and shows
the report without saving. The token comes from `KALZIT_API_TOKEN`, as for
[provisioning](provisioning.md); the role needs `dashboards:write` where the dashboard goes and
`datasources:query` on the mapped sources.

The API route is `POST /api/orgs/{orgId}/dashboards/import/grafana` with
`{ dashboard, datasources: { <grafana>: <kalzit id> }, folderId?, dryRun? }`; it answers the
report, the converted model and the saved dashboard.

To keep an imported dashboard as code, export it with `kalzit provision export` afterwards.
