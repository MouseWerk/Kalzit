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
  Linux. The orchestrator merges once CI is green and the review agent has no open findings, and
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
  security patch). Releases are published on GitHub only; the owner installs them on his demo
  system himself (never update or start the demo, never read its credential file).
- 0.7.2 (alerting routing: policy tree, grouping, escalation, Slack and Teams; #292 server, #291
  UI) is merged; release prep #295 is merged on main at b2a53164. Release gate: 2 of 3 green CI
  runs on that commit are done. Next: one more green run on the same commit, tag `v0.7.2`, watch
  the release workflow, then two independent security reviews of the release.
- M7 order after that: 0.7.3 share links and snapshots, 0.7.4 provisioning and Grafana import,
  0.7.5 reports by mail, 0.7.6 new sources, 0.7.7 leftover settings, SDKs and app plugins. Finish
  M7 before M8.
- Open: Dependabot PRs #276-#280 and #282 pass CI; #281, #215 and #211 fail and are held.
  Follow-up: the `__field__=amount` label shows on long-table alert rules.
- Owner to-dos: Windows checklists per release, catalog signing key for `MouseWerk/kalzit-plugins`,
  Dependabot/CodeQL alerts, Windows code-signing certificate (not blocking releases).

### Milestones

- M8 "Analysis depth": graph algorithms as steps, graph layouts and styling, deeper Explore and
  variables, dashboard tabs, XY and map panels, forecast and outlier steps, MCP server, plus
  "Performance und Tempo" (measured speed-ups, CI benchmarks) and the Grafana settings parity gaps
  and feature follow-ups deferred from M6 reviews.
- M9: the community plugin store (registry repo `MouseWerk/kalzit-plugins`, website store pages
  hidden behind `STORE_ENABLED` until then). M10: Kalzit's own animated icon set.
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

### How the work runs

- Orchestrator plus agents in their own worktrees; a read-only review agent checks every PR
  (`gh pr diff`, `git show`, never a checkout in the main folder). Merge through the merge queue
  (GraphQL `enqueuePullRequest`) with green CI on Windows and Linux; delete worktree and branch
  after merge.
- Owner decisions are asked as a selection menu with the recommended option first.
- Boards in `docs/design/blueprint/` are drawn and approved before UI work on a new screen.
- Release notes: each PR adds a fragment in `docs/releases/unreleased/`; the release PR assembles
  `docs/releases/v<version>.md`, bumps `server/Cargo.toml`, `Cargo.lock` and the README version.
  0.7.x gate: release PR merged, 3 consecutive green CI runs on that commit, then the tag.
- After each milestone release: two independent security reviews, fixes as normal PRs.
- Keep the README screenshots in `docs/screenshots/` current after visible UI changes.
- Local load and storage: `CARGO_TARGET_DIR=F:/kz-target/<topic>`, `CARGO_BUILD_JOBS=2`,
  `cargo clean` afterwards, `vitest --maxWorkers=2`, `npm ci` per worktree (no junctions to the
  main checkout's `node_modules`), targeted tests locally, full suites in CI. Port 3000 is reserved
  for the owner's demo.
- The website never announces releases and describes only the published release; main-only
  features wait on branch `after-0.6.0`-style branches until their release is out.
