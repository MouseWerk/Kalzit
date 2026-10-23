# Shell API: search, stars, recently viewed dashboards, preferences

What the app shell needs per user: the command palette's search, starred and recently viewed
dashboards for the start page, and personal preferences. Implemented in
`server/src/routes/{home,preferences}.rs`, stored by migration 0008. The conventions of
`docs/api/access.md` ("Conventions") apply: paths under `/api`, `Page<T>` lists with `limit` and
`cursor`, `422 validation` with `field`, unknown fields and query parameters refused.

## Who sees what

Every answer is decided by the caller's access at the time of the request (role, team roles and
grants, the rule of `authz::check_resource`):

- a dashboard needs `dashboards:read` on it, a folder `folders:read`, a data source
  `datasources:read` (a `query` grant includes reading);
- inside a restricted folder only grants there count, unless the caller holds
  `folders:permissions`;
- a grant on a dashboard alone shows that dashboard with `folderId: null` and an empty `path`;
  the folder above stays unnamed. `path` stops at the first folder the caller cannot see;
- trashed folders, dashboards and data sources are left out.

A star or view of a dashboard the caller can no longer see stays stored but is left out of every
answer; it comes back if access returns. Purging a dashboard deletes its stars and views.

## Search

`GET /orgs/{orgId}/search?q=&kind=&limit=&cursor=` (member) answers `200 Page<SearchHit>`.

```ts
interface SearchHit {
  kind: "dashboard" | "folder" | "datasource";
  id: string;
  title: string;
  folderId: string | null;   // where a dashboard or folder lives, as the caller sees it
  path: string[];            // folder names from the top down to that folder
  datasourceKind?: string;   // data sources only, such as "postgres"
  score: number;             // higher is a better match
}
```

- `q` (at most 100 characters, no control characters) matches when its letters appear in the
  title in that order, in any case (Unicode lower case). `%`, `_` and `\` are letters, not
  wildcards. Without `q`, everything the caller sees.
- Ranking: the whole title (1000), a prefix (900 minus the extra length), a substring at a word
  start (800 minus its position), any substring (700 minus its position), the letters in order
  (at most 599, more for adjacent letters and word starts, less for gaps). Ties: dashboards,
  folders, data sources, then title and id. The UI ranks its own entries (sections, actions) with
  the same rules (`ui/src/shell/fuzzy.ts`).
- `kind` limits to one kind; anything else is `validation` `kind`.
- At most 10,000 dashboards and 10,000 data sources are considered per request. Dashboards in
  folders hidden from the caller are left out by the database before that limit, so hidden content
  never takes the place of visible matches; folders are read in full. An organization with more
  matching dashboards, or more data sources, gets the best matches among the first 10,000 by id.

## Stars

| Method and path | Answer |
|---|---|
| `GET /orgs/{orgId}/stars` | `200 Page<DashboardEntry>`, by title |
| `GET /orgs/{orgId}/dashboards/{dashboardId}/star` | `200 { "starred": boolean }` |
| `PUT /orgs/{orgId}/dashboards/{dashboardId}/star` | `204` |
| `DELETE /orgs/{orgId}/dashboards/{dashboardId}/star` | `204` |

```ts
interface DashboardEntry {
  id: string;
  title: string;
  folderId: string | null;
  path: string[];
  at: number;   // when it was starred, or last opened
}
```

`GET` and `PUT` answer `404` for a dashboard the caller cannot read. `PUT` again changes nothing;
a dashboard in the trash is `409 conflict`; at most 1000 stars per user and organization
(`validation`). `DELETE` removes the caller's own star and answers `204` whether or not there was
one. Stars are personal and not audited.

## Recently viewed

| Method and path | Answer |
|---|---|
| `POST /orgs/{orgId}/dashboards/{dashboardId}/views` | `204` |
| `GET /orgs/{orgId}/recents` | `200 Page<DashboardEntry>`, last opened first |

The UI records a view when a dashboard page opens (no body needed). `404` for a dashboard the
caller cannot read. The newest 50 per user and organization are kept. Not audited.

## Preferences

For any signed-in user (`Authenticated`).

```ts
interface Preferences {
  language: "de" | "en" | null;                          // null: see below
  theme: "system" | "light" | "dark" | "contrast" | null; // null: see below
  timeZone: string | null;                                // IANA name; null: the browser's
  weekStart: "monday" | "sunday" | "saturday" | null;     // null: Monday (ISO 8601)
  startDashboard: { orgId: string; dashboardId: string; title: string } | null;
  defaults: { language: string; theme: string };          // appearance.default_language/theme
}
```

| Method and path | Answer |
|---|---|
| `GET /me/preferences` | `200 Preferences` |
| `PATCH /me/preferences` | `200 Preferences` |

**`PATCH /me/preferences`**: each field absent keeps it, `null` resets it, a value sets it.
`startDashboard` is sent as `{ "orgId", "dashboardId" }` and must be a dashboard the user can
open, not in the trash; another organization's, a hidden or an unknown dashboard are refused
alike. `timeZone` is checked for the shape of an IANA name only (`Europe/Berlin`, `UTC`); the
browser knows the zones. Errors: `validation` with `field` `language`, `theme`, `timeZone`,
`weekStart` or `startDashboard`. Audit `user.preferences_updated` with the changed field names.

**Language and theme in the browser.** The UI decides in this order:

1. the user's preference, when the server holds one;
2. otherwise an explicit choice made in this browser on the sign-in or setup page, before
   signing in;
3. otherwise the server's default (`defaults`), so `appearance.default_language` and
   `appearance.default_theme` apply to everyone who has chosen nothing.

What the browser merely applied (an earlier user's preferences, the browser's own language list)
is never a choice. A choice of step 2 is kept apart from the applied values, belongs to the first
account that signs in after it (or the one that made it), is saved as that account's preference
where it has none (one `PATCH`) and is then forgotten; signing out forgets it as well. So on a
shared browser one user's language or theme never becomes the next user's preference. When a
session ends, or another account signs in, the UI drops everything it cached for the previous
account (its preferences are also kept per account id), so nothing of it applies to the next one.
**Time zone and week start** apply to every time the UI shows or works with: lists, tables,
tooltips, chart axes, the time range of dashboards and Explore (`now/d`, `now/w` and typed times
are resolved on the wall clock of the chosen zone, also across a daylight saving change), and the
day filter of the audit log.
A start dashboard that was trashed, purged or is no longer readable answers `null` without being
removed. The UI opens it when the user enters Kalzit at `/`; the start page stays reachable from
the navigation.
