# Kalzit user guide

How to work with Kalzit, one page per area. The guide describes what the interface does today;
the [roadmap in the README](../../README.md#roadmap) lists what is still to come. Labels are
written as the English interface shows them, with the German label in parentheses where it helps.

## Pages

| Page | What it covers |
|---|---|
| [Installation](installation.md) | The deb and rpm packages with their systemd service, paths, updates and removal; the container image: volume, configuration, secrets key, Compose with SQLite or PostgreSQL, health check, updates; the Windows installer (MSI) with its wizard, silent installation, the service, updates and uninstalling |
| [Linux without a package](linux-binary.md) | The plain binary as a hardened systemd service: account, folders, configuration, the secrets key in the credential store, AppArmor on Ubuntu, updates |
| [HTTPS and certificates](https.md) | HTTPS with your own certificate files or automatic certificates over ACME (Let's Encrypt or another CA): setup, validation, renewal, troubleshooting |
| [Reverse proxy](reverse-proxy.md) | Kalzit behind nginx, Caddy, Traefik or IIS: WebSocket, forwarded headers, timeouts and upload sizes, checking the setup |
| [Backup and restore](backup.md) | What to back up (database, secrets key, ACME and plugin folders, `kalzit.toml`), consistent copies of SQLite and PostgreSQL, restoring, a restore drill |
| [Upgrading](upgrading.md) | Moving to a new release per installation type, the built-in updater, what to check before and after |
| [Getting started](getting-started.md) | First setup with the setup code, sign-in, the sample data and the bundled help, your first data source, dashboard and Explore query |
| [Dashboards](dashboards.md) | View and edit mode, Add menu, rows, panel editor, variables (also set by clicks on documents, rows and graph nodes), time range, annotations, links, library panels, history, trash, sharing, kiosk, pinning, starring |
| [Panels](panels.md) | Every visualization with its options, the graph panels with node details, selection, pins and the explorer; colours, thresholds, units, value mappings, overrides |
| [Explore](explore.md) | Free queries per source kind (Cypher and GSQL included), the three result shapes, steps and graph steps, add to dashboard |
| [Query languages for beginners](query-languages.md) | What each source holds, small read-only example queries per language (SQL, PromQL, Flux and InfluxQL, LogQL, Lucene and Query DSL, MongoDB pipelines, Cypher, GSQL), files and HTTP JSON, and how the time range and variables apply |
| [Saved analyses](saved-analyses.md) | Saving Explore queries, the list under Explore, linked dashboard panels, versions and conflicts |
| [Calculated fields and statistics](calculated-fields.md) | Analysis steps, the expression language, statistics, graph steps, with examples |
| [Export](export.md) | CSV, JSON and Excel files, and their limits |
| [Performance and caching](performance.md) | The server's query cache per person, its settings per data source and for the server, Refresh, what Inspect shows, the other limits |
| [Data sources](data-sources.md) | Every supported kind, connection settings and strings, read-only behaviour (TigerGraph's REST++ authentication included), testing, access, trash |
| [Plugins](plugins.md) | Installing data source and panel plugins from a file or the signed catalog, the checks and permissions, a plugin's status, log, sandbox and network, trusted keys, unsigned plugins, blocking per organization, panels of plugins |
| [AI](ai.md) | Turning AI on with a provider, a provider per function, limits, the organization's own provider, what AI may read of a data source, the first-use notice, explain, draft and summarize, Ask (chat about your data) with its history and retention |
| [Sign-in and security](account-security.md) | Your second factor (passkeys, authenticator app, recovery codes), the second step of the sign-in, requiring a second factor on the server and per organization, resetting someone's second factor |
| [Administration](administration.md) | Organizations, members, teams, roles and permissions, audit log, server settings, updates |

For operators there are three more guides: [updates](../operations/updates.md) (the built-in
updater, offline packages, returning to an earlier version, release signing),
[several servers](../operations/high-availability.md) (high availability on one PostgreSQL
database, the load balancer, rolling updates) and, for plugin authors,
[writing plugins](../plugins/authoring.md) (the Rust SDK, the manifest, packaging and signing).

The HTTP API behind every function is described in [docs/api](../api): [access](../api/access.md),
[data sources and queries](../api/datasources.md),
[settings and dashboards](../api/settings-dashboards.md),
[dashboard features](../api/dashboard-features.md), [saved analyses](../api/analyses.md),
[Explore history](../api/explore-history.md), [live updates](../api/live.md),
[shell](../api/shell.md), [usage](../api/usage.md), [sign-in providers](../api/sso.md),
[SCIM](../api/scim.md), [mail](../api/mail.md), [updates](../api/updates.md),
[plugins](../api/plugins.md) and [AI](../api/ai.md). Words used in the interface are explained in the
[glossary](../glossary.md); how to install and run a server is in
[Installation](installation.md), [Linux without a package](linux-binary.md) and the
[README](../../README.md#quick-start).

## Finding your way

The **sidebar** on the left is the main navigation:

- **Home** (Start): the start page with your organization in numbers, favorites and recently
  opened dashboards.
- **Dashboards**, **Explore** and **Data sources**: working with data.
- **Ask** (Fragen, Beta): questions about your data in plain words, while AI is on
  ([AI](ai.md#ask-fragen)).
- **Organization** group: **Members**, **Settings** and **Administration** (Verwaltung). Each
  entry appears only if your role may open it.
- Your **pinned dashboards** sit under the navigation, in your own order.
- The **organization card** at the top shows the organization you work in; open it for its
  settings, members and teams, and to switch organization (server admins see all organizations).

The **bar on top** shows where you are (breadcrumbs), the search, a **New** menu (dashboard,
folder, import, data source) and **Help** (keyboard shortcuts and documentation). On a phone the
search, New and Help are icon buttons.

Faster ways:

| Keys | What happens |
|---|---|
| Ctrl+K (Cmd+K on macOS) | Command palette: find dashboards, folders, data sources and pages by a few letters, or run an action such as a new dashboard, Explore or the theme. It lists only what you may open. |
| `/` | Search (outside text fields) |
| `?` | All keyboard shortcuts of the current area |
| Ctrl+B | Collapse or expand the sidebar |
| Esc | Close a menu, dialog or the palette |

Your language (English or German), theme (system, light, dark, high contrast), time zone, start
dashboard and first day of the week are set on your account page (see
[Administration](administration.md#your-account)).
