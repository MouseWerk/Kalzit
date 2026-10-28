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

> **Status: early development.** The current version is 0.3.2;
> features, the API and the configuration may still change. See the [roadmap](#roadmap).

![A dashboard in the dark theme with a region variable, a time series, a stat, a bar chart and a table](docs/screenshots/dashboard-dark.png)

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
| Prometheus | frame | Supported |
| Elasticsearch, OpenSearch | documents (hits), frame (aggregations) | Supported |
| CSV, JSON and NDJSON files | frame (CSV), documents (JSON, NDJSON) | Supported |
| HTTP JSON | documents | Supported |
| MongoDB | documents | Supported |
| Neo4j, Memgraph (Cypher over Bolt) | graph | Supported |
| TigerGraph 3.10+ and 4.x (GSQL) | graph | Supported |
| InfluxDB, Loki, ClickHouse | frame | Planned (M5) |
| Graphite, Redis, Oracle, Tempo, Jaeger | various | Planned (M6) |

Adding a data source shows each kind as a card with its logo; secrets are stored encrypted and
never returned by the API.

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
- Local accounts with Argon2id passwords, sessions you can see and end, and a sign-in rate
  limit.
- Updates from signed GitHub releases or an offline package: verified with Ed25519 before
  anything is installed, a database backup first, an automatic return when the new version does
  not start healthy, planning for a maintenance window and a history with returns to kept
  versions ([operator guide](docs/operations/updates.md)).
- Interface in English and German, light, dark and high contrast themes, keyboard shortcuts and a
  command palette (Ctrl+K).

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

## Screenshots

The images come from the real application with demo data (`npm run screenshots` in `ui/`).

| | |
|---|---|
| ![Start page with the organization in numbers and dashboards as cards](docs/screenshots/start.png) | ![A dashboard in the light theme](docs/screenshots/dashboard-light.png) |
| Start page | Dashboard, light theme |
| ![The full-page panel editor with the preview, the query and the options](docs/screenshots/panel-editor-dark.png) | ![The panel editor's steps tab with a moving average and a trend line](docs/screenshots/panel-editor-steps-dark.png) |
| Panel editor | Analysis steps |
| ![Explore with a SQL query and a time series](docs/screenshots/explore.png) | ![A dashboard on a JSON file of orders: the documents as a tree, their field schema and the distribution of the order status](docs/screenshots/dashboard-documents-dark.png) |
| Explore | Documents: tree, schema and field distribution |
| ![Adding a panel: the visualization picker and a first empty query](docs/screenshots/panel-new-dark.png) | ![Data source kinds as cards with their logos](docs/screenshots/data-source-kinds-dark.png) |
| New panel and visualization picker | Adding a data source |
| ![Form for a new PostgreSQL data source](docs/screenshots/data-source.png) | ![Members of an organization with their roles](docs/screenshots/admin-members.png) |
| Data source form | Members and roles |
| ![List of dashboards](docs/screenshots/dashboards.png) | ![Sessions of the signed-in account](docs/screenshots/account.png) |
| Dashboards | Profile and sessions |
| ![Time series graph styles: a monochrome hatched series, a dashed comparison, bars, points, steps and stacked series](docs/screenshots/graph-styles-light.png) | ![Time series graph styles in the dark theme](docs/screenshots/graph-styles-dark.png) |
| Time series graph styles | Graph styles, dark theme |
| ![Text, grouped bar chart, bar gauge and pie panels in the light theme](docs/screenshots/dashboard-panels-light.png) | ![The same panels in the dark theme](docs/screenshots/dashboard-panels-dark.png) |
| Text, bar chart, bar gauge and pie | The same panels, dark theme |
| ![The panel editor on a phone](docs/screenshots/panel-editor-phone.png) | ![Sign-in page: one card on the calm backdrop, language, theme and help on top](docs/screenshots/sign-in.png) |
| Panel editor on a phone | Sign in |
| ![The time picker with quick ranges, an absolute range and a calendar](docs/screenshots/time-picker-dark.png) | ![A dashboard in edit mode with the rail and its Add pane](docs/screenshots/dashboard-edit-dark.png) |
| Time picker, dark theme | Dashboard in edit mode, dark theme |
| ![A dashboard on a phone with the top bar and the toolbar in two rows](docs/screenshots/dashboard-phone.png) | ![A dashboard with live updates on: each panel says how it stays current](docs/screenshots/dashboard-live-dark.png) |
| Dashboard on a phone | Live updates, dark theme |
| ![Explore with a saved analysis open, its name above the toolbar](docs/screenshots/explore-saved.png) | ![The list of saved analyses with data source, creator and use in dashboards](docs/screenshots/analyses.png) |
| Explore with a saved analysis | Saved analyses |
| ![A saved analysis opened by a viewer to view and run](docs/screenshots/analysis-view.png) | ![Explore on a MongoDB collection with the field distribution counted over all documents of the result](docs/screenshots/explore-distribution-dark.png) |
| A saved analysis for a viewer | Field distribution on MongoDB, dark theme |
| ![Network, hierarchy, path and explorer panels on a Neo4j shop graph, dark theme](docs/screenshots/graph-panels-dark.png) | ![The same graph panels in the light theme](docs/screenshots/graph-panels-light.png) |
| Graph panels on Neo4j, dark theme | Graph panels, light theme |
| ![A network panel with a customer selected and the node details beside the drawing](docs/screenshots/graph-inspector-dark.png) | ![Explorer mode: a customer's orders loaded as a step in the Steps line](docs/screenshots/graph-explorer-dark.png) |
| Node details | Explorer mode |
| ![A category tree as a hierarchy in layers](docs/screenshots/graph-hierarchy-dark.png) | ![A shortest path from a customer to a product, node, relationship, node](docs/screenshots/graph-path-dark.png) |
| Hierarchy | Paths |
| ![Settings: appearance and brand with the preview, dark theme](docs/screenshots/settings-dark.png) | ![Settings: appearance and brand, light theme](docs/screenshots/settings-light.png) |
| Settings, dark theme | Settings, light theme |
| ![Settings on a phone](docs/screenshots/settings-phone.png) | ![Updates: installed version, channel, checks before an update, offline upload and backups](docs/screenshots/updates.png) |
| Settings on a phone | Updates |
| ![First setup, step one: the setup code and where to find it](docs/screenshots/setup.png) | ![First setup, step two: the owner account with the password rules, dark theme](docs/screenshots/setup-account-dark.png) |
| First setup: the setup code | First setup: your account, dark theme |
| ![Sign-in page in the dark theme](docs/screenshots/sign-in-dark.png) | |
| Sign in, dark theme | |
| ![About Kalzit: the calcite crystal with a beam of light split in two, the build and the license, dark theme](docs/screenshots/about-dark.png) | ![About Kalzit in the light theme](docs/screenshots/about-light.png) |
| About Kalzit, dark theme | About Kalzit, light theme |
| ![Settings > Plugins: the installed plugins with publisher, signature, version, network targets and status](docs/screenshots/plugins.png) | ![A plugin's page: granted permissions, the process and its sandbox layers](docs/screenshots/plugin-details.png) |
| Plugins: installed plugins | A plugin's page with its sandbox |
| ![Signature and trust: the trusted keys and the switch for unsigned plugins](docs/screenshots/plugins-trust.png) | ![Add data source with a plugin kind: its own group, the publisher and the plugin's advice](docs/screenshots/data-source-plugin.png) |
| Plugins: signature and trust | A data source of a plugin kind |

## Quick start

Run the container image (below), or build Kalzit from source. The result of a build is one
binary, `kalzit` (`kalzit.exe` on Windows), with the web interface embedded.

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

To run Kalzit as a systemd service or a Windows service with a virtual account, see
"Running as a service" in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#running-as-a-service).
Backups are described under [Backups](docs/ARCHITECTURE.md#backups). The container image is
described under [Docker](#docker); deb and rpm packages are planned for M5.

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

Configuration sections are `server`, `tls`, `security`, `sessions`, `database`, `paths` and
`log`; unknown keys and misspelled `KALZIT_*` variables are refused at start.
`kalzit check-config` validates a configuration without starting the server.

- **Own database:** SQLite (default, one server) or PostgreSQL (`database.url`).
- **HTTPS:** your own certificate and key in PEM (`tls.cert_file`, `tls.key_file`), reloaded
  without a restart; trusted reverse proxies in `security.trusted_proxies`.
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
  server --> plugins["Data source plugins<br/>(compiled in)"]
  plugins --> sql[("SQL and metrics<br/>frame")]
  plugins --> docs[("MongoDB, search, files<br/>documents")]
  plugins --> graphs[("Neo4j, Memgraph, TigerGraph<br/>graph")]
```

- The Rust server (axum, tokio, sqlx, rustls) serves the API and the embedded UI from one
  origin. Queries always run on the server, never from the browser to a database.
- Every data source implements one plugin trait; the built-in sources are compiled in, and
  external plugins over the same contract are planned for M4.
- The UI is React 19 with the React Compiler, TypeScript, Vite, TanStack Router and Query, and
  modern CSS without a framework. Its API types are generated from the server.

| Path | What |
|---|---|
| [`server/`](server) | Rust crate `kalzit`: HTTP server, auth, authorization, data sources, query engine, storage |
| [`server/migrations/`](server/migrations) | SQL migrations for SQLite and PostgreSQL |
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

| Milestone | Scope | Status |
|---|---|---|
| M0 Foundation | Server with HTTP and HTTPS, own database with migrations, first-run setup, local sign-in, design tokens, i18n, CI on Windows and Linux | Done |
| M1 Core | Organizations, teams, roles and permissions, administration, audit log, dashboards, SQL and Prometheus sources, Explore, analysis steps, export | Done |
| M2 Documents | MongoDB with pipeline editor, document views, schema and distribution, projections, Elasticsearch and OpenSearch, files and HTTP JSON, saved analyses, live updates with change streams, Docker image | Done |
| M3 Graphs | Neo4j, Memgraph and TigerGraph with Cypher and GSQL editors, network, hierarchy and path panels with node details, explorer mode, graph steps, variables across result shapes, new sign-in and setup with sample data | Done |
| M4 Plugins | External plugin processes, manifest, signatures, catalog, Rust SDK | Planned |
| M5 Operations | OIDC, LDAP and Active Directory, two-factor sign-in, mail and invitations, ACME, service accounts, Windows service installer, deb and rpm packages, InfluxDB, Loki, ClickHouse | Planned |
| M6 Expansion | Alerting, public links, provisioning as code, further sources (Graphite, Redis, Oracle, traces) | Planned |

## Documentation

- [docs/guide/](docs/guide/README.md): the user guide, one page per area: installation, getting
  started, dashboards, panels, Explore, calculated fields and statistics, export, data sources and
  the administration.
- [docs/PLAN.md](docs/PLAN.md): what Kalzit becomes (German).
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): code layout, contracts, configuration, data
  directory, services, storage, backups and tests.
- [docs/api/](docs/api): the HTTP API: [access](docs/api/access.md),
  [data sources and queries](docs/api/datasources.md),
  [settings and dashboards](docs/api/settings-dashboards.md),
  [dashboard features](docs/api/dashboard-features.md), [shell](docs/api/shell.md),
  [updates](docs/api/updates.md).
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

Product names and logos are trademarks of their owners. Kalzit uses them only to identify the
data source it connects to, with no endorsement implied (see
[ui/src/assets/logos/NOTICE.md](ui/src/assets/logos/NOTICE.md)). Kalzit is an independent
implementation and is not affiliated with any other dashboard product.

## Acknowledgements

Kalzit builds on excellent open source work, among others:
[uPlot](https://github.com/leeoniya/uPlot) for time series,
[Sigma.js](https://www.sigmajs.org) and [Graphology](https://graphology.github.io) for graphs,
[CodeMirror](https://codemirror.net) for the query editors,
[React](https://react.dev) and [TanStack](https://tanstack.com) for the interface,
[axum](https://github.com/tokio-rs/axum), [Tokio](https://tokio.rs),
[SQLx](https://github.com/launchbadge/sqlx) and [rustls](https://github.com/rustls/rustls) for the
server, and [Simple Icons](https://simpleicons.org) for the data source logos.
