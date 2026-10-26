# Live updates

`GET /api/orgs/{orgId}/live` opens a WebSocket that pushes query results whenever they change,
instead of the browser asking again and again. A connection carries any number of subscriptions
(up to a limit); each is a panel's stored queries or free queries, and each result keeps its
native shape (`frame`, `documents`, `graph`) exactly as `POST /query` answers it
(docs/api/datasources.md).

Server side: `server/src/routes/live.rs` (connection, authorization, protocol) and
`server/src/live.rs` (feeds, limits). The TypeScript types (`LiveSubscribe`, `LiveUnsubscribe`,
`LiveMessage`) are generated into `ui/src/api/generated/shapes.ts`.

## Handshake

- The session cookie signs the connection in; without a valid session the handshake answers
  `401 unauthenticated`, for a non-member of the organization `404 not_found`.
- `Origin` must be this server (the same rule as for every changing request: `server.public_url`,
  or the `Host` the browser addressed); another origin answers `403 cross_origin`. A client that
  sends no `Origin` (not a browser) passes, as for the rest of the API.
- Messages are JSON text frames of at most 256 KiB.

## Subscribing

```json
{ "type": "subscribe", "id": "p1",
  "panel": { "dashboardId": "…", "panelId": "…" },
  "lastMs": 3600000, "variables": { "land": "AT" }, "refreshMs": 30000 }
```

```json
{ "type": "subscribe", "id": "e1",
  "queries": [{ "refId": "A", "datasourceId": "…", "query": { "collection": "orders", "filter": "{\"land\": \"AT\"}" } }],
  "timeRange": { "from": 1767225600000, "to": 1767312000000 } }
```

- `id`: the client's name for the subscription, 1 to 64 characters, unique on the connection.
- Exactly one of `panel` (a dashboard panel's stored queries) and `queries` (free queries, as in
  `POST /query`, without `cursor`).
- Exactly one of `timeRange` (fixed) and `lastMs` (the last `lastMs` milliseconds before each
  run, at most 100 years).
- `intervalMs`, `maxDataPoints` and `variables` as in `POST /query`; `limit` is the panel's row
  limit (free queries carry their own).
- `refreshMs`: how often the queries run when they are polled; default 30 s, at least the
  server's minimum (5 s), at most a day.

`{ "type": "unsubscribe", "id": "p1" }` ends a subscription; an unknown `id` is ignored.

## Authorization

Every subscription is authorized on the server when it is made, with the caller's current
session, membership and permissions:

- `panel`: the caller may read the dashboard (`dashboards:read`, by role or grant), as for
  `POST /dashboards/{id}/panels/{panelId}/query`; the variables are checked against the dashboard
  the same way. Viewers run only these stored queries.
- `queries`: `datasources:query` on every source the queries use (editor and up, or a grant).
  A source the caller cannot see answers `not_found`.

Every 30 seconds the session, the membership and each subscription are checked again:

- An ended session closes the connection (`live.unauthenticated`, close code 4001); a membership
  that ended closes it with `live.forbidden` (4003).
- A subscription the caller may no longer run ends with an `error` message (`live.forbidden`,
  with the code the check answered, `forbidden` or `not_found`); the connection stays.
- A panel whose stored queries changed (the dashboard was saved) moves to the new queries.

## Messages from the server

```json
{ "type": "status", "id": "p1", "mode": "changes", "refreshMs": 30000 }
{ "type": "status", "id": "e1", "mode": "poll", "refreshMs": 30000, "reason": "live.source_unsupported" }
{ "type": "result", "id": "p1", "at": 1767312000000, "results": { "A": { "result": { "documents": { … } } } } }
{ "type": "error", "id": "e1", "error": { "code": "forbidden", "message": "…", "reason": "live.forbidden" } }
{ "type": "closing", "error": { "code": "busy", "message": "…", "reason": "live.idle_timeout" } }
```

- `status`: after subscribing and whenever the mode changes. `changes`: the sources report
  changes; `poll`: the queries run every `refreshMs`. `reason` says why a subscription with a
  fixed range polls (`live.source_unsupported`, `live.changes_unavailable`).
- `result`: first right after subscribing, then whenever the results differ from the last ones
  sent (identical results are not sent again). `results` is the `results` object of
  `POST /query`, one outcome per `refId`; a failing query answers its error there, as in
  `POST /query`. `at` is when the queries ran (Unix milliseconds).
- `error`: a subscription that was refused or ended, with the `error` body of the REST API
  (`code`, `message`, `reason`, `params`). Without `id`: a message that was not understood
  (`live.invalid_message`).
- `closing`: the server closes the connection right after this; the close frame carries the same
  reason as its text.

| Close code | Reason |
|---|---|
| 1001 | `live.shutting_down` |
| 4001 | `live.unauthenticated` |
| 4003 | `live.forbidden` |
| 4008 | `live.idle_timeout` |
| 4009 | `live.slow_client` |
| 4029 | `live.too_many`, `live.server_busy` |

All reasons and their texts are listed in docs/api/datasources.md, "Reasons".

## How results stay current

- **MongoDB change streams.** For a fixed `timeRange`, a MongoDB query watches its collection
  (`collection.watch`), when the deployment has change streams (a replica set or a sharded
  cluster; the login's `read` role includes the `changeStream` action). Inserts count only when
  the new document passes the query's filter (a find's `filter`, or a pipeline's leading
  `$match`, where it can be applied to the event); updates, replacements and deletes always
  count, since a document may leave the result. The events carry no documents. On a change the
  query runs again (changes within a second make one run) and the new result is pushed in its
  `documents` shape. The stream continues from its resume token after reconnects and is reopened
  every 10 minutes, so changed settings and target rules of the source apply. As a safety net,
  the queries also run every 5 minutes.
- **Polling.** Everything else runs every `refreshMs`: SQL, metrics, search and graph sources, a
  moving range (`lastMs`), a MongoDB server without change streams (a standalone server), a view,
  and a pipeline that reads other collections (`$lookup`, `$graphLookup`, `$unionWith`). A change
  feed that fails falls back to polling and is tried again after a minute.
- Each run is an ordinary query run: the data source's timeout, row limit, response size limit,
  the server's budget for results in memory and the per-user and server-wide parallel query
  limits all apply.
- Subscriptions with the same queries, range rule, variables and refresh share one feed, also
  across users (each of them authorized on their own). The feed runs with the query slots of the
  user who started it and ends with its last subscriber.

## Limits

| Limit | Default |
|---|---|
| Live connections per user | 8 (`live.too_many`) |
| Live connections on the server | 1000 (`live.server_busy`) |
| Subscriptions per connection | 50 (`live.too_many_subscriptions`) |
| Shortest `refreshMs` | 5 s |
| Messages waiting for a slow client | 32; one more closes it (`live.slow_client`), as does a message that takes over 10 s to send |
| Without subscriptions | closed after 5 minutes (`live.idle_timeout`) |
| Silent client | the server pings every 30 s; a client that sends nothing (no pong) for 90 s is closed (`live.idle_timeout`) |

When the server stops (or updates itself), every live connection gets `closing` with
`live.shutting_down` before the listeners stop; clients reconnect once it is back.
