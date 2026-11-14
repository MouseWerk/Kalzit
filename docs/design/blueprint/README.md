# Design blueprint

The binding look of the Kalzit web app. Every UI change matches these boards: layout, density,
spacing, component shapes and wording. Colours map onto the existing design tokens; the hex values
in the boards are reference values, not new tokens. The rules in `CLAUDE.md` still win where they
are stricter (no accent borders or left bars for selected states, i18n catalogs, tokens).

Each board is a static HTML page at 1440 px width. Open it in a browser; the `support.js` reference
belongs to the design tool and is not needed to view the page. `canvas.json` holds the board order,
titles and heights.

| Board | Screen |
| --- | --- |
| `Main.dc.html` | Dashboard view: sidebar, top bar, toolbar with filters, panel grid, right rail |
| `DashboardEdit.dc.html` | Edit mode with the Add menu |
| `DashboardEditSelected.dc.html` | Edit mode with the outline and the panel inspector |
| `PanelEditor.dc.html` | Full-page panel editor with queries, colours and thresholds |
| `Start.dc.html` | Start page |
| `Explore.dc.html` | Explore with documents, schema and analysis steps; below it the guidance: "Hier anfangen" with starters per source, the schema list with its actions, the cheat sheet (Shift+F1) and a tip, hints next to errors, the query of a step, empty states, and tips in the preferences |
| `Settings.dc.html` | Server settings with live preview and undo |
| `Updates.dc.html` | Online and offline updates, backups and history |
| `DataSources.dc.html` | Data source list with team access drawer |
| `DataSourceNew.dc.html` | Add and configure a data source, advanced options per type |
| `DataChat.dc.html` | "Fragen", the AI agent chat (M4), with the changes frame 11 of `AI.dc.html` lists |
| `SavedAnalyses.dc.html` | Saved analyses: save dialog and saved state in Explore, the list under Explore, the panel editor's "From saved analysis", and the conflict on save |
| `Access.dc.html` | Sign in and first-run setup on the calm backdrop: every state of both, 360 px layouts, light and dark, notes on motion and accessibility |
| `Graph.dc.html` | Graph native (M3): network panel, explorer, hierarchy and paths, the graph panel editor, and Explore with graph steps (frames 5A and 5B) |
| `Plugins.dc.html` | Plugins (M4): installed plugins, install from a file or the catalog, signatures and trusted keys, permissions and their re-approval, per-organization blocking |
| `AI.dc.html` | KI (M4): AI settings and providers, limits and usage, per data source opt-in and excluded fields, the first-use notice, and the AI functions in the UI |
| `Identity.dc.html` | Identity and sign-in (M5): SSO-first sign-in, second factor with passkeys and authenticator app, invitations and password links, Verwaltung > Anmeldung (OIDC, SAML, LDAP, group mapping, local sign-in, 2FA policy), mail server, members with invitations and 2FA status, service accounts with tokens and SCIM, LDAP sync |
| `Alerting.dc.html` | Alerting (M7, 0.7.0, draft for approval): rule list with instances, the rule editor (query, reduce step, condition, "für" duration, labels, contact points) with the preview of the current evaluation per shape (frame, documents, graph), contact points (mail, signed webhook, test send; managed by organization admins, read-only for editors), silences, history, the alert badge on panels, the alerting opt-in per data source and Verwaltung > Alerting; light and dark |
| `AlertingRouting.dc.html` | Alerting routing (M7, 0.7.2, draft for approval): the notification policy tree (nesting, label matchers, contact points, grouping and timing, "weiter prüfen") with the route checker, a policy detail with inherited values and escalation steps, the timeline of grouping and escalation for one group, Slack and Microsoft Teams contact points with test send, grouped messages in mail, Slack and Teams, the read-only tree for editors, the route of a rule in the rule editor and the rule list, the row menu, deletion and hints; light and dark |
| `Sharing.dc.html` | Sharing (M7, 0.7.3, approved): the Share dialog on a dashboard (link in the organization, public link, snapshot) with expiry, maximum time window, locked variables, copy and revoke, the disabled state with its reason (server or organization switch off, `dashboards:public` missing), the public viewer with the time range limited to the window and its expired, revoked and unavailable states, the snapshot viewer with frame, documents and graph panels (public and in the organization), Verwaltung > Freigaben, Konto > Meine Freigaben with the revoke dialog, Verwaltung > Teilen with the organization switch and the new permission, empty states and hints; light and dark |
| `Traces.dc.html` | Traces (M7, 0.7.5, approved): the new native result shape `trace` from Tempo and Jaeger; trace search in Explore (service, operation, tags, duration, status, time range, the generated TraceQL) with duration over time and the result list, the waterfall of one trace with the span detail (attributes, events, links, resource), light theme, truncated and unknown traces, trace panels on a dashboard and in the panel editor, the steps Trace to table (span table) and Trace to graph (service map) with the step catalog, add-data-source forms for Tempo and Jaeger with test and field errors, empty states and hints and the decisions; light and dark |
| `Settings075.dc.html` | Server settings 0.7.5 (M7, 0.7.5, approved): Verwaltung > CORS (origins, methods, headers, credentials, preflight cache, origin check; errors and locked values), Verwaltung > Registrierung (self-registration off by default, mail domains, organization, default role, admin approval, rate limits without captcha), the visitor sign-up states, requests under Mitglieder, Verwaltung > Sicherungen (schedule, retention, contents, last runs) with the target form (local folder or S3-compatible, test and one explicit Save), app plugins (list and detail with pages and permissions, install approval, an app in the sidebar, per-organization blocking and roles, update with new permissions, failure), empty states, hints and the decisions; light and dark |

The boards contain sample data only.
