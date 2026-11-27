## Improved

- The step catalog has the graph algorithms for a graph result, in seven groups: centrality,
  communities, similarity, paths, structures, link prediction and reshaping. Each entry says which
  question it answers and where it computes with the chosen data source; the search also finds
  steps by their question ("important", "loop", "group").
- Algorithm steps have their parameters with the allowed range at each field, compute right after
  they are added, and say where they ran ("Runs in Neo4j (GDS)", "Runs on the server") and why,
  with one sentence about their result. Limits and errors are said in plain words, with "Insert a
  filter before" or "Compute on the server" where that helps.
- In the panel editor a step's result can be shown on the canvas with one click: as the size of the
  nodes (a new style rule "Size by value"), as their color, or with one color per community.
- Quick actions on the graph canvas: find the shortest, all shortest or weighted path between two
  selected nodes, see how three to ten selected nodes are connected, and list the most important
  nodes by PageRank, degree or betweenness. They compute on what the canvas has loaded, ask the data
  source nothing and are open to viewers; keys W, J, G and U.
- Suggested edges of link prediction are drawn dotted with a diamond, are not counted and can be
  hidden.
- "Calculate degree" is now called "Degree" and sits under centrality.
- New guide page: Graph algorithms and paths.

## Checklist for Windows (manual)

- In the panel editor of a Neo4j graph panel, add PageRank from the step catalog: the step says
  where it ran and "N nodes scored"; "Show as size" adds a style rule and the nodes change size.
- On the canvas, select two nodes in the table view, switch back to the graph and use "Find path":
  the path is drawn strong and neutral, the rest dimmed; Escape closes it.
