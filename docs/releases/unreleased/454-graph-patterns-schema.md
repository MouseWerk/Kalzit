## Improved

- Neo4j, Memgraph and TigerGraph take graph patterns as queries: nodes with labels and conditions, edges with types, direction and path length, optional parts (Neo4j and Memgraph) and a limit. Kalzit writes the Cypher or GSQL for a pattern and shows it; values are always sent as typed parameters, never as query text. The pattern builder in Explore follows in a later release.
- Many ids at once: paste them one per line (or separated by commas, semicolons, tabs or spaces) into a list parameter of a pattern.
- Cypher and GSQL in the simple form a pattern produces can be read back into a pattern; anything more says "not representable as a pattern" instead of leaving part of the query out.
- Saved analyses can be search templates such as "Kunden von $firma": everyone who may read the analysis, viewers too, runs it with their own value, and only the saved query runs.
- Graph sources describe their schema as a graph: labels and edge types with counts, their properties with data types, and which label connects to which. Memgraph gives exact counts when it runs with `--schema-info-enabled`, otherwise Kalzit reads a sample as before.
- EXPLAIN and PROFILE of a Cypher query come back as a plan tree with rows and database hits for Neo4j and Memgraph; PROFILE stays read-only and within the source's time limit. For TigerGraph Kalzit says that GSQL has no general query plan.
