<p align="center">
  <img src="ui/public/favicon.svg" alt="Kalzit mark" width="72" height="72">
</p>

<h1 align="center">Kalzit</h1>

<p align="center"><strong>Your data, in the shape it already has.</strong></p>

<p align="center">
  <a href="https://github.com/MouseWerk/Kalzit/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://github.com/MouseWerk/Kalzit/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/platforms-Windows%20%7C%20Linux-lightgrey" alt="Platforms: Windows and Linux">
</p>

Kalzit is a self-hosted platform for visualizing and analyzing data: dashboards, Explore,
analysis steps, data sources, organizations, teams and roles. Document databases (MongoDB) and
graph databases (Neo4j, Memgraph, TigerGraph) are native data shapes next to SQL and metrics
sources: a MongoDB result stays a set of documents, a Cypher result stays a graph of nodes and
edges, and nothing is turned into a table unless you add that step yourself. The server is one
binary with the web interface built in, and runs on Windows and Linux.

> **Status: early development.** The current version is 0.5.0;
> features, the API and the configuration may still change. See the [roadmap](#roadmap).

<picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/dashboard-overview-light.webp"><img src="docs/screenshots/gallery/dashboard-overview-dark.webp" alt="A Kalzit dashboard named Site Basalt overview: four key figures with small charts, line charts of IT power per hall and inlet temperature per row over 24 hours, average power per row as bars, PUE per hall and a table of the racks with the highest power draw"></picture>

## Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)
- [Roadmap](#roadmap)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Features

### Three native result shapes

Every query answers in exactly one shape, `frame` (tables and time series), `documents` or
`graph`. Panels say which shapes they understand, and the panel picker offers the fitting ones
first. Turning documents into a table is an explicit, visible projection step that can be turned
off, never a hidden conversion in the backend.

### Dashboards and panels

- Folders, version history with restore, trash, and a conflict dialog when two people save at
  once.
- Visualizations for frames: time series, stat, bar chart (grouped series, legend below or on the
  right), table, gauge, bar gauge (one bar per row, value after the bar), pie and donut (labels on
  the slices), heatmap, histogram, state timeline, status history and text (Markdown with
  variables).
- Visualizations for documents: document list with an expandable tree, single document card,
  schema (field paths with types and coverage) and field distribution.
- Visualizations for graphs: network (WebGL), hierarchy and path panels; node details with typed
  properties and neighbours by edge type, multi-selection and pins kept per viewer; an explorer
  that loads a node's neighbourhood step by step, with going back, cancel and undo, and opens
  the exploration as a Cypher query in Explore.
- Variables across result shapes: a click on a document, a table row or a graph node sets a
  variable that SQL, Cypher, GSQL and MongoDB queries take as a parameter.
- Time series graph styles: lines, bars or points, smooth or stepped lines, dashed or dotted
  lines, fills and hatching with gradients, stacking (also to 100 %) and muted comparison series,
  each settable per series through an override.
- Field options for every panel: units per language, decimals, thresholds, value mappings,
  colors, display names and overrides; legends and tooltips.
- Variables from fixed values, free text or a query, sent to the database as parameters, never
  as text in the query; panels and rows that repeat per value.
- Collapsible rows, annotations, dashboard and data links, per-panel time range and time shift,
  library panels, kiosk and TV mode, playlists, JSON model with import and export.
- A full-page panel editor with its own address: preview with a table view, queries and steps in
  tabs, and options in groups.

### Explore

Write a query without a dashboard, see the result in a matching visualization or as documents or
a graph, inspect it and add it to a dashboard. Query editors (CodeMirror) for SQL, PromQL,
MongoDB pipelines and `find`, Cypher, GSQL, Elasticsearch Lucene and Query DSL, files and HTTP
JSON, with suggestions from the source's schema. Save a query as an analysis in folders and team
spaces with a version history, link it into dashboard panels, and let viewers open and run it.
Turn on **Live** and results update by themselves: MongoDB reports changes, other sources run
again at an interval.

### Analysis steps and export

- Steps on query results, in the panel editor and in Explore: calculated fields with formulas
  (also across two joined queries), statistics (sum, mean, median, percentiles, standard
  deviation), trend line, moving average, correlation, comparison with the previous week, month
  or year, group and pivot, and the `toFrame` projection for documents.
- Graph steps: counts per label and edge type, degree distribution, top N by degree, shared
  neighbours, degree as a property, a filtered subgraph and a table from the graph; Neo4j and
  Memgraph run them in the database where they can, and each step shows where it runs.
- Each step can be moved, turned off and removed, with a preview after every step; the queries
  themselves stay as they are.
- The browser and the server run the same steps with the same rules (a shared conformance
  suite), so an export matches what the panel shows.
- Export a panel or an Explore result as CSV (semicolon and decimal comma in German, for Excel),
  Excel workbook or JSON, with the steps applied. Exporting needs the `data:export` permission and
  every export is in the audit log.

### Data sources

| Source | Shape | Status |
|---|---|---|
| PostgreSQL | frame | Supported |
| MySQL, MariaDB | frame | Supported |
| Microsoft SQL Server | frame | Supported |
| SQLite | frame | Supported |
| ClickHouse (HTTP interface) | frame | Supported |
| Prometheus | frame | Supported |
| InfluxDB 1.x, 2.x, 3.x (Flux, InfluxQL, SQL) | frame | Supported |
| Loki (LogQL) | documents (log lines), frame (metric queries) | Supported |
| Elasticsearch, OpenSearch | documents (hits), frame (aggregations) | Supported |
| CSV, JSON and NDJSON files | frame (CSV), documents (JSON, NDJSON) | Supported |
| HTTP JSON | documents | Supported |
| MongoDB | documents | Supported |
| Neo4j, Memgraph (Cypher over Bolt) | graph | Supported |
| TigerGraph 3.10+ and 4.x (GSQL) | graph | Supported |
| Graphite, Redis, Oracle, Tempo, Jaeger | various | Planned (M7) |

Adding a data source shows each kind as a card with its logo; secrets are stored encrypted and
never returned by the API. Plugins add further kinds (see below).

### Plugins

- Data source plugins run as processes of their own next to the server, speaking a versioned gRPC
  protocol and answering in the same three shapes as the built-in sources; panel plugins are
  visualizations that run in your browser in a sealed-off frame.
- Install from a file or from a signed catalog (off by default, your own mirror or the project's
  list): every package is checked before anything in it runs (signature from a trusted key,
  checksums of every file, platform, Kalzit version), and its network targets are granted
  explicitly. Updates stay bound to the publisher's key and never go back to an older version.
- Each plugin has its own page with its manifest, permissions, process, sandbox layers, log and
  the data sources that use it; organizations can block a plugin for themselves.
- Plugins run in a sandbox: on Windows a restricted token in a job object and an AppContainer
  without network, on Linux Landlock, seccomp and namespaces. A plugin has no network of its own
  and reaches only the targets its manifest declares, through Kalzit, which checks every
  connection. On Linux plugins need Landlock unless an administrator allows them without it;
  without Landlock a plugin could read Kalzit's files. Its network stays closed through the
  seccomp filter or a network namespace; only if plugins are allowed without Landlock and the host
  offers neither, a plugin starts with an unlimited network and its page warns about it.
- A Rust SDK and the `kalzit-plugin` tool to package and sign, with two examples: "CSV and JSON
  over HTTP" and the panel "KPI tile" ([writing plugins](docs/plugins/authoring.md)).

### AI

- Off until a server administrator connects a provider and turns it on; without one, no AI button
  or hint appears. Any OpenAI-compatible server (Ollama, LiteLLM, vLLM, OpenAI) or Anthropic,
  configured per server or per organization, with a provider per function if you like.
- **Explain** and **Draft** a query in Explore (a draft is never run by itself), **Summarize** a
  result in Explore or a panel.
- **Ask** (beta): questions about your data in plain words; the assistant reads schemas, runs
  read-only queries and dashboard panels with your rights and shows every step with its query and
  result.
- AI reads a data source only after it was opened to AI; excluded fields are left out by name (a
  field renamed in a query is not caught), so data that must never reach a provider stays in a
  source closed to AI. Everyone sees once which data goes where, and limits per person and
  organization apply.
  Every call is in the audit log, without the question, the answer or any result; chats are
  private and deleted after 30 days by default.

### Organizations, roles and administration

- Several organizations per installation, with members and teams.
- Built-in roles owner, admin, editor and viewer, custom roles made of fine-grained permissions,
  and grants on single folders, dashboards and data sources.
- Viewers run only the stored queries of dashboards they may read; free queries need
  `datasources:query` (editor and up).
- Settings on one page for the server, the organization and yourself, with a search that finds
  any setting in German or English and a link to every setting. Changes apply at once with undo;
  values from the environment or `kalzit.toml` show locked with their source.
- Appearance and brand through checked options, never custom CSS: default theme, accent color
  (eight checked colors, or your own color when its contrast is high enough), product name and
  logo, density, font size, start page, time zone and the sign-in page's welcome text and notice,
  per server and per organization. Settings export and import as JSON with a preview of every
  change.
- Users and organizations for server administrators; an audit log with configurable retention.
- Usage insights per organization: the most viewed dashboards, the slowest panels, errors, cache
  hit rates and dashboards nobody opens, counted per dashboard, panel and data source, never per
  person.
- Updates from signed GitHub releases or an offline package: verified with Ed25519 before
  anything is installed, a database backup first, an automatic return when the new version does
  not start healthy, planning for a maintenance window and a history with returns to kept
  versions ([operator guide](docs/operations/updates.md)).
- Interface in English and German, light, dark and high contrast themes, keyboard shortcuts and a
  command palette (Ctrl+K).

### Sign-in and identity

- Single sign-on with OpenID Connect (Keycloak, Authentik, Entra ID, ...), SAML 2.0 (AD FS, Entra
  ID, Shibboleth, ...) and LDAP or Active Directory, each tested with a test sign-in before it is
  saved. The groups a provider sends give roles and teams per organization ("IdP decides" or
  "Kalzit adds"), and a nightly directory sync locks people who left.
- SCIM 2.0 provisioning of people and groups from Entra ID, Okta and other directories, one token
  per organization; nothing is ever deleted through SCIM.
- Two-factor sign-in with passkeys, an authenticator app and recovery codes, optional or required
  by the server or an organization, also after LDAP and providers.
- Recent sign-ins on the account page (method, provider, second factor, browser, address and
  refused attempts), and for server admins on the user list; sessions you can see and end.
- Local accounts with Argon2id passwords and sign-in rate limits; password sign-in can be turned
  off for everyone except a break-glass admin.
- Service accounts with API tokens (`Bearer kz_sa_...`) that are shown once, expire, can be bound
  to networks and are revoked at once.
- Mail through your SMTP server: invitations with a role and team, password reset links and
  notices, in the recipient's language; without a mail server, links to pass on.

### Operations

- Windows installer (MSI) that sets up the Windows service with its own service account, in German
  or English; deb and rpm packages with a hardened systemd service for Debian, Ubuntu, Fedora and
  RHEL; a Docker image.
- HTTPS with your own certificate files or automatic certificates from Let's Encrypt or another
  ACME authority (HTTP-01 or TLS-ALPN-01), renewed without a restart.
- High availability: several Kalzit servers on one PostgreSQL database behind a load balancer,
  with one leader for scheduled work and changes reaching every server within a second
  ([guide](docs/operations/high-availability.md)).
- A query cache on the server, per person, so repeated loads and auto refresh do not hit the
  database again.

### Security posture

- **Read-only data sources.** SQL sources accept one `SELECT` or `WITH` statement (parsed, not
  pattern-matched) and run in a read-only transaction where the engine has one; Cypher runs in a
  read transaction; GSQL is parsed and refused when it writes; MongoDB pipelines that write are
  refused; search and HTTP sources reach only read endpoints. The settings form still asks for a
  read-only login, which is the real boundary.
- **Server-side authorization.** Every route declares its access rule and every request and
  resource is checked on the server; a resource you may not see answers "not found".
- **Target policy.** Sources may point at private networks and localhost, but Kalzit's own data
  directory and database, link-local and cloud metadata addresses, and SQLite or other files
  outside directories an administrator allowed are always refused. Administrators can restrict
  sources further to a list of hosts and networks.
- **Secrets** are encrypted with AES-256-GCM; the key comes from the environment, systemd
  credentials or DPAPI (see [Configuration](#configuration)).
- **Private data directory.** Kalzit creates its data directory closed to other accounts and
  refuses to start when an existing one is open to them.
- **Signed, sandboxed plugins.** Only packages signed by a trusted key run (unsigned ones only
  behind an explicit switch), in an operating system sandbox without a network of their own.
- **AI only reads.** AI acts with the asking person's rights through the normal read-only query
  path, sees only sources opened to it, and never sees secrets or connection settings.

## Screenshots

The same pictures as the gallery on the website: the current development version with the fictional
example data of a data center, "Site Basalt" (every name and figure is invented). They follow your
GitHub theme, dark or light. More screens are in the [user guide](docs/guide/README.md); how the
pictures are made is in [docs/screenshots/README.md](docs/screenshots/README.md).

### Dashboards

<picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/dashboard-overview-light.webp"><img src="docs/screenshots/gallery/dashboard-overview-dark.webp" alt="A Kalzit dashboard named Site Basalt overview: four key figures with small charts, line charts of IT power per hall and inlet temperature per row over 24 hours, average power per row as bars, PUE per hall and a table of the racks with the highest power draw"></picture>

Site overview: key figures, power and temperature per hall and row, the racks with the highest power draw.

| | |
|---|---|
| <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/dashboard-all-sources-light.webp"><img src="docs/screenshots/gallery/dashboard-all-sources-dark.webp" alt="A dashboard that combines a time series from SQLite, bars from OpenSearch, the incident severity across MongoDB documents and the power chain as a graph from Neo4j"></picture> | <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/dashboard-live-light.webp"><img src="docs/screenshots/gallery/dashboard-live-dark.webp" alt="A live dashboard of rack temperatures in hall B, each panel marked as live every 30 seconds"></picture> |
| One dashboard, four sources: SQLite, OpenSearch, MongoDB and Neo4j. | Rack temperatures in hall B, live every 30 seconds. |

### Graphs

<picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/graph-network-light.webp"><img src="docs/screenshots/gallery/graph-network-dark.webp" alt="A graph panel with the network and power topology of the example data center, nodes colored by label"></picture>

Network and power topology: 88 nodes, colored by label.

| | |
|---|---|
| <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/graph-inspector-light.webp"><img src="docs/screenshots/gallery/graph-inspector-dark.webp" alt="The same topology with one server selected and the node inspector open on the right"></picture> | <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/graph-hierarchy-paths-light.webp"><img src="docs/screenshots/gallery/graph-hierarchy-paths-dark.webp" alt="A graph laid out as a hierarchy from the site down to servers, and two path panels below it"></picture> |
| One node selected: the rest fades back, the inspector lists its properties. | A hierarchy from site to servers, and the paths between two nodes. |

### Documents

| | |
|---|---|
| <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/documents-dashboard-light.webp"><img src="docs/screenshots/gallery/documents-dashboard-dark.webp" alt="A dashboard of MongoDB documents: incidents as a tree, the field schema of the asset records and two value distributions"></picture> | <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/documents-pipeline-light.webp"><img src="docs/screenshots/gallery/documents-pipeline-dark.webp" alt="Explore with a MongoDB aggregation pipeline and a preview of the documents after the first stage"></picture> |
| Incidents as nested documents, field coverage and value distributions. | An aggregation pipeline, stage by stage, with a preview of the documents. |

### Explore

| | |
|---|---|
| <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/explore-steps-light.webp"><img src="docs/screenshots/gallery/explore-steps-dark.webp" alt="Explore with a SQL query on SQLite and two steps that add a moving average and a trend line"></picture> | <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/graph-explorer-light.webp"><img src="docs/screenshots/gallery/graph-explorer-dark.webp" alt="A graph panel in explorer mode, expanded in two steps from a spine switch, with the inspector open"></picture> |
| A SQL query with two steps: a moving average and a trend line. | A graph explored step by step: load the neighbours of a node. |

### AI

<picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/ask-answer-light.webp"><img src="docs/screenshots/gallery/ask-answer-dark.webp" alt="Ask: a question about the hottest racks, the assistant's steps (sources, schema, a read-only SQL query with its result) and the answer; on the right the model, its endpoint and whether data leaves the network"></picture>

Ask: a question in plain words, every step the assistant took with its query and result, then
the answer.

| | |
|---|---|
| <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/explore-explain-light.webp"><img src="docs/screenshots/gallery/explore-explain-dark.webp" alt="Explore with a saved SQL query on PUE per hall and its explanation above the editor"></picture> | <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/explore-summarize-light.webp"><img src="docs/screenshots/gallery/explore-summarize-dark.webp" alt="Explore with the result table of PUE and IT load per hall and a summary of it"></picture> |
| Explain a query in the editor. | Summarize a result, with what was sent. |
| <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/ai-settings-light.webp"><img src="docs/screenshots/gallery/ai-settings-dark.webp" alt="Settings, AI: the switch, the status, and two providers with base URL, model, where data goes and their last test"></picture> | <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/ai-functions-light.webp"><img src="docs/screenshots/gallery/ai-functions-dark.webp" alt="Settings, AI: which provider explains and drafts, which summarizes and which answers in Ask, and the limits below"></picture> |
| AI is off until an administrator connects a provider and turns it on. | A provider per function, and the limits per person and organization. |

### Plugins

<picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/dashboard-plugin-panel-light.webp"><img src="docs/screenshots/gallery/dashboard-plugin-panel-dark.webp" alt="A dashboard with four KPI tile panels from a panel plugin, each with a value, its change and a sparkline, above a time series of IT power per hall"></picture>

Panels of a plugin (the example "KPI tile"), each in a sealed-off frame, next to a built-in
time series.

| | |
|---|---|
| <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/plugins-installed-light.webp"><img src="docs/screenshots/gallery/plugins-installed-dark.webp" alt="Settings, Plugins: a data source plugin and a panel plugin with publisher, signature key, version, network targets and status"></picture> | <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/plugin-page-light.webp"><img src="docs/screenshots/gallery/plugin-page-dark.webp" alt="The page of a data source plugin: granted permissions and its process with the sandbox layers"></picture> |
| Installed plugins with publisher, signature and status. | A plugin's page: what it may reach and the layers of its sandbox. |
| <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/plugin-install-light.webp"><img src="docs/screenshots/gallery/plugin-install-dark.webp" alt="Install from file: the checks of a signed package passed, and the network targets to grant"></picture> | <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/plugins-catalog-light.webp"><img src="docs/screenshots/gallery/plugins-catalog-dark.webp" alt="The plugin catalog: a signed list of plugins with publisher key, version and network targets, to install or update"></picture> |
| Every package is checked before anything in it runs. | The catalog: a signed list, off until an administrator turns it on. |

### Sign-in and identity

<picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/recent-sign-ins-light.png"><img src="docs/screenshots/recent-sign-ins-dark.png" alt="Settings, Sign-in and security: the password and the second factor with an authenticator app, passkeys and recovery codes, and beside them the recent sign-ins with method, provider, second factor, browser and address, this session marked and a refused attempt"></picture>

Your sign-ins, with this session marked and refused attempts with their reason.

| | |
|---|---|
| <img src="docs/screenshots/sign-in-providers.png" alt="Settings, Sign-in: three providers, OpenID Connect, LDAP and SAML, with their place on the sign-in page, status and number of people"> | <img src="docs/screenshots/sign-in-ldap.png" alt="The dialog of an Active Directory provider: server with LDAPS, service account, base DN, login attribute and the directory sync"> |
| OpenID Connect, LDAP and SAML side by side, in the order of the sign-in page. | An Active Directory with LDAPS, nested groups and a nightly sync. |
| <img src="docs/screenshots/sign-in-saml.png" alt="The dialog of a SAML provider: metadata URL, entity ID, sign-in URL, the pinned certificate and Kalzit's own addresses to enter at the provider"> | <img src="docs/screenshots/two-factor-setup-app.png" alt="The second step of setting up two-factor sign-in: the QR code and key for an authenticator app"> |
| SAML with the pinned certificate and Kalzit's addresses for the provider. | Two-factor sign-in with an authenticator app, passkeys and recovery codes. |
| <img src="docs/screenshots/service-accounts.png" alt="Administration, Service accounts: an account with its role and an API token limited to a network"> | <img src="docs/screenshots/scim.png" alt="The SCIM card: the endpoint to copy, the organization's SCIM token and what SCIM did today"> |
| Service accounts with API tokens that expire and can be bound to networks. | SCIM provisioning from Entra ID, Okta and other directories. |

### First steps

| | |
|---|---|
| <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/setup-light.webp"><img src="docs/screenshots/gallery/setup-dark.webp" alt="The first-run setup of Kalzit at the owner account step"></picture> | <picture><source media="(prefers-color-scheme: light)" srcset="docs/screenshots/gallery/sign-in-light.webp"><img src="docs/screenshots/gallery/sign-in-dark.webp" alt="The sign-in page of Kalzit"></picture> |
| The first start: setup code, owner account and organization. | Signing in with email address and password. |

## Quick start

Run the container image (below), install the Windows service with the MSI package from the
[releases](https://github.com/MouseWerk/Kalzit/releases) (see
[the installation guide](docs/guide/installation.md#windows)), or build Kalzit from source. The
result of a build is one binary, `kalzit` (`kalzit.exe` on Windows), with the web interface
embedded.

### Docker

The image `ghcr.io/mousewerk/kalzit` runs on Linux (amd64 and arm64) and on Docker Desktop for
Windows and macOS. It keeps its data in the volume `/var/lib/kalzit` and listens on port 3000:

```sh
docker run -d --name kalzit -p 3000:3000 -v kalzit-data:/var/lib/kalzit ghcr.io/mousewerk/kalzit
docker exec kalzit kalzit setup-code     # the one-time setup code for the first start
```

Then open `http://localhost:3000`. Compose files for SQLite and for PostgreSQL as Kalzit's own
database are in [deploy/docker](deploy/docker); configuration, the secrets key as a Docker secret,
health checks and updates are described in
[the installation guide](docs/guide/installation.md#docker).

### Prerequisites for a build

| Tool | Version |
|---|---|
| Rust | current stable toolchain (edition 2024; CI uses `stable`) |
| Node.js | 26 or newer (`engines` in [ui/package.json](ui/package.json)) |
| Git | any recent version |

No C compiler, OpenSSL or database server is needed: TLS uses rustls and the default database is
an embedded SQLite file.

### Build

The UI is built first, because the server embeds `ui/dist` at compile time.

Linux:

```sh
git clone https://github.com/MouseWerk/Kalzit.git
cd Kalzit/ui
npm ci
npm run build
cd ..
cargo build --release --locked
```

Windows (PowerShell):

```powershell
git clone https://github.com/MouseWerk/Kalzit.git
cd Kalzit\ui
npm ci
npm run build
cd ..
cargo build --release --locked
```

The binary lands in `target/release/kalzit` (`target\release\kalzit.exe`).

### First run

```sh
./target/release/kalzit          # Linux
.\target\release\kalzit.exe      # Windows
```

1. Kalzit listens on port **3000** (`0.0.0.0:3000`) and keeps its data in the data directory:

   | System | Default data directory |
   |---|---|
   | Windows | `%ProgramData%\Kalzit\data` |
   | Linux | `/var/lib/kalzit` |

   The account Kalzit runs as must be able to create it (on Linux, for example
   `sudo install -d -o "$USER" -m 0700 /var/lib/kalzit`), or point it somewhere else with
   `KALZIT_PATHS_DATA_DIR`.
2. Open `http://localhost:3000`. On the first start Kalzit asks for a one-time setup code, which
   it writes to `setup-token.txt` in the data directory (`kalzit setup-code` prints it).
3. Enter the code (it is checked right away), then create your owner account and the first
   organization with its defaults. The last step offers sample data to explore.

To run Kalzit as a systemd service, see "Running as a service" in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#running-as-a-service); on Windows,
`kalzit service install` (elevated) sets up the Windows service without the MSI package
([installation guide](docs/guide/installation.md#windows)).
Backups are described under [Backups](docs/ARCHITECTURE.md#backups). The container image is
described under [Docker](#docker); the deb and rpm packages with their systemd service under
[Installation](docs/guide/installation.md#debian-ubuntu-fedora-rhel-deb-and-rpm).

## Configuration

Settings come from three layers, in this order of precedence: `KALZIT_*` environment variables,
the configuration file `kalzit.toml`, then values saved in the administration. What the
environment or the file sets is shown locked in the UI. Network and TLS settings can only be set
in the file or the environment, so a wrong value cannot lock you out.

`kalzit.toml` is read from `--config <file>` or `KALZIT_CONFIG`, otherwise from `./kalzit.toml`,
then `%ProgramData%\Kalzit\kalzit.toml` (Windows) or `/etc/kalzit/kalzit.toml` (Linux). Relative
paths in the file resolve against the file's folder.

```toml
[server]
http_addr = "0.0.0.0:3000"
public_url = "https://kalzit.example.com"

[paths]
data_dir = "data"

[database]
url = "postgres://kalzit@db.internal/kalzit"   # default: SQLite in the data directory
```

| Variable | Purpose |
|---|---|
| `KALZIT_CONFIG` | Path of the configuration file |
| `KALZIT_<SECTION>_<KEY>` | Any configuration key, for example `KALZIT_SERVER_HTTP_ADDR`, `KALZIT_PATHS_DATA_DIR`, `KALZIT_DATABASE_URL`, `KALZIT_TLS_CERT_FILE` |
| `KALZIT_SETTING_<KEY>` | Runtime settings, for example `KALZIT_SETTING_DATASOURCES_SQLITE_DIRS` |
| `KALZIT_DATABASE_URL_FILE` | A file with the URL of Kalzit's own database (also the credential `kalzit-database-url`), so the password is in no variable |
| `KALZIT_SECRETS_KEY` | Key for data source secrets (base64, 32 bytes) |
| `KALZIT_SETUP_TOKEN` | A setup code of your own instead of a generated one |

Configuration sections are `server`, `tls`, `security`, `sessions`, `database`, `paths`, `log`
and `smtp` (the mail server, otherwise set in Settings, Email; give its password in
`KALZIT_SMTP_PASSWORD`); unknown keys and misspelled `KALZIT_*` variables are refused at start.
`kalzit check-config` validates a configuration without starting the server.

- **Own database:** SQLite (default, one server) or PostgreSQL (`database.url`).
- **HTTPS:** your own certificate and key in PEM (`tls.cert_file`, `tls.key_file`), reloaded
  without a restart, or without them automatic certificates from Let's Encrypt or another ACME
  authority, set up in Settings, Network ([HTTPS and certificates](docs/guide/https.md));
  trusted reverse proxies in `security.trusted_proxies`.
- **Secrets key** for data source passwords and tokens, first match wins: `KALZIT_SECRETS_KEY`,
  systemd credentials (`kalzit-secrets-key`) on Linux, a DPAPI-protected key file on Windows,
  and as a last resort a `secrets.key` file with mode 0600 in the data directory (with a warning in
  the log). Back up the key together with the database. `kalzit secrets rotate` re-encrypts all
  secrets with a new key.
- **Health checks:** `/healthz` and `/readyz`; `kalzit healthcheck` asks `/readyz` of the
  server on the same machine (exit code 0 when ready), for container health checks.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (configuration, data directory, storage,
backups) and [docs/api/settings-dashboards.md](docs/api/settings-dashboards.md) (every setting).

## Architecture

```mermaid
flowchart LR
  browser["Browser<br/>React UI"] -- "HTTPS / JSON API" --> server
  subgraph kalzit["kalzit binary"]
    server["axum server<br/>auth, authorization, query engine"]
    ui["embedded UI<br/>(ui/dist)"]
    server --- ui
  end
  server --> own[("Own database<br/>SQLite or PostgreSQL")]
  server --> plugins["Data source kinds<br/>(compiled in or plugin processes)"]
  plugins --> sql[("SQL and metrics<br/>frame")]
  plugins --> docs[("MongoDB, search, files<br/>documents")]
  plugins --> graphs[("Neo4j, Memgraph, TigerGraph<br/>graph")]
```

- The Rust server (axum, tokio, sqlx, rustls) serves the API and the embedded UI from one
  origin. Queries always run on the server, never from the browser to a database.
- Every data source implements one plugin trait; the built-in sources are compiled in, and
  external plugins serve the same contract over gRPC from a sandboxed process.
- The UI is React 19 with the React Compiler, TypeScript, Vite, TanStack Router and Query, and
  modern CSS without a framework. Its API types are generated from the server.

| Path | What |
|---|---|
| [`server/`](server) | Rust crate `kalzit`: HTTP server, auth, authorization, data sources, query engine, storage |
| [`server/migrations/`](server/migrations) | SQL migrations for SQLite and PostgreSQL |
| [`plugin-api/`](plugin-api), [`plugin-sdk/`](plugin-sdk), [`plugin-tool/`](plugin-tool) | Plugin protocol and manifest, the Rust SDK, the `kalzit-plugin` packaging and signing tool; examples in [`examples/plugins/`](examples/plugins) |
| [`ui/`](ui) | React web interface; [`ui/e2e/`](ui/e2e) holds the Playwright tests and the screenshot script |
| [`docs/`](docs) | Plan, architecture, HTTP API, design notes, glossary, release notes |
| [`.github/`](.github) | CI workflows, Dependabot, issue and pull request templates |

## Development

After building the UI once, run the server with `cargo run` from the repository root and the UI
dev server with `npm run dev` in `ui/`, which proxies the API to the server on port 3000. The checks every pull request must pass:

```sh
# Server (repository root)
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked

# UI (ui/)
npm run check
npm run lint
npm run typecheck
npm test
npm run build

# End-to-end against the release binary (ui/)
npm run e2e
```

Data source tests run against real databases when `KALZIT_TEST_<SOURCE>_URL` is set and are
skipped with a notice otherwise. Pull requests that change the UI visibly rerun
`npm run screenshots` and commit the changed images. More in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#testing-contracts) and [ui/README.md](ui/README.md).

**CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs formatting, lints, unit and
API tests, the UI checks and the Playwright end-to-end tests on both `ubuntu-latest` and
`windows-latest`, plus PostgreSQL as Kalzit's own database, data sources against real servers in
containers, and `cargo audit` and `npm audit`. A nightly job tests TigerGraph against a real
instance.

## Roadmap

The full plan, milestone by milestone, is in [docs/PLAN.md](docs/PLAN.md) (German).

<picture><source media="(prefers-color-scheme: light)" srcset="docs/roadmap/progress-light.svg"><img src="docs/roadmap/progress-dark.svg" alt="Milestone progress. M0 Foundation: done. M1 Core: done. M2 Documents: done. M3 Graphs: done. M4 Plugins and AI: done. M5 Operations: done. M6 Polish: in progress, 15 of 68 plan items done. M7 Expansion: planned. M8 Plugin store: planned."></picture>

The bars come from [docs/roadmap/progress.json](docs/roadmap/progress.json); M6 counts the items of
its plan that are merged.

| Milestone | Scope | Status |
|---|---|---|
| M0 Foundation | Server with HTTP and HTTPS, own database with migrations, first-run setup, local sign-in, design tokens, i18n, CI on Windows and Linux | Done |
| M1 Core | Organizations, teams, roles and permissions, administration, audit log, dashboards, SQL and Prometheus sources, Explore, analysis steps, export | Done |
| M2 Documents | MongoDB with pipeline editor, document views, schema and distribution, projections, Elasticsearch and OpenSearch, files and HTTP JSON, saved analyses, live updates with change streams, Docker image | Done |
| M3 Graphs | Neo4j, Memgraph and TigerGraph with Cypher and GSQL editors, network, hierarchy and path panels with node details, explorer mode, graph steps, variables across result shapes, new sign-in and setup with sample data | Done |
| M4 Plugins and AI | External plugin processes in a sandbox, signatures, catalog, Rust SDK, panel plugins; AI help and the "Fragen" chat | Done |
| M5 Operations | OIDC, LDAP and Active Directory, SAML and SCIM, two-factor sign-in, recent sign-ins, mail and invitations, ACME, service accounts, high availability on PostgreSQL, Windows service installer, deb and rpm packages, query cache, usage insights, InfluxDB, Loki, ClickHouse | Done |
| M6 Polish | No new features: fixing and polishing every area, open review points, UI flaws, flaky tests, performance, accessibility and docs, plus promised work not built yet (graph export, read-only database graph algorithms, shape per label) | In progress |
| M7 Expansion | Alerting, public links and snapshots, scheduled reports, provisioning as code with Git and a CLI, deeper analysis and Explore, dashboard tabs, XY and map panels, forecast and outlier steps, graph analysis (algorithms, filters, schema, map layout), an MCP server, further sources (Graphite, Redis, Oracle, traces, BigQuery, Snowflake, Databricks) | Planned |
| M8 Plugin store | Community store for plugins: a site with every plugin, submissions by community authors, review and signing, revocations; the source of the catalog in Kalzit | Planned |

## Documentation

- [docs/guide/](docs/guide/README.md): the user guide, one page per area: installation, getting
  started, dashboards, panels, Explore, calculated fields and statistics, export, data sources,
  plugins, AI and the administration.
- [docs/PLAN.md](docs/PLAN.md): what Kalzit becomes (German).
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): code layout, contracts, configuration, data
  directory, services, storage, backups and tests.
- [docs/api/](docs/api): the HTTP API: [access](docs/api/access.md),
  [data sources and queries](docs/api/datasources.md),
  [settings and dashboards](docs/api/settings-dashboards.md),
  [dashboard features](docs/api/dashboard-features.md), [shell](docs/api/shell.md),
  [updates](docs/api/updates.md), [plugins](docs/api/plugins.md), [AI](docs/api/ai.md).
- [docs/plugins/authoring.md](docs/plugins/authoring.md): writing, packaging and signing plugins.
- [docs/operations/updates.md](docs/operations/updates.md): installing updates online and offline,
  returning to an earlier version, the release key and its rotation.
- [docs/glossary.md](docs/glossary.md): the terms used in the interface, in German and English.
- [docs/design/feel.md](docs/design/feel.md) and [docs/design/depth.md](docs/design/depth.md):
  look and feel, and the depth of options.
- [docs/releases/](docs/releases): release notes.
- [ui/README.md](ui/README.md): the web interface and its scripts.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the branch and pull
request workflow, the checks and the code rules, and follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Bugs and ideas go to
[GitHub issues](https://github.com/MouseWerk/Kalzit/issues/new/choose).

## Security

Please do not report vulnerabilities in public issues. Use
[GitHub's private vulnerability reporting](https://github.com/MouseWerk/Kalzit/security/advisories/new);
see [SECURITY.md](SECURITY.md).

## License

Kalzit is licensed under the [GNU Affero General Public License v3.0](LICENSE). If you offer a
modified Kalzit to users over a network, the license requires you to make your source code
available to them.

Third-party components keep their own licenses; Settings, About lists every package with its
license, and the notices ship with the interface (`THIRD-PARTY-NOTICES.txt`). The optional ELK
hierarchy layout uses [elkjs](https://github.com/kieler/elkjs), offered under "EPL-2.0 OR
GPL-3.0-or-later"; Kalzit takes it under GPL-3.0-or-later, which section 13 of the GPLv3 and the
AGPLv3 allow to combine with Kalzit, and ships it unmodified as a separate file that loads only
when a panel uses ELK.

Product names and logos are trademarks of their owners. Kalzit uses them only to identify the
data source it connects to, with no endorsement implied (see
[ui/src/assets/logos/NOTICE.md](ui/src/assets/logos/NOTICE.md)). Kalzit is an independent
implementation and is not affiliated with any other dashboard product.

## Acknowledgements

Kalzit builds on excellent open source work, among others:
[uPlot](https://github.com/leeoniya/uPlot) for time series,
[Sigma.js](https://www.sigmajs.org) and [Graphology](https://graphology.github.io) for graphs,
[elkjs](https://github.com/kieler/elkjs) for the optional ELK hierarchy layout,
[CodeMirror](https://codemirror.net) for the query editors,
[React](https://react.dev) and [TanStack](https://tanstack.com) for the interface,
[axum](https://github.com/tokio-rs/axum), [Tokio](https://tokio.rs),
[SQLx](https://github.com/launchbadge/sqlx) and [rustls](https://github.com/rustls/rustls) for the
server, and [Simple Icons](https://simpleicons.org) for the data source logos.
