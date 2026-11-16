# ArangoDB

Kalzit reads ArangoDB 3.11 and later over its HTTP API. Queries are written in AQL. A result with
edges or traversal paths is a **graph**; any other result stays a list of **documents**, as
ArangoDB stores them. Nothing is turned into a table unless you add a step that does it.

## Connecting

Add a data source of the kind **ArangoDB** under **Administration > Data sources**.

| Setting | Meaning |
|---|---|
| URL | The HTTP API, such as `http://arango.intern:8529` or `https://arango.intern:8529` |
| Database | The database to read; `_system` when empty |
| User name, Password | The login; the password is stored encrypted |
| CA certificate | A private CA in PEM, for HTTPS with a certificate of your own CA |
| Allow a user that may write | Off by default; see below |
| Node limit, Edge limit | The largest graph a query answers (10,000 nodes and 50,000 edges unless set lower) |

The address must be allowed by the server's target rules like every other source; Kalzit's own
database and metadata addresses are always refused.

**Test connection** shows the ArangoDB version and edition, and whether the user may write.

## Read-only

ArangoDB has no read-only query mode, so Kalzit keeps a source read-only in three ways:

1. **The user.** Create a user with read-only access (`ro`) on the database, and no `rw` on any of
   its collections:

   ```js
   // arangosh, as an administrator
   const users = require("@arangodb/users");
   users.save("kalzit", "a long password");
   users.grantDatabase("kalzit", "shop", "ro");
   ```

   Kalzit reads the user's access levels when the source is set up and on **Test connection**, and
   refuses a user who may write, or whose levels it cannot read. Only a data source admin can turn
   on **Allow a user that may write**; then **Test connection** says that only Kalzit's checks keep
   queries read-only.
2. **The query text.** `INSERT`, `UPDATE`, `REPLACE`, `REMOVE` and `UPSERT` are refused, as are
   user-defined functions (`MYFUNCS::x()`) and `CALL` and `APPLY`, before anything is sent.
3. **ArangoDB's parser.** Every query is parsed by ArangoDB first, without running it, and refused
   when its syntax tree has a writing operation or a user function call.

## Queries

```aql
FOR p IN persons
  FILTER p.land == @land
  SORT p.name
  LIMIT 100
  RETURN p
```

Dashboard variables are bind parameters: `@land` takes the variable `land`. `@__timeFrom` and
`@__timeTo` are the time range in Unix milliseconds, `@__interval_ms` the interval. `@@name` names
a collection; only a constant or custom variable whose value is a collection name may fill it.

```aql
FOR v, e, p IN 1..3 OUTBOUND 'persons/ada' knows
  LIMIT 25
  RETURN p
```

A traversal returning paths (or edges) answers a graph: a node's id is the document's `_id`, its
label the collection, its properties the document without `_id` and `_rev`; an edge's type is its
edge collection. Graph steps, the graph panel and the explorer work on it as on any graph.

Results are read in batches from a streaming cursor, up to the row limit; the query time limit is
sent as ArangoDB's `maxRuntime`.

## Schema and Explore

The schema lists the document collections as node labels, the edge collections as edge types, and
the attribute names of a sample of each collection. Explore offers starters for the picked
collection: documents, a count, neighbours along the edges and paths up to three steps. The
query language guide has more examples ([AQL](query-languages.md#arangodb)).

## When something goes wrong

- **The ArangoDB user may write**: the user has `rw` on the database or a collection. Grant `ro`
  instead, or let a data source admin allow it.
- **Kalzit cannot read the access levels**: the user may not read its own access levels, or no
  user is set (a server without authentication). Use a user with a password.
- **ArangoDB answered with an error**: the message is ArangoDB's own, such as a syntax error with
  its line and column.
