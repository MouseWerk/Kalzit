# Reports

A report sends a dashboard by mail on a schedule: all of its panels or some of them, as a PDF
file, as CSV files, or both. Kalzit draws the PDF itself, on the server, without a browser or an
outside service; it looks close to the dashboard, not identical.

## In the interface

**Reports** in the main navigation, after Alerting, lists the reports of the organization: what
each sends, its schedule, format, recipients, the next and the last run, and the person whose
rights it runs with. Filter by "Mine" and "With problems" (suspended, or the last run failed), or
search by report and dashboard. Suspended and paused reports are muted and say so in words; a
suspended one names its reason under the list. The row menu edits, pauses, sends now, duplicates
and deletes. The entry shows with `reports:read` while reports are on for the server and the
organization.

- **New report** opens the editor: name, dashboard and panels, time range and variables, schedule
  with its time zone (the next runs are shown as you choose), recipients, format and language. The
  summary on the right follows the form. Nothing applies before **Save**; what is missing or
  refused shows at its field, a refused recipient on the person it names.
- **Create report…** in a dashboard's menu opens the same editor on that dashboard, with the time
  range and the variable values chosen there. The menu also leads to the reports the dashboard
  already has.
- **Recipients** are added by name or address: members of the organization, and addresses outside
  it where the organization allows them. Kalzit reads the member list for this, which takes
  `users:read`.
- **Preview** draws the draft as PDF with the same renderer as a run, with the data of now and your
  own rights, and sends nothing. Download it or open it in a new tab; its size stands against the
  largest mail allowed.
- **Send now** on a saved report asks first: the report goes to all of its recipients, not only to
  you. It is not offered without a mail server or while reports are off.
- **Runs** next to a report's details lists each run with what started it, how long it took, how
  many recipients got it, the size of the files and the result with its reason. Runs still on
  their way update by themselves.
- **Duplicate** creates a copy that runs with your rights, which is the way to take over a report
  whose creator lost a right or left.

Without a mail server the pages say so, with the way to Administration > Mail for server admins.
The settings are under Administration > Reports (server) and the organization's Reports section.
The API (`/api/orgs/{orgId}/reports`) is below.

## What a report holds

- **Dashboard and panels.** All panels in the dashboard's order, or the panels you pick. A panel
  removed from the dashboard later shows a note in the PDF.
- **Time range.** The dashboard's own, or one of the report: `now-7d` to `now`, rounded ranges
  such as `now-1d/d` to `now-1d/d` (yesterday, midnight to midnight) or `now-1M/M` to `now-1M/M`
  (last month), or fixed dates. Days, weeks, months and years count on the calendar of the report's
  time zone; weeks start on Monday. Fiscal years and quarters are not available in reports.
- **Variables.** Fixed values for the dashboard's variables. Variables you leave open take the
  value saved with the dashboard.
- **Schedule.** Daily, weekly (on chosen days) or monthly (on a day; in shorter months on their
  last day) at a time of day, or a cron expression with five fields (minute, hour, day of month,
  month, day of week). A report runs at most every 15 minutes.
- **Time zone.** When the schedule runs and how times in the report read. A report at 08:00 runs at
  08:00 in summer and in winter. A time that does not exist when the clocks go forward runs when
  the gap ends (02:30 becomes 03:00); a time that happens twice when they go back runs once.
- **Format.** PDF, CSV or both. CSV files need the right to export data (`data:export`): the creator
  needs it, and only recipients who hold it get the CSV files. Everyone else, and every address
  outside the organization, gets the PDF only; the run history counts them.
- **Language.** German or English, for the PDF and the mail.
- **Recipients.** Members of the organization, and addresses outside it where the organization
  allows them (below). At most 20 per report by default.

## How the files look

The PDF is A4 landscape: a cover with the dashboard, the time range, the variable values and when
the report was made, then one card per panel. Every result keeps its shape:

| Result | In the PDF |
|---|---|
| Table result (frame) in a time series panel | Lines over time, up to 8 series, with a legend |
| ... in a bar panel | Bars per category, up to 24 categories |
| ... in a stat, gauge or bar gauge panel | The value with the panel's reducer and unit |
| ... in a table panel | The first 25 rows, as many columns as fit |
| Documents | The first documents as an indented tree, up to 40 lines, in their own field order |
| Graph | A static layout of up to 150 nodes and 2,000 relationships, coloured by label |
| Trace | A waterfall of up to 40 spans in tree order: service and operation, start and duration within the trace, errors in red |
| Text panel | Its text |

What is left out (more rows, series, documents or nodes) is said under the panel. A panel type the
PDF does not draw yet (pie chart, heatmap, histogram, state timeline, status history, plugin
panels) shows a note and its values as a table. A panel whose result does not fit its type (a
documents result in a time series panel) shows a placeholder with the reason; Kalzit never turns
documents or graphs into a table on its own.

CSV files hold table results only, one file per result, written like an export (semicolons and
decimal commas in German, commas and points in English). Several files arrive as one zip file.
A documents, graph or trace panel is in the CSV files only when it has a step that makes a table of it
("To table", a graph step with a table result, or "Span table" (`spanTable`) for traces); otherwise the
mail names it as left out.

## Runs and rights

- A report runs with the **current rights of the person who created it**, checked at every run:
  they must still be an active member with `reports:write`, be able to read the dashboard, and for
  CSV files hold `data:export`. Only the dashboard's stored queries run. Editing a report does not
  change whose rights it runs with.
- When one of those rights is missing, the report is **suspended**, not deleted: the run is
  recorded as "suspended" with the reason, and the report resumes at the first scheduled time the
  right is back. Suspended and paused times are not made up later.
- Every member among the recipients must be able to read the dashboard. Saving refuses a member
  without that right; a member who loses it later, leaves the organization or is disabled is left
  out of the runs, and the run history counts them.
- **Failures.** A run fails as a whole when a panel's query or steps fail, when the panels'
  results are larger than a report may hold (eight times the largest mail), when the files are
  larger than the largest mail allowed (10 MB by default, counted as they travel in the mail),
  when rendering takes longer than a minute, when the mail server cannot be reached or refuses every
  recipient. Nothing goes to the recipients then, not even part of the report. Kalzit tries once more
  after five minutes; when that fails too, the creator gets a mail with the reason, at most one per
  report and day.
- A scheduled time that passed while no server ran, or a run still waiting for its turn 15 minutes
  after its time, is recorded as "skipped" and not made up. Organizations take turns: up to four
  reports are made at once, one per organization.
- **Send now** queues a run at once, with the same checks.
- Runs are kept for 90 days by default. The files are not stored: each run makes them anew.

## Addresses outside the organization

By default reports go to members only. Organization admins turn on
`reports.allow_external_recipients` and may limit addresses to mail domains
(`reports.external_domains`, for example `example.com`). External addresses also need the server's
public address (`server.public_url`). An address that belongs to an account of the server is
refused: add the person by their account, so the read check applies; one that becomes an account
later is left out of the runs. Mails to outside addresses contain no link into Kalzit apart from a
one-click unsubscribe (the link at the bottom and the unsubscribe button of mail programs). After
unsubscribing, the address is left out of that report's runs. Unsubscribe links keep working after
the secrets key is rotated.

## Permissions

| Permission | Roles | Allows |
|---|---|---|
| `reports:read` | editor, admin, owner | Seeing reports and their runs |
| `reports:write` | editor, admin, owner | Creating, changing, deleting, sending now and the preview |

Viewers receive reports but do not see or create them. Reports on dashboards you cannot read do not
show up for you. Creating, changing and deleting a report and every "send now" are in the audit log,
without addresses.

## Settings

| Server setting | Default | What it does |
|---|---|---|
| `reports.enabled` | on | Off, reports are kept but neither run nor sent |
| `reports.max_reports_per_org` | 100 | Reports one organization may have |
| `reports.max_runs_per_org_hour` | 60 | Runs an organization may start per hour; further scheduled runs are recorded as skipped |
| `reports.max_recipients` | 20 | Recipients per report |
| `reports.max_attachment_bytes` | 10 MB | The largest files of one mail together |
| `reports.history_retention_days` | 90 | How long runs are kept |

Organization settings: `reports.org_enabled` (on; an organization may only turn reports off),
`reports.allow_external_recipients` (off) and `reports.external_domains` (empty: any domain). A mail server must be set up (Administration > Mail).

## API

| Method and path | Permission | What |
|---|---|---|
| `GET /api/orgs/{orgId}/reports` | `reports:read` | The reports, newest first (`Page<Report>`) |
| `POST /api/orgs/{orgId}/reports` | `reports:write` | Create (`ReportInput`); answers `201` with the report |
| `GET /api/orgs/{orgId}/reports/status` | `reports:read` | On or off, mail set up, external addresses, limits |
| `POST /api/orgs/{orgId}/reports/preview` | `reports:write` | A draft (`ReportInput`) as PDF, with your own rights; nothing is stored or sent; failing panels show their reason |
| `GET /api/orgs/{orgId}/reports/{reportId}` | `reports:read` | One report |
| `PUT /api/orgs/{orgId}/reports/{reportId}` | `reports:write` | Change, with the `version` it started from (`409 version_conflict` otherwise) |
| `DELETE /api/orgs/{orgId}/reports/{reportId}` | `reports:write` | Delete, with its runs |
| `POST /api/orgs/{orgId}/reports/{reportId}/send` | `reports:write` | Send now; answers `202` with the queued run |
| `POST /api/orgs/{orgId}/reports/{reportId}/pause`, `.../resume` | `reports:write` | Pause or resume, with `{ "version" }`. Pausing always works; resuming checks the report as a change would |
| `GET /api/orgs/{orgId}/reports/{reportId}/runs` | `reports:read` | The runs, newest first (`Page<ReportRun>`) |
| `GET`, `POST /api/reports/unsubscribe/{token}` | public | The unsubscribe page and the one-click unsubscribe |

A report body:

```json
{
  "name": "Lager weekly",
  "dashboardId": "0192...",
  "panelIds": ["p1", "p4"],
  "timeRange": { "from": "now-1w/w", "to": "now-1w/w" },
  "variables": { "region": "nord" },
  "schedule": { "kind": "weekly", "time": "07:00", "weekdays": ["mon"] },
  "timeZone": "Europe/Berlin",
  "formats": ["pdf", "csv"],
  "language": "de",
  "recipients": [{ "userId": "0192..." }, { "email": "partner@example.com" }],
  "paused": false
}
```

Schedules: `{"kind": "daily", "time": "08:00"}`, `{"kind": "weekly", "time": "08:00", "weekdays":
["mon", "fri"]}`, `{"kind": "monthly", "time": "06:00", "day": 1}`, `{"kind": "cron",
"expression": "30 7 * * 1-5"}`. Run statuses: `queued`, `running`, `ok`, `partial` (some
recipients left out), `failed`, `suspended`, `skipped`. Errors carry a reason such as
`reports.recipient_no_access`, `reports.external_not_allowed`, `reports.schedule_too_frequent`,
`reports.creator_no_dashboard` or `reports.attachment_too_large`.
