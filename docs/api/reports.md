# Reports API

Scheduled PDF and CSV reports of a dashboard, sent by mail. What a report holds, how runs work and
the settings are described in the guide ([Reports](../guide/reports.md)); this page lists the
routes and the reasons they answer with. The types (`ReportInput`, `Report`, `ReportRun`,
`ReportsStatus`, `SendNow`) are in `ui/src/api/generated/shapes.ts`.

## Routes

| Method and path | Permission | What |
|---|---|---|
| `GET /api/orgs/{orgId}/reports` | `reports:read` | The reports on dashboards the caller can read, newest first (`Page<Report>`) |
| `POST /api/orgs/{orgId}/reports` | `reports:write` | Create (`ReportInput`); `201` with the report. The caller becomes the creator, whose current rights every run uses |
| `GET /api/orgs/{orgId}/reports/status` | `reports:read` | On or off (server and organization), mail set up, outside addresses and domains, limits |
| `POST /api/orgs/{orgId}/reports/preview` | `reports:write` | A draft as PDF with the caller's rights; nothing is stored or sent; failing panels show their reason |
| `GET /api/orgs/{orgId}/reports/{reportId}` | `reports:read` | One report |
| `PUT /api/orgs/{orgId}/reports/{reportId}` | `reports:write`, creator or `org:write` | Change, with `version` (`409 version_conflict` with the current report otherwise). The report keeps its creator |
| `DELETE /api/orgs/{orgId}/reports/{reportId}` | `reports:write`, creator or `org:write` | Delete, with its runs |
| `POST /api/orgs/{orgId}/reports/{reportId}/send` | `reports:write`, creator or `org:write` | Queue a run now; `202` with the run |
| `POST /api/orgs/{orgId}/reports/{reportId}/pause` | `reports:write` | Pause, with `{ "version" }` (`409 version_conflict` with the current report otherwise). Never checks the report's content, so it works on a report that could not be saved as it is; answers the report. A report already paused is answered as it is: no new version, no audit entry |
| `POST /api/orgs/{orgId}/reports/{reportId}/resume` | `reports:write`, creator or `org:write` | Resume, with `{ "version" }`. Checks the report as an update would (panels, rights, recipients) and answers with the same reasons when it cannot run; answers the report. Members among the recipients who left the organization are removed from the report instead of refusing it (the audit entry counts them); a report already running is answered as it is |
| `GET /api/orgs/{orgId}/reports/{reportId}/runs` | `reports:read` | The runs, newest first (`Page<ReportRun>`) |
| `GET`, `POST /api/reports/unsubscribe/{token}` | public | The unsubscribe page and the one-click unsubscribe (RFC 8058) of outside addresses |

A report runs and mails with its creator's rights, so only the creator and organization admins
(`org:write`) change, resume, send or delete it; others with `reports:write` get `403 forbidden`,
reason `reports.not_owner`, and may still pause it.

Run errors (`ReportRun.error.code`) and the reason of a suspension (`Report.suspended.code`) use
the same reasons as the routes.

## Reasons

As in docs/api/datasources.md, "Reasons": `reason` and `params` next to `code`, translated by the
UI, with `message` as the English fallback.

| Reason | Params | When |
|---|---|---|
| `reports.name_required` | | the report has no name |
| `reports.dashboard_unknown` | | the dashboard does not exist or the caller cannot read it |
| `reports.panels_invalid` | | `panelIds` is empty, too long or names a panel twice |
| `reports.panel_unknown` | `panelId` | `panelIds` names a panel the dashboard does not have |
| `reports.time_invalid_range` | | a time of the range is not like `now`, `now-7d`, `now-1d/d` or a date |
| `reports.time_unit_unsupported` | | the range uses fiscal years or quarters |
| `reports.time_range_reversed` | | the range ends before it starts |
| `reports.time_zone_invalid` | | `timeZone` is not a time zone name |
| `reports.time_invalid` | | a schedule's time of day is not like `08:00` |
| `reports.weekdays_invalid` | | a weekly schedule names no day |
| `reports.day_invalid` | | a monthly schedule's day is not 1 to 31 |
| `reports.cron_invalid` | | the cron expression does not have five valid fields |
| `reports.schedule_never` | | the schedule never runs |
| `reports.schedule_too_frequent` | | the schedule runs more often than every 15 minutes |
| `reports.formats_invalid` | | no format, or one twice |
| `reports.csv_needs_export` | | `403 forbidden`: CSV files without `data:export` |
| `reports.not_owner` | | `403 forbidden`: a change, resume, send or delete of a report by someone who neither created it nor has `org:write` |
| `reports.recipients_required` | | the report has no recipient |
| `reports.too_many_recipients` | `max` | more recipients than `reports.max_recipients` |
| `reports.recipient_invalid` | `index` | a recipient has neither or both of `userId` and `email` |
| `reports.recipient_unknown` | `index` | a `userId` is no active member of the organization |
| `reports.recipient_no_access` | `index`, `name` | a member cannot read the dashboard |
| `reports.recipient_duplicate` | `index` | a recipient is listed twice |
| `reports.recipient_email_invalid` | `index` | an address is not a mail address |
| `reports.recipient_is_account` | `index` | an address belongs to an account; list the person by `userId` |
| `reports.external_not_allowed` | `index` | the organization sends reports to its members only |
| `reports.external_domain_not_allowed` | `index` | the address is not in an allowed mail domain |
| `reports.external_needs_public_url` | `index` | outside addresses need `server.public_url` for their unsubscribe link |
| `reports.version_required` | | an update without `version` |
| `reports.too_many` | `max` | `409 conflict`: the organization has as many reports as it may |
| `reports.disabled` | | `409 conflict`: reports are off for the server or the organization; also a queued run then |
| `reports.mail_not_configured` | | `409 conflict`: "send now" without a mail server |
| `reports.rate_limited` | | `429`: "send now" beyond `reports.max_runs_per_org_hour`; a scheduled run is then skipped |
| `reports.results_too_large` | `max` | `413`: the panels' results exceed what a report may hold |
| `reports.creator_gone` | | suspended: the creator is no active member any more |
| `reports.creator_no_permission` | | suspended: the creator lost `reports:write` |
| `reports.creator_no_dashboard` | | suspended: the creator cannot read the dashboard, or it is in the trash |
| `reports.creator_no_source` | | suspended: the creator may no longer query a data source the report's values pick for a data source variable, or it is in the trash or of another kind |
| `reports.creator_no_export` | | suspended: the creator lost `data:export`, which CSV files need |
| `reports.dashboard_unavailable` | | run failed: the dashboard is gone |
| `reports.panel_link_missing` | | run failed: a panel's library panel or saved analysis is gone |
| `reports.query_missing` | | run failed: a query gave no answer |
| `reports.render_failed` | | run failed: the PDF or zip file could not be made, or rendering took too long |
| `reports.attachment_too_large` | | run failed: the files are larger than `reports.max_attachment_bytes` in the mail |
| `reports.nothing_to_send` | | run failed: no PDF and no table for CSV |
| `reports.no_recipients` | | run failed: no recipient may receive the report now |
| `reports.all_refused` | | run failed: the mail server refused every recipient |
| `reports.internal` | | run failed: a fault on the server (in its log) |
| `reports.interrupted` | | run failed: the server stopped while the report was made |
| `reports.recipients_left_out` | | a partial run: some recipients were left out |
| `reports.missed` | | skipped: the scheduled time passed while no server ran |
| `reports.queue_late` | | skipped: the run waited more than 15 minutes for its turn |
| `reports.panel_removed` | | a PDF placeholder: the panel is no longer on the dashboard |
| `reports.panel_no_queries` | | a PDF placeholder: the panel has no query |
| `reports.no_data` | | a PDF placeholder: no data in the time range |
| `reports.shape_mismatch` | | a PDF placeholder: the result's shape does not fit the panel type |
| `reports.csv_needs_projection` | | a panel left out of the CSV files: documents, a graph or a trace without a step to a table |
