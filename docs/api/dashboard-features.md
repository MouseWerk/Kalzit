# API: dashboard model version 2, annotations, playlists and library panels

The routes and model parts that make dashboards more than a grid of panels, exactly as the server
implements them. General rules (docs/ARCHITECTURE.md, "API conventions", and
docs/api/settings-dashboards.md) apply: JSON in `camelCase`, ids are UUIDv7 strings, times are
Unix milliseconds, errors are `{"error": {"code", "message", "field"?}}`, unknown body fields and
query parameters are `422 validation`, lists are `Page<T>` (`limit` 1 to 200, default 50).

## Dashboard model, schemaVersion 2

Version 2 adds the parts below. Each is optional with an empty default; a version 1 model is
migrated by setting `schemaVersion` to 2 and nothing else (`dashboards/model.rs`, `v1_to_v2`).
Clients may keep sending version 1; the server stores and answers the current version.

```ts
interface DashboardModel {                       // in addition to version 1
  tags?: string[];                               // up to 20, 1 to 50 characters, no surrounding spaces,
                                                 // each once regardless of case
  rows?: Row[];                                  // up to 100, display order
  annotations?: AnnotationQuery[];               // up to 20
  links?: DashboardLink[];                       // up to 50
}
interface Row {
  id: string;                                    // 1 to 64 characters, unique among rows
  title?: string;                                // up to 200 characters
  collapsed?: boolean;                           // as the editor saved it; viewers toggle without saving
  repeat?: { variable: string };                 // a variable with multi: true
}
interface Panel {                                // in addition to version 1
  rowId?: string;                                // a row of this dashboard; grid.y then counts from the row's top
  repeat?: { variable: string; direction: "horizontal" | "vertical"; maxPerRow?: number };  // 1 to 24
  timeFrom?: string;                             // relative range of its own: "now-24h", "now-7d/d"
  timeShift?: string;                            // 1 to 5 digits and a unit (s m h d w M y): "1d"
  links?: { title: string; url: string; newTab?: boolean }[];  // up to 20; data links
  libraryPanelId?: string;                       // shows that library panel; targets must be empty
  description?: string;                          // 1 to 1000 characters, line breaks allowed, not only white space
  transparent?: boolean;                         // drawn without the card's surface and border; true or absent
}
interface Target {                               // in addition to version 1
  hide?: boolean;                                // kept with the panel but not run; true or absent
}
interface Variable {                             // in addition to version 1
  multi?: boolean;                               // custom and query variables only
}
interface AnnotationQuery {
  id: string;                                    // unique among annotation queries
  name: string;                                  // 1 to 200 characters
  datasourceId: string;
  query: unknown;
  enabled?: boolean;                             // default true
  color?: number;                                // 1 to 8, an entry of the chart palette
}
type DashboardLink =
  | { type: "dashboards"; tag: string; title?: string; newTab?: boolean }   // dashboards with that tag
  | { type: "url"; title: string; url: string; newTab?: boolean };
```

Panel titles and descriptions refuse invisible direction and format characters (bidi
embeddings, overrides and isolates, direction marks, the zero-width space, word joiners, the byte
order mark) and the line and paragraph separators U+2028 and U+2029, as appearance texts do.

`description` and `transparent` came with version 0.1.0's edit mode. Models are read with unknown
fields refused, so a server from before them refuses a dashboard that uses them: returning to such
a version needs the database backup taken with the update, or those panels saved without them
first.

Rules:

- A repeat must name a variable with `multi: true`. A panel inside a repeated row cannot repeat
  on its own.
- **Link addresses** (`links[].url` of the dashboard and of panels) must start with `http://`,
  `https://`, `mailto:` or `/` (a path on this server, not `//host`), written out: no spaces
  before it, no variable in the scheme. `javascript:`, `data:`, `vbscript:` and every other
  scheme are refused. Variables (`${name}`) may appear after the scheme; the browser fills them in
  and checks the result again before it shows the link.
- Annotation queries are stored queries: saving checks `datasources:query` on the data source of
  every new or changed one, as for panel targets.
- A new `libraryPanelId` (one the stored version did not have) must name a library panel of the
  organization that the caller may read; otherwise `422 validation` on `model` ("library panel
  ... does not exist"); one in a trashed folder counts as missing. Keeping an existing reference
  needs no access to it. A save that adds references takes the organization's lock first and
  checks them again inside its transaction, as a library panel's delete takes the same lock
  before it counts the uses, so a reference never outlives the panel it names.
- A panel with `libraryPanelId` is a slot: it holds the place (`id`, `grid`, `rowId`, `repeat`)
  and, for readability, `type` and `title`; `targets`, `transformations` and `links` must be
  empty (`422 validation` on `model`), since the library panel holds them.

`Dashboard` answers carry the library panels the model references:

```ts
interface Dashboard {                            // in addition to settings-dashboards.md
  libraryPanels: Record<string, { id: string; name: string; version: number; model: LibraryPanelModel }>;
}
interface DashboardSummary {                     // in addition
  tags: string[];
}
```

Reading the dashboard shows these library panels and runs their queries, whatever folder they
live in, as it runs the dashboard's own stored queries: whoever placed the panel there had read
access and shared it with the dashboard's readers. A library panel deleted since (only possible by
purging its folder) is missing from the map; the panel route then answers `404 not_found`.

`GET /orgs/{orgId}/dashboards?tag=` lists dashboards with that tag (any case).

### `POST /orgs/{orgId}/dashboards/validate`

Any member. Body `{"model": unknown}`. Checks the model as a save would (migrations, rules, size)
and answers `{"model": DashboardModel}` as it would be stored; `422 validation` field `model`
otherwise. Data sources and library panels are checked on save, where the caller's rights count.

## Annotations

```ts
interface Annotation {
  id: string;
  dashboardId: string;
  panelId: string | null;          // null: shown on every time panel of the dashboard
  time: number;
  timeEnd: number | null;          // set for a span
  text: string;                    // 1 to 2000 characters, line breaks allowed
  tags: string[];                  // as dashboard tags
  version: number;
  createdBy: string | null;
  createdAt: number;
  updatedBy: string | null;
  updatedAt: number;
}
```

Reading needs `dashboards:read` on the dashboard. Writing needs read access and either the
org-wide `annotations:write` or `dashboards:write` on the dashboard (a grant counts). A dashboard
the caller cannot see is `404 not_found` on every route; a trashed one is readable, and writes
answer `409 conflict`. Events are recorded on the dashboard (`resource_type` `dashboard`,
actions `annotation.created`, `annotation.updated`, `annotation.deleted`, summary
`{"annotationId"}`), so the audit view hides them with a restricted dashboard. Purging the
dashboard deletes its annotations.

### `GET /orgs/{orgId}/dashboards/{dashboardId}/annotations?from=&to=`

`from` and `to` are required (a valid range, else `422 validation`). `Page<Annotation>` of the
annotations overlapping the range, oldest first (`time`, then `id`).

### `POST /orgs/{orgId}/dashboards/{dashboardId}/annotations`

Body `{"time", "timeEnd"?, "text", "tags"?, "panelId"?}`. Answers `201` with the `Annotation`.
`422 validation` with field `time`, `timeEnd` (before `time`), `text`, `tags` or `panelId` (not a
panel of the dashboard's current version). Create, change and delete take the organization's
lock and check inside their transaction that the dashboard still exists outside the trash.

### `PATCH /orgs/{orgId}/dashboards/{dashboardId}/annotations/{annotationId}`

Body `{"version", "time"?, "timeEnd"?, "text"?, "tags"?}`; `"timeEnd": null` makes it a point in
time. `409 version_conflict` with `current: Annotation`.

### `DELETE /orgs/{orgId}/dashboards/{dashboardId}/annotations/{annotationId}`

`204`; deleted for good.

### `POST /orgs/{orgId}/dashboards/{dashboardId}/annotation-queries/{queryId}/query`

Runs one stored annotation query, with the access and variable rules of the panel route
(docs/api/datasources.md). Body `{"timeRange", "variables"?}`; answers `QueryResponse` with the
outcome under the query's `id`. An unknown query id is `404 not_found`. The UI reads a frame's
first time field as the time, a field named `timeEnd` as the end, `text` (else the first text
field) as the text and `tags` as tags; nothing is converted on the server.

## Playlists

```ts
type PlaylistItem = { type: "dashboard"; dashboardId: string } | { type: "tag"; tag: string };
interface Playlist {
  id: string;
  name: string;                    // 1 to 100 characters
  intervalSeconds: number;         // 10 to 86400
  items: PlaylistItem[];           // up to 100
  version: number;
  createdAt: number;
  updatedBy: string | null;
  updatedAt: number;
}
```

Reading and playing need org-wide `dashboards:read`, changing needs `dashboards:write`. A
playlist never names a dashboard to someone who may not read it: entries for such dashboards are
left out of every answer, and kept at their positions when the caller saves. Entries naming a
purged dashboard are dropped on the next save. The limit of 100 counts the kept entries too.
Naming a dashboard the caller cannot read is `422 validation` field `items`. Audited as
`playlist.created`, `playlist.updated`, `playlist.deleted`.

| Route | |
|---|---|
| `GET /orgs/{orgId}/playlists` | `Page<Playlist>` by name |
| `POST /orgs/{orgId}/playlists` | `{"name", "intervalSeconds", "items"?}`, `201` |
| `GET /orgs/{orgId}/playlists/{playlistId}` | the `Playlist` |
| `PUT /orgs/{orgId}/playlists/{playlistId}` | `{"version", "name", "intervalSeconds", "items"}`; `409 version_conflict` |
| `DELETE /orgs/{orgId}/playlists/{playlistId}` | `204` |
| `GET /orgs/{orgId}/playlists/{playlistId}/play` | `{"intervalSeconds", "items": [{"id", "title"}]}`: the dashboards to show in order, tags expanded by title, each once, trashed and unreadable ones left out |

## Library panels

A panel kept once in a folder and shown by many dashboards. Rights follow the folder: reading
needs `dashboards:read` there, saving `dashboards:write`, deleting `dashboards:delete` (at the top
level the org-wide permission). A library panel in a folder the caller cannot see is
`404 not_found`, and lists leave it out. A library panel in a trashed folder is `404 not_found` on
every route and cannot be newly referenced until the folder is restored; dashboards that already
show it keep showing it.

```ts
interface LibraryPanelModel {                    // a panel without its place
  schemaVersion: number;                         // migrated on read like a dashboard
  type: string; title?: string; targets?: Target[]; transformations?: unknown[];
  options?: unknown; fieldConfig?: unknown; links?: PanelLink[]; timeFrom?: string; timeShift?: string;
}
interface LibraryPanel {
  id: string;
  folderId: string | null;                       // null at the top level or when the folder is hidden
  name: string;                                  // 1 to 100 characters
  model: LibraryPanelModel;
  version: number;
  uses: number;                                  // dashboards showing it that the caller may read,
                                                 // trashed ones included; others are not counted
  createdAt: number; updatedAt: number; updatedBy: string | null;
  access: { write: boolean; delete: boolean };
}
```

`id`, `grid`, `rowId`, `repeat` and `libraryPanelId` in a library panel model are `422 validation`
(field `model`): the dashboard decides where the panel goes. Saving checks `datasources:query` on
the data sources of new or changed queries, as for dashboards. Creating runs the panel option
checks of a dashboard write, and saving runs them when `type`, `options` or `fieldConfig` differ
from the stored content, so a library panel stored before a rule tightened can still be renamed,
moved or get new queries: `422 validation` on `model`, reason `dashboards.panel_options` with
`panel` (its title, else the library panel name) and `detail` (paths start at `model`, as in
`model.fieldConfig.defaults.decimals`). Library panels keep no versions, so there is no restore.
Audited as
`library_panel.created`, `library_panel.saved`, `library_panel.deleted`.

| Route | |
|---|---|
| `GET /orgs/{orgId}/library-panels?folderId=&q=` | `dashboards:read`; `Page<LibraryPanel>` by name |
| `POST /orgs/{orgId}/library-panels` | `{"name", "folderId"?, "model"}`, `201` |
| `GET /orgs/{orgId}/library-panels/{libraryPanelId}` | the `LibraryPanel` |
| `PUT /orgs/{orgId}/library-panels/{libraryPanelId}` | `{"version", "name", "model", "folderId"?}`: every dashboard showing it shows the new content. Moving needs `dashboards:write` on the new folder, and across a restricted folder `folders:permissions` on both (between the open tree and team spaces edit rights on both sides; out of a team space only maintainers of its team and org admins). Into a team space only while no dashboard outside it shows the panel (`409 conflict`). `409 version_conflict` |
| `DELETE /orgs/{orgId}/library-panels/{libraryPanelId}` | `204`; `409 conflict` while a dashboard (trashed ones too) shows it |
| `GET /orgs/{orgId}/library-panels/{libraryPanelId}/uses` | `{"items": [{"id", "title", "deletedAt"}]}`: the dashboards showing it that the caller may read; others are neither listed nor counted |

Purging a folder deletes the library panels in it; dashboards elsewhere that showed one show it as
deleted.
