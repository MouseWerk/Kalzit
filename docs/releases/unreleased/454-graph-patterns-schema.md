## Improved

- Neo4j, Memgraph and TigerGraph take graph patterns as queries: nodes with one of several labels and conditions (all or any of them), edges with types, direction and path length, optional parts (Neo4j and Memgraph) and a limit. Kalzit writes the Cypher or GSQL for a pattern and shows it; values are always sent as typed parameters, never as query text. The pattern builder in Explore follows in a later release.
- A pattern shows at most 500 matches unless changed, never more than the data source's row limit. Reaching the limit is said without counting; counting the matches is a second query on request.
- Many values at once: paste them one per line (or separated by commas, semicolons or tabs; ids also by spaces) into a list parameter. Repeats and empty entries are left out and named, and the result says how many were found, such as "9 of 12 found". Settings › Data sources sets the largest list (10,000 values by default) and the longest path in a pattern (6 steps by default).
- Cypher and GSQL in the simple form a pattern produces can be read back into a pattern; anything more says "not representable as a pattern" instead of leaving part of the query out.
- Saved analyses can be search templates such as "Kunden von $firma": everyone who may read the analysis, viewers too, runs it with their own value, and only the saved query runs. An input can offer the values of one property to choose from (at most 200, with a search).
- Graph sources describe their schema as a graph: labels and edge types with counts, their properties with data types, and which label connects to which, the largest first. Memgraph gives exact counts when it runs with `--schema-info-enabled`, otherwise Kalzit reads a sample as before; a label without a count can be counted on request.
- EXPLAIN and PROFILE of a Cypher query come back as a plan tree with rows and database hits for Neo4j and Memgraph; PROFILE stays read-only and within the source's time limit, and counts as a query in the source's usage. For TigerGraph Kalzit says that GSQL has no general query plan.

## Checklist for Windows (manual)

- Settings › Data sources shows "Most values per pasted list" and "Longest path in a pattern"; changing one saves and can be undone.
