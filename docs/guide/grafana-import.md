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
- **Options**: see the next section. Every option goes only where the Kalzit panel's editor
  shows it, so an imported panel holds nothing its options do not show.

## Options: what maps and what does not

| Grafana | In Kalzit |
| --- | --- |
| Units (`currencyEUR`, `percent`, `percentunit`, `ms`, `s`, `bytes`, `decbytes`, `bps`, `binBps`, `short`, `none`, `reqps`, ...) | The same catalog unit (Euro, Percent, Bytes, ...). The ISO and US date formats become Kalzit's date and time in local time, reported as the nearest unit. Units without one, also those that scale in other steps (`kbytes`, `Bps` as SI bytes per second, `bits` and `binbps` as binary bits, `pps`, `rpm` as reads per minute, other currencies, `prefix:`), become a **Custom suffix** with their symbol and are reported; an unknown id is dropped and reported. |
| Decimals, min and max, display name, "no value" text | Taken over. |
| Thresholds | Colours become the nearest tone (green, yellow and orange, red, blue, purple) or stay a free colour; `transparent` becomes neutral and is reported. |
| Value mappings: value, range, regex | Taken over with text and tone on every panel with value mappings (stat, gauge, bar gauge, bar chart, pie chart, table, time series, state timeline, status history). Special matches (null, NaN, true, false, empty) are reported. |
| Field overrides by name, by a list of names, by regular expression | Overrides **With the name** or **Matching a regular expression**, with colour, unit, min and max, decimals, display name, value mappings, thresholds, line width and the other graph style options, cell display, column width and the first data link. Other matchers (by type, by query, by value) and other properties are reported. |
| Prometheus and Loki `legendFormat` | The time series' **Series names** template (`{{label}}` and text). Queries with different formats share the first one; other panel types report it. |
| Time series: draw style, line interpolation, line width, fill opacity, stacking (normal, percent), points, line style, gaps, bar alignment, threshold display (`line`, `area`, `line+area`; dashed becomes plain) | The graph style options of the same name. Axis labels, log scales and hiding series are reported. |
| Colour schemes | On time series: palette, fixed colour, thresholds, `shades` (single colour) and the continuous schemes (green-yellow-red, blues; others become the nearest one and are reported). On bar charts the green-to-red schemes become threshold colours; other schemes are reported. |
| Legends (mode, placement, values) and tooltips (mode) | Taken over on time series, bar, pie chart, histogram, state timeline and status history. Legend values last, min, max and mean on time series and bar charts; others (sum, count, ...) are reported, as is the tooltip's sort order. |
| Stat, gauge, bar gauge, pie chart | Calculation (last, mean, min, max, sum; others reported), colour, graph and text mode, threshold markers, LCD display, orientation, value and name display, pie type and legend values. |
| Bar chart | Values shown or not. Horizontal bars and stacking are reported: Kalzit's bar chart stands upright with bars side by side. |
| Heatmap | Counting into buckets or reading buckets, bucket counts, the square root colour scale and the axis unit. Bucket sizes, log buckets and colour schemes are reported. |
| Table | The organize step's new names become each column's display name (overrides on the column's own name), cell types gauge, coloured background and coloured text become the cell display, column filters and widths. Hidden columns, the column order, the footer and the starting sort order are reported, as is every other transformation. |

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
