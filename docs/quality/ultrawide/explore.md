# Ultrawide audit: Explore

Audit of 2026-11-24 on the comparison instance (`cae59d2e`), every finding checked against
`origin/main` at `b99aa491`; file:line references are on that commit. Query answers were faked in
the browser because the instance's sources were down (see [README.md](README.md)).

| Id | Severity | Status |
|---|---|---|
| UW-E1 | minor | open |
| UW-E2 | minor | open |

The time axis of Explore's chart also loses its dates on wide windows; that is UW-D1 in
[dashboards.md](dashboards.md), shot `shots/explore-time-axis-3840-light.png`.

Checked without findings: the toolbar (Open, History, Share, Cheat sheet, range, Save, Live, Run)
stays on one row aligned with the editor's right edge; the steps rail keeps its width and sits
beside the editor at every width; the chart canvas is sharp at DPR 2.

## UW-E1 The result has a fixed height of 24rem whatever the window

- **Where:** `ui/src/features/explore/explore.css:135-142` (`.explore__panel { height:
  var(--size-result) }`), `ui/src/styles/tokens.css:506` (`--size-result: 24rem`).
- **Width/theme:** every large window; measured: at 3840 x 1600 the result panel is 3 216 x
  384 px (8.4:1) and ends at y = 812, so the lower half of the screen stays empty; at 5120 x 1440
  it is 4 496 x 384 px (11.7:1). Both themes.
- **Reproduce:** Explore, Prometheus, `up`, "Last 7 days", run at 3840 x 1600.
- **Expected / actual:** Explore is where one looks at a result; the result should use the
  height the window has. Actually it keeps the height of a 1080p layout: the series are squeezed
  into a flat band and the page ends in the middle of the screen.
- **Screenshot:** `shots/explore-result-3840-light.png`, `shots/explore-result-5120-light.png`.
- **Root cause (confirmed):** a fixed token height (the trace case already uses `42rem` with a
  `100dvh` cap, `explore.css:145-148`).
- **Fix:** `height: clamp(var(--size-result), calc(100dvh - <offset of the result>), 60rem)` or a
  flex column so the result takes the rest of the viewport, with a resize handle; keep 24rem as
  the minimum. The same token is also the alerting side column's width
  (`alerting.css:558`), so give the Explore height its own token.
- **Test:** e2e at 3840 x 1600: the result panel's height is at least 50 % of the viewport.

## UW-E2 Hints and "Start here" stretch across the whole editor width

- **Where:** `ui/src/styles/components.css:495-498` (`.field__hint`: no measure), the "Start
  here" card `ui/src/help/help.css:185-192` (`.help-start`: full width, text column narrow).
- **Width/theme:** from 2560; at 3840 the editor hint "Ctrl+Enter runs the query, Ctrl+Space
  shows suggestions. ..." is one line of 220-250 characters over 3 216 px, at 5120 over 4 496 px;
  "Time series, stat, bar and table panels need a table. ..." 251 characters on one line. Both
  themes.
- **Reproduce:** Explore with Loki or Prometheus selected at 3840; the panel editor's query hint
  is the same.
- **Expected / actual:** hints read as short sentences of at most about 80 characters. Actually
  one has to sweep the eyes across the whole screen to read one hint, and the "Start here: Loki"
  card is a 3 000 px wide tinted box whose text stops after 400 px.
- **Screenshot:** `shots/explore-hints-3840-light.png`.
- **Root cause (confirmed):** hints and the start card take the width of their container; there
  is no measure token for running text (see UW-S3 in [shell.md](shell.md) for the shared fix).
- **Fix:** `max-inline-size: var(--measure)` (a new token, about `70ch`) on `.field__hint`;
  give `.help-start` `max-inline-size: max-content` or the same measure, so the card ends where
  its text ends.
- **Test:** the sweep's measure check (UW-S3) passes on Explore at 3840.
