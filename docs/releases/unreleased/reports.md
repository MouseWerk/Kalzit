## Improved

- Reports: a dashboard, all of its panels or some, sent by mail on a schedule (daily, weekly,
  monthly or a cron expression, in a time zone) as a PDF file, CSV files or both, with its own
  time range and fixed variable values. Kalzit draws the PDF itself on the server, without a
  browser: time series, bars, stat values and tables, documents as a tree and graphs as a static
  layout, each in its own shape; panels it cannot draw show the reason. CSV files hold table
  results, several of them in a zip file. A report runs with the current rights of the person who
  created it and is suspended while one is missing; recipients must be able to read the dashboard.
  A failed run sends nothing to the recipients, is tried once more after five minutes and then
  tells the creator. Addresses outside the organization are off by default; organization admins
  may allow them, also limited to mail domains, and their mails have a one-click unsubscribe. New
  permissions `reports:read` and `reports:write` for editors and up; new server settings to turn
  reports off and to limit reports, runs per hour, recipients (20) and the size of a mail (10 MB).
  The pages in the interface follow; until then reports are made through the API
  ([Reports](../../guide/reports.md)).
