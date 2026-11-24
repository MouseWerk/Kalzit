# Ultrawide audit: dashboards (view, edit mode, panel editor) and panels

Audit of 2026-11-24 on the comparison instance (`cae59d2e`), every finding checked against
`origin/main` at `b99aa491`; file:line references are on that commit. The instance's sources
were down, so the panels ran on faked query answers inside the browser (see
[README.md](README.md)); layout, ticks and canvases are the real code.

| Id | Severity | Status |
|---|---|---|
| UW-D1 | major | open |
| UW-D2 | minor | open (owner decision) |
| UW-D3 | minor | open |
| UW-D4 | polish | open |

Checked without findings: the dashboard toolbar, the variable bar and the right rail span the
content and stay aligned with the grid at every width; the sticky toolbar keeps its width while
scrolling; canvases (uPlot) are drawn at the device pixel ratio (at 1920 x 1080 DPR 2 a 679 px
chart has a 1358 px backing store), so nothing is blurred on HiDPI; the time series tooltip opens
next to the cursor and stays inside the panel; the panel menu and the "New dashboard" dialog sit
where they should (the dialog centred in the window).

## UW-D1 Time axes drop the date as soon as the window is wide enough for sub-day ticks

- **Where:** `ui/src/panels/timeseries/UplotTimeSeriesChart.tsx:191-196` (`values: ... (step >=
  DAY ? dates : times)`), `ui/src/panels/timeseries/SvgTimeSeriesChart.tsx:307-312`,
  `ui/src/panels/heatmap/index.tsx:289-294`; the tick spacing is
  `ui/src/panels/timeseries/layout.ts:14` (`PX_PER_TIME_TICK = 110`). Explore uses the same
  charts.
- **Width/theme:** any width where a panel is wider than about 7 x 110 px per shown day: on the
  reference dashboard (last 7 days) "CPU per host" and "Latency distribution" show dates at 2560
  but only times at 3840; at 5120 also "Revenue per region". Explore's chart (full width) loses
  the date already at 2560. Both themes.
- **Reproduce:** open "Shop operations" (range "Last 7 days") at 2560, look at "CPU per host"
  (labels 11/18 ... 11/24); then at 3840 x 1600 (labels "12:00 AM, 12:00 PM" fourteen times).
  In Explore, run `up` on Prometheus over 7 days at 3840: 28 labels "06:00 PM, 12:00 AM, ...".
- **Expected / actual:** a wider chart shows more detail and still says which day a point
  belongs to. Actually a bigger monitor removes the day: nobody can tell Monday's noon from
  Thursday's, and the readout is the only way to find the date.
- **Screenshot:** `shots/dash-time-axis-2560-light.png` (dates) against
  `shots/dash-time-axis-3840-light.png` (times only, same panel),
  `shots/explore-time-axis-3840-light.png`.
- **Root cause (confirmed):** the label format is chosen from the tick step alone; with a step
  under a day every label is formatted as time, also when the range spans several days.
- **Fix:** when the range crosses midnight and the step is under a day, label the first tick of
  each day (or every tick at midnight) with the date, e.g. a second line "Di 18.11." under
  "00:00", or "18.11. 12:00" on the ticks that start a day; uPlot's own multi-level `values`
  table does this. Keep one rule for the uPlot, SVG and heatmap axes (a shared helper next to
  `timeTicks` in `series.ts`).
- **Test:** unit test of the shared label helper: 7 days at 3000 px width gives a date on every
  tick that starts a day; a Playwright check at 3840 that "CPU per host" shows at least one date.

## UW-D2 Fixed row height: half-width panels turn into flat strips on wide screens

- **Where:** `ui/src/features/dashboards/dashboards.css:286-293` (`.dash-grid`: 24 columns of
  `1fr`, `grid-auto-rows: var(--dash-row-height)`), `ui/src/styles/tokens.css:186`
  (`--size-grid-row: 2rem`).
- **Width/theme:** from 3440; measured panel cards: a 12-column panel is 1 742 x 312 px at 3840
  and 2 382 x 312 px at 5120 (7.6:1); "Top customers" is 4 772 x 352 px at 5120. Both themes.
- **Reproduce:** "Shop operations" at 5120 x 1440: "Revenue per region" and "CPU per host" are
  wide flat bands; the "Revenue" card is 1 187 x 152 px for three stat tiles; "Orders per
  channel" keeps a small donut in a wide card.
- **Expected / actual:** a dashboard laid out at 1920 keeps its proportions; actually only the
  width grows. Lines lose their shape (a 7-day series in 2 400 x 200 px), and two rows of a
  1920 layout fill a 5120 screen's width but only a third of its height.
- **Screenshot:** `shots/dash-view-5120-light.png`, `shots/dash-view-3840-light.png`.
- **Root cause (confirmed):** columns are fractions of the width, rows are a fixed rem value.
  This matches Grafana and the comment "Edge to edge" in the CSS, so it is a design choice, not a
  bug.
- **Fix (owner decision, recommended first):**
  1. A dashboard setting "Largest width" (off by default; e.g. 1920 / 2560 px / none) that centres
     the grid; kiosk and TV modes keep full width.
  2. Let the row height grow gently with the width above 2560 px
     (`--dash-row-height: clamp(2rem, 1.25vw, 3rem)`), keeping layouts proportional; needs a
     check of the drag and resize maths in `DashboardGrid.tsx:267`, which already reads the
     computed row height.
- **Test:** for option 2, a unit test that the grid's pixel maths uses the computed row height;
  a screenshot at 5120.

## UW-D3 Table panels spread a few columns over the whole width

- **Where:** `ui/src/panels/panels.css:538-542` (`.vt__table { width: 100%; }`), column widths
  `ui/src/panels/table/index.tsx:512` (`COLUMN_WIDTH` only for virtualised wide tables).
- **Width/theme:** from 2560, strong at 3840 and 5120; both themes.
- **Reproduce:** "Top customers" (4 columns, full-width panel) at 3840: the "time" column runs
  from x = 277 to 1 942 (1 665 px for a 20-character timestamp), then EU, US and APAC are
  600 px each and right-aligned, ending at x = 2 538, 3 134 and 3 743.
- **Expected / actual:** a row reads as one line. Actually the eye has to cross 500-1 000 px of
  empty row between a label and its numbers, which on a 3840 screen is hard to follow even with
  the row hover.
- **Screenshot:** `shots/dash-table-3840-light.png`.
- **Root cause (confirmed):** the table is forced to 100 % width and the browser shares the slack
  among all columns.
- **Fix:** when the columns' natural widths sum to less than the panel, size them to content
  (`width: max-content; min-width: 0`) and let the last column or an empty filler take the rest;
  or cap a column's automatic width (e.g. `max-width: 32rem` per cell unless the user set a
  width). A table option "Fit to width" can keep today's behaviour.
- **Test:** unit/e2e: a 4-column table in a 3000 px panel has no column wider than its cap.

## UW-D4 Panel editor: the options pane stays 330 px next to a 3 000 px preview

- **Where:** `ui/src/features/dashboards/panelEditor.css:150` (`minmax(0, 1fr) auto
  var(--editor-options, var(--size-editor-options))`), `ui/src/styles/tokens.css:930`
  (`--size-editor-options: 20.625rem`).
- **Width/theme:** from 3440; both themes.
- **Reproduce:** edit "Revenue" at 3840 x 1600.
- **Expected / actual:** on a wide screen the options get room to show labels and hints in full.
  Actually the pane keeps its 330 px (hints wrap into 4-5 lines, "Own time range" and "Time
  shift" sit side by side at 70 px each) while the preview is 3 000 px wide with a stat that
  uses a third of its height. The pane can be dragged wider, but the default ignores the window.
- **Screenshot:** `shots/dash-panel-editor-3840-light.png`.
- **Root cause (confirmed):** a fixed default width.
- **Fix:** default `--size-editor-options` to `clamp(20.625rem, 18vw, 30rem)`; a width the person
  dragged still wins.
- **Test:** e2e at 3840: the options pane's default width is above 330 px; at 1280 unchanged.
