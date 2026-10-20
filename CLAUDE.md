# Working on Granit

Granit is a self-hosted dashboard and observability platform (dashboards, data sources, roles,
teams, plugins) where document databases (MongoDB) and graph databases (Neo4j, Memgraph) are native
data shapes, not converted to tables, next to all common SQL and metrics sources. Server runs on
Windows and Linux. Planned stack: Rust server
(axum, sqlx), React + TypeScript UI embedded in one binary. Read `docs/PLAN.md` first. Follow
https://github.com/mauricekleindienst/AICodeGuidelines (read its CLAUDE.md first); this file wins
where it is more specific.

## Owner decisions (standing)

- Commits are authored as `Maurice Kleindienst <kleindiema@gmail.com>` (see owner.md). No co-author
  or session trailers, no assistant or model names in commits, code, comments or docs.
- No pull requests unless asked. No force push, branch deletion or history rewrite without an
  explicit request.
- Secrets only in the OS credential store or the environment's secret settings.
- Positioning: a platform for visualizing and analyzing data in general, not only monitoring.
- Server in Rust. License AGPL-3.0. Self-hosted only, no cloud offering. Public GitHub repository.
- Multiple organizations per installation. Alerting comes in M6, after the core.
- First graph sources: Neo4j and Memgraph. All common standard sources are supported too
  (PostgreSQL, MySQL/MariaDB, SQL Server, SQLite, Prometheus, Elasticsearch, ...; see
  `docs/PLAN.md` section 3).
- UI in German with "du" and English; glossary in `docs/glossary.md` (to be created).
- Clean-room implementation: no Grafana code, name or logo in the product.
- Every query result keeps its native shape (`frame`, `documents`, `graph`); conversions are
  explicit, visible projection steps in the query, never implicit in the backend.
- Data sources are read-only by default; write queries are rejected server-side.
- Windows and Linux servers are both first-class: CI, e2e and releases run on both.

## Code rules

- Match the surrounding style and comment density. No emojis anywhere.
- UI texts go through the i18n catalogs; the translation check must pass.
- Use the design tokens; no one-off colors or sizes.
- No accent-colored borders, outlines, left bars, glows or gradient borders for selected, active or
  current states (graph node selection included); quiet neutral tint and text weight instead.
  Focus visible only on `:focus-visible`, neutral. No colored bars on the left anywhere.
- Authorization is checked on the server for every request and resource.
- Release notes: `docs/releases/v<version>.md` with "## Improved", "## Fixed" and
  "## Checklist for Windows (manual)"; user-facing lines only.

## Checks

```
<to be defined in M0: cargo fmt --check, cargo clippy, cargo test, npm run lint, npm run typecheck,
npm test, production build + Playwright e2e on Linux and Windows>
```

Never kill processes by name or pattern; kill only PIDs you started. Prefer root-cause fixes; never
skip or weaken a test.
