# Access API: members, teams, roles, grants, administration, self service

The routes of organizations' access model, the server administration of accounts and
organizations, and the signed-in user's own account. Everything here is implemented in
`server/src/routes/{members,teams,roles,grants,admin_users,admin_orgs,me}.rs`; the rules behind it
are in `server/src/authz.rs` and `docs/ARCHITECTURE.md` ("Authorization").

## Conventions

- All paths are under `/api`. JSON bodies, `camelCase`, ids are UUIDv7 strings, times Unix
  milliseconds. Request bodies reject unknown fields (`validation`).
- Errors: `{"error": {"code", "message", "field"?}}`. `field` names the request field (JSON name)
  for `validation` errors and for the `conflict` errors listed with a field below.
- Access is checked before the handler (and before the body is read):
  - no session: `401 unauthenticated`;
  - `/orgs/{orgId}/...` when the caller is not a member of that organization (or `orgId` is not
    a canonical UUID): `404 not_found`;
  - a missing permission named in the table: `403 forbidden`;
  - `/admin/...` for a signed-in non-admin: `403 forbidden`.
- Lists answer `Page<T>`: `{"items": T[], "nextCursor": string | null}`. Query `?limit=` (1 to
  200, default 50) and `?cursor=` (the `nextCursor` of the previous page). Other values are
  `422 validation` with `field` `limit` or `cursor`; unknown query parameters are
  `422 validation`. Order is newest first unless the route says otherwise.
- Every change writes an audit entry in the same transaction (action listed per route). Audit
  summaries hold ids, role keys, levels and changed field names, never emails, names or passwords.
- `422 validation` is the status of `validation`; `409 conflict` the status of `conflict`.

### Role keys

A member's org role and a team's roles are role keys: a built-in name (`owner`, `admin`,
`editor`, `viewer`) or the `id` of a custom role of the same organization. `GET .../roles` lists
them all with their names and permissions.

### The guards

- **Nobody hands out what they do not hold.** Creating or changing a custom role, assigning a
  role, giving a team roles, adding someone to a team (who then gets the team's roles) and creating
  a grant need the caller to hold every permission given. Changes that take rights away (demoting
  or removing a member, removing a team member, deleting a team, changing or deleting a custom
  role, lowering or deleting a grant) also need the caller to hold what is taken away, so nobody
  changes someone with more rights than themselves. Refused with `403 forbidden`; the message
  names the missing permissions.
- **An enabled owner remains.** The last enabled owner of an organization cannot be removed,
  demoted or disabled: `409 conflict` (disabled owners do not count). Owners can only be made by
  owners: they alone hold `org:delete`, which no custom role may contain.
- **The last active server admin** (admin and not disabled) cannot be disabled or lose the role:
  `409 conflict`.
- **Concurrent changes.** Changes within one organization run one after the other, so two equal
  requests at the same moment answer as if sent in sequence (never `500`).

## Members

### Member

```ts
interface Member {
  userId: string;
  email: string;
  name: string;
  role: string;      // role key
  joinedAt: number;
}
```

| Method and path | Access | Answer |
|---|---|---|
| `GET /orgs/{orgId}/members` | `users:read` | `200 Page<Member>`, newest member first |
| `POST /orgs/{orgId}/members` | `users:write` | `201 Member` |
| `PATCH /orgs/{orgId}/members/{userId}` | `users:write` | `200 Member` |
| `DELETE /orgs/{orgId}/members/{userId}` | `users:write` | `204` |

**`POST`** `{ "email": string, "role": string }` adds an existing account (any case and
surrounding spaces in the email are fine). Errors: `validation` `email` (not an address, or no
account has it), `validation` `role` (no such role key), `409 conflict` `email` (already a
member), `403` (role exceeds the caller's permissions). Audit `member.added`.

**`PATCH`** `{ "role": string }`. Errors: `404` (not a member), `validation` `role`, `403` (new or
current role exceeds the caller's permissions), `409 conflict` (last owner). Audit
`member.role_changed` (only when the role changes).

**`DELETE`** removes the membership, the member's team memberships in this organization and the
grants to them here; the account stays. The caller must hold what the member loses: their org
role, the roles of their teams here and the permissions of their grants. Errors: `404`, `403`,
`409 conflict` (last owner). Audit `member.removed`.

## Teams

### Team and TeamMember

```ts
interface Team {
  id: string;
  name: string;
  roles: string[];      // role keys, sorted; never "owner"
  memberCount: number;
  createdAt: number;
}

interface TeamMember {
  userId: string;
  email: string;
  name: string;
  role: "member" | "maintainer";
  addedAt: number;
}
```

| Method and path | Access | Answer |
|---|---|---|
| `GET /orgs/{orgId}/teams` | `teams:read` | `200 Page<Team>` |
| `POST /orgs/{orgId}/teams` | `teams:write` | `201 Team` |
| `GET /orgs/{orgId}/teams/{teamId}` | `teams:read` | `200 Team` |
| `PATCH /orgs/{orgId}/teams/{teamId}` | `teams:write` | `200 Team` |
| `DELETE /orgs/{orgId}/teams/{teamId}` | `teams:write` | `204` |
| `GET /orgs/{orgId}/teams/{teamId}/members` | `teams:read` | `200 Page<TeamMember>` |
| `PUT /orgs/{orgId}/teams/{teamId}/members/{userId}` | `teams:members` or maintainer of the team | `200 TeamMember` |
| `DELETE /orgs/{orgId}/teams/{teamId}/members/{userId}` | `teams:members` or maintainer of the team | `204` |
| `PUT /orgs/{orgId}/teams/{teamId}/roles` | `teams:write` | `200 Team` |

An unknown team id (or one of another organization) is `404` on every team route.

**`POST`** and **`PATCH`** `{ "name": string }` (trimmed, 1 to 100 characters, no control
characters). Errors: `validation` `name`, `409 conflict` `name` (name taken in the organization,
compared without regard to case, umlauts included).
Audit `team.created`, `team.renamed`.

**`DELETE`** `?transferTo=<teamId>|org` removes the team, its memberships, its roles, the grants to
it and the team contexts that named it. Needs the caller to hold the team's roles. What the team
owns (team spaces, folders and dashboards; see "Team spaces") is handed over in the same change:
to another team of the organization, or with `org` to the organization (owner cleared; team-only
content stays team only, so only org admins and grants reach it). A team that owns anything and a
call without `transferTo` answer `409 conflict` field `transferTo`; `transferTo` naming the team
itself or an unknown team is `422 validation` field `transferTo`. Audit `team.deleted` with
`transferTo` and `handedOver` (how many folders and dashboards changed hands).

**`PUT .../members/{userId}`** `{ "role"?: "member" | "maintainer" }` (default `member`) adds the
member or changes their team role; repeating it changes nothing. The route is declared for
every member (`OrgMember`) and the handler requires `teams:members` or being a maintainer of this
team (`403` otherwise). The caller must hold the team's roles. Errors: `404` (team, or the user is
not a member of the organization), `validation` `role`, `403`. Audit `team.member_added`,
`team.member_changed`.

**`DELETE .../members/{userId}`** Errors: `404` (team, or not in the team), `403`. Audit
`team.member_removed`.

**`PUT .../roles`** `{ "roles": string[] }` replaces the team's roles (duplicates collapse, at most
20). The caller must hold both the old and the new roles' permissions. Errors: `validation` `roles`
(unknown key, `owner`, more than 20), `403`. Audit `team.roles_changed`.

## Team spaces

A team space is a restricted folder at the top level that a team owns (`ownerTeamId` on the
folder, `teamSpace: true` in folder answers). Its members get their roles inside it: their org
role plus the team's roles (`PUT .../roles`), and maintainers of the team also `folders:permissions`
and `dashboards:share` there, so they share the space themselves. An editor of the team edits, a
viewer reads. Everyone else sees nothing of the space, its subfolders and dashboards (`404` on
every route, left out of lists, search, the start page lists and the audit view, as for any
restricted folder) until the team or an admin shares the space or a part of it with a grant
(`view` or `edit`, to a team, a person or a role; see "Grants"). Dashboards and library panels
inside follow their folder.

Created with `POST /orgs/{orgId}/folders` `{"name", "ownerTeamId"}` (no `parentId`): by a
maintainer of the team, or by an org admin (`folders:permissions` org-wide). Audit
`folder.created` with `ownerTeamId`. A team space stays at the top level (`422 validation`
`parentId` on a move) and team only: only org admins open it up (`PATCH` `restricted: false`) or
change its owner.

Adding a member to a team that owns team spaces or team-only content is for maintainers of that
team and org admins (`403` for anyone else, also with `teams:members`); an org admin who is not a
maintainer of it is recorded with `team_space.admin_access` (`summary.action`
`team.member_added`).

### Team ownership

A team can also own single folders and dashboards inside shared folders
(`PUT /orgs/{orgId}/folders/{folderId}/owner`, `PUT /orgs/{orgId}/dashboards/{dashboardId}/owner`,
body `{"ownerTeamId": string | null, "visibility": "shared" | "team", "version"?: number}`; a
`version` that is no longer the item's is `409 version_conflict` with `current`):

- `shared`: everyone with access to the place reads it; only members of the owner team (with their
  role there) and grants change, delete, share or annotate it. Members outside the team lose
  `folders:write`, `folders:permissions`, `dashboards:write`, `dashboards:delete`,
  `dashboards:share` and `annotations:write` from their role on it; org admins keep them.
- `team`: team only. For a folder this is `restricted: true`; for a dashboard `teamOnly: true`:
  the dashboard governs itself like a restricted folder, so only the team, grants on the dashboard
  and org admins see it.

Ownership passes down: a dashboard in a team-owned folder belongs to that team unless it has an
owner of its own; the nearest owner decides who edits. Membership in a team that owns a folder
further up still lets its members see the content. `ownerTeamId: null` hands the item to the
organization. Every rule is checked again under the organization's lock (`403` unless noted):

- The caller may edit the item and manage its access: `folders:write` and `folders:permissions` on
  a folder, `dashboards:write` and `dashboards:share` on a dashboard.
- Content their own team does not own (open content, or another team's) needs
  `folders:permissions` on its folder: an org admin, or an `admin` grant there. Team editors change
  owner and visibility only of what their team already owns.
- A team space's owner and visibility are changed by org admins only.
- Inside a team space or another restricted folder, content belongs to that folder's team (or to
  nobody); only org admins hand it to another team, whose members would otherwise gain their roles
  there from someone who may not hand them out.
- The new owner team must be one of the caller's teams unless they are an org admin (`422
  validation` `ownerTeamId` for an unknown team).

Whoever makes an item team only without belonging to its team keeps a grant on it, at the
strongest level within what they held there before (never more). Audit `folder.owner_changed`,
`dashboard.owner_changed`.

Moves: moving a folder or dashboard between the open tree and a team space, or between two team
spaces, needs edit rights on both sides (`dashboards:write` on the dashboard and on the target
folder, `folders:write` for folders); moves into or out of other restricted folders still need
`folders:permissions` on both sides. Moving content out of a team space is for maintainers of the
space's team and org admins only; team editors move within the space. A folder moved out takes
content another team owns along only when the caller is a maintainer of that team or an org admin.
Each such move writes `team_space.moved_out` on the item with `spaceId`, `teamId`, `from` and
`to`. Library panels follow the same rules, and move into a team space only while no dashboard
outside that space shows them (`409 conflict`).

### Admins and the audit log

Org admins (members whose org-wide permissions include `folders:permissions`) see and manage every
team space and team-only item, for example when a team is dissolved. Every access whose permission
an admin would not hold without that reach into restricted and team content writes the audit
event `team_space.admin_access` on the resource reached, whatever other grants they hold there:
opening another team's space, a team-only dashboard or a restricted folder (also a space handed to
the organization), changing another team's shared content, saving, moving, trashing, exporting,
the versions, the access dialog, "why can I". The summary names the `permission`, the nearest
owner team in the chain (`teamId`) and the governing restricted resource (`governingType`,
`governingId`). Repeated accesses to the same resource by the same admin are written once per ten
minutes, since opening a dashboard checks access for every panel query. Lists and the folder tree
do not write it.

### Team context

`GET /orgs/{orgId}/team-context` and `PUT /orgs/{orgId}/team-context` (`{"teamId": string |
null}`), access `OrgMember`: the team a member works in, stored per user and organization.

```ts
interface TeamContext {
  teamId: string | null;            // the active team; null: all areas
  teams: {
    id: string;
    name: string;
    member: boolean;                // org admins also get teams they are not in
    maintainer: boolean;
    spaces: { id: string; name: string }[];   // the team's spaces the caller sees, by name
  }[];                              // the caller's teams first, then (org admins) the others
  defaultFolderId: string | null;   // where "New dashboard" puts a dashboard
}
```

The caller may pick their own teams, and org admins every team; another team is `422 validation`
`teamId`. Without a stored choice, or when the stored team is no longer one the caller may pick,
the first of their own teams is active (`null` without a team). `defaultFolderId` is the active
team's first space when the organization setting `dashboards.new_in_team_space` is on and the
caller may create dashboards there.

The team context is a view, not a right. Lists take it as `?team=<teamId>`: `GET .../folders`,
`GET .../dashboards`, `GET .../stars`, `GET .../recents` and `GET .../pins`. They then leave out
what lies in other teams' spaces (restricted top-level folders a team owns), unless a grant to
the team, to the caller in person or to one of their roles reaches it (on the space, a folder in
it, or the dashboard). The team is checked against the caller's teams on every call (`422
validation` `team`).

## Roles

```ts
interface Role {
  id: string;              // built-in name or custom role id: the role key
  name: string;            // built-in roles: the key; translate by id in the UI
  description: string;     // "" for built-in roles
  builtin: boolean;
  permissions: Permission[];   // catalog order
  createdAt: number | null;    // null for built-in roles
}
```

| Method and path | Access | Answer |
|---|---|---|
| `GET /orgs/{orgId}/roles` | `roles:read` | `200 Page<Role>`, one page: built-ins (owner, admin, editor, viewer), then custom roles by name; `nextCursor` is always `null` |
| `POST /orgs/{orgId}/roles` | `roles:write` | `201 Role` |
| `PATCH /orgs/{orgId}/roles/{roleId}` | `roles:write` | `200 Role` |
| `DELETE /orgs/{orgId}/roles/{roleId}` | `roles:write` | `204` |

An organization has at most 100 custom roles.

**`POST`** `{ "name": string, "description"?: string, "permissions": Permission[] }`. Name as for
teams, and not a built-in role name in any case; description at most 500 characters, line breaks
allowed. Errors: `validation` `name` / `description` / `permissions` (unknown permission, or
`org:delete`, which belongs to owners only), `409 conflict` `name` (taken, compared without regard
to case), `409 conflict` (100 custom roles), `403` (permissions the caller does not hold). Audit
`role.created`.

**`PATCH`** `{ "name"?, "description"?, "permissions"? }` (each optional; `permissions` replaces
the set). Errors: `403` (a built-in role id, or the current or new permissions exceed the
caller's), `404` (unknown id), validation and name conflicts as for `POST`. Audit `role.updated`
with the changed field names.

**`DELETE`** removes the role, its use as a team role and the grants to it. Errors: `403`
(built-in, or more permissions than the caller), `404`, `409 conflict` (members have it as their
org role; give them another role first). Audit `role.deleted`.

## Grants

A grant gives a subject a level on one folder, dashboard or data source. One grant per subject and
resource. Levels include the ones before them:

| Resource | Level | Permissions on the resource |
|---|---|---|
| folder | `view` | `folders:read`, `dashboards:read` |
| folder | `edit` | + `folders:write`, `dashboards:write`, `dashboards:delete` |
| folder | `admin` | + `folders:permissions`, `dashboards:share` |
| dashboard | `view` | `dashboards:read` |
| dashboard | `edit` | + `dashboards:write`, `dashboards:delete` |
| dashboard | `admin` | + `dashboards:share` |
| datasource | `query` | `datasources:query`, `datasources:read` |
| datasource | `edit` | + `datasources:write` |
| datasource | `admin` | + `datasources:permissions` |

Folder grants apply to the folder's subfolders and dashboards. Subjects: `user` (a member's user
id), `team` (a team id), `role` (a role key: every member holding that role, as org role or
through a team). A member's permissions on a resource are their org-wide permissions plus their
grants on it. Grants extend a role: the folder and dashboard routes are open to every member and
check the permission on the resource, so a viewer with an `edit` grant on a folder saves, creates
and deletes dashboards there (`docs/api/settings-dashboards.md`, "Access to folders and
dashboards"); the top level, outside every folder, still takes the org-wide permission. The
folder and dashboard answers carry `access` (`write`, `delete`, `permissions`) computed this way.
Grants on a resource are deleted when it is purged; a grant created while its resource is being
purged answers `404`.

Restricted folders: the nearest restricted folder above a resource (or the resource itself)
governs it. There the org-wide permissions count only for members holding `folders:permissions`
(admins and owners); everyone else needs a grant on that folder or below it, and without one the
folder and what is inside it are `404`. Grants on folders above it do not reach into it, so a
restricted subfolder narrows access: with restricted "Finanzen" (Finance team may view) holding
restricted "Gehaelter" (HR team may view), Finance members see "Finanzen" but not "Gehaelter".

```ts
interface Grant {
  id: string;
  subjectType: "user" | "team" | "role";
  subjectId: string;
  subjectName: string;     // user name, team name, custom role name, or the built-in key
  resourceType: "folder" | "dashboard" | "datasource";
  resourceId: string;
  level: string;
  createdAt: number;
}
```

| Method and path | Access | Answer |
|---|---|---|
| `GET /orgs/{orgId}/grants?resourceType=&resourceId=` | member; on the resource: `folders:permissions`, `dashboards:share` or `datasources:permissions` | `200 Page<Grant>`: the grants on exactly this resource (inherited ones are listed on their folder) |
| `POST /orgs/{orgId}/grants` | as `GET`, for the resource in the body | `201 Grant` (created) or `200 Grant` (level of the existing grant changed or unchanged) |
| `DELETE /orgs/{orgId}/grants/{grantId}` | as `GET`, for the grant's resource | `204` |

The managing permission may come from the role or from an `admin` grant on the resource (or a
folder above it).

Errors common to all three: `404` (the resource or grant does not exist in the organization, the
id is not a UUID, or the caller may not see the resource), `403` (sees it but lacks the managing
permission).

**`GET`**: `validation` `resourceType` (missing or not one of the three), `validation`
`resourceId` (missing), paging errors.

**`POST`** `{ "subjectType", "subjectId", "resourceType", "resourceId", "level" }`. Errors:
`validation` `resourceType`, `validation` `level` (not a level of that resource type),
`validation` `subjectType`, `validation` `subjectId` (no such member, team or role here), `403`
(the level's permissions, or those of the level being replaced, exceed the caller's on the
resource). Audit `grant.created`, `grant.changed` (level changed).

**`DELETE`** Errors: `404`, `403` (as above, for the grant's level). Audit `grant.deleted`.

## Explain

`GET /orgs/{orgId}/explain?permission=&resourceType=&resourceId=`, access `OrgMember`. Why the
caller holds `permission`, org-wide or on one resource (`resourceType` and `resourceId` together,
or neither).

```ts
interface Explanation {
  permission: Permission;
  allowed: boolean;          // sources is not empty
  sources: GrantSource[];
}

type GrantSource =
  | { kind: "orgRole"; role: string }                                    // built-in org role
  | { kind: "customRole"; roleId: string; roleName: string }             // custom org role
  | { kind: "teamRole"; teamId: string; teamName: string; role: string; roleName: string }
  | { kind: "teamOwner"; teamId: string; teamName: string }               // membership in the
                                                                          // owner team
  | { kind: "grant"; grantId: string; subjectType: string; subjectId: string;
      resourceType: string; resourceId: string; level: string };          // may be on a folder above
```

Order: the org role, team roles (by team name), then grants. With a resource in a restricted
folder, role sources are listed only for members holding `folders:permissions`. Errors:
`validation` `permission` (missing or not in the catalog), `validation` `resourceType` /
`resourceId` (one without the other, or an unknown type), `404` (the caller may not see the
resource, or it does not exist).

## Server administration

Every `/admin/...` route needs a server admin. Server admins are not members of every
organization.

```ts
interface AdminUser {
  id: string;
  email: string;
  name: string;
  isServerAdmin: boolean;
  disabled: boolean;
  createdAt: number;
}

interface AdminOrg {
  id: string;
  name: string;
  memberCount: number;
  createdAt: number;
}
```

| Method and path | Answer |
|---|---|
| `GET /admin/users` | `200 Page<AdminUser>`, newest first |
| `POST /admin/users` | `201 AdminUser` |
| `PATCH /admin/users/{userId}` | `200 AdminUser` |
| `GET /admin/orgs` | `200 Page<AdminOrg>`, newest first |
| `POST /admin/orgs` | `201 AdminOrg` |
| `PATCH /admin/orgs/{orgId}` | `200 AdminOrg` |

**`POST /admin/users`** `{ "name", "email", "password", "isServerAdmin"?: boolean }` (default
`false`). Password: 12 to 1024 characters. Errors: `validation` `name` / `email` / `password`,
`409 conflict` `email` (taken). Audit `user.created`.

**`PATCH /admin/users/{userId}`** `{ "name"?, "disabled"?, "isServerAdmin"?, "password"? }`.
Disabling ends all the account's sessions at once. A new password ends the account's sessions
(when admins set their own, except the session of this request). Errors: `404`, validation of
`name` / `password`, `409 conflict` (last active server admin, or disabling the last enabled
owner of an organization). Audit `user.updated` (fields
`name`, `isServerAdmin`, `password`), `user.disabled`, `user.enabled`.

**`POST /admin/orgs`** `{ "name", "ownerUserId" }` creates the organization with that account as
its owner. Errors: `validation` `name`, `validation` `ownerUserId` (no such account, or it is disabled). Audit
`org.created`.

**`PATCH /admin/orgs/{orgId}`** `{ "name" }`. Errors: `404`, `validation` `name`. Audit
`org.renamed`.

## Self service

For any signed-in user (`Authenticated`).

```ts
interface SessionView {
  id: string;          // opaque; not the token or its hash
  createdAt: number;
  lastSeenAt: number;  // updated at most every 5 minutes
  expiresAt: number;
  current: boolean;    // the session of this request
}
```

| Method and path | Answer |
|---|---|
| `PATCH /me` | `200 Me` (as `GET /me`) |
| `POST /me/password` | `204` |
| `GET /me/sessions` | `200 Page<SessionView>`, newest first; sessions past their lifetime or idle limit are left out |
| `DELETE /me/sessions/{sessionId}` | `204` |
| `POST /me/sessions/revoke-others` | `200 { "revoked": number }` |

**`PATCH /me`** `{ "name" }`. Errors: `validation` `name`. Audit `user.updated`.

**`POST /me/password`** `{ "current", "new" }`. Ends every other session of the account; this one
stays. Attempts count against a budget of their own and against the account email's sign-in
budget (failed sign-ins and failed checks here add up); once either is used up the answer is
`429 rate_limited`. A correct password resets both. Of two changes at the same moment with the same
current password, the second answers `validation` `current`. Errors: `validation` `current` (not correct), `validation` `new`
(policy), `429 rate_limited`. Audit `user.password_changed`.

**`DELETE /me/sessions/{sessionId}`** ends one of the caller's sessions (also the current one,
which signs this browser out). Errors: `404` (unknown, or another user's). Audit
`auth.session_ended`.

**`POST /me/sessions/revoke-others`** (no body needed) ends every session but this one. Audit
`auth.sessions_revoked`.
