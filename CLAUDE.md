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
- Work like a professional team: every change goes through a feature branch (`m<n>/<topic>`,
  `fix/<topic>`) and a pull request into `main`. Parallel work runs in sub-agents with their own
  worktrees; the orchestrator integrates, opens the PR and runs a review agent on it.
- PRs are squash-merged (PR title becomes the commit subject); the branch is deleted after merge.
  `main` is protected: no direct push, no force push, merge only with green CI on Windows and
  Linux. The orchestrator merges once CI is green and the review agent has no open findings, and
  sends the owner a short summary per PR.
- No force push, history rewrite or deletion of unmerged branches without an explicit request.
- Secrets only in the OS credential store or the environment's secret settings.
- Product name: Kalzit (calcite, the "sunstone" that makes hidden structure visible). It replaces
  the working title Granit; crate, binary (`kalzit`), `KALZIT_*` variables, repository and texts
  are renamed in their own pull request.
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
- Frontend uses the current stack as of October 2026 (React 19 with React Compiler, TypeScript 7,
  Vite 8, TanStack Router and Query, Biome, Vitest, Playwright) and modern CSS without a framework.
- Full role system on server and organization level, and complete server settings (HTTP/HTTPS,
  TLS, proxies, sessions, mail, appearance, operations); see `docs/PLAN.md` sections 6 and 8.
- Settings apply instantly with undo, except forms with dependent fields that need a connection
  test (SMTP, OIDC, LDAP): those use one explicit Save with a clear error per field.

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
