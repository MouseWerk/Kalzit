## Improved

- The graph explorer works with TigerGraph: Kalzit writes the GSQL for a vertex's neighbours by edge type and direction from the graph's schema, follows directed edges backwards through their reverse edge type, and says which edge types it cannot follow.
- Counting vertex types runs in TigerGraph when an interpreted query prints only vertex sets, so it counts the whole result instead of what fits the node limit.
- PageRank, connected components, core numbers, triangles and reachability run in TigerGraph through Kalzit's own read-only algorithm queries, with the same results as on the Kalzit server. Kalzit checks after each run that the database computed on the same edges as your result, and otherwise computes the step itself; the step says why.
- Kalzit can install these algorithm queries itself through a second, optional install access of the data source, off by default and set only by data source admins. It shows the exact GSQL before it installs, updates or removes anything, touches only its own queries, refuses an install access that may write data or the schema, does not run a query that was changed in the database, and records every step in the audit log. Administrators can also install the queries themselves and approve them by name.
- The GSQL editor gets the vertex and edge types with their attributes, the directions an edge type can be followed in, and GSQL's accumulator types for completion.

## Checklist for Windows (manual)

- Add a TigerGraph 4.x source, open a graph result in the explorer and load the neighbours of a vertex, along and against the direction of a directed edge type with a reverse edge type.
- Turn on **Install algorithm queries**, set an install user with only the query privileges, check the shown GSQL, install, run PageRank on a graph result and see it computed in the database; then remove the queries again.
