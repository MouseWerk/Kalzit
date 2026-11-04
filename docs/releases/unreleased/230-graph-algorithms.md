## Improved

- Cypher may call the graph algorithms of Neo4j GDS (`stream` and `stats` modes) and Memgraph
  MAGE that only read, from a reviewed list; writing modes, graph projections and APOC stay
  refused. Graph panels with more than 2,000 nodes get their communities from GDS or MAGE when
  the source has it and you may query the source.

## Checklist for Windows (manual)

- In Explore on a Neo4j source with GDS, run `CALL gds.louvain.write('g', {writeProperty: 'c'})`:
  it is refused as not on the list of read procedures; a graph panel with more than 2,000 nodes
  from a Memgraph source with MAGE names its communities "computed by the database".
