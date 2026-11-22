## Improved

- Graph results can run algorithm steps: centrality (PageRank, betweenness, closeness, eigenvector, harmonic), communities and components, k-core, triangles and clustering, similarity (Jaccard, overlap, cosine, nearest neighbours), suggested edges, shortest, weighted, all and k shortest paths, reachable nodes, bridges, articulation points, cycles, merging nodes and aggregating along neighbours or paths. The steps work on exactly the query result and never write to the data source. The step catalog in Explore and the panel editor follows in a later release.
- Algorithm steps compute in Neo4j with Graph Data Science or in Memgraph with MAGE where they can, otherwise on the Kalzit server, which also takes over automatically when the database cannot. Each step says where it ran and why, and sums up its result in one sentence.
- Suggested edges stay apart from the data: they are not counted, not read by later steps and not exported.
- "Degree" can count only some edge types and sum an edge weight.
- Settings › Data sources has limits for graph steps: time, nodes, memory, steps at once, paths and cycles, top k and suggestions. Organizations can only lower them.

## Checklist for Windows (manual)

- Settings › Data sources shows the graph step limits; changing one saves and can be undone.
