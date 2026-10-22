# Kalzit

Kalzit is a self-hosted platform for visualizing and analyzing data: dashboards, data sources,
organizations, teams, roles and plugins. Document databases (MongoDB) and graph databases (Neo4j,
Memgraph, TigerGraph) are planned as native data shapes with their own views, not tables in
disguise. All common sources (PostgreSQL, MySQL/MariaDB, SQL Server, SQLite, Prometheus,
Elasticsearch and more) are supported as well. The server runs on Windows and Linux.

Status: early development. The plan is in [docs/PLAN.md](docs/PLAN.md).

![A dashboard with a region variable, a time series, a stat, a bar chart and a table](docs/screenshots/dashboard-light.png)

## What works today

- **Dashboards** with folders, versions and a conflict dialog when two people save at once.
  Panels: time series, stat, bar chart and table. Variables (fixed values, free text, values from
  a query) reach the database as parameters, never as text in the query.
- **Explore**: write a query, see the result in a matching visualization, inspect it and add it
  to a dashboard.
- **Data sources**: PostgreSQL, MySQL/MariaDB, SQL Server, SQLite and Prometheus. Read-only by
  default (queries that change data are refused on the server), secrets stored encrypted, and
  addresses that must not be reached (Kalzit's own database, cloud metadata) are refused.
- **Organizations, teams and roles**: owner, admin, editor, viewer and own roles from fine-grained
  permissions, plus access to single folders, dashboards and data sources. Every request is
  checked on the server.
- **Administration**: users, organizations, server and organization settings, audit log.
- Interface in English and German, with light, dark and high contrast themes.

| | |
|---|---|
| ![Dashboard in the dark theme](docs/screenshots/dashboard-dark.png) | ![Explore with a time series](docs/screenshots/explore.png) |
| Dashboard, dark theme | Explore |
| ![Form for a new PostgreSQL data source](docs/screenshots/data-source.png) | ![Members of an organization with their roles](docs/screenshots/admin-members.png) |
| Data source form | Members and roles |
| ![Sign-in page](docs/screenshots/sign-in.png) | ![Account page with profile, password and sessions](docs/screenshots/account.png) |
| Sign in | Your account |

The screenshots come from the real application with demo data (`npm run screenshots` in `ui/`).

## Running Kalzit

Kalzit is one binary with the web interface built in. To build it from source you need Rust
(stable) and Node.js 26:

```
cd ui
npm ci
npm run build
cd ..
cargo build --release
```

Start it with `target/release/kalzit` (`kalzit.exe` on Windows). It listens on port 3000 and keeps
its data in `/var/lib/kalzit` on Linux and `%ProgramData%\Kalzit\data` on Windows; the
configuration file `kalzit.toml` or `KALZIT_*` environment variables change that. On the first
start, open `http://localhost:3000` and enter the setup code from `setup-token.txt` in the data
folder to create the first organization and its owner.

## Documentation

- [docs/PLAN.md](docs/PLAN.md): what Kalzit becomes, milestone by milestone.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the code is shaped, configuration, data
  directory, backups and tests.
- [docs/api/](docs/api/): the HTTP API (access, data sources and queries, settings and
  dashboards).
- [docs/glossary.md](docs/glossary.md): the terms used in the interface.
- [ui/README.md](ui/README.md): the web interface and its scripts.

## License

AGPL-3.0, see [LICENSE](LICENSE).
