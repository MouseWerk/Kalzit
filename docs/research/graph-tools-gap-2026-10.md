# Kalzit and dedicated graph analysis tools: gap analysis

Date: 2026-10-29. This compares Kalzit (`origin/main` at #144/#143, v0.3.2 line, M4 in progress) with
dedicated graph exploration, visualization and analysis tools. Kalzit facts come from `docs/PLAN.md`,
`docs/design/blueprint/Graph.dc.html` (approved board), `docs/design/depth.md`,
`docs/guide/panels.md`, `docs/guide/explore.md`, `docs/guide/export.md`, `ui/src/panels/graph/*`,
`ui/src/analysis/graphSteps.ts`, `server/src/datasources/cypher.rs`, `server/src/ai/tools.rs` and
`server/src/analysis/export.rs`. Tool facts come from the vendor documentation linked per row.
Vendor claims are reported as the vendor makes them; this report gives no figures of its own.

Status values: **done** (in `main`), **partial**, **planned Mx** (written in PLAN or on an approved
board, with the milestone where one is named), **missing** (in neither).
Effort: S = days, M = one to two weeks, L = several weeks or more, for one agent working in the
existing structure.

## What Kalzit has today (graph)

- Sources: Neo4j and Memgraph over Bolt (Cypher editor with schema completion), TigerGraph via
  GSQL (interpreted and installed queries with typed parameters). Read-only: read transactions,
  a Cypher tokenizer guard and a GSQL parser guard.
- Panels: Network (Sigma.js, WebGL, ForceAtlas2 in a worker), Hierarchy (own layered layout),
  Paths. Table view of nodes and edges as an equal fallback (no WebGL, screen readers).
- Styling options: caption property, color by label (palette color per label), by property (ramp
  or per text value, auto or fixed range), by community (Louvain in the browser up to 2,000 nodes)
  or component; size by degree or property; edge width by property; arrows and edge type labels;
  labels by zoom with "always label the N largest".
- Interaction: node details sheet (typed properties, neighbours by type and direction), multi
  select, "show only selection", pins and selection saved per viewer on the server, legend hides
  labels, layout switch forces/hierarchy per view, keyboard navigation and live-region
  announcements.
- Explorer: load neighbours with limit, edge type and direction per step, step line with undo,
  cancel, start over, "load N more", "open as a query in Explore" (Neo4j/Memgraph only, not
  TigerGraph).
- Large graphs: node limit per panel (default 5,000, max 20,000, keeps the best-connected nodes
  with a notice), automatic grouping by label from 2,000 nodes or 8,000 edges, open a group.
- Time: an edge timestamp property adds a time slider.
- Graph steps (in the database for Neo4j/Memgraph, else server): count per label, count per edge
  type, degree distribution, calculate degree, top N by degree, filter subgraph, shared
  neighbours, graph to table; shape change always shown ("Graph -> Table").
- Cross-shape: a click on a node, row or document sets dashboard variables used by SQL, Mongo and
  graph panels alike; multi-value variables from a multi selection.
- AI (M4, off by default): "Fragen" chat with read-only tools (`list_datasources`, `get_schema`,
  `run_query`, `find_panels`, `run_panel`, `propose_query`), explain and draft queries, per-source
  opt-in and field redaction.

Notable findings while checking the code:

- **Graph export is planned but not built.** PLAN section 2 promises GraphML/JSON and the board
  shows "Exportieren (GraphML, JSON, CSV)", but `docs/guide/export.md` says "graphs have no export
  format yet" and `server/src/analysis/export.rs` only notes GraphML as a later encoder.
- **Database-side algorithms are blocked by the guard.** PLAN and the board say community
  detection comes "from the source (GDS, MAGE)" above 2,000 nodes, but `READ_PROCEDURES` in
  `server/src/datasources/cypher.rs` only allows schema procedures (`db.labels`,
  `db.schema.visualization`, ...). `gds.*.stream` or MAGE `pagerank.get()` are refused today.
- **Shape per label** is on the approved board ("Form je Label", circle/square/diamond) but not in
  `GraphPanelOptions`.

## 1. Capability tables

### 1.1 Visual exploration

| Capability | Tools that have it (source) | Kalzit status | Value for Kalzit users | Effort |
|---|---|---|---|---|
| Expand neighbours from a node, step history, undo | Bloom/Explore [B1]; TigerGraph Insights graph widget (expand, undo/redo) [T2]; GraphStudio Explore Graph [T3]; Linkurious [L1] | **done** (Explorer with step line; not for TigerGraph) | High; core of graph exploration | - |
| Explorer for TigerGraph sources | TigerGraph Insights, GraphStudio [T2][T3] | **missing** (explicitly off; neighbour queries are Cypher) | Medium; TigerGraph users get no expand | M (GSQL neighbour query via interpreted mode, guarded) |
| Search-to-graph: type a label/property value, get nodes on the canvas | Bloom/Explore search bar, full-text search [B1][B2]; G.V() no-code explorer with property filters [G1]; Insights pattern search [T2] | **missing** (only via query or variable) | High for analysts who do not write Cypher | M |
| Saved parameterised searches ("search phrases", "query templates") as buttons/forms | Bloom search phrases [B2]; Linkurious query templates [L3] | **partial**: dashboards with variables and saved analyses cover the "form" part; no in-canvas phrase | Medium; dashboards already do most of this | S-M |
| Shortest path between two selected nodes from the canvas | Insights graph widget (one or all shortest paths) [T2]; GraphStudio [T3] | **partial**: Path panel shows paths the query returns; no "path between these two" action | High; frequent question, read-only friendly | S-M |
| Saved scenes / perspectives (a styled exploration you can reopen and share) | Bloom perspectives and scenes [B2][B5]; Linkurious visualizations in Spaces [L3] | **partial**: pins and selection per viewer; panel options are the "perspective"; an explorer state cannot be saved as a shared view (only "open as query in Explore") | Medium-high | M |
| Deep link to a scene/state | Bloom deep links [B5] | **missing** (variables in URL exist for dashboards, not explorer state) | Medium | S |
| Dismiss / hide selected nodes, invert selection | Bloom scene actions [B3] | **partial**: "show only selection", legend hides labels; no "hide these nodes" | Low-medium | S |

### 1.2 Styling rules

| Capability | Tools (source) | Kalzit status | Value | Effort |
|---|---|---|---|---|
| Color by label, size by metric, caption property | Bloom rule-based styling [B2]; Memgraph GSS [M1]; Cytoscape visual styles [C1]; Grafana node graph [GR1] | **done** | - | - |
| Rule-based styling by property condition (value ranges, "if amount > x then red") | Bloom rule-based styling [B2]; Insights conditional styling [T2]; GSS expressions [M1] | **partial**: color by property ramp or per text value; no conditional rules, no override matchers for graphs yet (depth.md P2 overrides by label/edge type/property are planned) | High; lets dashboards flag risky nodes | M |
| Shape per label | KeyLines/ReGraph [K1]; Cytoscape [C1]; GSS [M1] | **planned** (approved board), not built | Medium (accessibility: second cue besides color) | S |
| Icons / images per node | Bloom icons [B2]; Memgraph GSS images, Font Awesome [M2]; KeyLines [K1] | **missing** | Medium; vendor logos and type icons aid reading | S-M |
| Style as text (stylesheet language, shareable) | Memgraph GSS [M1]; Neo4j Browser style editor [NB1] | **missing** (styles are panel options in JSON; JSON model is shareable) | Low; panel JSON covers it | - |
| Edge style by type (dash, color) | GSS @EdgeStyle [M1]; KeyLines [K1] | **partial**: width by property, labels; no color/dash per edge type | Medium | S |
| Node badges / glyphs (counts, flags) and donut arcs | KeyLines glyphs/donuts [K1]; Grafana node graph arcs [GR1] | **missing** | Low-medium | M |

### 1.3 Layouts

| Capability | Tools (source) | Kalzit status | Value | Effort |
|---|---|---|---|---|
| Force-directed | all (Bloom [B4], Gephi [GE1], Graphistry [GS1], yFiles organic [Y1]) | **done** (ForceAtlas2) | - | - |
| Hierarchical / layered | Bloom [B4]; yFiles hierarchic [Y1]; Grafana layered [GR1] | **done** (own layered layout); ELK optional **planned M5** | - | - |
| Radial / concentric around a focus node | KeyLines/ReGraph radial [K2]; yFiles radial [Y1] | **missing** | Medium-high; "everything around this customer" is a dashboard staple | S-M |
| Sequential / tree, circular, orthogonal, grid | KeyLines sequential [K2]; yFiles tree, circular, orthogonal [Y1]; Grafana grid [GR1]; Cytoscape layouts [C2] | **missing** (except hierarchy) | Low-medium | S each (circular/grid), M (orthogonal) |
| Coordinate layout (x/y from properties) | Bloom coordinate layout [B4] | **missing** | Medium (also gives geo without a map) | S |
| Geographic (nodes on a map) | KeyLines Leaflet map mode [K3]; Linkurious geo mode [L1]; GraphXR [X1]; Insights map widget [T2] | **missing**; PLAN has Geo only for documents (GeoJSON), depth.md says geo panel "with #27 documents" | High for logistics, supply chain, fraud | M-L (needs tile source decision for self-hosted/offline) |
| Layout of selection only / incremental layout keeping positions | Cytoscape "selected only" [C2]; KeyLines adaptive [K2] | **done** for explorer (new nodes start near origin, rest stays) | - | - |
| 3D layouts | GraphXR [X1] | **missing** | Low for dashboards | L, not recommended |

### 1.4 Large graphs

| Capability | Tools (source) | Kalzit status | Value | Effort |
|---|---|---|---|---|
| WebGL rendering | Graphistry [GS1]; KeyLines WebGL [K3]; Bloom GPU rendering [B1] | **done** (Sigma.js) | - | - |
| Node limit with notice, best-connected first | Grafana node graph limit [GR1] | **done** | - | - |
| Grouping / combos (collapse by label or property, open in place) | KeyLines/ReGraph combos [K2][K3]; Linkurious grouping [L1] | **partial**: auto group by label with open group; no group by property, no nested combos, no manual grouping | Medium-high | M |
| Server-side GPU layout and analytics for millions of edges | Graphistry [GS1] | **missing** (budget target 20,000 nodes) | Low for Kalzit's audience; out of scope | L, not recommended |
| Sampling strategies (random, by community) | Graphistry [GS1] | **partial** (top by degree only) | Low-medium | S |

### 1.5 Algorithms

| Capability | Tools (source) | Kalzit status | Value | Effort |
|---|---|---|---|---|
| Degree, components | Gephi [GE1]; Cytoscape NetworkAnalyzer [C1] | **done** (browser and graph steps) | - | - |
| Community detection | Bloom via GDS [B6]; Gephi modularity [GE1]; MAGE Louvain/Leiden [M3]; Insights Louvain [T2] | **partial**: Louvain in the browser up to 2,000 nodes; "from the source (GDS, MAGE)" **planned** but blocked by `READ_PROCEDURES` | High | M |
| Centrality (PageRank, betweenness, closeness) | GDS [N1]; MAGE [M3]; Gephi [GE1]; Cytoscape [C1]; Insights PageRank [T2] | **missing** (degree only) | High; "who is central" is the most asked graph question | M (DB-side via GDS/MAGE stream procs) + S (browser for small graphs) |
| Similarity (node similarity, KNN) | GDS [N1] | **partial**: "shared neighbours" step | Medium | M |
| Path finding (weighted shortest, all shortest, k paths) | GDS [N1]; Insights [T2] | **partial**: Cypher `shortestPath` in user queries plus Path panel | Medium | S (step that writes the query) |
| Link prediction, node embeddings (FastRP, Node2Vec), ML pipelines | GDS [N1][N2]; MAGE [M3]; PyGraphistry UMAP [GS1] | **missing** | Low for dashboards; analysts use notebooks | L, not recommended now |
| Algorithm results styled automatically (size by score, color by community) | Bloom GDS drawer [B6] | **partial**: color by community/component works; no "size by algorithm score" because no scores exist | High once centrality exists | S |
| Writing results back into the database (write/mutate modes) | GDS write mode [N2]; Bloom [B6] | **missing by design** (read-only); stream mode fits Kalzit | Kalzit should stay with `stream` | - |

### 1.6 Time and space

| Capability | Tools (source) | Kalzit status | Value | Effort |
|---|---|---|---|---|
| Time slider over an edge timestamp | Bloom slicer [B7]; KeyLines time bar [K3]; Gephi timeline [GE1]; Linkurious timeline [L1] | **done** (one property, graph at time t) | - | - |
| Histogram under the timeline, ranges, playback | Bloom slicer (up to five ranges, playback modes) [B7]; KeyLines time bar histogram [K3]; Linkurious date filter histograms [L4] | **partial**: slider only; no histogram, no playback, no node time property | Medium-high | S-M |
| Dashboard time range drives the graph | Grafana node graph via query [GR1] | **done** (`$__from` in Cypher, GSQL params) | Kalzit is ahead here | - |
| Geospatial graph view | see 1.3 | **missing** | High | M-L |

### 1.7 Filters on properties

| Capability | Tools (source) | Kalzit status | Value | Effort |
|---|---|---|---|---|
| Filter panel with histograms per property (dim or hide) | Bloom filters [B7]; Insights filter menu [T2]; Graphistry histograms [GS1]; Linkurious [L4] | **partial**: "filter subgraph" step (label, edge type, one property condition); legend toggles labels; no interactive filter pane with histograms on the canvas | High; fastest way to read a graph without queries | M |
| Filter by degree/score | Gephi filters [GE1] | **partial** (degree via steps) | Medium | S |

### 1.8 Schema, data model, query building

| Capability | Tools (source) | Kalzit status | Value | Effort |
|---|---|---|---|---|
| Schema view as a diagram (labels, relationship types, properties) | Memgraph Lab graph schema [M4]; G.V() data model explorer [G1]; Hackolade [H1]; GraphStudio design schema [T3] | **partial**: schema lists feed completion; `db.schema.visualization` is allowed but no schema panel/diagram for graphs (documents have a Schema panel) | High; first thing users look at in a new graph | S-M (the data is there; draw it with the network panel) |
| Visual pattern / query builder without Cypher or GSQL | Insights no-code pattern search [T2]; GraphStudio VQB (deprecated since 3.9.3) [T1]; Bloom graph pattern search [B1] | **planned** ("optional visual pattern builder", PLAN section 3, no milestone) | High for viewers/analysts | M-L |
| Data modeling, forward engineering (DDL) | Hackolade [H1]; Memgraph data modeling [M4] | **missing by design** | Low; not Kalzit's job | - |
| Query autocomplete from schema | G.V() [G1]; Neo4j/Memgraph tools | **done** | - | - |

### 1.9 Collaboration, alerts, cases

| Capability | Tools (source) | Kalzit status | Value | Effort |
|---|---|---|---|---|
| Shared views in team spaces with rights | Linkurious Spaces [L3]; Bloom shared perspectives [B2]; Memgraph GSS/query sharing (Enterprise) [M5] | **done** for dashboards and saved analyses (team spaces, roles) | Kalzit is ahead (built in, self-hosted) | - |
| Annotations on nodes/edges | KeyLines annotations [K3]; Linkurious comments on cases [L2] | **planned** (PLAN "Anmerkungen an Datensätzen"; depth.md: from node property after #32) | Medium | M |
| Alerts on graph patterns | Linkurious alerts (pattern query run periodically) [L2] | **planned M7** (alerting; depth.md notes native graph conditions such as node degree) | High | part of M7 alerting |
| Case management (assign, status, triage, comments) | Linkurious case management [L2] | **missing** | Low-medium; product line Kalzit does not need to enter | L, not recommended |

### 1.10 Editing and import (Kalzit is read-only by default)

| Capability | Tools (source) | Kalzit status | Value | Effort |
|---|---|---|---|---|
| Create/edit nodes and relationships in the canvas | Bloom/Explore editing [B1]; G.V() [G1] | **missing by design** (read-only, write clauses refused) | Not for Kalzit; keep refused | - |
| CSV import / loading jobs | Memgraph Lab CSV import [M4]; GraphStudio load data [T3]; Gephi import [GE1] | **missing by design** | Not for Kalzit | - |

### 1.11 Export

| Capability | Tools (source) | Kalzit status | Value | Effort |
|---|---|---|---|---|
| Export graph as GraphML/JSON | Gephi GraphML/GEXF [GE1] | **planned** (PLAN section 2, board 5A) but **not built** (guide: "graphs have no export format yet") | High; promised and visible on the board | S-M |
| Export visible graph as CSV (nodes, edges, single file) | Bloom CSV export [B5]; Neo4j Browser CSV/JSON [NB1] | **partial**: via "graph to table" step then CSV | Medium | S |
| Image export (PNG/SVG) of the drawing | Bloom PNG/SVG [B5]; Neo4j Browser PNG/SVG [NB1]; Insights image [T2]; Gephi SVG/PNG/PDF [GE1] | **missing** | Medium-high for reports | S (PNG from canvas), M (SVG) |

### 1.12 Query diagnostics and operations

| Capability | Tools (source) | Kalzit status | Value | Effort |
|---|---|---|---|---|
| Query plan for EXPLAIN/PROFILE | Neo4j Browser plan view [NB1]; G.V() Gremlin debugger [G1] | **partial**: the guard accepts `EXPLAIN`/`PROFILE` prefixes; no plan view (result is empty or a table) | Medium for editors writing heavy Cypher | M |
| DB monitoring, logs | Memgraph Lab monitoring and logs [M4] | **partial** (Kalzit can chart Prometheus metrics of the DB; no Bolt-side stats) | Low | - |

### 1.13 AI

| Capability | Tools (source) | Kalzit status | Value | Effort |
|---|---|---|---|---|
| Natural language to Cypher | Aura Cypher copilot [N3]; Memgraph GraphChat [M6]; NeoDash text2cypher [N4] | **done** (M4 "Entwerfen", chat with `propose_query`, schema-aware, opt-in per source) | - | - |
| Chat that picks tools and shows intermediate queries | GraphChat 3.3 [M6] | **done** (Fragen with read-only tools and visible steps) | - | - |
| AI writes graph styling | Memgraph GSS generation [M7] | **missing** | Low | S |
| Graph RAG over the user's graph | Neo4j GraphRAG Text2CypherRetriever [N5] | **partial** (the chat does text2cypher over graph sources; no vector retrieval) | Low for a dashboard tool | - |

## 2. Missing from the plan, ranked by value

M6 is fix and polish only, so nothing new goes there. Two items are gaps against what is already
promised (export, DB-side algorithms) and fit M6 only if the owner counts them as "finishing
promised work"; otherwise they lead M7.

1. **Centrality and community from the database (stream mode), with "size/color by score".**
   Allow-list read-only `stream` procedures of GDS (`gds.pageRank.stream`, `gds.louvain.stream`,
   `gds.betweenness.stream`, ...) and MAGE (`pagerank.get`, `community_detection.get`,
   `betweenness_centrality.get`) per source, plus graph steps "PageRank", "Betweenness",
   "Communities" that add a property. Never `write`/`mutate`. Fixes the contradiction between PLAN
   and `READ_PROCEDURES`. Browser fallback for small graphs (graphology metrics). Suggest: **M7**
   (first graph item). Effort M.
2. **Graph export: GraphML, JSON, CSV, PNG.** Already promised (PLAN section 2, board 5A); the
   guide says it does not exist. Behind `data:export`, audited like other exports. Suggest:
   **M7** (or M6 if counted as finishing promised work). Effort S-M.
3. **Interactive filter pane with property histograms on graph panels** (dim or hide, per label
   and edge type, numeric ranges and value lists), stored per viewer like pins. Suggest: **M7**.
   Effort M.
4. **Geographic graph layout** (nodes by lat/lon or point property on a map, edges as lines) plus a
   simpler **coordinate layout** (x/y properties). Needs a self-hosted tile decision (configurable
   tile URL, offline fallback without tiles). Shares the map work with the planned document Geo.
   Suggest: **M7**. Effort M-L.
5. **Graph schema panel** (labels, relationship types, counts, properties as a small graph from
   `db.schema.visualization`/TigerGraph schema), also as Explore's first view on a graph source.
   Suggest: **M7**. Effort S-M.
6. **Search-to-graph and "path between two selected nodes"** on the network panel: a search box
   that finds nodes by caption/property (database-side, limited) and adds them; a canvas action
   that runs a bounded shortest-path query between two selected nodes. Same rights as the
   explorer (`datasources:query`). Suggest: **M7**. Effort M.
7. **Radial layout around a focus node** (and cheap extras: circular, grid). Suggest: **M7**.
   Effort S-M.
8. **Conditional styling rules and icons** (rules by property condition, edge color/dash per type,
   icon per label from a bundled icon set) on top of the planned overrides for graphs. Suggest:
   **M7**. Effort M.
9. **Timeline histogram and playback** for the existing time slider; node time property.
   Suggest: **M7**. Effort S-M.
10. **Saved explorations**: save an explorer state (steps, pins, filters) as a saved analysis
    shareable in the team, with a deep link. Suggest: **M7**. Effort M.
11. **Explorer for TigerGraph** via guarded interpreted GSQL. Suggest: **M7** with the other graph
    source work. Effort M.
12. **Query plan view for EXPLAIN/PROFILE** (Neo4j/Memgraph) in Explore's Inspect tab. Suggest:
    **M7**. Effort M.
13. **Visual pattern builder** (already in PLAN without milestone): give it one. Suggest: **new
    milestone or late M7**, after the schema panel which it builds on. Effort M-L.

Deliberately not recommended: editing data in the canvas, CSV import/ETL, write-back of algorithm
results, case management, embeddings/link prediction/ML pipelines, 3D, GPU server analytics. These
either contradict read-only by default or belong to specialist products.

## 3. Where Kalzit is ahead

- **Graphs next to SQL, metrics and documents in one dashboard.** Bloom, Memgraph Lab, GraphStudio,
  Linkurious, Gephi and Cytoscape are graph-only; TigerGraph Insights mixes widgets but only over
  TigerGraph and only interpreted GSQL [T2]. Grafana's node graph needs graphs flattened into node
  and edge frames [GR1]; Kalzit keeps the native `graph` shape end to end.
- **Variables across shapes.** A click on a node sets a variable that filters a Postgres table, a
  Mongo document list and a Prometheus chart; multi-selection gives multi-value variables.
- **Several graph databases in one tool, plus a dashboard time range.** Neo4j, Memgraph and
  TigerGraph side by side (ArangoDB and Gremlin planned in M7), with `$__from`/`$__to` reaching
  Cypher and GSQL as parameters. Vendor tools are tied to their own database (G.V() is the
  multi-database exception [G1], but has no dashboards).
- **Read-only enforced on the server** by a real tokenizer/parser for Cypher and GSQL, not by
  convention; viewers run only stored queries; rights per resource. Safer to hand to business
  users than tools whose main mode includes editing (Bloom/Explore, G.V()).
- **Visible graph-to-table steps pushed down to the database**, with the shape change labeled.
  Most tools either stay in the canvas or export to a notebook.
- **Self-hosted, AGPL, Windows and Linux, multi-organization, team spaces, SSO/LDAP (M5),
  audit log.** Several comparable features in vendor tools are Enterprise-only (Memgraph GSS and
  query sharing need Enterprise and Docker [M5]; Bloom scene sharing needs the full-access tier
  [B2]).
- **AI with read-only tools, per-source opt-in, field redaction, audit, local models.** GraphChat
  and the Aura copilot are comparable on NL to Cypher [M6][N3]; Kalzit adds redaction, provider
  choice incl. local servers and the same rights as the user.
- **Accessibility:** a table view as an equal representation, keyboard navigation and live-region
  announcements on the graph panels. None of the reviewed tool docs describe a comparable mode.

## 4. Recommended plan changes (max 8)

1. Add a **"Graph analysis" block to M7** (PLAN section "M7 Ausbau") listing items 1-10 of
   section 2, with the read-only rule written down: algorithms only in stream mode, never
   write/mutate, never data editing or import.
2. **Resolve the GDS/MAGE contradiction**: extend `READ_PROCEDURES` per source with an explicit
   allow-list of stream procedures (admin can turn the list off per source), add graph steps
   "PageRank", "Betweenness", "Communities (database)". Update PLAN section 2 "Graph-Kennzahlen"
   and the board note accordingly.
3. **Graph export** (GraphML, JSON, CSV, PNG) scheduled explicitly, not just mentioned: either the
   first M7 item or, if the owner allows, M6 as finishing promised work; fix `docs/guide/export.md`
   either way.
4. **Map work shared between shapes**: one map renderer and tile-source setting for document Geo
   (planned) and the geographic graph layout; record the self-hosted tile decision as an owner
   question.
5. **Schema panel for graph sources**, mirroring the document Schema panel; make it the start view
   when a graph source is opened in Explore.
6. **Filter pane with histograms** for graph panels, stored per viewer like pins; reuse the field
   distribution component from documents.
7. **Give the visual pattern builder a milestone** (after the schema panel), or drop it from
   PLAN section 3 if search-to-graph and the AI draft cover the need.
8. **Board update before building**: extend `Graph.dc.html` with filter pane, schema panel,
   radial/geo layouts, algorithm steps and export dialog, so the binding blueprint covers the new
   items (the board already covers shape per label, which is still to build).

## Sources

- [B1] Neo4j Aura Explore introduction: https://neo4j.com/docs/aura/explore/introduction/
- [B2] Bloom perspectives, styling, search phrases: https://www.neo4j.com/docs/bloom-user-guide/current/bloom-perspectives/perspective-creation/ ; https://neo4j.com/docs/aura/explore/explore-perspectives/perspectives/
- [B3] Bloom scene interactions: https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/bloom-scene-interactions/
- [B4] Explore scene layouts (force, hierarchical, coordinate): https://neo4j.com/docs/aura/explore/explore-visual-tour/scene-interactions/
- [B5] Scenes and sharing data (CSV, PNG/SVG, deep links): https://neo4j.com/docs/aura/explore/explore-features/scenes-export/ ; SVG release: https://neo4j.com/release-notes/bloom/bloom-2300/
- [B6] Bloom GDS integration: https://neo4j.com/docs/bloom-user-guide/current/bloom-tutorial/gds-integration/
- [B7] Slicer: https://neo4j.com/docs/aura/explore/explore-features/slicer/
- [NB1] Neo4j Browser result frames and export: https://neo4j.com/docs/browser/operations/result-frames/ ; https://neo4j.com/docs/browser-manual/current/operations/export-results/
- [N1] GDS algorithm catalog: https://neo4j.com/docs/graph-data-science/current/algorithms/
- [N2] GDS execution modes: https://neo4j.com/docs/graph-data-science/current/common-usage/running-algos/
- [N3] Aura Cypher copilot: https://neo4j.com/blog/developer/cypher-co-pilot/ ; https://feedback.neo4j.com/changelog/cypher-copilot-updates-smarter-queries-baseline-edits-and-in-editor-review
- [N4] NeoDash text2cypher (Labs): https://www.neo4j.com/labs/neodash/2.4/user-guide/extensions/natural-language-queries/
- [N5] Neo4j GraphRAG Text2CypherRetriever: https://neo4j.com/blog/developer/effortless-rag-text2cypherretriever/
- [M1] Memgraph GSS: https://memgraph.com/docs/memgraph-lab/features/graph-style-script/main-building-blocks
- [M2] Style graphs with images/icons: https://memgraph.com/docs/memgraph/tutorials/style-your-graphs-in-memgraph-lab
- [M3] MAGE algorithms: https://memgraph.com/blog/graph-algorithms-list
- [M4] Memgraph Lab features (schema, CSV import, data modeling, monitoring, logs, query modules): https://memgraph.com/docs/memgraph-lab/features
- [M5] Memgraph Lab sharing (Enterprise): https://memgraph.com/docs/memgraph-lab/features/sharing-features
- [M6] GraphChat: https://memgraph.com/docs/memgraph-lab/features/graphchat ; https://memgraph.com/blog/memgraph-lab-3-3
- [M7] AI generating GSS: https://memgraph.com/blog/llm-throws-syntax-error-tantrum-teaching-ai-graph-style-script
- [T1] GraphStudio visual query builder (deprecated): https://docs.tigergraph.com/ui/graphstudio/build-graph-patterns/visual-query-builder-overview
- [T2] TigerGraph Insights graph widget and widget list: https://www.tigergraph.com/docs/insights/4.2/widgets/graph-widget
- [T3] GraphStudio overview (schema, load, explore): https://docs.tigergraph.com/ui/graphstudio/overview
- [L1] Linkurious Enterprise vs Bloom (timeline, geo mode, grouping): https://linkurious.com/blog/linkurious-enterprise-neo4j-bloom/
- [L2] Linkurious alerts and cases: https://doc.linkurious.com/admin-manual/3.0/alerts ; https://linkurious.com/blog/linkurious-enterprise-3-0/
- [L3] Linkurious spaces and query templates: https://doc.linkurious.com/user-manual/4.2/page.html ; https://linkurious.com/blog/top-10-query-templates-to-accelerate-your-investigations/
- [L4] Linkurious date filters with histograms: https://linkurious.com/blog/time-filtering-linkurious/
- [GS1] Graphistry (WebGL, filters, timebars, histograms, UMAP): https://pypi.org/project/graphistry/0.34.14
- [K1] ReGraph features: https://cambridge-intelligence.com/regraph/features
- [K2] KeyLines layouts (radial, sequential, adaptive, combos): https://keylines.cambridge-intelligence.com/layoutbasics.htm
- [K3] KeyLines time bar, Leaflet map mode, WebGL: https://developers.cambridge-intelligence.com/docs/keylines/time-bar ; https://developers.cambridge-intelligence.com/docs/keylines/leaflet-integration
- [Y1] yFiles layouts: https://www.yworks.com/products/yfiles/layouts
- [GE1] Gephi features: https://gephi.org/features/
- [C1] Cytoscape: https://cytoscape.org/what_is_cytoscape.html
- [C2] Cytoscape layouts: https://manual.cytoscape.org/en/3.10.2/Quick_Tour_of_Cytoscape.html
- [X1] Kineviz GraphXR: https://neo4j.com/users/kineviz/
- [G1] G.V() (Neptune docs): https://docs.aws.amazon.com/neptune/latest/userguide/gv-tool.html
- [H1] Hackolade for Neo4j: https://hackolade.com/help/Neo4j.html
- [GR1] Grafana node graph: https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/node-graph/
