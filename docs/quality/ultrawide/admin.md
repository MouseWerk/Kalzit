# Ultrawide audit: data sources, alerting, reports, Verwaltung and settings

Audit of 2026-11-24 on the comparison instance (`cae59d2e`), every finding checked against
`origin/main` at `b99aa491`; file:line references are on that commit. The org "Shop" had no alert
rules and no reports, so alerting and reports were seen with their empty states and editors.

| Id | Severity | Status |
|---|---|---|
| UW-M1 | major | open |
| UW-M2 | minor | open |
| UW-M3 | minor | open; owner decision 2026-11-24: lists stop at the content width token |
| UW-M4 | polish | open; owner decision 2026-11-24: reading-width pages centred on wide screens |

Checked without findings: the Verwaltung overview (cards of a fixed size, eight in a row at 3840,
wrapping cleanly), the settings navigation and its sections (they keep the reading width as the
tokens intend), the data source list's summary tiles and toolbar, the alerting tabs, the reports
empty state (centred in its card at every width), the "New dashboard" and other dialogs (centred
in the window), and the command palette (centred, fixed width).

## UW-M1 Alert rule and report editors stretch every field over the whole window

- **Where:** `ui/src/features/alerting/alerting.css:555-560` (`.alert-editor {
  grid-template-columns: minmax(0, 1fr) minmax(0, var(--size-result)) }`, no maximum), used by
  the rule editor and by `ui/src/features/reports/ReportEditorPage.tsx:367`; inside it
  `alerting.css:592-595` (`.alert-head-fields`, 1fr / 2fr) and the two-column field rows
  `:656-662`.
- **Width/theme:** from 2560, strong at 3440 and up; both themes. Measured at 3840: the rule's
  name field is 1 035 px, its description 2 071 px, the data source and range selects 1 553 px
  each, interval and "for" 1 031 px each; the report's name, description, dashboard and time range
  fields 3 118 px each. At 5120: rule description 2 924 px, report fields 4 398 px. The preview
  and summary column stays 384 px.
- **Reproduce:** Alerting > New rule, and Reports > New report, at 3840 x 1600.
- **Expected / actual:** these are forms; the tokens say forms keep the reading width
  (`tokens.css:166-169`, `--content-max-width: 72rem`), and the boards draw the editor as a
  form column with the preview beside it. Actually a 3 000 px input for a report name, a select
  whose value sits 1 500 px from its arrow, and the preview pushed to the far right edge, away
  from the fields it previews.
- **Screenshot:** `shots/admin-alert-rule-editor-3840-light.png`,
  `shots/admin-report-editor-3840-light.png`.
- **Root cause (confirmed):** the editor grid's first column is `1fr` without a cap.
- **Fix:** `grid-template-columns: minmax(0, var(--content-max-width)) minmax(0,
  var(--size-result)); justify-content: start;` (or `max-width: calc(var(--content-max-width) +
  var(--space-4) + var(--size-result))` on `.alert-editor`), so the side column stays next to the
  form. Also give the side column its own token instead of reusing Explore's `--size-result`.
- **Test:** e2e at 3840: no text input or select in `.alert-editor__form` is wider than 72rem,
  and the side column starts within `--space-4` of the form's right edge.

## UW-M2 Add data source: kind descriptions cut off while the empty form half takes 47 %

- **Where:** `ui/src/features/datasources/datasources.css:186-190` (`.ds-new { grid-template-
  columns: minmax(0, 1.15fr) minmax(0, 1fr) }`) and the kind tiles `:281`
  (`repeat(auto-fill, minmax(min(100%, var(--size-field)), 1fr))`, one-line summaries).
- **Width/theme:** from 2560, strong at 3840 (kinds 1 890 px, empty "Choose a kind" card 1 640
  px) and 5120; both themes.
- **Reproduce:** Data sources > Add data source at 3840, before choosing a kind.
- **Expected / actual:** the kinds are what one reads first, with their one-line explanation.
  Actually each tile is about 200 px and cuts its summary after 25 characters ("Relational
  database, Timesc…", "Graph database queried in …"), while the right half is a large placeholder
  with one centred sentence.
- **Screenshot:** `shots/admin-datasource-new-3840-light.png`.
- **Root cause (confirmed):** fixed fractions for both halves, independent of whether a kind is
  chosen; tile summaries are single-line with ellipsis.
- **Fix:** before a kind is chosen, give the placeholder a fixed narrow column
  (`minmax(0, 1fr) minmax(0, var(--size-form))`, or `max-width` on the placeholder card) and let
  tile summaries wrap to two lines (`-webkit-line-clamp: 2`); after choosing, keep today's split.
- **Test:** e2e at 3840: no `.ds-kinds__summary` is truncated (`scrollWidth <= clientWidth`).

## UW-M3 Lists put the cells of one row 500-1 500 px apart

- **Where:** the shared list tables, e.g. members (`ui/src/features/admin/org/MembersPage.tsx`
  with `admin.css`), data sources (`ui/src/features/datasources/datasources.css:1062-1066`,
  `.ds-layout` full width), dashboards; the shell comment `ui/src/styles/components.css:979-985`
  ("Dashboards, Explore and lists are canvases").
- **Width/theme:** from 3440; both themes.
- **Reproduce:** Verwaltung > Members at 3840: the role select sits at x = 1 600, "Last active"
  at x = 3 380 for one member; Data sources at 5120 (measured header cells): Name 1 064 px, Kind
  804 px, "Changed" 781 px, and the actions column starts at x = 4 559, 4 250 px right of the
  name.
- **Expected / actual:** a row is read as a unit; actually the eye loses the row between cells,
  and a short list (one member, three sources) looks lost in a very wide empty table.
- **Screenshot:** `shots/admin-members-3840-light.png`, `shots/admin-datasources-5120-light.png`.
- **Root cause (confirmed):** tables are `width: 100%` and share the slack among all columns; this
  follows the documented "lists use the whole width".
- **Owner decision (2026-11-24):** lists stop at the content width token.
- **Fix:** give list pages (members, teams, roles, service accounts, shares, audit logs, users,
  organizations, data sources, dashboards and saved analyses, alert rules, contact points,
  silences, history, reports) `max-width: var(--content-max-width)` (72rem) for the page header,
  toolbar and table together, so the page actions end where the table ends; tables inside stay
  `width: 100%` of that box. Update the comments that say lists use the whole window
  (`ui/src/styles/tokens.css:166-168`, `ui/src/styles/components.css:979-982`): only dashboards
  and Explore keep the full width. Where the list pages are centred follows UW-M4.
- **Test:** e2e at 3840 and 5120: on the members and data source pages the table is at most
  72rem wide and the page's primary action ends at the table's right edge.

## UW-M4 Reading-width pages hug the left edge on ultrawide screens

- **Where:** data source detail `ui/src/features/datasources/datasources.css:67-80` (`.ds-edit {
  max-width: calc(var(--size-form) + var(--space-4) + var(--size-drawer)) }`), settings
  `ui/src/features/settings/settings.css:17` with `--size-settings-main: 62.5rem`
  (`tokens.css:1104`), `.admin-list:has(> .admin-row--setting)` (`admin.css:230-234`).
- **Width/theme:** 3440 and up; both themes.
- **Reproduce:** open a data source (Shop (PostgreSQL)) or Settings > General at 3840 x 1600.
- **Expected / actual:** the reading width is intended (forms keep it). At 3840 the 62-72rem
  block stands at the left and 2 600-2 900 px of the main area stay empty; on the data source page
  the header's "Test" and "Open in Explore" end in the middle of the screen, while on the list
  pages the page actions sit at the right edge, so the actions jump between pages.
- **Screenshot:** `shots/admin-datasource-3840-light.png`,
  `shots/admin-settings-3840-light.png`.
- **Root cause (confirmed):** deliberate left alignment of reading-width content.
- **Owner decision (2026-11-24):** reading-width pages are centred in the main area on wide
  screens.
- **Fix:** centre the reading-width block in the main area (`margin-inline: auto` on `.ds-edit`,
  the settings layout `settings.css:17` with its navigation, `.admin-list:has(> .admin-row--setting)`
  and the other `--content-max-width` pages, the alert rule and report editors of UW-M1 and, per
  UW-M3, the list pages); the page header with its actions takes the same box, so actions end at
  the content's right edge on every page. Below about twice the block's width the centring is
  invisible, so narrow windows do not change.
- **Test:** e2e at 3840: on a data source page, Settings > General and the members list, the
  content box's left and right margins in the main area differ by at most 1 px, and the header's
  last action ends at the box's right edge.
