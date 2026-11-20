# Graph analysis tools and Kalzit: inventory for M8

Date: 2026-11-20. This updates `graph-tools-gap-2026-10.md` for the M8 plan (`PLAN.md`, section 15).
Kalzit facts come from `main` at 986f8baf. Tool facts come from the vendor documentation and
release notes linked per claim; a claim marked "(unverified)" rests on general product knowledge,
not on a page checked for this report. Clean-room: this lists capabilities only. No code, design or
wording of another tool is taken over.

Owner goal (2026-11-20): Kalzit does everything TigerGraph Insights does, and more, and becomes the
best graph analysis and graph UI tool on the market.

## 1. Kalzit today

Solid:

- Sources: own Bolt client for Neo4j and Memgraph (Bolt 4.4, 5.0-5.8), TigerGraph 3.10+ and 4.x
  (interpreted GSQL and installed queries with typed parameters). Read-only in layers: read
  transactions, privilege probes, a Cypher lexer guard with procedure allow-lists (GDS
  `stream`/`stats`, MAGE), a GSQL parser guard (`server/src/datasources/{neo4j,cypher,gsql,
  tigergraph}.rs`).
- The `graph` shape (`server/src/shapes.rs:288-352`): nodes, edges, paths, schema, `truncated`,
  notices; typed values including `point`.
- Eight graph steps in the browser preview and on the server; five of them (count labels, count
  edge types, degree distribution, top degree, shared neighbours) also run in Neo4j and Memgraph
  (pushdown, `server/src/analysis/pushdown.rs`); all pass the same conformance cases
  (`server/src/analysis/conformance.json`).
- Graph panels on WebGL (Sigma.js 4, Graphology): network, hierarchy (own layered layout or ELK),
  paths. Colour and size by property, community or component; shape per label; label collision
  handling; grouping by label above 2,000 nodes; up to 20,000 drawn nodes.
- Explorer on Neo4j and Memgraph: typed neighbour expansion with undo; "open as query".
- Node clicks and multi-selection set dashboard variables; data links; GraphML export.
- Accessibility: table view as an equal alternative, keyboard navigation, live region,
  forced colours, reduced motion.

Gaps against the goal:

1. TigerGraph is second-class: no explorer, no pushdown, no community requests, no GSQL
   completion; nightly CI only on 4.2.
2. No visual pattern search (the core of Insights).
3. Algorithms are not product features: no centrality or path steps, no size or colour by score;
   GDS/MAGE results cannot flow back onto nodes.
4. Thin canvas interaction: no drag, hover tooltip, edge selection, context menu, lasso, search,
   hide or invert selection.
5. Layouts: force and layered only; no radial, circular, grid, coordinate or map layout.
6. Styling: no rules, icons, edge colour or dash per type, badges.
7. Schema: the source schema lists property keys flat (the result shape has them per label); no
   graph schema panel; Memgraph schema from a sample of 10,000 elements.
8. Scale: 20,000 drawn nodes against the 100,000 / 500,000 target; one JSON response, no
   streaming; hierarchy and browser Louvain stop at 2,000 nodes.
9. Time: one edge-time slider; no histogram, playback or node time.
10. Filtering: one-condition `filterGraph` step; no filter pane.
11. Explorations cannot be saved, shared or linked; pins and selection are per viewer only.
12. Explore: no EXPLAIN/PROFILE plan view.
13. Missing step kinds: merging nodes, aggregation over neighbourhoods and paths.

## 2. TigerGraph Insights in detail

- Widgets (11): graph, map (lat/long attributes), table, value, markdown, line, bar, pie, Sankey,
  scatter, inputs (number, string, date, time, vertex, multi-line text, slider, dropdown with
  label-to-value mapping, date picker); since Sep 2025 an ActionForm that writes data. At most 20
  widgets per page. ([widgets](https://www.tigergraph.com/docs/insights/4.3/widgets/),
  [inputs](https://www.tigergraph.com/docs/insights/4.3/widgets/inputs),
  [tools notes](https://www.tigergraph.com/docs/gui/4.3/tools-release-notes/))
- Variables: an input's name is a variable used in pattern queries, GSQL and widget titles; global
  variables since 4.2.1; typed variable pickers (Jul 2026) and query-backed dropdowns (Sep 2026).
  Actions are links: open a URL, another page with parameters, or refresh a widget. No documented
  "click a vertex to set a variable". ([actions](https://www.tigergraph.com/docs/insights/4.2/widgets/actions))
- Graph widget: no-code pattern search (vertex and edge types with attribute filters) that shows its
  GSQL, or raw GSQL; expand by count badge, Explore Neighbors; one or all shortest paths between two
  selected vertices; table view; filters that dim; PageRank (size) and Louvain (colour) only; zoom,
  fit, layout change, mini-map, undo/redo; PNG export only.
  ([graph widget](https://www.tigergraph.com/docs/insights/4.3/widgets/graph-widget))
- Conditional styling on table, graph and map: simple comparisons, ranges, unique values, always;
  not for boolean, date, array or map fields.
  ([conditional styling](https://www.tigergraph.com/docs/insights/4.2/widgets/conditional-styling))
- Apps with pages; sharing with users, multi-user editing, token links for login-free viewing;
  apps as JSON; printing; auto refresh.
  ([applications](https://www.tigergraph.com/docs/insights/4.1/intro/applications))
- Limits: interpreted GSQL only, no accumulators, no concurrent editing of one widget, a size warning
  without a stated threshold ([forum](https://dev.tigergraph.com/forum/t/graphs-size-warning/2817)).
- Around it: 50+ library algorithms (centrality, community, similarity, path, classification, link
  prediction, embeddings) ([GDS library](https://docs.tigergraph.com/graph-ml/current/intro/));
  CoPilot as a separate product ([overview](https://docs.tigergraph.com/tg-copilot/intro/overview));
  GraphStudio's visual query builder deprecated since 3.9.3
  ([builder](https://docs.tigergraph.com/ui/graphstudio/build-graph-patterns/visual-query-builder-overview)).

## 3. Other tools, key capabilities

- **Neo4j Explore (Bloom)**: perspectives (business vocabulary; tier caps), search phrases, scene
  actions on the selection, rule styling with icons, layouts force (GPU), hierarchical, coordinate,
  circular; typed expansion; shortest path up to 20 hops; grouping; histogram filters; an animated
  slicer over time and numbers; seven GDS algorithms, scene-only or written back; PNG and CSV
  export; a node limit of 10,000.
  ([scene interactions](https://neo4j.com/docs/aura/explore/explore-visual-tour/scene-interactions/),
  [GDS](https://www.neo4j.com/docs/aura/explore/explore-features/gds-integration/),
  [slicer](https://neo4j.com/blog/developer/slice-and-dice-your-graph-data-with-neo4j-bloom/))
- **Aura Dashboards and NeoDash**: table, graph, charts, single value, map, choropleth, Sankey,
  sunburst, 3D graph, forms; natural-language card queries in Aura.
  ([reports](https://neo4j.com/docs/neodash-commercial/current/user-guide/reports/))
- **Memgraph Lab**: a CSS-like style script with conditions and hover/selected states; force, tree
  and map views; schema view and modelling; GraphChat agent; MAGE algorithms including node2vec and
  GNN link prediction; sharing, SSO and map tiles in the Enterprise edition.
  ([style script](https://memgraph.com/docs/memgraph-lab/features/graph-style-script/directive-properties),
  [MAGE](https://memgraph.com/docs/mage/algorithms))
- **Linkurious Enterprise**: no-code query builder with bulk paste and the Cypher shown; group
  collapse; entity resolution; multi-rule alerts and case management; lifespan timeline, sticky
  notes, Copilot that filters and selects on the canvas; 65+ algorithms.
  ([4.2](https://linkurious.com/blog/linkurious-enterprise-4-2/),
  [4.3](https://linkurious.com/blog/linkurious-enterprise-4-3/))
- **Graphistry**: GPU server layout, millions of edges, automatic time bar, hypergraph transform,
  UMAP embeddings. ([PyPI](https://pypi.org/project/graphistry))
- **GraphXR**: 2D/3D with geo and time in one canvas, graph transforms such as aggregating
  neighbour values onto a node.
  ([visual language](https://medium.com/kineviz/a-visual-language-for-exploratory-graph-data-analytics-e953c5e61ced))
- **KeyLines/ReGraph** (SDKs): nested combos, a time bar with two-way filtering, sequential and
  radial layouts, Leaflet maps. ([time bar](https://cambridge-intelligence.com/timebar))
- **Gephi**: classic network metrics, SVG/PDF export; memory-bound; Gephi Lite on the web up to
  about 10,000 nodes. ([features](https://www.gephi.org/features))
- **yFiles** (SDK): the widest layout set (hierarchic with swimlanes and ports, orthogonal, radial,
  balloon) and edge routing. ([layouts](https://www.yworks.com/products/yfiles/layouts))

## 4. What users report as weak (opportunities)

Points without a link come from the vendor documentation of section 2 and 3 or are marked
"(unverified)".

- Insights: two algorithms on the canvas, undocumented layouts, PNG-only export, 20 widgets per page,
  an unexplained size warning, interpreted GSQL only, the visual builder deprecated without an equal
  successor; slow at times and weakly documented ([G2](https://www.g2.com/products/tigergraph/reviews),
  [PeerSpot](https://www.peerspot.com/questions/what-needs-improvement-with-tigergraph)).
- Bloom: a 10,000-node cap
  ([community](https://community.neo4j.com/t/bypass-10000-node-limit-in-bloom-neo4j-desktop/45670)),
  scenes that break when database ids are reused, filters not saved with a scene, sharing only
  through a plugin, edits need write access
  ([scenes](https://neo4j.com/docs/aura/explore/explore-features/scenes-export/)), tier caps, no
  dashboards.
- NeoDash: Labs edition unsupported; Aura drops the advanced visualisations
  ([docs-aura](https://github.com/neo4j/docs-aura/pull/758/files)); Neo4j only.
- Memgraph Lab: no expand-on-click, filters or time slider in the documentation (unverified); key
  features in the Enterprise edition ([features](https://memgraph.com/docs/memgraph-lab/features)).
- Linkurious: price ([Software Advice](https://www.softwareadvice.com/risk-management/linkurious-profile/)),
  graph-only ([G2](https://www.g2.com/products/linkurious/reviews)).
- Gephi: memory ([troubleshooting](https://docs.gephi.org/desktop/User_Manual/Troubleshooting)),
  crashes, no live database.

## 5. Where Kalzit can lead

1. One product for graph exploration and dashboards: Bloom-grade canvas next to Insights-grade
   variables and actions, with two-way cross-filtering (chart brush selects nodes; node selection
   filters charts and tables).
2. Three graph databases and all other sources in one place, joined through visible projection
   steps.
3. Algorithms as visible, explained steps on every source: database library where present,
   Kalzit's own implementation otherwise; scores as size and colour; a plain-language summary
   ("3 communities, modularity 0.41"). No write-back.
4. A visual pattern builder that round-trips with Cypher and GSQL and always shows its query.
5. Temporal graphs: time histogram with playback, node and edge lifespans, the difference between
   two points in time, a stable layout across refreshes.
6. Honest scale: "showing N of M" everywhere, aggregation on the server, level of detail, streaming.
7. Graph alerts on the existing alerting: a new path between flagged nodes, a community change, a
   degree spike, a new cycle.
8. Saved explorations keyed by stable properties, not internal ids; share links and snapshots;
   notes on elements.
9. Styling as rules shared by graph, map and table, including date and boolean fields.
10. Layout depth on the web: radial, circular, grid, coordinate, map, timeline, layered with
    routing; saved positions per view.
11. AI under the person's rights and read-only, with the query shown: "why is this node
    important", explain a path or a community.
12. Accessible graph interaction and SVG/PDF/GraphML/CSV export; no competitor documents
    accessible graph interaction.
13. Self-hosted, AGPL, no tier caps.
