## Improved

- New data source ArangoDB (AQL): traversals and edges arrive as graphs, other results as
  documents. Kalzit refuses users who may write, checks every query and lets ArangoDB parse it
  before it runs, so writing queries are refused.
- New data source Gremlin for graph databases behind Apache TinkerPop Gremlin Server: traversals
  are checked and sent as bytecode under the server's read-only strategy, never as scripts;
  vertices, edges and paths arrive as graphs.
- New data source Couchbase (SQL++): only SELECT statements run, always as read-only requests, and
  users with roles beyond reading are refused; results arrive as documents.
- All three have Test connection, schema browsing, query editors with highlighting, Explore
  starters and a cheat sheet, and a guide page each.
