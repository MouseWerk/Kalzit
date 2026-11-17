## Improved

- Traces in Explore: a search form for Tempo and Jaeger without a query language (service, operation, tags, duration, status), which shows the TraceQL it stands for, the result list with duration over time, and one trace as a waterfall with the detail of a span (attributes, events, linked spans, resource). Bars are neutral; only errors are red, and say so in words.
- Trace panel for dashboards: the list of traces, the waterfall of one, or automatically by what the query answers; a click sets a variable.
- Trace steps in the step catalog: filter spans, critical path, spans or traces as a table, service map and span tree, with a question before a graph over very many spans.
- Verwaltung > CORS: origins, methods and headers apply at once with undo, a wrong entry says why at its field, and an origin can be checked against the settings.
- Verwaltung > Registrierung, with the pages for visitors (create an account, check the inbox, name and password behind the link, waiting for approval) and the requests above the members.
- Verwaltung > Sicherungen: schedule, retention, encryption and the last runs, and the target (local folder or S3-compatible) with a test before the one Save.
- Apps: installed apps appear under "Apps" in the sidebar and run in a sealed frame; the plugins page shows an app's pages and what it may do, and Verwaltung > Apps blocks an app or limits it to a role per organization.
- Loki, Tempo and Jaeger: label, tag and service names are offered while typing a query.
