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
  the same way. Viewers run only these stored queries. A panel linked to a library panel or a
  saved analysis runs that one's current queries, authorized by the dashboard as for the REST
  route; when the library panel or the analysis changes, the next check moves the subscription to
  the new queries.
- `queries`: `datasources:query` on every source the queries use (editor and up, or a grant).
  A source the caller cannot see answers `not_found`.

Every 30 seconds the session, the membership and each subscription are checked again:

- An ended session closes the connection (`live.unauthenticated`, close code 4001); a membership
  that ended closes it with `live.forbidden` (4003).
- A subscription the caller may no longer run ends with an `error` message (`live.forbidden`,
  with the code the check answered, `forbidden` or `not_found`); the connection stays.
- A panel whose stored queries changed (the dashboard was saved) moves to the new queries.
- A check that cannot be done (the database is busy) twice in a row ends what it guards:
  the subscription, or for the session the connection (`live.check_failed`, close code 1011).

## Messages from the server

```json
{ "type": "subscribed", "id": "p1", "feed": "0193…" }
{ "type": "status", "feed": "0193…", "mode": "changes", "refreshMs": 30000 }
{ "type": "status", "feed": "0194…", "mode": "poll", "refreshMs": 30000, "reason": "live.source_unsupported" }
{ "type": "result", "feed": "0193…", "at": 1767312000000, "results": { "A": { "result": { "documents": { … } } } } }
{ "type": "error", "id": "e1", "error": { "code": "forbidden", "message": "…", "reason": "live.forbidden" } }
{ "type": "closing", "error": { "code": "busy", "message": "…", "reason": "live.idle_timeout" } }
```

Subscriptions with the same queries, range rule, variables and refresh share one **feed**, also
across users and connections. `status` and `result` name the feed, so one result message is
made once and sent to every connection that follows it; a connection gets each feed's messages
once, however many of its subscriptions share it.

- `subscribed`: the subscription `id` follows `feed`; its status and results are that feed's.
  Sent after subscribing, and again with another feed when a check moved the subscription (its
  panel was edited). A subscription joining a feed the connection already follows gets the feed's
  current `status` and `result` again right after.
- `status`: when a feed starts and whenever its mode changes. `changes`: the sources report
  changes; `poll`: the queries run every `refreshMs`. `reason` says why a feed with a fixed range
  polls (`live.source_unsupported`, `live.changes_unavailable`, `live.streams_limit`), or why it
  shows an older result (`live.memory_limit`).
- `result`: first right after the feed's first run, then whenever the results differ from the
  last ones (identical results are not sent again). `results` is the `results` object of
  `POST /query`, one outcome per `refId`; a failing query answers its error there, as in
  `POST /query`. `at` is when the queries ran (Unix milliseconds).
- `error`: a subscription that was refused or ended, with the `error` body of the REST API
  (`code`, `message`, `reason`, `params`). Without `id`: a message that was not understood
  (`live.invalid_message`). A feed that ends (its first result does not fit, `live.memory_limit`,
  or an internal error) ends every subscription following it with an `error` each.
- `closing`: the server closes the connection right after this; the close frame carries the same
  reason as its text.

| Close code | Reason |
|---|---|
| 1001 | `live.shutting_down` |
| 1011 | `live.check_failed` |
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
  query runs again and the new result is pushed in its `documents` shape; runs keep at least the
  minimum refresh (5 s) apart, however many changes come in.
- Change streams use their own client per source, with its own pool of 8 connections (each open
  stream holds one in a waiting `getMore`), so they never take the connections queries use. At
  most 8 streams are open per source; further subscriptions poll (`live.streams_limit`).
- The stream's position (its resume token, also after waits without changes) is kept; when the
  stream is reopened (after a failure, and every 10 minutes, so changed settings and target rules
  of the source apply) it continues from there. When the server no longer has that history, the
  stream starts from now; the queries run after every open, so nothing is missed. As a safety
  net, the queries also run every 5 minutes.
- **Polling.** Everything else runs every `refreshMs`: SQL, metrics, search and graph sources, a
  moving range (`lastMs`), a MongoDB server without change streams (a standalone server), a view,
  and a pipeline that reads other collections (`$lookup`, `$graphLookup`, `$unionWith`). A change
  feed that fails falls back to polling and is tried again after a minute.
- Each run is an ordinary query run: the data source's timeout, row limit, response size limit
  and the server's budget for results in memory apply. Feeds run with their organization's live
  query slots (as many parallel queries as one user gets), within the server-wide limit, never
  with a subscriber's own: a user who left does not pay for a feed. A feed runs one query run at
  a time (a run that is still waiting or running is never queued a second time), and of the
  feeds one user started, at most 2 runs wait for or hold slots at once, so one user's many
  feeds cannot hold up the feeds of others.
- The latest result of every feed is kept once, for subscribers that join. It is charged to the
  user who started the feed and to the organization: at most 8 MiB per result, 32 MiB per user,
  128 MiB per organization and 256 MiB on the server. When a share is full, new feeds of that
  user (or organization) are refused with `live.memory_limit`; running feeds keep their last
  result that fit, and their `status` says `live.memory_limit` until a new result fits again.
  Nobody's feed ends because of someone else's results. A feed ends with its last subscriber.

## Limits

| Limit | Default |
|---|---|
| Live connections per user | 8 (`live.too_many`) |
| Live connections on the server | 1000 (`live.server_busy`) |
| Subscriptions per connection | 50 (`live.too_many_subscriptions`) |
| Different feeds one user follows | 100 (`live.too_many_feeds`) |
| Feeds on the server | 500 (`live.feeds_busy`) |
| Latest results kept | 8 MiB per result, 32 MiB per user, 128 MiB per organization, 256 MiB in all (`live.memory_limit`) |
| Runs of one user's feeds waiting for or holding query slots | 2 |
| Change streams per MongoDB source | 8 (`live.streams_limit`) |
| Shortest `refreshMs`, and shortest time between runs after changes | 5 s |
| Messages waiting for a slow client | 32; one more closes it (`live.slow_client`), as does a message that takes over 10 s to send |
| Without subscriptions | closed after 5 minutes (`live.idle_timeout`) |
| Silent client | the server pings every 30 s; a client that sends nothing (no pong) for 90 s is closed (`live.idle_timeout`) |

When the server stops (or updates itself), every live connection gets `closing` with
`live.shutting_down` before the listeners stop; clients reconnect once it is back.

Change streams are tested against an in-process MongoDB that speaks the change stream protocol;
the CI MongoDB is a standalone server, so there only the fallback to polling runs against a
real server.
