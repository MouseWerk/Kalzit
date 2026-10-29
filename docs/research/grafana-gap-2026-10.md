# Kalzit vs. Grafana: gap analysis (2026-10-29)

Grafana reference: Grafana 13.0 (14 Apr 2026), 13.1 (Jun 2026) and 13.2 (20 Aug 2026), plus Grafana
Enterprise and Grafana Cloud features where they are named as such. Sources are grafana.com docs,
release blogs and "What's new" posts, found and checked by web search on 2026-10-29. Where a source
gave conflicting availability (for example SQL expressions marked GA in one page and preview in
another), the table says so.

Kalzit reference: `origin/main` at c0068132 (#136, 2026-10-28), read without checking it out: PLAN.md
section 12 (M0 to M8), README roadmap, `docs/design/depth.md` (dated 2026-10-23), `docs/guide/`,
`server/src/routes/`, `ui/src/panels/`, `ui/src/features/`, `ui/src/analysis/steps.ts`. The local
`main` checkout in F:\GITHUB\Granit is behind (#91); nothing there was changed.

Legend. Status: **done** (on main), **partial**, **Mx** (named in that milestone), **depth Px** (only
in the depth.md roadmap, no milestone), **missing** (no plan anywhere). Importance is for Kalzit's
positioning (general data visualization and analysis, documents and graphs native, self-hosted
only): High / Med / Low / n/a. Effort: S one focused change, M one PR of real work, L several PRs or
a subsystem.

Clean-room note: everything below names capabilities in our own words; nothing is to be copied.

---

## 1. Tables per area

### 1.1 Data analysis and exploration

| Grafana feature | Source | Kalzit status | Importance | Effort |
|---|---|---|---|---|
| Explore: ad hoc queries, add result to dashboard | https://grafana.com/docs/grafana/next/visualizations/explore/query-editor/ | done (single query, `ExplorePage.tsx`, Add to dashboard) | High | - |
| Explore: several queries, mixed sources, split view with linked time | https://grafana.com/docs/grafana/next/visualizations/explore/query-editor/ | depth P2-8 (no milestone); today one query per Explore | High | M |
| Query history with search, filter, star | same as above | partial: private 30-day history, search, filter; stars and notes open (depth P2-8) | Med | S |
| Saved queries / shared query library with RBAC and variable mapping (Enterprise/Cloud, GA in 13.2) | https://grafana.com/blog/grafana-13-2-release-all-the-latest-features/ | done in Kalzit's form: saved analyses (query + steps + view, permissioned like dashboards; `routes/analyses.rs`, `docs/guide/saved-analyses.md`) | High | - |
| Drilldown apps: queryless exploration of metrics, logs, traces, profiles | https://grafana.com/docs/grafana-cloud/learn-and-build/telemetry-signals/query-visualize-data/drilldown/ , https://grafana.com/docs/grafana/v13.2/visualizations/simplified-exploration/ | missing as such. Kalzit has shape-native drill pieces (schema panel, field distribution, graph explorer mode, click-to-variable) but no queryless "pick a source, browse breakdowns" app | High (as a shape-native variant: SQL tables, collections, labels) | L |
| Transformations: about 40 in-browser steps (organize, filter rows/fields, sort, limit, convert, reshape, merge, extract JSON, regression, etc.) | https://grafana.com/docs/grafana/v13.1/visualizations/panels-visualizations/query-transform-data/transform-data.md , https://grafana.com/docs/grafana-cloud/whats-new/2024-01-15-moving-average-and-trend-lines-using-transformations | partial: calculate, reduce, group, pivot, join, moving average, trend, correlate, compare, toFrame, graph steps; run on browser and server alike. Filter, sort, limit, organize, convert, reshape, merge, extract are depth P2-9 only | High | L |
| SQL expressions: server-side SQL over the results of several queries (joins, CTEs, GROUP BY); feed alerts and recording rules. GA per What's new 15 Jul 2026 (some doc pages still say preview) | https://grafana.com/whats-new/2026-07-15-transform-your-data-with-sql-expressions--now-generally-available/ , https://grafana.com/docs/grafana/next/visualizations/panels-visualizations/query-transform-data/sql-expressions/ | missing; depth.md 3.4 decided "not now" in favour of the expression language | Med (analysts know SQL; but a second evaluator conflicts with "steps run identically in both engines") | L |
| Math/reduce/resample expressions across queries | https://grafana.com/docs/grafana/v13.1/visualizations/panels-visualizations/query-transform-data/expression-queries.md | partial: `calculate` and `join` across refIds; resample in depth P2-9 | Med | S |
| Correlations: admin-defined links from a field in one source to a query in another or a URL | https://grafana.com/docs/grafana/v13.2/administration/correlations/ | missing (depth 3.8 mentions "later", no milestone) | Med | M |
| Query and resource caching with TTL per source and per panel (Enterprise/Cloud) | https://grafana.com/docs/grafana/next/enterprise/query-caching/ | missing. depth.md 3.5 says "later milestone (M5)", but PLAN M5 does not list it; only a browser-side `resultCache.ts` exists | High for heavy SQL/graph sources | M |
| Recorded queries (deprecated in favour of recording rules) | https://grafana.com/docs/grafana/latest/administration/recorded-queries/ | missing; not needed (deprecated upstream) | Low | - |
| Grafana-managed recording rules (store a query result periodically) | https://grafana.com/docs/grafana/latest/administration/recorded-queries/ (points to them) | missing; would come with M7 alerting's scheduler | Med | M |
| Statistics: correlation, comparison with previous period | (Grafana has no step for these; regression transformation exists, see above) | done, Kalzit ahead (`correlate`, `compare`) | High | - |
| ML forecasting and outlier detection (Cloud ML app) | https://grafana.com/docs/grafana-cloud/ai-tools/machine-learning/ | missing (Kalzit has trend and moving average only) | Med | M (forecast step) to L |
| Sift automated investigations (Cloud only) | https://grafana.com/docs/grafana-cloud/machine-learning/sift/sift/ | n/a (Cloud, Kubernetes telemetry focus); Kalzit's chat covers ad hoc investigation | Low | - |

### 1.2 Visualizations

| Grafana feature | Source | Kalzit status | Importance | Effort |
|---|---|---|---|---|
| Core panels: time series, stat, gauge (revamped in 13.0), bar gauge, bar chart, table, pie, histogram, heatmap, state timeline, status history, text | https://grafana.com/docs/grafana/v13.0/panels-visualizations/visualizations/ , https://grafana.com/blog/grafana-13-release-all-the-latest-features/ | done (all present in `ui/src/panels/`); option depth thinner, see depth.md P1-3, P2-2 to P2-4 | High | M per area |
| Node graph | https://grafana.com/docs/grafana/v13.0/panels-visualizations/visualizations/ | done and ahead: network, hierarchy, path panels on native graphs | High | - |
| Geomap | same | missing (PLAN 2 mentions GeoJSON on a map; depth P3-8 only) | High for business data | M |
| XY chart | same | missing (depth P3-5 only) | High (correlation is a Kalzit strength) | M |
| Trend (non-time numeric x axis), candlestick | same | missing | Low to Med | S each after XY |
| Logs panel | same | missing; depth P3-7 tied to M5 Loki | Med | M |
| Traces panel, flame graph | same | traces: M7 (span tree as graph); flame graph: missing | Low (observability-specific) | M each |
| Canvas (free layout with live values) | same | missing | Med (process and floor-plan views in business use) | L |
| Graphviz / DOT diagram panel (private preview, 13.0) | https://grafana.com/whats-new/2026-04-14-new-panel--graphviz/ | partial equivalent: hierarchy panel draws real graphs; no DOT input | Low | M |
| Dashboard list, annotation list, alert list panels | https://grafana.com/docs/grafana/v13.0/panels-visualizations/visualizations/ | missing (dashboard list in depth P3-6) | Low | S each |
| Visualization suggestions from data (GA in 13.0) | https://grafana.com/blog/grafana-13-release-all-the-latest-features/ | partial: shapes-first picker and `suggestPanel` | Med | S |
| Panel styles (presets, public preview 13.0) | same | missing (depth 3.3 "Looks") | Low | S |
| View panel sidebar: viewers change legend, stacking, split series without edit rights (public preview 13.2) | https://grafana.com/blog/grafana-13-2-release-all-the-latest-features/ | missing | Med | M |

### 1.3 Dashboards

| Grafana feature | Source | Kalzit status | Importance | Effort |
|---|---|---|---|---|
| Dynamic dashboards: tabs (nested up to 3 levels), auto grid, show/hide rules, outline; schema v2; GA 13.0 | https://grafana.com/whats-new/2026-04-08-dynamic-dashboards-is-now-generally-available/ , https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/create-dynamic-dashboard | partial: rows, repeats, outline in the canvas rail; tabs, auto grid and show/hide rules are depth P3-1 only | High | M |
| Section-level variables for rows and tabs (13.1) | https://grafana.com/blog/grafana-13-1-release-all-the-latest-features/ | missing | Low | S |
| Variables: query, custom, textbox, constant, interval, data source, ad hoc filters, group by, switch; multi-value, include all, chaining | https://grafana.com/blog/grafana-13-1-release-all-the-latest-features/ (variable types GA) | partial: custom, textbox, query in UI, constant and interval in the model, multi-value; cross-shape variables are ahead. Ad hoc filters, group by, data source, chaining are depth P2-5/P2-6 only | High | L |
| Annotations, dashboard and panel links, library panels, playlists, kiosk/TV | https://grafana.com/docs/grafana/v13.2/visualizations/dashboards/create-manage-playlists/ , https://grafana.com/docs/grafana/v13.2/visualizations/dashboards/use-dashboards.md | done (`routes/annotations.rs`, `library_panels.rs`, `playlists.rs`, guide "Kiosk, TV mode") | Med | - |
| Versions with diff and restore | https://grafana.com/docs/grafana/v13.2/visualizations/dashboards/build-dashboards/ | done (plus trash with undo) | Med | - |
| JSON export and import with data source mapping | same | done | Med | - |
| Import of Grafana dashboard JSON | (format of the above) | M7 ("soweit sinnvoll") | High for adoption | M |
| Suggested dashboards for a source (public preview 13.0) | https://grafana.com/blog/grafana-13-release-all-the-latest-features/ | missing (the AI chat can draft panels; sample data at setup) | Med | M |
| Refreshed home page with recent, starred, firing alerts (13.2) | https://grafana.com/blog/grafana-13-2-release-all-the-latest-features/ | done (start page with recent and starred; alerts after M7) | Low | - |

### 1.4 Sharing, reporting, embedding

| Grafana feature | Source | Kalzit status | Importance | Effort |
|---|---|---|---|---|
| Share link with time and variables, short links | https://grafana.com/docs/grafana/v13.1/visualizations/dashboards/share-dashboards-panels.md | missing (depth P3-2 only); org-internal grants exist | High | S |
| Snapshots (data frozen, queries stripped) | https://grafana.com/docs/grafana/v13.0/developer-resources/api-reference/http-api/api-legacy/snapshot/ | missing (depth P3-4 only) | Med | M |
| Externally shared (public) dashboards; anonymous access (OSS/Enterprise) | https://grafana.com/docs/grafana/v13.1/visualizations/dashboards/share-dashboards-panels.md | M7 (public links, separate permission) | Med | M |
| Image export PNG of panel/dashboard | https://grafana.com/docs/grafana/v13.2/setup-grafana/image-rendering.md | missing (depth P3-3, browser rendering decided) | Med | M |
| PDF export and scheduled reports by mail (PDF, CSV, image; Enterprise). Since 13.0 rendering runs only in the separate renderer service | https://grafana.com/docs/grafana/next/visualizations/dashboards/create-reports.md , https://grafana.com/whats-new/2026-04-14-grafana-image-renderer-plugin-support-removed/ | missing; depth.md only says "a server renderer follows in M7 with reports", PLAN M7 does not list reports | High for business users | L |
| Data export CSV/Excel | https://grafana.com/docs/grafana/v13.1/visualizations/dashboards/share-dashboards-panels.md | done and ahead: CSV (locale-aware, BOM), Excel, JSON, NDJSON, GraphML; export equals panel; `data:export` right | High | - |
| Embedding (iframe of panels/dashboards) | https://grafana.com/docs/grafana/v13.1/visualizations/dashboards/share-dashboards-panels.md | missing (depth P3-2: org-internal embed, `frame-ancestors` opt-in) | Med | S |
| Publish to community dashboard catalog | same | n/a (could come with M8 store) | Low | - |

### 1.5 Alerting and incident response

| Grafana feature | Source | Kalzit status | Importance | Effort |
|---|---|---|---|---|
| Alert rules, contact points, notification policies, silences, mute timings | https://grafana.com/docs/grafana/v13.2/alerting/fundamentals/notifications/ | M7 | High | L |
| Alert rules from SQL expressions | https://grafana.com/docs/grafana/next/visualizations/panels-visualizations/query-transform-data/sql-expressions/ | M7 (rules on steps, per depth 3.10) | Med | - |
| Dynamic/ML alerting (Cloud) | https://grafana.com/docs/grafana-cloud/ai-tools/dynamic-alerting/ | missing | Low | M |
| IRM: on-call schedules, escalation, incidents, mobile app (Cloud; OnCall OSS archived, OSS push ended 24 Mar 2026) | https://grafana.com/docs/grafana-cloud/platform/mobile-app/irm/ | n/a by positioning; integrate by webhook later | Low | - |

### 1.6 Administration, security, as code

| Grafana feature | Source | Kalzit status | Importance | Effort |
|---|---|---|---|---|
| Orgs, teams, folders, basic roles | https://grafana.com/docs/grafana/v13.2/administration/roles-and-permissions/access-control.md | done | High | - |
| Fixed and custom RBAC roles (Enterprise/Cloud) | same | done and ahead in OSS terms: custom roles, scopes, "why can I" explanation, per-source query/edit rights | High | - |
| OIDC/OAuth, LDAP | https://grafana.com/docs/grafana/v13.2/administration/roles-and-permissions/access-control/plan-rbac-rollout-strategy/ | M5 | High | L |
| SAML | same | partial plan: PLAN 6 says "SAML später", no milestone | Med | M |
| Team sync / role sync from IdP groups | same | M5 (PLAN 6: roles and teams from groups) | High | M |
| SCIM provisioning (Enterprise/Cloud, SAML only) | https://grafana.com/docs/grafana/latest/setup-grafana/configure-security/configure-scim-provisioning/ | missing | Med (larger orgs) | M |
| Service accounts and tokens | https://grafana.com/docs/grafana/v13.2/administration/roles-and-permissions/access-control.md | M5 | High | M |
| Audit log | (Enterprise auditing) | done | High | - |
| Usage insights: views, query errors per dashboard and source (Enterprise) | https://grafana.com/docs/grafana/latest/enterprise/usage-insights | missing (depth P3-9 "server stats", no milestone) | Med | M |
| Grafana Advisor: weekly health checks of data sources, plugins, config (GA 13.0) | https://grafana.com/whats-new/2026-04-14-grafana-advisor-is-now-generally-available-health-checks-for-your-grafana-instance-to-keep-things-running-smoothly/ | partial: `/healthz`, `/readyz`, data source test, update check; no scheduled check report | Med | M |
| Provisioning from files | https://grafana.com/docs/grafana/next/as-code/observability-as-code/ | M7 ("Provisioning als Code") | High | M |
| Git Sync: dashboards and folders synced with GitHub, GitLab, Bitbucket, plain Git, PR workflow (GA 13.0) | https://grafana.com/blog/grafana-13-release-all-the-latest-features/ , https://grafana.com/blog/grafana-13-1-release-all-the-latest-features/ | missing; M7 provisioning does not say Git | High (GitOps is expected for self-hosted) | L |
| CLI (grafanactl / gcx), Foundation SDK, Terraform provider, operator | https://grafana.com/docs/grafana/next/as-code/observability-as-code/ | missing; Kalzit has an HTTP API documented in `docs/api/` | Med | M (CLI) / L (Terraform) |
| Data source breadth: 300+ plugins in catalog | https://grafana.com/blog/grafana-marketplace-pilot | partial: about 14 built-in kinds plus plugin data sources (M4); InfluxDB, Loki, ClickHouse M5; Graphite, Redis, Oracle, Tempo/Jaeger, ArangoDB, Gremlin, Couchbase M7. Not planned: BigQuery, Snowflake, Databricks, CloudWatch, Azure Monitor, Google Sheets, Splunk, DB2 | High (general analysis needs the warehouse sources) | M each |
| Plugin catalog, signed plugins, app plugins, Scenes framework | https://grafana.com/blog/grafana-marketplace | M4 (sandboxed, signed, catalog off by default), M8 store; no app-plugin page framework planned beyond "App" type in PLAN 7 | Med | - |
| Commercial Marketplace (GA 20 Oct 2026, Cloud trials) | https://grafana.com/press/2026/10/20/marketplace-ga/ | n/a (AGPL, community store M8) | Low | - |
| UI languages: about ten languages, browser detection | https://grafana.com/developers/plugin-tools/key-concepts/plugin-i18n-concept | partial: German and English with full parity check, by design | Low | - |

### 1.7 AI

| Grafana feature | Source | Kalzit status | Importance | Effort |
|---|---|---|---|---|
| Grafana Assistant: agent chat that queries sources, builds dashboards, investigates; for OSS/Enterprise only with a connected Grafana Cloud stack (13.1+), prompts go to Cloud | https://grafana.com/docs/grafana-cloud/machine-learning/assistant/on-premise/ , https://grafana.com/blog/grafana-13-1-release-all-the-latest-features/ | done (M4 "Fragen"): own provider (OpenAI-compatible incl. Ollama/LiteLLM, or Anthropic), read-only tools with the user's rights, per-source opt-in, redacted fields, run panels, open in Explore | High | - |
| Assistant creates and edits dashboards | https://grafana.com/docs/grafana-cloud/platform/grafana-assistant/ | partial: drafts queries, "Save as panel", "Add to dashboard" via dialog; no multi-panel dashboard generation | Med | M |
| LLM app plugin with own key (OpenAI, Azure, Anthropic, Ollama, vLLM) for small generative features | https://grafana.com/docs/grafana-cloud/ai-tools/llm-plugin/llm-setup/ | done (explain, draft, summarize) | Med | - |
| MCP server exposing Grafana to external agents (read-only mode available) | https://grafana.com/docs/grafana/v13.2/developer-resources/mcp/configure/ | missing | Med (users run their own agents) | M |

### 1.8 Observability products outside the dashboard core

| Grafana feature | Source | Kalzit status | Importance | Effort |
|---|---|---|---|---|
| Adaptive Metrics/Logs/Traces/Profiles (Cloud cost control at ingestion) | https://grafana.com/docs/grafana-cloud/adaptive-telemetry | n/a: Cloud ingestion and billing; Kalzit stores no telemetry | n/a | - |
| Faro frontend observability, k6 load testing (Cloud products, OSS SDKs) | https://grafana.com/blog/2022/11/02/introducing-grafana-faro-oss-application-observability , https://grafana.com/de/products/cloud/performance-load-testing-k6/ | n/a: separate products; Kalzit could only read their data stores | n/a | - |
| Profiles (Pyroscope) source and flame graph | https://grafana.com/docs/grafana/v13.2/visualizations/simplified-exploration/ | missing | Low | M |
| Mobile app | https://grafana.com/docs/grafana-cloud/platform/mobile-app/irm/ | n/a: Grafana's app is for IRM; Kalzit plans responsive dashboards on phones (PLAN 10) | Low | - |

---

## 2. Missing from the plan

Features Grafana has that no Kalzit milestone (M0 to M8) names. Items that exist only in
`docs/design/depth.md` P1 to P3 count as missing from the plan, because depth.md has no milestone
mapping and M6 cannot take them. Ranked by value for Kalzit's positioning.

| # | Feature | Why it matters for Kalzit | Suggested milestone |
|---|---|---|---|
| 1 | Analysis step catalog round 2: filter rows, pick fields, sort, limit, organize, convert, reshape, merge, extract, resample, per-step preview (depth P2-9) | Basic analyst work; today a user cannot filter or sort a result without editing the query | M5 (late) or M7, first block |
| 2 | Explore depth: several queries, mixed sources, split view, stars (depth P2-8) | Explore is half of "analysis"; Grafana's core analyst surface | M7 |
| 3 | Variables depth: ad hoc filters, group by, data source variable, chaining, include all (depth P2-5/P2-6) | Interactive analysis dashboards rely on them; ad hoc filters on documents and graphs would be unique | M7 |
| 4 | Server query cache with TTL per source and panel | Expensive SQL, aggregation pipelines and graph traversals; depth.md already says M5 but PLAN M5 does not | M5 (fix the inconsistency) |
| 5 | Scheduled reports (PDF and CSV by mail) and PNG/PDF export | Business data users expect weekly reports; Grafana keeps this Enterprise-only, so an AGPL Kalzit with it is a differentiator. Needs SMTP (M5) and a renderer | M7, next to alerting (same scheduler) |
| 6 | Share links, short links, snapshots, org-internal embedding (depth P3-2 to P3-4) | Everyday collaboration; small to medium effort | M7 (with public links) |
| 7 | Dashboard tabs, auto grid, show/hide rules (depth P3-1) | Grafana made this GA and default in 13.0; long dashboards get unwieldy without tabs | M7 |
| 8 | Git-based provisioning (sync folders and dashboards with a Git repository, PR review) and a CLI | Self-hosted teams expect GitOps; M7 "Provisioning als Code" should say file and Git | M7 (spell out in PLAN) |
| 9 | Warehouse and cloud sources: BigQuery, Snowflake, Databricks, Google Sheets, CloudWatch, Azure Monitor | "All common sources" for general analysis; many could ship as M4-style plugins rather than built-ins | M7 (built-in: BigQuery, Snowflake); others as plugins via M8 |
| 10 | XY chart and geo map panels (depth P3-5, P3-8; PLAN 2 already promises GeoJSON maps) | Correlation and location are core analysis views; PLAN promises geo without a milestone | M7 |
| 11 | Queryless drill-down app per shape: pick a table, collection or label set, browse breakdowns by field, drill to records | Kalzit's version of the Drilldown apps, built on schema sampling and field distribution that already exist | M7 or later |
| 12 | Correlations registry (field in source A opens a query in source B) | Joins worlds (SQL row to graph neighbourhood); data links cover part | M7 |
| 13 | SAML and SCIM | Larger organizations; SAML is "später" in PLAN without a milestone | SAML M5 (or M7), SCIM M7 |
| 14 | Usage insights and a health advisor (views, query errors, slow queries, failing sources, outdated plugins) | Operators of self-hosted installs; no telemetry, local only | M7 (or M5 for the advisor part) |
| 15 | Forecast and anomaly steps (seasonal forecast, outlier flag) as visible analysis steps | Grafana keeps ML in Cloud; a local, explainable step fits Kalzit | M7 or later |
| 16 | MCP server (read-only, user-scoped tokens) | Lets users' own agents use Kalzit; reuses the AI tool layer and M5 service accounts | M7 |
| 17 | Recording rules (store a query result on a schedule) | Comes almost free with the alerting scheduler | M7 |
| 18 | View panel sidebar for viewers (legend, stacking without edit rights) | Viewer-side analysis | M7 |
| 19 | Logs panel independent of Loki (Elasticsearch/OpenSearch hits, SQL log tables) | Kalzit already reads ES; a log view is generic | M5 with Loki (make it source-neutral) |
| 20 | Canvas, candlestick, trend, flame graph, dashboard/annotation list panels | Long tail | Plugins (M8) or after M7 |

Not applicable (self-hosted only, no cloud offering): Adaptive Telemetry (ingestion-side cost
control and billing in Grafana Cloud), Sift (Cloud, Kubernetes telemetry), IRM/on-call with mobile
push (Cloud product; OnCall OSS archived), Faro and k6 (separate telemetry products), the commercial
Marketplace (Kalzit's M8 store is community and AGPL), and the Assistant's Cloud backend (Kalzit's
AI is already fully self-hosted with any provider). None of these should enter the plan.

M6 rule respected: nothing above is placed in M6. M6 can still take the polish half of existing
features (option depth of existing panels, editor lag, overlapping labels), as decided.

---

## 3. Where Kalzit is ahead (honest)

- **Native result shapes.** Documents stay trees with types per value, graphs stay nodes, edges and
  paths; projection is a visible `toFrame` step. Grafana turns everything into data frames; its node
  graph needs two tables. This is real and unique among dashboard tools.
- **Graph panels and graph analysis.** Network, hierarchy and path panels, explorer mode with undo,
  graph steps pushed down as Cypher, TigerGraph with a parsed read-only GSQL guard. Grafana has a
  node graph panel and, since 13.0, a private-preview Graphviz panel; no graph analysis.
- **Document views.** Schema panel with type distribution and coverage, field distribution over the
  whole result in the database, pipeline editor with per-stage preview. Grafana's MongoDB source is
  an Enterprise plugin and returns frames.
- **Read-only by construction.** Server-side rejection of writes per engine with guard tests.
  Grafana relies on the data source user's rights.
- **Steps that match exports.** Steps run identically in browser and server (conformance suite), so
  CSV equals the panel; Grafana transformations run in the browser. Correlation and
  previous-period comparison exist as steps.
- **AI fully self-hosted.** Any OpenAI-compatible provider (including local Ollama) or Anthropic,
  off by default, per-source opt-in, excluded fields redacted on the server, read-only tools with the
  user's rights, per-user and per-org limits, audit without content. Grafana Assistant on
  self-managed Grafana needs a Grafana Cloud stack and sends prompts there.
- **Plugins sandboxed and signed.** Out-of-process plugins in an OS sandbox (AppContainer / Job
  Object on Windows, namespaces and seccomp on Linux), network only through Kalzit's connector,
  panel plugins in a sandboxed iframe. Grafana backend plugins run as separate processes without an OS sandbox (its plugin sandbox covers frontend code only).
- **Permissions in OSS.** Custom roles, scopes and a "why can I" explanation without an Enterprise
  licence; Grafana's fixed and custom roles are Enterprise/Cloud only.
- **Saved analyses and query history in the free product.** Grafana's shared query library is
  Enterprise/Cloud only.
- **Windows first-class.** CI and e2e on Windows, DPAPI secrets, SQL Server and Active Directory as
  first-class targets, MSI planned in M5.
- **Accessibility and design discipline.** Contrast theme, keyboard operation of graphs and document
  trees, i18n parity tests; Grafana's translations are partly labelled preview.

Where Kalzit is honestly behind (not "ahead"): option depth per panel, variables, Explore, sharing
and reporting, alerting, identity providers, data source breadth (about 14 kinds vs. a 300+ plugin
catalog), dashboard layout (tabs, auto grid), and anything as code.

---

## 4. Recommended plan changes (max 10)

1. **Map depth.md P1 to P3 onto milestones.** Today they float; M6 cannot take features. Put P2-8,
   P2-5/6, P2-9, P3-1 to P3-6 into M7 explicitly (or split M7 into "M7 Analysis depth" and
   "M7b Alerting and sharing").
2. **Add a server query cache to M5** (depth.md already promises M5; PLAN M5 does not list it), keyed
   per org and permission boundary, TTL per source and panel.
3. **Add reports to M7** next to alerting: scheduled PDF/CSV mail and image export, sharing the
   scheduler and the renderer decision from depth.md decision 3.
4. **Spell out "provisioning as code" in M7** as files plus Git sync (folders and dashboards, PR
   review) and a small `kalzit` CLI for push/pull/validate.
5. **Put SAML into M5 or M7** (PLAN 6 says "später" with no milestone); add SCIM to M7.
6. **Add warehouse sources** (BigQuery, Snowflake, Databricks) to M7 or as first-party plugins, so
   "all common sources" holds for business analysis, not only operations.
7. **Add XY chart and geo map to M7**; PLAN section 2 already promises a GeoJSON map without a
   milestone.
8. **Add a shape-native drill-down app** (queryless browse of tables, collections and graph labels)
   to M7 or later: Kalzit's answer to the Drilldown apps, built on schema sampling.
9. **Add usage insights and an advisor page** (local only, no telemetry) to M7; add an MCP server
   (read-only, service-account scoped) to M7 after M5 service accounts.
10. **Decide SQL expressions explicitly.** Either keep the depth.md "not now" and close the gap with
    step catalog round 2, or plan SQL over results as a server step in both engines. Record the
    decision in PLAN 13.

---

## 5. Suggested updates to docs/design/depth.md (not applied; repo left unchanged)

- Header date and reference: 2026-10-29, Grafana 13.2 (Aug 2026) instead of 13.3 from the demo.
- Mark as done since 2026-10-23: rows, repeats, annotations, links, playlists, library panels,
  kiosk, JSON model (#32); document panels and pipeline editor (#27); saved analyses; dashboard
  toolbar and time picker (P1-2) except drag-to-zoom; outline in the canvas rail.
- 3.5 "Query cache": change "Later milestone (M5)" to match PLAN after decision on item 2 above.
- 3.4 "SQL over query results": note Grafana made SQL expressions GA (Jul 2026) and that they also
  drive alert and recording rules.
- 3.7 Dashboards: add Grafana's dynamic dashboards GA (tabs nested to three levels, auto grid,
  show/hide rules, schema v2) and section-level variables (13.1).
- 3.9 Administration: add Git Sync GA, Grafana Advisor GA, SCIM, usage insights, MCP server.
- New 3.11 AI: Grafana Assistant needs a Grafana Cloud stack for self-managed Grafana (13.1+);
  Kalzit's self-hosted AI is ahead here.
- Section 5 roadmap: add a milestone column to each P item.
