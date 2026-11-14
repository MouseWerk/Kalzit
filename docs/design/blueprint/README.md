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
| `Provisioning.dc.html` | Provisioning and Grafana import (M7, 0.7.4, approved): resources as YAML or JSON files in Git with secrets as references, `kalzit provision plan`, `apply` (all or nothing, with errors) and `export` with diffs, `import-grafana` on the command line, provisioned dashboards, data sources, alert rules and roles marked "aus Dateien verwaltet" and read-only with their source path, Verwaltung > Provisioning with applies, errors and drift, unlocking in an emergency, the Grafana dashboard import (file, data source mapping, report of what is converted, approximated or skipped, result), errors, empty states and permissions; light and dark |
| `Reports.dc.html` | Reports (M7, 0.7.4, approved): scheduled PDF and CSV reports by mail: the report list, the editor (dashboard or panels, time range, variables, schedule with time zone, recipients in the organization and external addresses, format and layout, mail), errors at the field (including recipients without read rights on the dashboard), the preview from the server-side renderer with its honest note, runs with errors, the mail as received (member, external, failure), suspended, paused and taking over, Verwaltung > Berichte, the organization settings and the permissions `reports:read` and `reports:write`, empty states and hints; light and dark |

The boards contain sample data only.
