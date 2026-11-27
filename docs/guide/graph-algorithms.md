# Graph algorithms and paths

When a query answers a graph (Neo4j, Memgraph, TigerGraph and the other graph sources), steps can
compute on it: who is central, which groups there are, how two nodes are connected, which nodes
are alike, where the graph hangs on a single edge, and which edges are likely missing. Every step
is visible in the step list, has its parameters, says where it computed and sums up its result in
one sentence. Nothing is ever written to the data source.

## Adding a step

**Add step** in Explore or in the panel editor opens the step catalog. For a graph it lists the
steps in seven groups, each line saying which question the step answers:

| Group | Steps |
| --- | --- |
| Centrality | Degree, PageRank, Betweenness, Closeness, Eigenvector, Harmonic |
| Communities | Louvain, Leiden, Label propagation, Connected components, Strongly connected components, k-core, Triangles and clustering |
| Similarity | Jaccard, Overlap, Cosine over properties, k nearest neighbours |
| Paths | Shortest path, All shortest paths, Weighted path, k shortest paths, Reachable within n steps |
| Structures | Bridges, Articulation points, Cycles |
| Link prediction | Common neighbours, Adamic-Adar, Preferential attachment |
| Reshape | Merge nodes, Aggregate along |

The steps from before (count per label, filter subgraph, turn into a table and others) follow under
"Count, filter, as a table". The search finds steps by their question too: "important" finds the
centralities, "loop" the cycles, "group" the communities.

Next to each name the catalog says where the step computes with the chosen data source: in the
database (Neo4j with Graph Data Science, Memgraph with MAGE) or on the Kalzit server. The defaults
fit, so a step computes right after it was added; only a path needs its two ends, which start as the
first two nodes of the result.

## What a step shows

- **Where it ran.** "Runs in Neo4j (GDS)", "Runs in Memgraph (MAGE)" or "Runs on the server". When
  a step ran on the server although the database has a library, a line says why, for example "the
  database's library did not answer; the result is the same". Under **Place** a step can be set to
  "Always on the server", to compare runs.
- **One sentence.** "15 nodes scored. Highest value: Anna Weber (0.108)." or "3 communities,
  modularity 0.30." Screen readers hear it once when the step has run.
- **Limits in plain words.** A step that is too large, takes too long or needs too much memory
  says so with the limit and offers **Insert a filter before**. Lists of paths and cycles stop at
  their maximum and say "200 of at least 200 cycles" instead of claiming a total. A database answer
  Kalzit cannot read offers **Compute on the server**.
- **Results may vary.** PageRank, eigenvector, Louvain, Leiden, label propagation and nearest
  neighbours are iterative; when they run in the database the step notes that values can differ
  slightly between runs.

The steps compute on exactly the query's result, never on the whole database. Their limits are
server settings under Settings › Data sources (time, nodes, memory, steps at once, paths and
cycles, top k, suggestions); organizations can only lower them.

## Results on the canvas

What a step finds becomes a property of the nodes (`pagerank`, `community`, `core`, `distance`,
...) or edges (`bridge`), so style rules, variables, filter steps, tables and alert rules read it
like any other property. In the panel editor a step's card offers:

- **Show as size**: adds the style rule "Size by value", from 5 to 17 px over the values in the
  result. The area of a node grows with its value. The rule is listed under Style and can be
  changed or removed there; when the step is turned off, the rule rests.
- **Show as color**: adds the style rule "Color by value": one tone of the data palette, light for
  the smallest value, saturated for the largest. Like the size rule it is listed under Style.
- **Color per community**: adds a rule with one color per community; the eight largest get the
  data palette.

Suggested edges of link prediction are drawn dotted with an open diamond. They are not in the
database, are not counted ("Plus 5 suggested edges; they are not counted"), go into no later step
and are left out of exports. **Hide suggestions** (or the key U) hides them.

## Quick actions on the canvas

Three questions need no step list. They compute on the Kalzit server on what the canvas has loaded,
ask the data source nothing, and are not saved, so viewers can use them too; they are off on public
links and snapshots.

- **Find path** with two selected nodes: shortest path, all shortest paths, "Weighted path by
  <property>" for each number on the edges (without one the entry stays visible with the reason),
  and the 3 shortest paths. "Swap From and To" turns the question around. The search ignores the
  direction of edges unless "Follow the direction of the edges" is ticked. The path is drawn
  strong in the text color, the other paths found lighter, the rest dimmed; its edges are listed
  with their weights and the sum. J and Shift+J walk through the paths, **Show only the path**
  hides the rest.
- **How are these connected?** with three to twenty selected nodes: one shortest path between each
  two, and the nodes that are not connected to the others by name. When a pair could not be
  computed, the sentence says why instead.
- **Most important nodes**: the first five ranks by PageRank, degree or betweenness (arrow keys
  switch the measure); ties share a rank, so the list may be longer, and beyond ten rows it says
  how many more share them. In the panel editor **Show as size** takes the ranking over as a step
  and adds a size rule.

W starts the path or the connection for the selection, G the most important nodes, Escape closes the
answer. In the panel editor, **Take over as a step** turns the answer into steps of the panel.
A person runs one quick action at a time, and a server a few at once; when it is busy, the answer
says so and a moment later it works again.

See also [Explore](explore.md#graph-steps), [Calculated fields and statistics](calculated-fields.md)
and the [API of the graph algorithm steps](../api/settings-dashboards.md#graph-algorithm-steps).
