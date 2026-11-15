# Sharing API

Public links and snapshots of dashboards (docs/PLAN.md, M7 0.7.4; user guide:
[Sharing](../guide/sharing.md)). Sharing inside an organization (granting users and teams access,
copying a dashboard's address with its time range and variables) needs `dashboards:share` and
stays as it is: the person opening it signs in and needs read rights. This page is about people
without an account.

Organization routes are under `/api/orgs/{orgId}/...`, the public routes under `/api/public/...`,
and follow the API conventions (JSON in camelCase, times in Unix milliseconds, lists as
`Page<T>` = `{ items, nextCursor }`, errors as `{ error: { code, message, field?, reason?,
params? } }`).

## Rules of the API

- **Permission `dashboards:public`**: creating public links and public snapshots. Built-in roles
  admin and owner have it; it can be given to custom roles. It is an organization permission, not
  a grant level on a dashboard.
- **Switches**: `sharing.public_enabled` (server, default `false`) and
  `sharing.org_public_enabled` (organization, default `true`, can only turn it off). Both must be on
  for anything public to be created or served. Further server settings:
  `sharing.max_expiry_days` (default `365`) and `sharing.snapshot_max_bytes` (default 10 MiB).
  Settings apply at once.
- **Tokens**: 256 random bits in unpadded base64url (43 characters), shown once in the answer that
  creates the link or snapshot, stored only as their SHA-256.
- **Expiry** is required: default 30 days, at most `sharing.max_expiry_days` counted from now. It
  can be changed later with the same bound (audited).
- **Revoking is final.** Revoked and expired links and snapshots stay listed with their status
  and are deleted 30 days after they expired or were revoked (an hourly job on the leading
  server). A revoked snapshot's frozen results are deleted at once.
- **Status** (`active`, `suspended` with `suspendedReason`, `expired`, `revoked`) is shown to the
  creator and the organization's admins only. Suspension is not stored: every request checks
  again, so a suspended link works again once the cause is gone, until it expires. Reasons:
  `sharingOff` (a switch is off), `creatorRemoved` (account deleted or disabled, or left the
  organization), `creatorRights` (no longer holds `dashboards:public`, read on the dashboard or
  query rights on one of its sources), `dashboardTrashed`.
- **Managing**: organization admins (`org:write`) list, change and revoke every link and
  snapshot of the organization; everyone else only their own (`mine`). Someone else's link is
  `404 not_found` for them.
- **Audit**: `public_link.created|expiry_changed|revoked`,
  `snapshot.created|expiry_changed|revoked`, with the dashboard id, never a token.
- **Visitors**: one neutral answer for every token that does not work (unknown, malformed,
  expired, revoked, suspended, a panel that is not there): `404 not_found` with reason
  `sharing.unavailable` and the same message. A revoked, expired or suspended token goes through
  the same checks of its creator as a working one before it is refused, so the time of the answer
  does not tell them apart either. Nothing about visitors is stored but a view count per link and
  snapshot (page loads) and the time of the last one.
- **Rate limits** (`429 rate_limited` with `sharing.rate_limited`): a client address (IPv6 per
  /64) may send 120 tokens a minute that do not exist; then it is refused for every token until
  the minute is over, so guessing costs only the guesser. The hash of a link or snapshot deleted
  in the last 90 days still counts as known (a tombstone without any other data), so old links
  in browser histories do not use up the budget. Trade-off: many people behind one address (a
  company's NAT) share the budget; only made-up tokens use it up. An existing token (in any
  state) is counted per address and token, 600 requests a minute: one visitor cannot use up a
  link for the others, and a full table of addresses never refuses. Beyond 6000 requests a
  minute to one token from all addresses together, each further request waits half a second
  first; it is never refused for that.
- **Work for visitors**: a panel's answer for a range is reused for 30 seconds (per link, panel
  as stored, rounded range, the creator's rights and the query cache's rights generations of its
  sources), so visitors cannot make the server run the panel's steps over and over. Steps for
  visitors run in a few slots shared by the whole server, and stop when the visitor goes away.
- **Headers**: every public answer, refusals included, carries `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`; the pages under `/public/` carry
  `X-Robots-Tag: noindex` and `Referrer-Policy: no-referrer` too. Request logs, timeouts included,
  show public paths with `[token]` in place of the token.
- **Signed-in people only publish**: creating a public link or a public snapshot, or changing
  the expiry of a link or snapshot, with an API token is `403 token.not_for_this_route`; internal
  snapshots may be made with one. The `sharing.*` settings of an organization are not changed
  with a token either.
- **Saving what a live link shows** (owner decision D1): saving a dashboard (or restoring one of
  its versions) that has active public links, or saving or restoring a version of a library
  panel or saved analysis such a dashboard shows, needs `dashboards:public`:
  `403 sharing.public_links_active` with `links` (the number of links) on the field `model`
  (`version` for a restore). A provisioning plan or apply that changes such a dashboard is
  refused the same way (field `files`). Live links stay live.

## Public links

### Create

`POST /orgs/{orgId}/dashboards/{dashboardId}/public-links` (`dashboards:public`, read on the
dashboard, `datasources:query` on every source its panels use; `409 sharing.public_off` when a
switch is off, `403 sharing.sources_forbidden` without the query rights)

```json
{
  "expiresAt": 1801234567000,
  "maxWindowMs": 604800000,
  "timeRange": { "from": "now-24h", "to": "now" },
  "variables": { "region": "Nord" }
}
```

Every field may be left out: 30 days, 7 days, the dashboard's range and its current variable
values. `maxWindowMs` is how far back visitors may look: any range from `now - maxWindowMs` to now
(1 minute up to `sharing.max_expiry_days`). Variables are checked like a panel query's
(`variables.*` reasons); constants are the dashboard's own and cannot be sent.

`201 { link: PublicLink, token }`. The page for visitors is `/public/dashboards/{token}`.

### List, change, revoke

- `GET /orgs/{orgId}/public-links?mine=&dashboardId=&limit=&cursor=` (member): `Page<PublicLink>`,
  newest first. Without `org:write` only the caller's own.
- `PATCH /orgs/{orgId}/public-links/{linkId}` (creator or admin): `{ expiresAt }`, answers the
  `PublicLink`; `409 sharing.revoked` or `sharing.expired` for one that ended.
- `POST /orgs/{orgId}/public-links/{linkId}/revoke` (creator or admin): `204`; again
  `409 sharing.revoked`.

`PublicLink`: `id`, `dashboardId`, `dashboardTitle` (absent when the caller may not read the
dashboard), `createdBy`, `createdByName`, `createdAt`, `expiresAt`, `maxWindowMs`, `timeRange`,
`variables`, `views`, `lastViewedAt`, `revokedAt`, `status`, `suspendedReason`.

### For visitors

Every request checks: the token, revocation, expiry, both switches, the creator's membership
and account, `dashboards:public`, read on the dashboard (not in the trash) and query rights on
every source of its panels, all as they are now.

- `GET /public/dashboards/{token}`: `{ dashboard: PublicDashboard, timeRange, maxWindowMs,
  expiresAt }`; counts a view.
- `POST /public/dashboards/{token}/panels/{panelId}/query` with `{ timeRange: { from, to } }`
  (absolute milliseconds): runs the panel's stored queries as its creator, with the link's
  variable values, and answers `QueryResponse`. The range must lie within the last `maxWindowMs`
  (`to` at most a minute ahead of the server's clock): `422 sharing.window_exceeded` otherwise.
  Any other field (variables, limits, cursors, refresh) is `422 request.body_invalid`; no free
  query can be sent. The range is rounded up to whole minutes before it runs, so visitors of the
  same link share the creator's cached answers.

`PublicDashboard` holds what draws the dashboard: title, time zone and week settings, rows, and
per panel its id, type, title, description, grid, row, own range or shift, its shown queries as
`targets` (`{ refId, hide: false }`), options and field settings without links (`dataLinks`,
cell `link`). It never holds query text, data source ids or names, annotations, dashboard links,
panel links, library panel or saved analysis ids, constants, tags, hidden queries or steps.
Variables come with their fixed value.

Answers hold only what the panel shows (owner decision D2), worked out on the server for links
and snapshots alike: the panel's enabled steps run there (the page draws the answers without
steps), answers of hidden queries are left out, and a network, hierarchy or path panel whose
property details are off (`clickDetails: false`) keeps only the node and edge properties its
options name (`caption`, colour, size, edge width, time, variable) and, without a caption of its
own, each node's first `name`, `title`, `label`, `displayName`, `caption`, `id` or `key`; the
graph's schema lists only the properties left. A step that fails, or does not even parse,
answers the neutral error instead of being skipped. Answers keep their shape (`frame`, `documents`, `graph`, `trace`) but lose the
executed statement, paging cursors, notices and step reports; a failed query answers only its
code (`datasource_error`, also for a failed step, or `query_timeout`) with the message "the
query failed". Panels repeated per variable value are shown once, with the stored value.

Known limitation: documents and trace answers are not trimmed to the fields their panel
displays yet, and frames keep every field after the steps, since no panel setting hides one
today. The panel work in 0.7.4 and 0.7.5 defines which fields the documents, document card and
trace panels display; the public trimming follows it then.

## Snapshots

A snapshot freezes the results of every panel at the moment it is made, in their native shape,
in Kalzit's database. Viewing one never runs a query.

### Create

`POST /orgs/{orgId}/dashboards/{dashboardId}/snapshots` (member; read on the dashboard, and
`dashboards:share` on it for an internal snapshot or `dashboards:public` plus the switches and
query rights for a public one)

```json
{
  "title": "Umsatz Oktober",
  "timeRange": { "from": 1801000000000, "to": 1801086400000 },
  "variables": { "region": "Nord" },
  "expiresAt": 1803000000000,
  "public": false
}
```

Only `timeRange` (absolute) is required. Panels run one after another as the caller; the
dashboard as shared and the answers together may be at most `sharing.snapshot_max_bytes`
(`422 sharing.snapshot_too_large` with `max`). `201 { snapshot: SnapshotSummary, token? }`; a
public snapshot's page is `/public/snapshots/{token}`.

### Read and manage

- `GET /orgs/{orgId}/snapshots/{snapshotId}` (read on the dashboard): `{ snapshot, dashboard:
  PublicDashboard, results: { [panelId]: QueryResponse } }`; counts a view. Revoked and expired
  ones are `404`.
- `GET /orgs/{orgId}/dashboards/{dashboardId}/snapshots` (read on the dashboard): the open
  snapshots of the dashboard.
- `GET /orgs/{orgId}/snapshots?mine=&dashboardId=` (member): as for links.
- `PATCH /orgs/{orgId}/snapshots/{snapshotId}` and `POST .../{snapshotId}/revoke`: as for links;
  someone who may read the dashboard but did not make the snapshot gets `403`.

`SnapshotSummary`: `id`, `dashboardId`, `dashboardTitle`, `title`, `public`, `createdBy`,
`createdByName`, `createdAt`, `expiresAt`, `timeRange`, `sizeBytes`, `views`, `lastViewedAt`,
`revokedAt`, and `status`/`suspendedReason` for the creator and admins. Only public snapshots can
be suspended; internal ones are seen with the viewer's own read right.

`GET /public/snapshots/{token}`: `{ title, timeRange, createdAt, expiresAt, dashboard, results }`
after the same checks as a public link (query rights on the sources the results came from).

## Reasons

As in docs/api/datasources.md, "Reasons": `reason` and `params` next to `code`, translated by the
UI, with `message` as the English fallback.

| Reason | Params | When |
|---|---|---|
| `sharing.unavailable` | | `404 not_found`: a public token that does not work, for whatever reason |
| `sharing.rate_limited` | | `429 rate_limited`: too many public requests from the address or for the token |
| `sharing.public_off` | | `409 conflict`: public sharing is off for the server or the organization |
| `sharing.sources_forbidden` | | `403 forbidden`: the caller may not query every source of the dashboard's panels |
| `sharing.expiry_invalid` | `maxDays` | `expiresAt` not in the future or beyond the longest expiry |
| `sharing.window_invalid` | `min`, `max` | `maxWindowMs` outside 1 minute to the longest expiry |
| `sharing.range_invalid` | | the link's `timeRange` is not `now`, relative or ISO |
| `sharing.window_exceeded` | `maxWindowMs` | a visitor's range does not lie within the last `maxWindowMs` |
| `sharing.snapshot_too_large` | `max` | the snapshot would be larger than `sharing.snapshot_max_bytes` |
| `sharing.public_links_active` | `links` | `403 forbidden`: the save reaches active public links and the caller lacks `dashboards:public` |
| `sharing.revoked` | | `409 conflict`: the link or snapshot was revoked; revoking is final |
| `sharing.expired` | | `409 conflict`: the link or snapshot has expired |
