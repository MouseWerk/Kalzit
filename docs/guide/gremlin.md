# Gremlin

Kalzit reads graph databases that speak the Apache TinkerPop Gremlin Server protocol (3.7 and
later, over WebSocket with GraphSON 3.0), such as Gremlin Server with TinkerGraph or JanusGraph;
CI checks it against Gremlin Server. Queries are Gremlin traversals. Vertices, edges and paths of them are a
**graph**; other values are **documents**.

## Connecting

Add a data source of the kind **Gremlin** under **Administration > Data sources**.

| Setting | Meaning |
|---|---|
| WebSocket URL | Such as `ws://graph.intern:8182/gremlin`, or `wss://...` with TLS |
| Traversal source | The name the server binds the graph to; `g` when empty |
| User name, Password | For servers with authentication (SASL PLAIN); the password is stored encrypted |
| CA certificate | A private CA in PEM, for `wss://` with a certificate of your own CA |
| Node limit, Edge limit | The largest graph a query answers |

Kalzit connects to the address the server's target rules allow, checks the name once and keeps it
for the TLS check. **Test connection** runs `g.inject(1)` on the traversal source.

## Read-only

Kalzit never sends a script. It reads your traversal itself, checks it and sends it as bytecode,
so Gremlin Server evaluates no Groovy:

1. **Kalzit's check.** A traversal starts with `g.V()`, `g.E()` or `g.inject()` and uses only
   reading steps, also inside anonymous traversals. `addV`, `addE`, `property`, `drop`, `mergeV`,
   `mergeE`, `io`, `call`, `sideEffect`, lambdas (`{ ... }`) and source steps such as
   `withStrategies` are refused before anything is sent.
2. **The server's check.** Every traversal is sent under TinkerPop's `ReadOnlyStrategy`, so the
   server refuses a step that would change the graph, whatever Kalzit's check missed.

Gremlin Server itself has no read-only users. Where your database has them, use one.

## Queries

```groovy
g.V().hasLabel('person').has('age', gt(30)).order().by('age', desc).limit(10)
```

```groovy
g.V().has('person', 'name', 'marko').outE('knows').inV().path()
```

A dashboard variable is its bare name where a value goes: `has('land', land)` takes the variable
`land`, as a value, never as text. `__timeFrom` and `__timeTo` are the time range in Unix
milliseconds, `__interval_ms` the interval. Predicates (`gt(5)`, `P.within('a', 'b')`,
`TextP.containing('ar')`), tokens (`desc`, `T.id`, `local`, `keys`) and anonymous traversals
(`__.out()` or `out()` inside a step) are written as in the Gremlin console. A trailing
`.toList()` is dropped, `.next()` becomes `limit(1)`.

Vertices become nodes (their id as text, their label, their properties), edges become edges, and a
`path()` stays a path. `elementMap()`, `valueMap()`, `project()` and other values answer documents;
counts and single values are `{"value": ...}`. When the server sends vertices and edges without
their properties (some configurations send only id and label), Kalzit reads the properties with
a second reading traversal.

## Schema and Explore

The schema lists vertex and edge labels and the property keys of a sample. Explore offers starters
for the picked label: vertices, paths to neighbours, and counts per label. More examples are in
the query language guide ([Gremlin](query-languages.md#gremlin)).

## When something goes wrong

- **is not a step Kalzit runs**: the step is not on Kalzit's list of reading steps (graph
  algorithms that need a graph computer among them).
- **Gremlin Server refused the traversal because it would change data**: the server's
  `ReadOnlyStrategy` found a mutating step.
- **The WebSocket connection failed**: check the URL and its path (usually `/gremlin`), and for
  `wss://` the certificate.
