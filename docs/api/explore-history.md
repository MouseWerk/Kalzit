# Explore history API

The queries a user ran from Explore, so they can find and run them again. All routes are under
`/api/orgs/{orgId}` and need only membership of the organization; the answers are about the
caller alone.

## Who sees what

- The history is private to its user. Nobody else reads it, administrators and owners included;
  there is no route for it, and the audit log is unaffected.
- Entries are kept per user and organization: the same user has a separate history in each
  organization, and an entry of one organization is never listed, deleted or run through another.
- Entries are kept for 30 days and at most 500 per user and organization. The newest stay.
- Only the query as Explore sent it is stored (`query`, the data source id, the shape and the
  size of the answer, how long it took). Results are never stored, and a data source's settings
  and secrets are not part of a query, so none are stored.
- An entry of a data source the caller may no longer query (a grant removed, the source deleted)
  is left out of the list. This is not an error and the list names nothing of it. The entries stay
  stored and reappear if the access returns; "delete all" removes them too.

## Recording

`POST /orgs/{orgId}/query` takes an optional `explore: true`. Explore sets it; dashboard panels
and other clients do not, and their runs are not recorded.

- Only items that succeeded and that the caller may query are kept. A refused, failed or timed-out
  query leaves nothing. A query larger than 64 KiB is run but not kept.
- The same query on the same data source right after the caller's latest entry does not add an
  entry; the latest one moves to the top (`createdAt` is the new run).
- Recording never fails the query: if the history cannot be written, the query still answers.
- `durationMs` is the time of the run when the request held a single query, else absent.

## List

`GET /explore/history?limit=&cursor=&datasourceId=&q=`

Newest first. `limit` 1 to 200 (default 50), `cursor` from `nextCursor`. `datasourceId` keeps one
data source. `q` (at most 100 characters) keeps entries whose query contains the text, ignoring
case; `%`, `_` and `\` are plain characters. Unknown parameters answer `422 validation`.

```json
{
  "items": [
    {
      "id": "0197...",
      "datasourceId": "ds1",
      "datasourceName": "Shop",
      "datasourceKind": "postgres",
      "query": { "sql": "SELECT status, count(*) FROM orders GROUP BY 1" },
      "shape": "frame",
      "rowCount": 4,
      "durationMs": 18,
      "createdAt": 1800000000000
    }
  ],
  "nextCursor": null
}
```

`shape` is `frame`, `documents` or `graph`; `rowCount` is rows, documents or nodes.

## Delete

- `DELETE /explore/history/{entryId}` deletes one of the caller's entries: `204`. An id that is
  not theirs, is of another organization or does not exist is `404 not_found`.
- `DELETE /explore/history` deletes all of the caller's entries in this organization: `204`, also
  when there are none.

## Running an entry

Running an entry is a normal `POST /orgs/{orgId}/query` with the stored query, so
`datasources:query` on the data source (role or grant) is checked as for any free query. History
never grants access.

## Errors

| Status and code | When |
|---|---|
| `401 unauthenticated` | not signed in |
| `404 not_found` | not a member of the organization; an entry that is not the caller's |
| `422 validation` | `limit`, `cursor` or `q` invalid, unknown parameter |
