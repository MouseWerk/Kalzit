# Working on Kalzit

Kalzit is a self-hosted dashboard and observability platform (dashboards, data sources, roles,
teams, plugins) where document databases (MongoDB) and graph databases (Neo4j, Memgraph, TigerGraph)
are native data shapes, not converted to tables, next to all common SQL and metrics sources. Server
runs on Windows and Linux. Planned stack: Rust server (axum, sqlx), React + TypeScript UI embedded
in one binary. Read `docs/PLAN.md` first. Follow
https://github.com/mauricekleindienst/AICodeGuidelines (read its CLAUDE.md first); this file wins
where it is more specific.

## Owner decisions (standing)

- Commits are authored as `Maurice Kleindienst <kleindiema@gmail.com>` (see owner.md). No co-author
  or session trailers, no assistant or model names in commits, code, comments or docs.
- Work like a professional team: every change goes through a feature branch (`m<n>/<topic>`,
  `fix/<topic>`, `feat/<topic>`, `ux/<topic>`, `docs/<topic>`) and a pull request into `main`.
  Parallel work runs in sub-agents with their own worktrees; the orchestrator integrates, opens
  the PR and runs a review agent on it.
- PRs are squash-merged (PR title becomes the commit subject); the branch is deleted after merge.
  `main` is protected: no direct push, no force push, merge only with green CI on Windows and
  Linux. CI runs on the owner's machine (`tools/local-ci`, Windows and WSL; owner decision
  2026-11-23: GitHub's runners were too slow), not on GitHub; `main` requires the statuses
  `local/windows` and `local/linux`. The orchestrator merges once CI is green and the review agent has no open findings, and
  sends the owner a short summary per PR.
- No force push, history rewrite or deletion of unmerged branches without an explicit request.
- Secrets are encrypted in Kalzit's own database with a key from `KALZIT_SECRETS_KEY`, systemd
  credentials (Linux) or DPAPI (Windows); signing keys and CI secrets only in GitHub environments.
- Product name: Kalzit (calcite, the "sunstone" that makes hidden structure visible). It replaces
  the working title Granit; crate, binary (`kalzit`), `KALZIT_*` variables, `kalzit.toml`,
  repository and texts carry the new name.
- Positioning: a platform for visualizing and analyzing data in general, not only monitoring.
- UI wording: "Explore" stays untranslated in German; "Start" for Home, "Verwaltung" for
  Administration. The UI palette is retuned to Kalzit together with the website.
- Repositories live in the MouseWerk organization: `MouseWerk/Kalzit` (public, AGPL) and the website
  in its own private repository `MouseWerk/kalzit-website` (Astro; bento grid with live mini-demos,
  full creative freedom including the hero; no company logo strips, no invented figures, honesty
  captions on product visuals; root path, intended domain kalzit.dev; hosting decided later).
- Viewers run only the stored queries of dashboards they may read; free queries need
  `datasources:query` (editor and up). `dashboards:share` is org-internal; public links are a
  separate permission (M7).
- Data sources may target private networks and localhost; Kalzit's own data and database,
  metadata addresses and SQLite files outside admin-allowed directories are always refused.
- The secrets key comes from `KALZIT_SECRETS_KEY`, systemd credentials (Linux) or DPAPI (Windows);
  a 0600 key file in the data directory with a log warning is the last resort.
- Default data directory: `%ProgramData%\Kalzit\data` on Windows, `/var/lib/kalzit` on Linux; configured relative paths resolve against the config file.
- Kalzit's own database: SQLite (default) or PostgreSQL; a one-way copy tool from SQLite to PostgreSQL (`kalzit db copy`); still no MySQL/MariaDB backend.
- Server in Rust. License AGPL-3.0. Self-hosted only, no cloud offering. Public GitHub repository.
- Multiple organizations per installation. M6 is a pure fix-and-polish milestone (no new features);
  alerting comes in M7, after it.
- M8 is graph-first (2026-11-20): Kalzit does everything TigerGraph Insights does, and more, and
  becomes the best tool to analyze and visualize graph databases (docs/PLAN.md section 15, stages
  0.8.1-0.8.6: canvas first, then algorithms, pattern builder and TigerGraph parity, time and
  explorations, scale, graph alerts and AI). Algorithms run in the database's library where there
  is one (read-only, on the result's subgraph), otherwise in Kalzit, with equivalent results; large
  graphs stay on Sigma with server aggregation, streaming and level of detail; no write-back.
- Built-in AI comes in M4: providers behind one interface (OpenAI and OpenAI-compatible APIs,
  LiteLLM, local models such as Ollama), plain calls and agent-based flows with tools. AI is off
  by default; one server setting turns all AI on or off, and without a connected provider the UI
  shows no AI buttons or hints. AI queries only with the signed-in user's rights, read-only.
  Clients: one OpenAI-compatible (OpenAI, LiteLLM, Ollama, other local servers) and a native
  Anthropic one. Providers server-wide, an organization may override with its own provider and
  key; request and token limits per user and organization (orgs may only lower them); chats
  stored per user with admin-set retention (default 30 days, orgs may only shorten it); AI reads
  a data source (schema included) only after a per-source opt-in, otherwise explain and draft see
  only the typed query text; per-source excluded fields never reach a model (shared redaction
  helper); a first-use notice per person and provider is acknowledged before the first call;
  token counts, no currency; keys in the encrypted secret store; every call audited without its
  content. Plain calls first, the agent chat after (docs/PLAN.md, M4; board `AI.dc.html`).
- First graph sources: Neo4j, Memgraph and TigerGraph. All common standard sources are supported too
  (PostgreSQL, MySQL/MariaDB, SQL Server, SQLite, Prometheus, Elasticsearch, ...; see
  `docs/PLAN.md` section 3).
- UI in German with "du" and English; glossary in `docs/glossary.md` (to be created).
- Clean-room implementation: no Grafana code, name or logo in the product.
- Every query result keeps its native shape (`frame`, `documents`, `graph`, and `trace` from
  0.7.5); conversions are
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
- The UI follows the design blueprint in `docs/design/blueprint/` (owner-approved); read the board
  for a screen before changing it.
- No accent-colored borders, outlines, left bars, glows or gradient borders for selected, active or
  current states (graph node selection included); quiet neutral tint and text weight instead.
  Focus visible only on `:focus-visible`, neutral. No colored bars on the left anywhere.
- Authorization is checked on the server for every request and resource.
- Release notes: each PR adds a fragment `docs/releases/unreleased/<pr>-<topic>.md` with
  "## Improved", "## Fixed" and "## Checklist for Windows (manual)" as needed; the release PR
  assembles them into `docs/releases/v<version>.md` with those three sections; user-facing lines
  only.

## Checks

```
<to be defined in M0: cargo fmt --check, cargo clippy, cargo test, npm run lint, npm run typecheck,
npm test, production build + Playwright e2e on Linux and Windows>
```

Never kill processes by name or pattern; kill only PIDs you started. Prefer root-cause fixes; never
skip or weaken a test.

## Project state and working notes (as of 2026-11-14)

### Where things stand

- Released: 0.6.0 (M6, Windows unsigned by owner choice), 0.7.0 (alerting core), 0.7.1 (alerting
  security patch), 0.7.2 (alerting routing: policy tree, grouping, escalation, Slack and Teams).
  Releases are published on GitHub only; the owner installs them on his demo system himself
  (never update or start the demo, never read its credential file).
- M7 plan (owner decision 2026-11-14: as fast as possible, all areas in parallel, three
  releases): 0.7.3 security patch for 0.7.2 (both reviews: no critical or high findings);
  0.7.4 share links and snapshots, provisioning and Grafana import, reports by mail; 0.7.5 new
  sources, leftover settings, SDKs and app plugins. Data warehouses (BigQuery, Snowflake,
  Databricks) are tested against recorded responses plus an optional nightly run with
  credentials from a GitHub environment. Traces (Tempo, Jaeger) are a fourth native shape
  `trace` with a waterfall panel and explicit projections to frame and graph. Report PDFs come
  from Kalzit's own server-side renderer (no browser), close to the UI, not pixel-identical.
  Finish M7 before M8.
- Open: Dependabot PRs #276-#280 and #282 pass CI; #281, #215 and #211 fail and are held.
  Follow-up: the `__field__=amount` label shows on long-table alert rules.
- Owner to-dos: Windows checklists per release, catalog signing key for `MouseWerk/kalzit-plugins`,
  Dependabot/CodeQL alerts, Windows code-signing certificate (not blocking releases).

### Milestones

- M8 "Analysis depth": graph analysis first (0.8.1-0.8.6, PLAN section 15), then deeper Explore and
  variables, dashboard tabs, XY and map panels, forecast and outlier steps, MCP server, plus
  "Performance und Tempo" (measured speed-ups, CI benchmarks) and the Grafana settings parity gaps
  and feature follow-ups deferred from M6 reviews.
- M9: the community plugin store (registry repo `MouseWerk/kalzit-plugins`, website store pages
  hidden behind `STORE_ENABLED` until then). M10: Kalzit's own animated icon set (pulled forward,
  runs next to M8). M11: multi-model sources (ArangoDB mixed shapes, SurrealDB, PostgreSQL with
  Apache AGE) and a built-in file data store on top of the file source (upload of CSV, JSON,
  NDJSON, GraphML; offline; Kalzit's own data, queries read-only); no own database engine.
- Owner goal across milestones: beginners grow into power users (tips, contextual help, guides,
  plain-language errors, the query behind no-code steps), calm and dismissible.

### Alerting decisions (M7)

- Rule = stored query copy + explicit reduce + condition, on all three shapes. States ok, pending,
  firing, no data, error. Permissions: `alerts:read` (viewer+), `alerts:write` (editor+: rules,
  silences), `alerts:contacts` (org admin+: contact points, policies).
- Delivery: outbox in the same transaction as state changes, send after commit, leader-only
  worker, fair per-org claiming, breakers, caps (1000 waiting per org, 100 per contact point,
  hourly limit). Resolves go in their own message and skip caps, limits and expiry.
- Webhooks: v1 for direct rules, v2 for routed groups, always within the configured largest
  payload; they use the outbound proxy when one is configured.
- People without read or query rights on a rule's source see only states and counts: no labels,
  values or data-derived errors, `hidden-N` fingerprints, and for groups no id, policy, contact
  point or position among a policy's groups; the route check uses only the rule's own labels.
- Rules route either through the policy tree or directly to contact points; silence =
  acknowledge; group wait/interval/repeat 30 s / 5 min / 4 h; at most 3 escalation steps.

### Sharing decisions (M7, 0.7.4)

- Org-internal sharing stays `dashboards:share`: copy a link with time range and variables;
  it needs sign-in and normal read rights.
- Public (no account): public live links and public snapshots. Both need `dashboards:public`
  (org admin and owner by default, custom roles may grant it) and a server switch, off by
  default; an org may only turn it off, never on when the server has it off.
- Public live links run only the dashboard's stored panel queries, with the creator's current
  rights checked on every request; they stop when the creator loses read/query rights or
  `dashboards:public`, leaves the org, or a switch is off. Visitors change only the time range,
  within the link's maximum window; variables are locked to the shared values.
- Expiry required for every public link and snapshot: default 30 days, admin-set maximum
  (default 1 year); revocable any time; view counter without visitor data; creation and
  revocation audited.
- Snapshots: panel results frozen at creation, stored in Kalzit's own database in their native
  shape (`frame`, `documents`, `graph`), size cap per snapshot (10 MB proposed, admin-settable);
  internal (org members with read on the source dashboard) or public (`dashboards:public`).
- Board `Sharing.dc.html` approved 2026-11-14. Visitors see one neutral message for every
  unavailable case (expired, revoked, suspended, unknown): "Dieser Link ist nicht verfügbar.";
  the real status and reason only in Verwaltung > Freigaben and Meine Freigaben.
- Lost rights, switch off or creator gone suspends a link; it resumes when they come back, until
  expiry. Window = range within the last N days (default 7). Expiry changeable up to the maximum
  from today; revoke is final, by the creator or org admins. Internal snapshots need
  `dashboards:share`; data deleted 30 days after expiry. Public pages hide source names, query
  text and error texts. Names: Verwaltung > Teilen (server), Verwaltung > Freigaben (org),
  Konto > Meine Freigaben.
- D1 (2026-11-15): saving a dashboard with active public links needs `dashboards:public`, also
  for a library panel or saved analysis such a dashboard uses; otherwise a field-level refusal
  that names the links. Live links stay live.
- D2 (2026-11-15): public answers hold only what the panel shows, worked out on the server for
  every shape and for public snapshots too: the panel's steps run on the server, hidden queries
  and fields the panel does not display are left out.

### Provisioning and reports decisions (M7, 0.7.4)

- Boards `Provisioning.dc.html` and `Reports.dc.html` approved 2026-11-14.
- Provisioning: data sources, dashboards, roles and alert rules as YAML/JSON files in Git (one
  resource per file, `kalzit-provision.yaml` per set). Files reach the server only through
  `kalzit provision plan|apply|export` and the API with a service-account token; the server
  reads no folder at start. Secrets only as references (`fromEnv`, `fromFile`, `fromStore`);
  plain text is an error, export never writes secrets.
- A set belongs to one org and owns its folders; no resource in two sets. `apply` validates
  everything, then applies all or nothing in one transaction; removal only with `--prune`.
  A failed connection test after apply is a warning. CLI output follows the system language
  (de/en, else English); `--output json` has English fields; `plan --exit-code` 0/2/1.
- Managed resources are read-only in the UI ("aus Dateien verwaltet", set, file path, apply,
  commit). Org admins may unlock one in an emergency; that is drift and the next apply
  overwrites it. Sharing, annotations, reports, silences and role membership stay outside the
  files; contact points and policies are not in files in 0.7.4.
- `provisioning:read|write` (org admin by default) plus the write rights per kind; Verwaltung >
  Provisioning (org) lists applies, errors and drift; plan runs are not stored.
- Grafana import (UI and `kalzit provision import-grafana`): dashboards only; steps file, data
  source mapping, report (converted, approximated, skipped with reasons), result. Needs
  `dashboards:write` in the target folder. The report stays on the dashboard; skipped panels
  are not created. Queries and macros are kept as they are.
- Reports: dashboard or selected panels as PDF, CSV or both by mail; time range relative to the
  run, fixed variables, schedule with time zone. PDF from Kalzit's own server-side renderer,
  close to the UI, not pixel-identical (said in the UI). CSV only for `frame` panels; documents
  and graph panels need a visible projection step.
- A report runs with the creator's current rights, checked at every run; missing rights or the
  creator leaving suspend it (resumes when rights return); editors may take it over. Every
  internal recipient must have read rights on the dashboard: rejected in the editor with a field
  error, skipped at runs and noted in the run. External addresses behind an org switch (default
  off) with optional allowed domains; no links into Kalzit, one-click unsubscribe.
- On failure: one retry after 5 min, then a mail only to the creator (at most one per report and
  day); nothing goes to recipients. Paused or suspended runs are not made up. Runs kept 90 days,
  attachments not stored. `reports:read|write` (editor+). Server: on/off, 20 recipients per
  report, 10 MB per mail; orgs may only turn reports off. "Berichte" in the main navigation.

### Traces, settings and apps decisions (M7, 0.7.5)

- Boards `Traces.dc.html` and `Settings075.dc.html` approved 2026-11-14.
- `trace` is the fourth native shape (Tempo, Jaeger): spans with trace_id, span_id,
  parent_span_id, service, operation, kind, start, duration, status, attributes, events, links,
  plus resource and scope per span (OpenTelemetry). Conversions only as visible steps:
  Trace → Trace (filter spans, critical path), Trace → Tabelle (spans, traces), Trace → Graph
  (service map in the server, span tree).
- Explore search without a query language (service, operation, tags, duration, status, limit)
  shows the generated TraceQL; Jaeger has no TraceQL and needs a service. Waterfall bars are
  neutral, red only for error status, no colour per service. One trace panel (list, waterfall,
  automatic), a click sets a variable.
- Limits: 100 traces per search (Tempo), 20 (Jaeger), max 1,000; 10,000 spans per trace,
  truncated keeping the root and all error spans; service map up to 100,000 spans before asking.
  Export as OTLP JSON; snapshots keep `trace`; alerts on traces only via Trace → Tabelle plus
  reduce. Not in 0.7.5: span to logs or metrics, side-by-side compare, flamegraph.
- CORS is set in the UI (Verwaltung > CORS), instant with undo; no headers without entries; `*`
  only for subdomains and never with credentials; HTTP only for localhost.
- Self-registration off by default; needs local sign-in and a tested mail server; at least one
  allowed domain, one target org, default role at most editor, admin approval on by default,
  requests expire after 14 days. Limits without captcha: 5 per IP per hour, 3 per address per
  day, 50 per server per day; link valid 24 h; a declined address waits 30 days.
- Backups: database, `acme/`, `plugins/`, `kalzit.toml`, never the secrets key; archive encrypted
  with the secrets key (default on); leader only; retention as a count (default 14). On
  PostgreSQL only the files, the database via `pg_dump`. Restore only via CLI
  (`kalzit backup restore`). Target local folder or S3-compatible (no bucket creation), one
  explicit Save after a passed test.
- App plugins: pages in a sandboxed iframe plus a backend process. Read-only, always with the
  signed-in person's rights: read dashboards and saved queries, run saved queries, 50 MB own
  storage per org, network targets only for the backend; never secrets, sessions or write
  access. Org admins block an app or limit it to roles (default viewer+) in Verwaltung > Apps.

### How the work runs

- Orchestrator plus agents in their own worktrees; a read-only review agent checks every PR
  (`gh pr diff`, `git show`, never a checkout in the main folder). CI runs locally on the
  owner's machine (`tools/local-ci/run.sh <pr> [<pr>...]`, Windows and WSL, batches allowed);
  merge with `tools/local-ci/merge.sh <pr> [<pr>...]` once `local/windows` and `local/linux`
  passed for the merged tree and the review is clean; delete worktree and branch after merge.
  `tools/local-ci/gh-run.sh` runs the same test on GitHub's runners (owner decision 2026-11-23:
  such a pass counts; green work may merge overnight). GitHub Actions CI otherwise runs only by
  hand.
- Working rules (owner decision 2026-11-24; they follow the AICodeGuidelines
  `workflow/02-git.md`, `03-agents.md`, `05-ci.md`):
  - Done means proven. A PR goes to review only after its checks ran for its area, the e2e
    specs it adds or touches included; the PR body names the commands and the pass/fail counts.
  - "Flaky" is not a root cause. Rerun a failed job at most once, and only to show that the
    failure lies outside the change (it fails the same on main, or died before any test ran). A
    second failure is real. The status stays red and the test gets a root-cause fix. Never skip,
    quarantine, loosen or retry a test into green, and never push an empty commit to re-run CI.
    Splitting a failed batch into smaller batches to find the culprit is not a rerun.
  - Finish before starting: no new feature builders while reviewed PRs wait to merge. At most
    three builders at a time (review and research agents not counted), and none builds or runs
    tests while a local CI run holds `C:/Users/klein/kz-ci/run.lock` (a `gh-run.sh` run on
    GitHub does not hold it).
  - On a branch with an open PR: merge `origin/main` in; never rebase or force push pushed
    commits unless the owner asks.
  - Every PR gets a review agent before it merges, the orchestrator's own small fixes included.
    PR review findings stay in the review report and go back to the builder.
  - CI and merge logic run only from `run.sh`, `merge.sh` and `gh-run.sh` in `tools/local-ci`
    (`--runner-from-pr` after review is the one exception); no local copies with changed limits,
    and a running script is stopped before it is edited.
  - Findings of audits and comparisons live in findings files in the repository
    (`docs/quality/<topic>/<area>.md`), each with id, where, severity and proposed fix, and each
    marked fixed (with the commit) or not fixed (with the reason or the release it moves to).
- Owner decisions are asked as a selection menu with the recommended option first.
- Boards in `docs/design/blueprint/` are drawn and approved before UI work on a new screen.
- Release notes: each PR adds a fragment in `docs/releases/unreleased/`; the release PR assembles
  `docs/releases/v<version>.md`, bumps `server/Cargo.toml`, `Cargo.lock` and the README version.
  Release gate: release PR merged, one full local run on that commit
  (`tools/local-ci/run.sh --ref origin/main --full`), then the tag.
- After each milestone release: two independent security reviews, fixes as normal PRs.
- Keep the README screenshots in `docs/screenshots/` current after visible UI changes.
- The process with roles, flow and places is described in `docs/process.md`.
- Local load and storage (owner's machine): `CARGO_TARGET_DIR=C:/Users/klein/kz-target/<topic>`
  (E: and D: are blocked for build scripts, F: is a slow USB stick), `CARGO_BUILD_JOBS=2`,
  `cargo clean` and the folder deleted afterwards, `vitest --maxWorkers=2`, `npm ci` per worktree
  (no junctions to the main checkout's `node_modules`), targeted tests locally, full suites in the local CI
  (`tools/local-ci`).
  Port 3000 is reserved for the owner's demo.
- The website never announces releases and describes only the published release; main-only
  features wait on branch `after-0.6.0`-style branches until their release is out.
