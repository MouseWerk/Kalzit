# Kalzit: depth of options and control

A gap analysis between Grafana and Kalzit as it is on `main` (2026-10-23, after #24), and a plan
to reach and then exceed Grafana's depth in Kalzit's own design language. The owner asked for
"state-of-the-art, advanced, deep options and control". `docs/design/feel.md` covers look, density
and speed; this file covers what a user can set, see and control.

## 1. Method and rules

- **Reference.** The public demo at play.grafana.org, browsed read-only and signed out on
  2026-10-23. It reported version 13.3 (a Cloud build). Where the demo hides an area from signed-out
  visitors (data source settings, administration, plugin catalog, alerting), the public
  documentation and release notes of the 12.x and 13.x lines were the source.
- **Clean room.** This file describes capabilities in our own words. It quotes no text and contains
  no screenshots, code or logos. The reference screenshots stay outside the repository, in a local
  scratch folder of the researcher. Nothing in the product is to be copied from them: layouts,
  names and wording are Kalzit's own and follow `feel.md` and the guidelines.
- **Kalzit's state.** Read from the code on `main`, with file references. The open PRs are marked
  where they close a gap: #32 (rows, repeats, annotations, links, playlists, library panels, kiosk,
  JSON model) and #27 (document panels, pipeline editor).
- **Gap size.** `none`: on par or ahead. `S`: one focused change. `M`: one PR of real work. `L`:
  several PRs or a new subsystem.
- **Principles every recommendation keeps** (CLAUDE.md, PLAN, ARCHITECTURE):
  1. Native shapes. `frame`, `documents` and `graph` stay what they are. Options for documents
     address field paths, options for graphs address labels, edge types and properties.
  2. Explicit projection. Every conversion is a visible step in the panel's `transformations`,
     never an implicit backend behaviour.
  3. Read-only sources. Nothing in the UI may write to a data source, not even as an "action".
  4. Server-side authorization and validation. Every new option is checked in
     `server/src/dashboards/panel_options.rs` with the same bounds the UI uses. Every new step runs
     in both engines and passes `server/src/analysis/conformance.json`.
  5. Neutral states. Selection, current and active are tint and weight, never accent borders, glows
     or left bars. That holds for option panes, tabs, graph selection and legends.

## 2. Summary

Kalzit is already broad: 15 panel types including three graph panels, shared field options with
overrides, ten analysis steps that run identically in the browser and on the server, versions with
diff, trash, restricted folders, custom roles with a "why can I" explanation, an audit log, and
read-only guards per engine. Few dashboard tools explain permissions or guarantee read-only
queries this well.

Where Kalzit is thin is **control within one panel and one dashboard**. The reference offers about
55 options on a single time series panel, while Kalzit's time series has four (series name
template, line width, legend, tooltip). The reference editor is a full page with option search;
Kalzit's is a modal. The reference variables, time picker, inspector and Explore each offer
several times the controls Kalzit has. The fifteen largest gaps, in the order they should close:

| # | Gap | Size | Roadmap |
|---|---|---|---|
| 1 | The panel editor is a modal: no option search, no "changed only" or overrides view, no table view toggle, no resizable splits, and typing lags | L | P1-1 |
| 2 | Time series draw styles: bars and points, interpolation, fill and gradient, line style, show points, null handling and gap connection, stacking | M | P1-3a |
| 3 | Axes: placement, label, width, soft min and max, log and symlog scales, centered zero, several value axes by unit, grid control | M | P1-3b |
| 4 | Legend and tooltip depth: the full reducer catalog as legend values, sort by column, click to isolate or hide a series, tooltip sort, hide zeros, shared crosshair across panels | M | P1-3c, P1-2 |
| 5 | Dashboard toolbar and time picker: breadcrumb header with icon buttons and overflow menu, shift and zoom the range, recent ranges, quick range search, copy and paste a range, per-dashboard time zone, week start, fiscal year, now delay, custom refresh intervals | M | P1-2 |
| 6 | Query options per panel: hide a query, max data points, minimum interval, relative time and time shift (#32 adds the last two), cache time | M | P2-1 |
| 7 | Inspector: a data tab (formatted or raw, per query or after steps, download), stats (timing, rows, bytes), request and response, panel JSON and result JSON | M | P2-1 |
| 8 | Overrides: matchers by field type, by query, by value condition and by shape-native selectors; per-series overrides of visualization options (axis, draw style, stacking group, hide in legend) | M | P2-2 |
| 9 | Variables: multi-value with include all, regex filter, sort, refresh policy, chained variables, data source variable, ad hoc filters, group-by, switch, formatting of values, placement | L | P2-5, P2-6 |
| 10 | Color: schemes (single, palette, by value with continuous and shades), threshold display on charts (lines, areas), a larger unit catalog, per-field min and max, display name templates, special value mappings | M | P2-3, P2-4 |
| 11 | Data links everywhere: field links with variables in every panel, panel links, links to Explore with the query and range (#32 adds dashboard and panel links) | M | P2-7 |
| 12 | Explore: several queries, mixed sources, split view with linked time, query history with stars and search, result tabs | M | P2-8 |
| 13 | Analysis step catalog: organize (rename, reorder, hide), filter rows, filter fields, sort, limit, convert type, format, labels to fields, merge and concatenate, extract JSON, partition, histogram, config from results; a per-step preview | L | P2-9 |
| 14 | Dashboard layout: tabs, an automatic grid, show and hide rules for panels and rows, an outline of the dashboard (rows, repeats and library panels are in #32) | M | P3-1 |
| 15 | Sharing: link with time and variables, image export, snapshots, public links (M6), embed; plus service accounts and a plugin catalog in administration | L | P3-2 to P3-4, P3-9, M4 to M6 |

## 3. Matrices

### 3.1 Panel editor

| Grafana capability | Kalzit today | Gap | Recommendation |
|---|---|---|---|
| Full-page editor: preview on top, queries below, options on the right; splits resizable and collapsible | Partial: modal dialog with preview, settings, queries and steps stacked (`ui/src/features/dashboards/PanelEditor.tsx`) | L | Full-page route as `feel.md` section 5 plans. Splits remember their size per user. Round 3 |
| Lower pane tabs for queries, transformations and alert rules, with counts | Partial: queries and steps both shown, no tabs (`PanelEditor.tsx`, `ui/src/analysis/StepsEditor.tsx`) | M | Tabs "Queries (n)", "Steps (n)"; a third "Rules" tab arrives with M6 alerting. Counts in the tab, no colored badges |
| Options pane search that matches across groups and shows "n of m options" | No | M | Search over every option label and hint in both languages; matches show with their group path. Round 3 |
| Collapsible option groups | Partial: field option sections are `<details>` (`ui/src/panels/fieldConfig/FieldConfigEditor.tsx`); the panel's own options are a flat list | S | One group component for both; groups remember open state per panel type |
| Views "All", "Overrides" and a filter for changed options | No | M | Three views: All, Changed (only non-default values, with reset per option), Overrides. Kalzit goes further with "Changed", which the reference lacks as a view |
| Table view toggle: the raw result as a table over the preview | No | S | Toggle above the preview. For `documents` it shows the document tree and for `graph` the node and edge tables (`ui/src/panels/graph/GraphTable.tsx`), so the raw view keeps the native shape |
| Visualization picker with suggestions from the data | Partial: picker with shapes-first order and previews (`ui/src/panels/picker/PanelPicker.tsx`; `suggestPanel` in `ui/src/panels/registry.ts`) | S | Add a "Suggested" row rendered from the actual result (small live previews) |
| Panel title, description shown as a hint or subtitle, transparent background | Partial: title only | S | Description (Markdown, shown on hover of an info icon or as a subtitle) and transparent background. Server-checked |
| Panel links, repeat options, show and hide rules in the editor | No (#32 adds panel links and repeats) | M | Groups in the options pane once #32 lands; show and hide rules in P3-1 |
| Discard, apply and save from the editor; back keeps the change unsaved | Partial: Apply and Cancel in the dialog | S | Back (Esc) applies to the draft, Discard reverts the panel, Save saves the dashboard. Matches `feel.md` |
| Editor responsiveness | Partial: every keystroke re-renders the whole editor (`feel.md` section 10) | M | `feel.md` section 10 fix 1 (state split, which also gives the preview a memoized panel) and fix 4 (full-page editor instead of the modal), with the e2e budget of fix 5. Round 3 |

### 3.2 Field options

| Grafana capability | Kalzit today | Gap | Recommendation |
|---|---|---|---|
| Unit catalog with hundreds of units in groups, plus custom prefix, suffix and SI | Partial: 41 units (30 fixed plus 11 currencies) in 8 groups and a custom suffix (`ui/src/panels/fieldConfig/units.ts`) | M | More currencies first (any ISO 4217 code through Intl), then the rest of the common set (length, mass, area, volume, pressure, speed, more throughput and duration formats). Add a custom prefix and an SI-scaled custom unit. Keep Intl formatting |
| Min, max, per-field min and max | Partial: min and max (`fieldConfig.ts`); no per-field range | S | A "range per field" switch, so gauges and colors scale each field to its own extent |
| Decimals, display name, no value text | Yes (`fieldConfig.ts` `parseFieldOptions`) | none | |
| Display name templates (field name, labels, query) | No: the display name is fixed text; only the time series has a series name template with `{{label}}` (`timeseries/index.tsx` `seriesName`) | S | Templates in the display name, in the series name template's `{{...}}` syntax (labels, plus reserved names such as `{{field}}` and `{{query}}`), checked the same way |
| Color scheme: fixed color, palette, single-hue shades, by value as continuous gradients or from thresholds | Partial: a fixed tone from 12 tokens (`TONES`) | M | Schemes: palette (default), fixed tone, shades of one tone, from thresholds, continuous sequential and diverging (validated ramps from `--chart-*`, 3:1 against the panel). The palette stays the default; a color picker allows any color per series, threshold step or override, stored as hex (decision 1, section 6) |
| Thresholds: absolute and percentage, any number of steps, shown on charts as lines, areas or dashed | Partial: modes and up to 20 steps (`fieldConfig.ts`); not drawn on time series | S | "Show thresholds" on time series and bars: off, lines, dashed lines, areas, lines and areas. Areas use the tone's low-alpha fill token |
| Value mappings: value, range, regex, special values (null, NaN, true, false, empty) | Partial: value, range, regex (`fieldConfig.ts` `ValueMapping`) | S | Add the special matcher, and an icon per mapping for state panels |
| Data links per field with variables (`${__value}`, field, series, time range); several links; open in new tab | Partial: one table cell link with `${__value}` and `${__field}` (`fieldConfig.ts` `cellLink`) | M | Links on every panel that shows fields, nodes or documents, with typed placeholders (value, field, series labels, time from and to, dashboard variables, document path, node property). `isSafeHref` stays the gate. Clean room: Kalzit's existing `${__value}` and `${__field}` names are its own and stay for compatibility, but new placeholders get no further `__`-prefixed names; they use one Kalzit syntax shared with the series name template (`{{value}}`, `{{field}}`, `{{label.job}}`, `{{time.from}}`, `{{node.name}}`). See P2-7 |
| Actions: buttons that call an HTTP endpoint from a panel | No | none | Deliberately not built: Kalzit never writes through a panel. A link can open another system; it cannot post to it |
| Overrides with matchers by name, regex, type, query, field value condition | Partial: by name and regex (`fieldConfig.ts` `FieldMatcher`) | M | Add by type (`number`, `time`, `string`, ...), by query (refId), and by value condition (reducer plus comparison, such as "max over 100"). Documents: by path pattern. Graphs: by node label, edge type, property key |
| Override properties include visualization-specific options | No: only shared field options | M | Each panel declares which of its own options are per field (axis placement, draw style, fill, stack group, line style, hide from legend or tooltip). The editor offers them in an override; the server checks them |
| Config from query results (a result row sets min, max, thresholds) | No | M | An analysis step "configure from results" whose output is field options, visible as a step, not a hidden link |

### 3.3 Visualization options

| Grafana capability | Kalzit today | Gap | Recommendation |
|---|---|---|---|
| Time series styles: lines, bars, points; interpolation linear, smooth, step before and after; line width; fill opacity; gradient by opacity, hue or scheme; line style solid, dashed, dotted; show points auto, always, never; point size; bar alignment | Partial: lines and line width (`ui/src/panels/timeseries/index.tsx` `TimeSeriesOptions`) | M | All of these, drawn by uPlot paths. Defaults stay monochrome per `feel.md` section 8 (hatch under the main line, dashed comparison). Round 3 for the defaults |
| Null handling: connect gaps never, always or below a threshold; disconnect after a threshold; treat null as zero | No: nulls break the line (`timeseries/align.ts`) | S | "Connect gaps" and "Break after" with a duration input; "null as zero" as an analysis step, not a draw option, so exports match |
| Stacking: off, normal, 100 %; stack groups per series | No | S | Off, normal, percent; groups through overrides |
| Axes: placement auto, left, right, hidden; label; width; soft min and max; scale linear, log (base 2 or 10), symlog; centered zero; grid lines; axis color from series; several axes by unit | Partial: one left axis that follows the first series' unit (`timeseries/index.tsx`) | M | All of these. Several axes appear automatically per distinct unit, placement per override. Grid lines default to the faint horizontal grid of `feel.md` |
| Legend: list or table, bottom or right, width, limit, values from the reducer catalog, sort by a column, click to isolate, ctrl-click to add, filter by label | Partial: list, table or hidden; bottom or right; last, min, max, mean (`ui/src/panels/fieldConfig/legendOptions.ts`) | M | Shared reducer catalog (see 3.4), sort by any legend column, click to isolate and modifier-click to toggle, a legend width and limit. Isolation is a view state, never saved unless asked |
| Tooltip: single, all, hidden; sort; hide zeros; hover distance; max size | Partial: single, all, hidden (`legendOptions.ts`) | S | Sort and hide zeros; the tooltip reads values from the same formatter |
| Shared crosshair or shared tooltip across a dashboard's panels | No | S | A dashboard setting; time-based panels draw a cursor at the same time. Keyboard readout follows too |
| Stat: color mode, graph mode, text mode, orientation, text size, justify, show percent change | Partial: reducer, color mode, graph mode, text mode (`ui/src/panels/stat/index.tsx`) | S | Percent change against the previous period (from the `compare` step), orientation, text size |
| Table: column filter, pagination, cell display (color text, background, gauge, link, image, JSON, sparkline), column width, footer with reducers, sort, frozen header, wrap | Partial: filters, pagination, cell display (auto, color text and background, gauge, link), width (`ui/src/panels/table/index.tsx`) | M | Footer with reducers, sparkline and JSON cells, wrap, column reorder, row height, frozen first column |
| Bar chart, gauge, bar gauge, pie, histogram, heatmap, state timeline, status history, text | Yes, with basic options each (`ui/src/panels/*/index.tsx`) | S to M each | Fill per type as the shared groups above land; heatmap color scales and bucket bounds; bar chart orientation, grouping and stacking |
| Further panel types: logs, traces, node graph, geomap, candlestick, XY chart, trend, flame graph, canvas, news, dashboard list, annotations list, alert list | Partial: network, hierarchy and path cover graphs; others no | L | Next by value for Kalzit's audience: XY chart (correlation), dashboard list, geo (with #27 documents), logs (M5 with Loki), traces as a graph of spans (M6). Canvas and news are low priority |
| Panel styles: one-click presets of option sets | No | S | "Looks" in the picker: two or three presets per panel type built from Kalzit's defaults |

### 3.4 Transformations and analysis steps

The reference catalog (about forty entries) next to Kalzit's steps (`ui/src/analysis/steps.ts`,
`server/src/analysis/steps.rs`):

| Grafana capability | Kalzit today | Gap | Recommendation |
|---|---|---|---|
| Add field from calculation (binary, unary, reduce row, cumulative, window, row index) | Yes, stronger: `calculate` with a typed expression language (`ui/src/analysis/expr.ts`), `movingAverage`, `trend` | none | Add cumulative and window functions to the language and a row index |
| Reduce rows to one value; series to rows | Yes: `reduce`. But there are several catalogs today: `Stat` for the `reduce` step and `Agg` for the `group` step are two separate lists (`ui/src/analysis/steps.ts`), the panels have their own `REDUCERS` (`ui/src/panels/reduce.ts`) and the legend its own four values | S | Merge them into one reducer catalog used by steps, legend, stat and table footer (P1-3c): count, sum, mean, median, min, max, range, first, last, first and last non-null, delta, step, difference, standard deviation, variance, percentiles, distinct count, change count, all nulls, all zeros |
| Group by, group to matrix, pivot | Yes: `group`, `pivot` | none | Keep pushdown to the database as the next step (ARCHITECTURE) |
| Join by field, join by labels, merge, concatenate | Partial: `join` by time or key with inner, left and outer modes (`JoinMode` in `ui/src/analysis/steps.ts`) | S | Only merge and concatenate are missing: one step with a mode |
| Organize fields: rename, reorder, hide | No | S | "Fields" step: rename, reorder, hide, with the renames visible as a list |
| Filter rows by values; filter fields by name or regex; filter by query | No | S | "Filter rows" with conditions on fields (also through the expression language), "Pick fields" by name, regex or refId |
| Sort by, limit | No | S | "Sort" and "Limit" steps |
| Convert field type, format time, format string | No | S | "Convert" step (number, text, time with a format, bool, enum); formats run in UTC in both engines per conformance |
| Labels to fields, rows to fields, partition by values, prepare time series (wide to long and back) | No | M | "Reshape" step with these modes, documented with before and after examples |
| Extract fields from JSON or key-value text; lookup from a resource | No | S | "Extract" step for `json` fields in frames. For documents the projection already does this natively and better |
| Histogram, create heatmap, trendline (regression) | Partial: the histogram and heatmap panels bucket themselves; `trend` | S | Bucketing as a step, so exports hold the buckets the panel shows |
| Config from query results | No | M | See 3.2 |
| SQL over query results | No | M | Not now. The expression language and steps cover it without a second evaluator. Revisit after the step catalog lands |
| Debug view per transformation, disable, reorder, help | Partial: disable and order (`StepsEditor.tsx`) | S | Per-step preview (input and output as a small table) and a short help per step. Kalzit goes further: document and graph steps keep their native preview |
| Correlation, comparison with the previous period | Kalzit only: `correlate`, `compare` | ahead | Keep and surface in the stat panel ("change against last week") |

### 3.5 Query editors and query options

| Grafana capability | Kalzit today | Gap | Recommendation |
|---|---|---|---|
| Builder and code modes for SQL and PromQL; schema browser; macros; autocompletion | Partial: code editors with schema completion and macro lists for SQL, PromQL, Cypher, GSQL, Lucene and Query DSL; form editors for MongoDB, files and HTTP JSON (`ui/src/features/datasources/editors/`) | M | A builder mode for SQL (table, columns, filters, group, order, limit) that writes visible SQL; a metric and label browser for PromQL; Cypher pattern builder per PLAN section 4. Builders produce text the user can read and edit, never a hidden form |
| Several queries per panel, each from any data source (mixed) | Yes: each target has its own source (`PanelEditor.tsx` `TargetEditor`) | none | Show the kind mark per target header (`feel.md` section 11) |
| Hide a query, duplicate, reorder, collapse, rename the refId | Partial: add and remove | S | Hide (runs but not drawn, still usable by steps), duplicate, drag to reorder, collapse, rename refId with step references updated |
| Query options: max data points, minimum interval, computed interval shown, relative time, time shift, hide time info, cache timeout | Partial: interval is computed (`timeRange.ts` `intervalFor`); relative time and time shift in #32 | M | Per-panel options row under the queries with the computed interval and the effective range. Server checks bounds. Cache timeout only once a query cache exists |
| Query cache | No | M | A server-side cache keyed by source, query text, bound parameters and the resolved range bucket, per organization, never across permission boundaries. Later milestone (M5) |
| Expressions: math across queries, reduce, resample, classic conditions, threshold, SQL | Partial: `calculate` and `join` across refIds | S | Resample (align two series to one interval) as a step; everything else already has a step |
| Saved queries, add from saved queries | No | M | Saved analyses (PLAN M2) cover it: a query plus its steps as a named, permissioned object |
| Query inspector reachable from the editor | Partial: Inspect shows executed text, notices, size (`ui/src/features/dashboards/ui/Inspect.tsx`) | M | See 3.6 |

### 3.6 Inspect

| Grafana capability | Kalzit today | Gap | Recommendation |
|---|---|---|---|
| Data tab: result as a table per query or joined, formatted or raw values, after transformations or before, download CSV or Excel | No | M | "Data" tab with a query picker, "after steps" switch, formatted switch. Download goes through the existing export route (`data:export`, audited), so a file always equals what the panel shows |
| Stats tab: execution time, rows, bytes, time to process | Partial: rows and fields (`Inspect.tsx`) | S | Add server time, source time, steps time, bytes, truncation |
| Query tab: request and response as sent and received | Partial: executed statement with macros expanded | S | Add the request body (without secrets) and the response envelope, collapsed by default |
| JSON tab: panel model, panel data, data frames | No (#32 adds the dashboard JSON model) | S | Panel JSON (editable for editors, validated by the server on apply) and the result envelope JSON in its native shape |
| Metadata tab | Partial: notices | none | Keep notices in the Query tab |

### 3.7 Dashboards

| Grafana capability | Kalzit today | Gap | Recommendation |
|---|---|---|---|
| Settings: title, description, tags, folder, editable or read-only, time options, graph tooltip, preload, JSON model | Partial: title, refresh, variables (`ui/src/features/dashboards/SettingsDialog.tsx`); JSON model in #32 | M | Description, tags (with tag filter in the list), editable switch, time options (zone, week start, now delay, refresh list, hide picker), shared crosshair or tooltip |
| Edit pane for the dashboard and the selected element (panel, row, variable) next to the canvas | No | M | After the full-page editor: a right pane in dashboard edit mode that edits the selected item in place. Same option components as the panel editor |
| Variables: query, custom, textbox, constant, data source, interval, ad hoc filters, group-by, switch | Partial: custom, textbox, query; constant and interval kept (`model.ts` `VARIABLE_TYPES`) | L | Add interval in the UI, data source (by kind), ad hoc filters (per source kind, bound as parameters), group-by, switch. Every value stays a bind parameter; identifiers only from the schema allow-list |
| Variable options: multi-value, include all with a custom all value, regex filter and capture, sort, refresh on load or time change, hide, description, display placement | No | L | All of these; multi-value expands to a parameter list for SQL `IN`, to arrays for Mongo and Cypher. Regex is RE2 in both places |
| Chained variables, value formatting (CSV, pipe, JSON, regex, glob, raw) | No | M | Chaining by referencing a variable in a query variable; formats only where the source needs text, otherwise parameters |
| Annotations: built-in, from queries, per-panel filter, colors | No (#32) | after #32 | Extend to document and graph sources (annotation from a document field or a node property) |
| Links: dashboard links by tag, URL links, panel links | No (#32) | after #32 | Keep `isSafeHref` as the gate |
| Versions with diff and restore | Yes (`VersionsPage.tsx`, `diff.ts`) | none | Add a JSON diff view next to the structural diff |
| Permissions per dashboard and folder | Yes: grants, restricted folders, "why can I" (`accessIntegration.tsx`, `ui/src/features/admin/access/`) | ahead | Keep; Kalzit's explanation of the source of a right is deeper than the reference |
| Time picker: quick ranges with search, recent ranges, absolute with calendar, copy and paste, shift back and forward, zoom out, time zone per dashboard, fiscal year start, week start | Partial: presets, absolute from and to, user time zone and week start (`TimeRangePicker.tsx`, `timeRange.ts`, `ui/src/lib/timeSettings.ts`) | M | All of these. Fiscal year adds the `fy` unit to the range grammar on both sides; zoom by dragging on a time series sets the range. Round 3 for the toolbar placement |
| Refresh: interval list, auto, live updates | Partial: fixed list (`refresh.ts`) | S | List from the dashboard settings within a server minimum; "auto" from the range and width |
| Rows, repeats, library panels | No (#32) | after #32 | |
| Tabs, automatic grid, show and hide rules, outline | No | M | P3-1 |
| Dashboard browse: folders tree, search, tags, starred, recently viewed, list and folder views, sort, trash | Partial: folder tree, search, starred, recent on start page, trash (`DashboardsPage.tsx`, `FolderTree.tsx`, `TrashPage.tsx`) | S | Tags, sort, a filter by owner and "shared with me" |
| Playlists, kiosk and TV modes, single panel view | No (#32) | after #32 | |
| Share: link with time and variables, short link, export JSON with source mapping, image export, embed, snapshot, public link | Partial: org-internal grants; export of data (`ui/src/analysis/ExportDialog.tsx`); JSON export and import in #32 | L | P3-2. Public links are M6 and a separate permission (CLAUDE.md) |
| Keyboard shortcuts | Yes: palette, help, panel move and resize, run, undo (`ui/src/shell/ShortcutsHelp.tsx`) | S | Add `e`, `v`, `i` on the hovered panel, `t` with arrows to shift time, `t z` to zoom out, `d r` to refresh, Ctrl+S to save |

### 3.8 Explore

| Grafana capability | Kalzit today | Gap | Recommendation |
|---|---|---|---|
| Several queries, mixed sources | No: one query (`ui/src/features/explore/ExplorePage.tsx`, `REF_ID`) | S | Reuse the editor's target list |
| Split view with two panes, linked time ranges | No | M | Two panes side by side on wide screens, a link toggle for time. Round 3 places it in the toolbar row |
| Query history: per user, search, filter by source, star, comment, retention | No | M | Server-side history per user and organization, private to its owner, kept 30 days by default (a server setting), starred entries kept beyond that (decision 2, section 6). Comments are in: a short private note per entry, visible only to its owner |
| Result tabs and outline: graph, table, logs, traces, raw | Partial: one panel chosen from the result, steps available | S | Tabs by shape: Chart and Table for frames, Tree and Schema for documents (#27), Network and Tables for graphs |
| Add to dashboard, create a panel from the result | Yes (`AddToDashboardDialog.tsx`) | none | |
| Logs UI: volume histogram, level filter, dedup, wrap, prettify, details with field links, live tail | No | L | M5 with Loki. Logs arrive as frames with log lines; the logs view is a panel, so it works in dashboards too |
| Traces UI: waterfall, span details, service graph | No | L | M6. Traces become `graph` (span tree); the waterfall is a graph panel layout, the service graph is the network panel |
| Correlations: links from a field in one source to a query in another | No | M | Data links with "open in Explore with this query" cover the core; an admin-level correlation registry later |

### 3.9 Data sources and administration

| Grafana capability | Kalzit today | Gap | Recommendation |
|---|---|---|---|
| Data source settings: connection, auth, TLS, timeouts, limits, custom headers, proxy, default source, test | Yes: per-kind settings with secrets, TLS, limits, test (`ui/src/features/datasources/DataSourceForm.tsx`) | S | A default source per organization; custom headers for HTTP kinds (no auth headers in plain settings); two-column layout per `feel.md` |
| Data source permissions: who may query, who may edit | Yes: grants per source with query, edit, admin (`ARCHITECTURE.md`, "Authorization") | ahead | |
| Data source health and usage (dashboards using a source) | Partial: health test | S | A health column with last check and a "used by" list |
| Users, teams, roles, organizations, server settings, audit | Yes (`ui/src/features/admin/`) | none | Table density and row actions per `feel.md` |
| Service accounts and tokens with scopes and expiry | No (M5) | M | Per PLAN M5 |
| Org preferences: home dashboard, theme, time zone, week start, language | Partial: user preferences and start dashboard (`ui/src/preferences/`) | S | Org defaults that user preferences override |
| Auth providers: OIDC, LDAP, SAML | No (M5) | L | Per PLAN M5, with the explicit Save and per-field errors that CLAUDE.md requires |
| Plugin catalog: browse, install, update, configure | No (M4) | L | Per PLAN M4, signatures enforced |
| Server stats and usage insights | No | S | Counts and a health page under "Verwaltung", no telemetry |
| Provisioning as code | No (M6) | M | Per PLAN M6 |

### 3.10 Alerting (summary)

The reference has alert rules with a query and condition editor in the panel editor, contact
points, notification policies with label routing, silences, mute timings, grouping, rule state
history and a list per folder. Kalzit plans alerting in M6 (PLAN section 12). Design notes for then:
rules reuse the panel's queries and steps (so a condition is a visible step), evaluate on the
server with the rule owner's rights checked at save like stored panel queries, and document and
graph conditions are native (a document count matching a filter, a node degree over a threshold).
The full-page editor reserves a third lower tab for rules.

## 4. Where Kalzit should differ or go further

- **Native shapes in every option.** Overrides, links and colors address document paths and graph
  labels and properties directly. The reference flattens documents and turns graphs into two
  tables first, so its options cannot do this.
- **Projection as the only bridge.** Every chart from documents or graphs shows its `toFrame` step.
  The panel editor shows a short notice "drawn through projection" with a link to the step.
- **Steps that match exports.** Every step runs in both engines and passes the conformance suite,
  so the CSV equals the panel. The inspector's Data tab and Download use the same path. The
  reference does transformations in the browser only, and exports can differ.
- **Provenance per value.** Kalzit can go further than the reference: a "where does this number
  come from" view on hover or in Inspect, listing query, steps and field options that produced a
  value. It follows from the explicit step model.
- **"Changed" view of options.** Alongside All and Overrides, a view of every option that differs
  from the default, with reset. It answers "why does this panel look like this" in one place.
- **No actions that write.** Read-only sources hold everywhere; panel buttons that post to an API
  are not built.
- **Accessible colors by default.** Schemes are validated, color-vision-safe ramps and tones, so
  the contrast theme and both schemes stay readable out of the box. A free color is possible per
  series, threshold or override (decision 1); then contrast and dark mode are the author's
  responsibility, and the picker warns where it cheaply can.
- **Permissions explained.** The "why can I" dialog stays ahead of the reference; extend it to
  variables and library panels.

## 5. Roadmap

Each numbered item is one PR that one agent can build; a series (P1-1, P1-3) is several PRs in
the given order. Items marked **(R3)** belong to **redesign round 3**: the phase 2 targets of
`feel.md` sections 13 and 14, namely the page header with breadcrumb and icon buttons plus an
overflow menu, the full-page panel editor (preview on top, queries and steps below, options pane
with search on the right, `feel.md` section 5), the editor lag fixes (`feel.md` section 10) and
the monochrome chart defaults (`feel.md` section 8). They should be designed together.

### P1: the next PRs

**P1-1 Full-page panel editor (R3), a series of three PRs.**

- **P1-1a Route, layout and lag fixes.** Route `/dashboards/$id/panels/$panelId/edit`; preview
  on top, lower pane with tabs Queries and Steps, options pane on the right (330 px, resizable,
  collapsible); `feel.md` section 10 fix 1 (state split: look and targets in separate state, stable
  `onChange` per refId, the preview built from a memoized panel) and fix 4 (full-page editor
  instead of the modal, CodeMirror views kept alive, uPlot updated with `setData` and `setSize`).
  Acceptance: Esc returns to the dashboard with the change in the draft; Discard and Save behave
  as in `feel.md`; typing 40 keys at 4x CPU throttling stays under 50 ms p95 Event Timing (e2e
  budget test, `feel.md` fix 5); splits remember their sizes; light, dark, contrast and 360 px
  layouts pass.
- **P1-1b Options pane: search and views.** One collapsible group component for panel and field
  options; search across every option label and hint in both languages with "n of m" and the
  group path; views All, Changed (with reset per option) and Overrides.
  Acceptance: searching "null" or "Lücken" finds the time series option "Connect gaps" (German
  "Lücken verbinden") under "Graph style" once P1-3a has added it, and before that searching
  "unit" or "Einheit" finds "Unit" under "Standard options"; Changed lists exactly the
  non-default options; i18n parity.
- **P1-1c Table view, description and background.** Table view toggle over the preview (frame
  table, document tree, graph node and edge tables); panel description (shown behind an info
  icon or as a subtitle) and transparent background.
  Acceptance: the table view never converts a shape; the server checks description length and
  the transparent flag; contract fixture updated.

**P1-2 Page header, dashboard toolbar and time picker (R3).** Breadcrumb header with icon
buttons and an overflow menu (history, access, settings, delete), Edit as a secondary button;
time picker with quick range search, recent ranges (per user, local), copy and paste a range,
shift back and forward, zoom out, drag-to-zoom on time series; per-dashboard time zone, week
start, fiscal year start and now delay; refresh list from settings; shared crosshair and shared
tooltip as a dashboard setting.
Acceptance: the range grammar gains the fiscal units on UI and server with tests at DST changes;
shift and zoom keep relative ranges relative where possible; keyboard shortcuts `t` plus arrows and
`t z` work and appear in the help; shared crosshair draws the same time on every time-based panel
within one frame; all icon buttons have names and tooltips; no accent states.

**P1-3 Time series depth (R3), a series of three PRs.** Every option of the series is in
`panel_options.rs` with the UI's bounds and in `ui/src/panels/contract.test.ts`, and contrast
tests cover new strokes and fills.

- **P1-3a Graph styles and monochrome defaults.** Draw style (lines, bars, points),
  interpolation, line width and style, fill opacity, gradient, show points and size, connect gaps
  and break after, stacking (off, normal, percent), threshold display; monochrome defaults per
  `feel.md` section 8.
  Acceptance: uPlot updates without rebuilding when only data or size change; stacking sums
  only aligned points and leaves gaps as gaps.
- **P1-3b Axes.** Placement, label, width, soft min and max, scale (linear, log 2 and 10,
  symlog), centered zero, grid lines, one axis per unit.
  Acceptance: log scales handle zero and negative values without throwing; two units give two
  axes without configuration.
- **P1-3c Legend, tooltip and one reducer catalog.** Today there are separate catalogs: the
  panels' `REDUCERS` (`ui/src/panels/reduce.ts`), `Stat` for the `reduce` step and `Agg` for the
  `group` step (`ui/src/analysis/steps.ts`), and the legend's own four values
  (`legendOptions.ts`). Merge them into one catalog used by legend, stat, table footer and both
  steps; legend sort and click to isolate; tooltip sort and hide zeros.
  Acceptance: both engines agree on every reducer in `conformance.json`; stored panels and steps
  with old reducer names keep working (upgrade test).

### P2

**P2-1 Query options and inspector.** Per-target hide, duplicate, reorder, refId rename (updating
step references); per-panel max data points and minimum interval with the computed interval shown;
relative time and time shift if #32 has not added them. Inspector tabs Data (query picker, after
steps, formatted, download through the export route), Stats, Query (request without secrets and
response), JSON (panel and result).
Acceptance: the server bounds the new query options; a hidden target runs and feeds steps but is
not drawn; the downloaded CSV equals the Data tab; viewers without `data:export` see no download;
secrets never appear in the Query tab (test).

**P2-2 Override matchers and per-field visualization options.** Matchers by type, refId, value
condition, document path pattern, node label, edge type; per-field visualization options declared
by each panel.
Acceptance: matchers are checked on the server; RE2 everywhere; overrides on graph panels apply
by label and edge type.

**P2-3 Color schemes and free colors.** Schemes (palette, fixed, shades, thresholds, continuous
sequential and diverging); a color picker for any color per series, threshold step and override,
stored as hex (decision 1).
Acceptance: the default palette and continuous schemes stay color-vision-safe and meet 3:1 in both
themes and the contrast theme (styles test); the server accepts only `#rrggbb` (or `#rrggbbaa`)
for free colors; the picker shows a contrast warning against the panel background of the current
theme when a color falls below 3:1; a free color is drawn as stored in every theme (the author's
responsibility, said in the picker's hint).

**P2-4 Field option details.** Special value mappings, per-field range, display name templates,
more currencies and the remaining common units.
Acceptance: templates use Kalzit's own placeholder syntax (see 3.2), checked like the series name
template; every unit formats through Intl in both languages.

**P2-5 Variables: selection options.** Interval and data source variables in the UI,
multi-value, include all with a custom all value, regex filter and capture (RE2), sort, refresh on
load or time change, hide, description.
Acceptance: multi-values reach every engine as parameter lists or arrays, never as text in a
query (guard tests); URL state round-trips every variable.

**P2-6 Variables: chaining, filters and switch.** Chained variables, value formats where a source
needs text, ad hoc filters and group-by for SQL, Mongo and Cypher, switch variable.
Acceptance: identifiers only from the schema allow-list; chained refresh has no cycles (rejected
at save); ad hoc filters are bound as parameters on every engine (guard tests).

**P2-7 Data links everywhere.** Field links on all panels with typed placeholders (value, field,
labels, time range, variables, document path, node property), several links per field, panel
links (#32), "open in Explore" with query and range.
Acceptance: `isSafeHref` gates every link; placeholders are URL-encoded; a test refuses
`javascript:`, `data:`, `//` and control characters on each panel type.

**P2-8 Explore depth.** Several queries with mixed sources, split view with linked time, server
query history per user (search, filter by source, star, and a short private note per entry),
result tabs by shape.
Acceptance: history and its notes are visible only to their owner, and no route lets an admin
read another user's history (API test); unstarred entries are deleted after the retention in the
server setting (default 30 days, decision 2), starred entries are kept; history is deleted with
the user; the audit log is unaffected; split state lives in the URL; both panes keep the editor
responsive under the P1-1a budget.

**P2-9 Analysis step catalog, round 2.** Fields (rename, reorder, hide), filter rows, pick fields,
sort, limit, convert, reshape (labels to fields, rows to fields, partition, wide and long), merge
and concatenate, extract JSON, bucket (histogram and heatmap), configure from results, resample;
per-step preview and help.
Acceptance: each step runs in both engines and has conformance cases; export equals panel; the
step limits of ARCHITECTURE ("Analysis steps and export") hold. If the catalog grows too large for
one review, split it at "reshape".

### P3

**P3-1 Dashboard layout and edit pane.** Tabs, an automatic grid mode, show and hide rules for
panels, rows and tabs (by variable value, by data presence, by width), an outline of the
dashboard, and a right-hand edit pane for the selected element in dashboard edit mode.
Acceptance: rules are evaluated identically for viewers and editors and checked on the server;
outline navigation works by keyboard; the model migration has a test.

**P3-2 Share links and embedding.** Share link with time and variables, short links, embed code
for org-internal embedding. Framing stays denied by default; a server admin setting opts in to
`frame-ancestors` for listed origins.
Acceptance: without the setting every page answers with framing denied (header test); short
links resolve only for members who may read the dashboard.

**P3-3 Image export.** PNG and SVG of a panel or dashboard rendered in the browser (decision 3;
a server renderer follows in M6 with reports and alerting).
Acceptance: both formats work in both schemes and the contrast theme and need no server
dependency.

**P3-4 Snapshots.** Snapshots with data frozen and stored under the dashboard's permissions.
Public links stay M6.
Acceptance: snapshots respect `dashboards:share` and the org boundary; a snapshot never contains
secrets or queries the viewer could not run.

**P3-5 XY chart panel.** Acceptance: server option checks, contract fixture, picker preview and
both themes; correlation from the `correlate` step can be drawn as a fitted line.

**P3-6 Dashboard list panel.** Acceptance as P3-5; lists only dashboards the viewer may read.

**P3-7 Logs panel** (with M5 Loki) and **P3-8 Geo panel** (with #27 documents), one PR each,
acceptance as P3-5.

**P3-9 Administration depth.** Data source "used by" and health history, org default
preferences, server stats. Service accounts with tokens and scopes follow in M5.

**P3-10 SQL builder** writing visible SQL; **P3-11 PromQL metric and label browser**;
**P3-12 Cypher pattern builder**. One PR each; acceptance: the builder's output is plain query
text the user can edit, and switching back to the builder never loses hand edits silently (it
says when it cannot read the text).

## 6. Owner decisions (2026-10-23)

1. **Colors: palette plus free color.** The color-vision-safe palette stays the default. A color
   picker allows any color per series, threshold step and override, stored as hex. With a free
   color, contrast and dark mode are the author's responsibility; the picker shows a contrast
   warning where that is cheap to compute. (P2-3)
2. **Query history: 30 days on the server, private.** Each user sees only their own history; the
   retention is a server setting with 30 days as default; starred queries are kept beyond it.
   Admins cannot see other users' history. The audit log is unaffected. (P2-8)
3. **Image export: in the browser now.** PNG and SVG are rendered in the browser. A server
   renderer comes later together with reports and alerting (M6). (P3-3)
