# Saved analyses API

A saved analysis is an Explore query kept under a name: its queries (each in its data source's own
form), the analysis steps and the chosen visualization. Analyses live in folders like dashboards
and follow the same access rules; dashboards can show one as a linked panel. All routes are under
`/api/orgs/{orgId}`.

## Model, schemaVersion 1

```ts
interface AnalysisModel {
  schemaVersion: 1;
  title: string;                                 // 1 to 200 characters
  description?: string;                          // 1 to 1000 characters, line breaks allowed
  timeRange?: { from: string; to: string } | null;  // as a dashboard's; null or absent: follow the range in use
  targets: Target[];                             // 1 to 50, as a dashboard panel's targets (refId, datasourceId, query, hide?)
  steps?: Step[];                                // analysis steps (settings-dashboards.md, "Analysis steps")
  visualization: { type: string; options?: object; fieldConfig?: object };  // a panel type with its options
}
```

- The model is checked as one panel of a dashboard would be: the same rules for title, time range,
  targets and steps (a step reads the `refId` of a target of this analysis), and for the panel
  options and field options of `visualization`. Errors are `422 validation` on `model`, with the
  place named as `model.steps[0]`, `model.visualization.options...` and so on; refused
  visualization options carry the reason `dashboards.panel_options` with the analysis's title as
  `panel`. Options are checked only when the save changes them, as for dashboard panels.
- Models are versioned by `schemaVersion` and migrated on read, one step per version, as
  dashboards are (docs/ARCHITECTURE.md, "Dashboards"). A model from a newer Kalzit is refused.
- Saving needs `datasources:query` on the data source of every new or changed query
  (`403 forbidden`, naming the source); a source that does not exist in the organization is
  `422 validation`. Queries the stored version already had with the same source and text are not
  checked again, so someone who may write the analysis but not query its source can still rename
  it or change its steps and visualization.

## Access

Analyses follow the dashboards' rules (docs/api/access.md):

| Action | Needs, on the analysis |
|---|---|
| list, read, run, read the history and the uses | `analyses:read` |
| create (in the folder, or org-wide at the top level), save, move, restore a version, trash, restore | `analyses:write` |
| purge (gone for good, as for data sources the admin level) | `analyses:write` and `dashboards:share`: an `admin` grant on the analysis or its folder, or the org-wide right where it applies |
| change the owner team, manage grants | `dashboards:share` (and `analyses:write` for the owner) |

- Folder grants carry `analyses:read` (`view`) and `analyses:write` (`edit`) to the analyses inside,
  and grants can be given on one analysis (`resourceType: "analysis"`, levels `view`, `edit`,
  `admin`). Restricted folders, team spaces and team ownership (`PUT .../owner`, team only) work
  as for dashboards: an analysis a team owns is edited only by that team and grants, a team-only
  one is seen only by its team, grants on it and org admins. Moving into or out of a restricted
  folder needs `folders:permissions` on both sides; out of a team space only maintainers of its
  team and org admins move it (audited `team_space.moved_out`).
- What the caller may not see answers `404 not_found`; what they see but may not do,
  `403 forbidden`.
- **Running.** As with a dashboard's stored queries, reading the analysis is what authorizes
  running its stored queries: viewers may open and run analyses shared with them, with the
  queries as stored. The data source's own query right is checked when a query is saved, not when
  it runs. Changing a query and running it is a free query (`POST /orgs/{orgId}/query`), which
  needs `datasources:query` of the caller; `mayQuery` in the answers tells whether the caller
  holds it on every source of the analysis.

## The analysis

```ts
interface Analysis {
  id: string;
  folderId: string | null;       // null at the top level, and when the caller cannot see the folder
  title: string;
  version: number;               // counts saves
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
  deletedAt: number | null;      // set while in the trash
  access: { write: boolean; delete: boolean; permissions: boolean };
  ownerTeam: { id: string; name: string } | null;
  teamOnly: boolean;
  datasourceIds: string[];       // the sources its queries use
  mayQuery: boolean;             // the caller holds datasources:query on all of them
  uses: number;                  // dashboards linking it that the caller may read (trashed ones too)
  model: AnalysisModel;          // not in list items
}
```

## Routes

| Route | Answer |
|---|---|
| `GET /analyses?folderId=&q=&trashed=&team=&datasourceId=&createdBy=&ownerTeamId=&sort=&limit=&cursor=` | `200 Page<Analysis>` without `model`. `q` matches part of the title in any case; `team` is a team context as for dashboards; `sort` is `title` (default, then id) or `updated` (newest change first, then id). Needs `analyses:read` org-wide |
| `POST /analyses` | `{"model", "folderId"?}`: `201` the analysis, version 1 |
| `GET /analyses/{analysisId}` | the analysis; one in the trash too |
| `PUT /analyses/{analysisId}` | `{"model", "version", "folderId"?}`: `200` the analysis with the next version. `version` is the one the caller started from; a newer stored one is `409 version_conflict` with the stored analysis as `current`. To overwrite, send again with `current.version`: that needs only the right to save, and the overwritten version stays in the history. `folderId` moves it (`null`: the top level); a folder hidden from the caller reads as `null`, and sending that back is no move. `409 conflict` while in the trash; `409`, reason `analysis.in_use`, for a move that a linking dashboard's audience does not allow (see "Linked panels") |
| `DELETE /analyses/{analysisId}` | `204`: to the trash. `409 conflict`, reason `analysis.in_use`, while a dashboard links it |
| `POST /analyses/{analysisId}/restore` | `200` the analysis; `409 conflict` while its folder is in the trash |
| `DELETE /analyses/{analysisId}/purge` | `204`: gone for good, with its history and grants; needs the admin level (see Access). `409 conflict` unless it is in the trash, and `409`, reason `analysis.in_use`, while a dashboard links it, also one in the trash (a folder's trash may have taken both along) |
| `PUT /analyses/{analysisId}/owner` | `{"ownerTeamId", "visibility": "shared" \| "team", "version"?}`, rules as for a dashboard's owner. Team only is refused (`409`, `analysis.in_use`) while dashboards link it |
| `GET /analyses/{analysisId}/uses` | `{"items": [{"id", "title", "deletedAt"}]}`: the dashboards linking it that the caller may read |
| `GET /analyses/{analysisId}/versions?limit=&cursor=` | `Page<{version, authorId, authorName, restoredFrom, createdAt}>`, newest first |
| `GET /analyses/{analysisId}/versions/{version}` | one version with its `model` |
| `POST /analyses/{analysisId}/versions/{version}/restore?expectedVersion=` | saves that version's model as a new version (it must pass today's rules, including the query right); `409 version_conflict` when `expectedVersion` is not the current one |
| `POST /analyses/{analysisId}/query` | runs the stored queries: body as a panel query (`timeRange`, `intervalMs`?, `maxDataPoints`?, `limit`?, `cursors`?); an analysis has no variables, so sending any is `422`. Answers `QueryResponse` by `refId`; the steps run in the browser. A trashed analysis is `404` |
| `POST /analyses/{analysisId}/distribution` | the field distribution of one stored query over its whole result, computed in the database (docs/api/datasources.md, "Field distribution"): body `PanelDistributionRequest` (`refId`, `timeRange`, `intervalMs`?, `path`, `top`?, `bins`?). Same rights as the query route (`analyses:read` on the analysis; the caller needs no right on the data source) and no variables (`422`). A `refId` the query route does not run (unknown, or hidden without a step reading it) and a trashed analysis are `404`; a source that cannot count in the database is `422 query_rejected` with `distribution.unsupported`. Answers `FieldDistribution` |

The history keeps every save; how many versions are kept per analysis follows the dashboards'
setting `dashboards.version_retention` (0: all).

## Linked panels

A dashboard panel can show an analysis: `analysisId` on the panel (dashboard model version 2,
docs/api/dashboard-features.md), as `libraryPanelId` shows a library panel. Started from an
analysis, a panel stays linked unless it is added as a copy (then it holds the queries itself).

- The panel is a slot: `targets` and `transformations` must be empty, and a panel links a library
  panel or an analysis, not both (`422 validation` on `model`). The analysis's current queries,
  steps and visualization are what the panel shows; a change of the analysis shows in every
  dashboard that links it.
- A new link (one the stored version did not have) needs `analyses:read` on the analysis, which
  must exist and be outside the trash (`422 validation` on `model`, "analysis ... does not
  exist"), and `datasources:query` on its sources: its queries count as the dashboard's own.
- **Audience.** A dashboard shows the analysis to all its readers, so it may link only an
  analysis whose audience is not narrower than its own: never a team-only analysis, and one in a
  restricted folder or team space only from a dashboard that the same restricted folder governs.
  Open analyses can be linked anywhere. Otherwise `403 forbidden`, for everyone, org admins
  included. The rule is checked for new links, and for all links when the dashboard moves.
- Viewers of the dashboard run the linked queries under the dashboard's stored-query rule
  (`POST /dashboards/{dashboardId}/panels/{panelId}/query`, and the panel export); they need no
  access to the analysis itself. The queries run with the dashboard's time range and the
  dashboard's variables, as the dashboard's own queries do; the analysis's own time range is not
  used there. Since variables shape what a query reads, the query right on the analysis's sources
  is checked when the dashboard is saved with a new link or with changed variables, as for its own
  queries, and when the analysis's queries change. The dashboard's answer carries the linked
  analyses: `analyses: Record<string, {id, title, version, model}>`.
- While any dashboard links an analysis (dashboards in the trash count, they can come back):
  `409 conflict`, reason `analysis.in_use`, with `dashboards` the number of those dashboards the
  caller may read, when the analysis would go to the trash or be purged, become team only, or move
  where the audience rule no longer holds for a linking dashboard (into a restricted folder or
  team space that does not govern it); and when a folder holding it would be trashed, purged,
  restricted (also made a team space or team only) or moved under another restricted folder or
  into a team space while a dashboard outside that folder links it. Removing the link from the
  dashboards, or purging them, frees it.

## Audit

`analysis.created`, `analysis.updated` (`{version, moved}`, or `{version, restoredFrom}` for a
restored version), `analysis.deleted` (to the trash), `analysis.restored`, `analysis.purged`,
`analysis.owner_changed` (`{from, to, visibility}`), and `team_space.moved_out` for a move out of a
team space. Summaries hold no query text. Events about analyses the viewer of the audit log cannot
see are left out, as for dashboards, also after a restricted analysis is purged. Reading and
running leave no entry.
