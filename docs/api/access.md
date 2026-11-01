# Access API: members, teams, roles, grants, administration, self service

The routes of organizations' access model, the server administration of accounts and
organizations, and the signed-in user's own account. Everything here is implemented in
`server/src/routes/{members,teams,roles,grants,admin_users,admin_orgs,me,setup,second_factor,security}.rs`; the rules behind it
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
- `429 rate_limited` always says how long to wait: the header `Retry-After: <seconds>` and the
  same number as `retryAfterSecs` in the error object
  (`{"error": {"code": "rate_limited", "message", "retryAfterSecs": 42}}`). It is the time until
  every budget that refused the attempt has a new window, in whole seconds rounded up, at least 1.
  This holds for sign-in, setup, the setup code check, `POST /me/password` and the connection
  test of unsaved data source settings.

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
  joinedBy: "invitation" | "creator" | "scim_owned" | "mapping" | "direct" | "legacy";
}
```

`joinedBy` (`org_members.joined_by`) records how the person joined: `invitation` (they accepted
an invitation), `creator` (they set up Kalzit with this organization, or a server admin made the
organization with them as its owner), `scim_owned` (an account this organization's SCIM made and
owns), `mapping` (a group mapping of an identity provider a server admin set up), `direct` (an
admin added the account, or SCIM linked an existing account that belonged to no organization;
service accounts too) or `legacy` (every membership from before 0.5.1). The organization's sign-in
rules, password sign-in off (`signin.local_password`, docs/api/sso.md) and its second factor
requirement (`security.two_factor_required`, "Second factor" below), bind a member only for
`invitation`, `creator`, `scim_owned` and `mapping`: the person's consent. They never bind a
`direct` or `legacy` member, for whom only the server's rules count. Accepting an invitation of an
organization one is already a member of turns the membership into `invitation`.

| Method and path | Access | Answer |
|---|---|---|
| `GET /orgs/{orgId}/members` | `users:read` | `200 Page<Member>`, newest member first |
| `POST /orgs/{orgId}/members` | `users:write` | `201 Member` |
| `PATCH /orgs/{orgId}/members/{userId}` | `users:write` | `200 Member` |
| `DELETE /orgs/{orgId}/members/{userId}` | `users:write` | `204` |

**`POST`** `{ "email": string, "role": string }` adds an existing account that belongs to no
organization yet (any case and surrounding spaces in the email are fine). A person who already
belongs to an organization joins another one only by accepting an invitation
(docs/api/mail.md, "Invitations"), so the person decides. The new membership is `direct`: this
organization's sign-in rules do not bind it. The account's row is locked before the
organization's, as on every way of joining, so two organizations cannot add one account at the
same time. Errors:
`validation` `email` (not an address, or no account has it), `validation` `role` (no such role
key), `409 conflict` `email` (already a member; reason `mail.email_unconfirmed` for an address
its owner has not confirmed; reason `members.invite_instead` for an account in another
organization), `403` (role exceeds the caller's permissions). Audit `member.added`.
Memberships from before 0.5.1 stay as they are (`legacy`); their members can leave on their own
(below).

**`PATCH`** `{ "role": string }`. Errors: `404` (not a member), `validation` `role`, `403` (new or
current role exceeds the caller's permissions), `409 conflict` (last owner). Audit
`member.role_changed` (only when the role changes).

**`DELETE`** removes the membership, the member's team memberships in this organization and the
grants to them here; the account stays. The caller must hold what the member loses: their org
role, the roles of their teams here and the permissions of their grants. Errors: `404`, `403`,
`409 conflict` (last owner). Audit `member.removed`. This organization's SCIM never adds the
person back (docs/api/scim.md, "Users").

### Leaving an organization

| Method and path | Access | Answer |
|---|---|---|
| `DELETE /me/orgs/{orgId}` | signed in (a session, never an API token) | `204` |

Everyone can leave an organization on their own; it ends the membership like `DELETE` above (team
memberships, grants and what the person kept there go with it, the account stays). It is not an
organization route, so no rule of that organization stands in the way: it works with any session
of the person, also while that organization turned password sign-in off and the password no
longer signs them in. Its last enabled owner cannot leave (`409 conflict`, reason
`members.last_owner`); another member becomes owner first. Errors: `404` (not a member). Audit
`member.left` in that organization. The leave sticks for the organization's SCIM, which never
adds the person back (docs/api/scim.md, "Users"), until they accept an invitation again or an
admin adds them. A provider whose group mapping a server admin set up may add the person again
at their next sign-in through it.

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
`transferTo` and `handedOver` (how many folders and dashboards changed hands). When the team owns
team spaces or team-only content, only org admins and maintainers of both teams (of the deleted
team, for a handover to `org`) may delete it (`403` otherwise, also with `teams:write`); an org
admin who is not a maintainer of both is recorded with `team_space.admin_access`
(`summary.action` `team.deleted`).

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
strongest level within what they held there before (never more). The kept grant is an ordinary
grant to that person: it outlasts their team memberships and stays until someone removes it in
the access dialog. Audit `folder.owner_changed`, `dashboard.owner_changed`.

Moves: moving a folder or dashboard between the open tree and a team space, or between two team
spaces, needs edit rights on both sides (`dashboards:write` on the dashboard and on the target
folder, `folders:write` for folders); moves into or out of other restricted folders still need
`folders:permissions` on both sides. Moving content out of a team space is for maintainers of the
space's team and org admins only; team editors move within the space. A folder moved out takes
content another team owns along only when the caller is a maintainer of that team or an org admin.
Each such move writes `team_space.moved_out` on the item with `spaceId`, `teamId`, `from` and
`to`, library panels included. Content another team owns goes into a team space only through org
admins. These checks run in the move's transaction, after the organization's lock. Library panels
follow the same rules, and move into a team space only while no dashboard outside that space shows
them (`409 conflict`). A dashboard outside a space may show a library panel kept in it only when
the caller maintains the space's team or is an org admin (`403`; checked for the library panels a
save adds, and for all of them when the save moves the dashboard).

### Admins and the audit log

Org admins (members whose org-wide permissions include `folders:permissions`) see and manage every
team space and team-only item, for example when a team is dissolved. Every access whose permission
an admin would not hold without that reach into restricted and team content writes the audit
event `team_space.admin_access` on the resource reached, whatever other grants they hold there:
opening another team's space, a team-only dashboard or a restricted folder (also a space handed to
the organization), changing another team's shared content, saving, moving, trashing, exporting,
the versions, the access dialog, "why can I". The summary names the `permission`, the nearest
owner team in the chain (`teamId`) and the governing restricted resource (`governingType`,
`governingId`). Reading a dashboard's annotations counts as reading the dashboard, so reading
shared content, or reading through an own grant, leaves no entry. Repeated accesses to the same
resource by the same admin are written once per ten
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

A grant gives a subject a level on one folder, dashboard, saved analysis or data source. One grant
per subject and resource. Levels include the ones before them:

| Resource | Level | Permissions on the resource |
|---|---|---|
| folder | `view` | `folders:read`, `dashboards:read`, `analyses:read` |
| folder | `edit` | + `folders:write`, `dashboards:write`, `dashboards:delete`, `analyses:write` |
| folder | `admin` | + `folders:permissions`, `dashboards:share` |
| dashboard | `view` | `dashboards:read` |
| dashboard | `edit` | + `dashboards:write`, `dashboards:delete` |
| dashboard | `admin` | + `dashboards:share` |
| analysis | `view` | `analyses:read` |
| analysis | `edit` | + `analyses:write` |
| analysis | `admin` | + `dashboards:share` (sharing an analysis is managed like a dashboard's; docs/api/analyses.md) |
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
  resourceType: "folder" | "dashboard" | "analysis" | "datasource";
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

## Service accounts

Accounts for scripts and other systems (`server/src/routes/service_accounts.rs`,
`server/src/auth/api_token.rs`). A service account belongs to one organization and holds one
role there: `admin`, `editor`, `viewer` or a custom role, never `owner`. It acts through API
tokens only; it has no password, never signs in, joins no team and receives no grants. Lists of
people (members, server users, team member pickers, member counts) leave service accounts out,
and the member routes answer `404` for them. They have no second factor: a required one never
applies to them, the server's two-factor overview does not count them, and both resets answer
`404`. A service account never becomes an organization's owner (`POST /admin/orgs` refuses it as
`ownerUserId`). Its made-up address (`<id>@service-account.invalid`) gets no mail: inviting it is
`422` (`mail.address_invalid`), a password link for it is neither sent on request nor by an admin
(`404`), and it never counts as a confirmed address. There are no personal tokens for people.

```ts
interface ServiceAccount {
  id: string;
  name: string;            // lowercase letters, digits and hyphens; unique in the organization
  description: string;
  role: string;            // role key, never "owner"
  disabled: boolean;       // its tokens are refused while disabled
  activeTokens: number;    // neither revoked nor expired
  nextExpiry: number | null;   // the soonest expiry of an active token
  lastUsedAt: number | null;
  createdByName: string | null;
  createdAt: number;
}

interface ApiToken {
  id: string;
  name: string;
  prefix: string;          // the visible start, "kz_sa_7f3a9c2e"; names the token in the audit log
  expiresAt: number;
  allowedIps: string[];    // canonical addresses and networks; empty for anywhere
  createdAt: number;
  createdByName: string | null;
  lastUsedAt: number | null;      // after a use that passed every check; written at most once a minute
  lastUsedAddress: string | null;
  revokedAt: number | null;
  revokedByName: string | null;
}
```

| Method and path | Access | Answer |
|---|---|---|
| `GET /orgs/{orgId}/service-accounts` | `serviceaccounts:write` | `200 Page<ServiceAccount>`, by name |
| `POST /orgs/{orgId}/service-accounts` | `serviceaccounts:write` | `201 ServiceAccount` |
| `GET /orgs/{orgId}/service-accounts/{accountId}` | `serviceaccounts:write` | `200 ServiceAccount & { tokens: ApiToken[] }` |
| `PATCH /orgs/{orgId}/service-accounts/{accountId}` | `serviceaccounts:write` | `200 ServiceAccount` |
| `DELETE /orgs/{orgId}/service-accounts/{accountId}` | `serviceaccounts:write` | `204` |
| `POST /orgs/{orgId}/service-accounts/{accountId}/tokens` | `serviceaccounts:write` | `201 ApiToken & { token: string }` |
| `POST /orgs/{orgId}/service-accounts/{accountId}/tokens/{tokenId}/revoke` | `serviceaccounts:write` | `200 ApiToken` |
| `GET /orgs/{orgId}/scim-token` | `serviceaccounts:write` and an admin's permissions | `200 { token: ApiToken \| null }` |
| `POST /orgs/{orgId}/scim-token` | `serviceaccounts:write` and an admin's permissions | `201 ApiToken & { token: string }` |
| `DELETE /orgs/{orgId}/scim-token` | `serviceaccounts:write` and an admin's permissions | `204` |

The guards of members apply: giving a role, and acting on an account (changing, deleting, making
or revoking its tokens), needs the caller to hold every permission of the account's role, so
nobody makes a token stronger than themselves. None of these routes can be called with an API
token (`403`, reason `token.not_for_this_route`).

**`POST`** `{ "name", "description"?, "role" }`. Errors: `validation` `name`
(`serviceaccount.name_invalid`), `validation` `role` (no such role, or
`serviceaccount.role_owner`), `409 conflict` `name` (`serviceaccount.name_taken`), `403`. Audit
`service_account.created`.

**`PATCH`** `{ "description"?, "role"?, "disabled"? }`. Audit `service_account.updated`,
`service_account.role_changed`, `service_account.disabled` or `service_account.enabled`, each only
when something changed.

**`DELETE`** deletes the account, its membership and its tokens; what it made stays. Audit
`service_account.deleted`.

**Tokens.** `POST .../tokens` `{ "name", "expiresInDays"?, "expiresAt"?, "allowedIps"? }`. A token
expires after 90 days unless `expiresInDays` (1 to 365) or `expiresAt` (Unix ms, at most 365 days
ahead) says otherwise; giving both is `validation`. `allowedIps` holds up to 50 addresses or
networks (CIDR), IPv4 or IPv6; the client address is the one `security.trusted_proxies` resolves.
The answer is the only one that holds the token itself (`kz_sa_` and 40 hex digits); Kalzit keeps
its SHA-256 and the prefix. Revoking is final and answers the token as it is when it was revoked
before. Revoked and expired tokens stay in `tokens` for 90 days after they ended (in the audit log
for good). Audit `service_account.token_created` and `service_account.token_revoked` with the
token's id and prefix, never the token.

**Using a token.** `Authorization: Bearer kz_sa_...` on any `/orgs/{orgId}/...` route signs the
request in as the service account: the same membership and permission checks run as for a
person, with the account's role, and every other rule (read-only data sources, stored queries
only for viewers) holds alike. Live updates (`/orgs/{orgId}/live`) need a browser session and
answer a token with `401`. A token of another organization answers `404 not_found` like an
organization the caller is not in; on other routes (`/me`, `/admin/...`) it is refused with `403`
(`token.org_routes_only`). Other `Authorization` values are not read, so a proxy's own bearer
token in front of Kalzit leaves the session cookie in charge. Unknown, revoked, expired and
disabled tokens, tokens used from an address outside their list and the SCIM token all answer the
same `401 unauthenticated`; each refusal writes `api_token.refused` with the reason (`unknown`,
`revoked`, `expired`, `account_disabled`, `address_not_allowed`, `wrong_kind`, `other_org`), the
address and the token's prefix when it is known. Only refusals count, per client address, with
the budget of failed sign-ins (`security.login_max_failures` per `security.login_window_secs`), so
working requests never use it up, however many arrive at once. Once it is used up, a token from
that address that would be refused answers `429 rate_limited` until the window ends; a working
token still works, so a few bad tokens behind a shared address cannot lock out the good ones.
Such refusals are audited per address and window, not one entry each: the first writes
`api_token.refused_rate_limited` (reason, `endsAt`, and the prefix when the token has our form,
never the token), and when the window ends `api_token.rate_limit_ended` names that entry
(`entryId`) and how many refusals followed it (`suppressed`). The closing entry is written when
the window ends, or at the address's next token request after that, whichever comes first; a
server that stops in between leaves the first entry without it.

Every audit entry written by a request made with a token names the token next to its service
account: `actorTokenId` and `actorTokenPrefix` in the audit API (`null` otherwise).

**SCIM token.** One per organization, for the SCIM endpoints (docs/api/scim.md); the same rules
(shown once, hashed, revocable, audited, 90 days by default, at most a year) without an IP list.
It provisions people and roles, so its routes need `serviceaccounts:write` and every permission
of the built-in admin role (`403` otherwise), and never an API token.
`POST` `{ "expiresInDays"?, "expiresAt"? }` revokes the current one and answers the new one.
`DELETE` revokes it (`404` without one). Audit `scim.token_created` and `scim.token_revoked`.

## Sign-in rate limits

`POST /auth/login` (`server/src/routes/auth.rs`) counts every attempt before the password is
checked, each budget under its own lock, and refuses it with `429 rate_limited` (with
`Retry-After` and `retryAfterSecs`) when a budget is used up. Parallel attempts therefore cannot
all pass a budget before the first failure is counted. A correct password gives the attempts
back, within the window they were counted in. `security.login_max_failures` per `security.login_window_secs` (default 10 per 15 minutes)
applies to each of:

- the client address (IPv4 per address, IPv6 per /64), whatever the email;
- the account at that address. Wrong passwords from other addresses never use it up;
- the account from all addresses together (sign-ins and failed `POST /me/password` checks).
  Used up, it refuses every sign-in of the account from a browser without a known device
  cookie, the right password included, with the whole window as the wait (it tells nothing
  about the account). A guess spread over many addresses so gets this one budget, not the
  budget of every address. An email without an account has the same budget, answered the same
  way, so a refusal does not tell whether the account exists. While the table of such emails is
  full, a new one counts in one of 4096 overflow buckets with the same budget, chosen by an HMAC
  of the email with a key derived from the secrets key; it reaches its refusal after about as
  many failures as an account does.

Only an attempt that passed its budgets takes a check slot: at most 2 password checks of one
account run at the same moment; more wait up to 2 seconds for a slot, then are refused with
`429 rate_limited` and a wait of 1 second. Sign-ins with a known device cookie, and `POST
/me/password` of a signed-in user, each have 1 slot per account of their own, so guesses holding
the others cannot keep them waiting. Successful sign-ins with a known device cookie also have a
budget of 30 per account and per address in the window, so an account that signs in over and
over cannot keep the threads of known devices busy for others. Password checks of sign-ins
from unknown browsers run on at most one thread per CPU; checks of known devices and signed-in
users run apart from them on a quarter of that, at least one, and hashing new passwords (setup,
an admin's new account or reset, a user's change) on as many threads of its own, so a flood of
guesses never delays the others and hashing never keeps known devices out. Up to 32 checks or
hashes per thread wait their turn, further ones are refused at once with `429 rate_limited`.

Known devices: a successful sign-in sets the cookie `kalzit_device` (`__Host-kalzit_device` over
HTTPS; `HttpOnly`, `SameSite=Lax`, `Path=/`, 90 days, renewed with every sign-in, kept on sign
out). Its value is an expiry, a random part and an HMAC, with a key derived from the secrets
key, over these, the account and its current password hash; it does not name the account, holds
no session and signs nobody in. A sign-in that brings a valid device cookie of the account it
names by email is not refused by the account's shared budget (its failures still count there,
and the budgets of the address and of the account at the address still apply), so an attacker
who uses that budget up cannot lock the owner out of a browser they signed in with before. A
new password, set by the user or an admin, revokes every device cookie of the account; so does a
new secrets key.

A browser that is not the user's own need not become a known device. `POST /auth/login` takes
`"forgetBrowser": true` next to `email` and `password` (the sign-in page's "This is not my
browser"): the sign-in then sets no device cookie and removes one the browser has (`Max-Age=0`).
`POST /auth/logout` keeps the device cookie by default, so the owner's own browser stays known;
`POST /auth/logout?forgetBrowser=true` (or `=1`; the account menu's "Sign out and forget this
browser") removes it too. The query is read leniently: other parameters or values never make
signing out fail, they only keep the device cookie. Both answer as before otherwise.

An IPv6 site (/48) also has a budget for all accounts together: 5 times
`security.login_max_failures` failures per window. Used up, an address in it goes on only with
accounts that are clean at that address (at most 2 failures there), so others' typos behind the
same network never make the owner's account dirty.

A successful sign-in gives the address its attempt back and clears the account's budget at that
address. Windows are measured on a monotonic clock, so a change of the system time neither ends
nor stretches them.

The counts live in memory, one table per kind of key (addresses, accounts at an address,
accounts, emails without an account, sites, password checks, setup codes), so a flood of one
kind never crowds out another. Entries whose window has ended are dropped. The budgets of
existing accounts have a table without a cap (it holds at most one entry per user), from which
nothing is dropped before its window ends, so no flood can reset them. The other tables are
bounded (100 000 / 300 000 entries; 10 000 / 30 000 for password checks, setup codes and
connection tests), and every key belongs to a network (IPv6 /48, IPv4 /24):

- a network holding fewer than 16 entries always gets its new key. At the larger number, room
  is made by dropping the oldest entry that has not used up its attempts from the network with
  the most such entries, so a flood pushes out its own entries. An entry that has used up its
  attempts is never dropped before its window ends;
- a network holding 16 or more gets new keys only while the table has fewer than the smaller
  number.

A client from a network that is not flooding is so always counted. Only a table holding nothing
but used-up entries refuses new keys, until the oldest window ends.

## Setup

The first start (`server/src/routes/setup.rs`). While the server has no user, a one-time setup
code opens setup: generated into `setup-token.txt` in the data directory (never logged), or fixed
by `KALZIT_SETUP_TOKEN`. Dashes, spaces and case do not matter. A generated code is replaced on
every start; the code of the previous start (its file read before it is replaced) is answered as
`setup_token_expired` and never opens setup. A fixed code has no previous code. All three routes
are `Public`.

| Method and path | Answer |
|---|---|
| `GET /setup` | `200 { "needed": boolean, "codeHint"?: "file" \| "docker" \| "fixed" }` |
| `POST /setup/check` | `200 { "valid": true }` |
| `POST /setup` | `200 Me` (as `GET /me`) and the session cookie |

**`GET /setup`** carries `codeHint` only while setup is needed: where the person setting up finds
the code. `fixed` when it comes from `KALZIT_SETUP_TOKEN`, `docker` when the server runs in a
container (`/.dockerenv` or `/run/.containerenv`), else `file`. It never names a path. `fixed`
tells a visitor that the code was chosen by a person (at least 16 letters or digits) rather than
generated; that is acceptable only because of the budgets below, which keep a guess slow however
many addresses it uses.

**`POST /setup/check`** `{ "token" }` checks the code alone, so the setup page can confirm it
before asking for the rest. Errors: `403 invalid_setup_token` (wrong code), `403
setup_token_expired` (the code of the previous start), `409 setup_done`, `429 rate_limited`. The
answer never contains the code.

**`POST /setup`** `{ "token", "orgName", "name", "email", "password", "language"?, "theme"?,
"timeZone"? }` creates the first organization and its owner (also server admin) and signs them in. When the server requires a second factor (`security.two_factor_required` other than `off`, which before setup only the environment or `kalzit.toml` can set), it opens no session: it answers `200 { "secondFactor": Prompt }` with `setup: true` and the pending cookie, and the owner sets up a second factor through the routes of "Second factor" before the session opens.
The optional fields set the server defaults `appearance.default_language` (`de`, `en`) and
`appearance.default_theme` (`system`, `light`, `dark`, `contrast`), and the new organization's
`appearance.time_zone` (an IANA name such as `Europe/Berlin`), with the rules of the settings
API; left out, they stay as they are. Everything is one transaction. Errors: `403
invalid_setup_token`, `403 setup_token_expired`, `409 setup_done`, `429 rate_limited`, `validation`
with `field` `orgName`, `name`, `email`, `password`, `language`, `theme` or `timeZone`. Audit
`setup.completed`, and `settings.updated` per chosen setting (summary `{ "key", "version",
"setup": true }`, never the value).

Both `POST` routes share two budgets. Only wrong codes (and the code of the previous start) use
them up, so nobody can use up the budget of the person who has the right code:

- per client (IPv4 per address, IPv6 per /48, so a site gets no more tries by using more of its
  /64 networks), the sign-in limits: `security.login_max_failures` wrong codes per
  `security.login_window_secs` (default 10 per 15 minutes). Used up, the client is refused
  before its code is compared, the right code included;
- for all addresses together: `security.setup_max_failures` wrong codes per
  `security.setup_window_secs` (default 100 per hour). Used up, it refuses a client that
  already had more than 2 wrong codes in its own window, so a guess spread over many clients
  gets 3 tries per client instead of the full budget. A clean address (at most 2 wrong codes) is
  still checked, and the right code opens setup.

Refused: `429 rate_limited` with `Retry-After` and `retryAfterSecs` (the wait of the budget that
refused). An attempt refused by the shared budget does not count for the address. A correct
code gives its attempt back; a check after setup is done does not count.

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
stays. Attempts count against a budget of their own (`security.login_max_failures` per window);
once it is used up the answer is `429 rate_limited`. Failed checks also count for the account's
shared sign-in budget (see Sign-in rate limits), which does not refuse here, since the caller
has a session. A correct password resets the budget of its own, and the new password revokes
the account's device cookies. Of two changes at the same moment with the same
current password, the second answers `validation` `current`. Errors: `validation` `current` (not correct), `validation` `new`
(policy), `429 rate_limited`. Audit `user.password_changed`.

**`DELETE /me/sessions/{sessionId}`** ends one of the caller's sessions (also the current one,
which signs this browser out). Errors: `404` (unknown, or another user's). Audit
`auth.session_ended`.

**`POST /me/sessions/revoke-others`** (no body needed) ends every session but this one. Audit
`auth.sessions_revoked`.

### Recent sign-ins

Every completed sign-in is recorded as the audit entry `auth.signed_in`, whichever way it came:
a password, the break-glass form, OpenID Connect, SAML or a directory (LDAP), with or without
Kalzit's second factor. Its summary holds `method`, the provider's `provider` (slug),
`providerName` and `providerMfa`, `secondFactor`, the `sessionId` it opened and the browser's
`userAgent` (without control characters, at most 256 characters); the address is the entry's
`actorAddress`. The list below reads these entries back, with the refused attempts of the
account: a wrong password (`auth.sign_in_failed`, which now names the account as its resource),
a wrong second factor (`auth.second_factor_failed`) and a provider's refusal after it found the
person (`auth.sso_failed`). They follow the audit log's retention (`audit.retention_days`).

```ts
interface SignIn {
  id: string;                  // the audit entry's id
  at: number;
  result: "success" | "refused";
  // credentials, disabled, password_off, second_factor, or a provider's reason (sso.unmapped, ...)
  reason: string | null;
  method: "password" | "break_glass" | "oidc" | "saml" | "ldap" | "provider" | null;
  provider: string | null;     // slug at the time of the sign-in
  providerName: string | null;
  secondFactor: "passkey" | "totp" | "recovery" | "provider" | null;
  address: string | null;
  userAgent: string | null;
  current: boolean;            // the sign-in that opened the session of this request
}
```

| Method and path | Access | Answer |
|---|---|---|
| `GET /me/sign-ins` | signed in | `200 Page<SignIn>`, the caller's own, newest first |
| `GET /admin/users/{userId}/sign-ins` | server admin | `200 Page<SignIn>`, never `current`; `404` for an unknown account or a service account |

Organization admins see no one's sign-ins here; the audit log of the organization does not hold
them either, since sign-ins belong to the server.

## Second factor

`server/src/auth/second_factor.rs` (with `totp.rs`, `passkeys.rs`, `recovery.rs`) and the routes
in `server/src/routes/{second_factor,security}.rs`. A person may protect their account with an
authenticator app (TOTP), passkeys and recovery codes; the server and each organization can
require it.

### Methods

- **Authenticator app (TOTP, RFC 6238)**: HMAC-SHA-1, 30-second steps, 6 digits. A code is
  accepted for the current step and one step on either side, and each step only once per account
  (a code cannot be used twice, nor an older one after a newer). The key (160 bits) is stored
  AES-GCM encrypted with the secrets key, bound to the account; `kalzit secrets rotate`
  re-encrypts it with the other secrets.
- **Passkeys (WebAuthn)** through webauthn-rs. The relying party is the host of
  `server.public_url`, or without it the host the request named (`Host`, or `X-Forwarded-Host` of
  a trusted proxy) with its scheme; its id is that host name, so passkeys need a host name, not an
  IP address (`second_factor.passkey_host`). No attestation is asked for; user verification is
  preferred (a PIN, fingerprint or face where the authenticator has one); sign counters are
  checked against the counter stored at that moment (under the passkey's row lock), and an assertion whose counter is not above it is refused (a replay or a cloned authenticator); the stored counter never moves back. A passkey is registered to one account only.
- **Recovery codes**: 10 per set, each 16 characters from a 32-letter alphabet without look-alikes
  (80 bits), shown as `xxxx-xxxx-xxxx-xxxx` once, when the set is made. Only a SHA-256 of each,
  bound to the account, is stored; each works once. Input ignores case, spaces and dashes. A set
  comes with the account's first method and goes when its last method is removed.

Codes are compared in constant time. Audit summaries name methods and ids, never keys or codes.

### Policy

| Setting | Scope | Values |
|---|---|---|
| `security.two_factor_required` | server | `off` (default), `admins`, `everyone` |
| `security.two_factor_required` | organization | `inherit` (default: the server's rule), `admins`, `everyone` |
| `security.two_factor_methods` | server | `all` (default), `passkey`, `totp`: what may be set up |

The server's rule is the minimum everywhere; an organization can only add to it (`off` is not
accepted there). `admins` on the server means server admins and the administrators of any
organization; in an organization, its administrators. An administrator is a member whose role
holds `users:write`, `roles:write` or `settings:write`. A person needs a second factor when the
server's rule or the rule of any organization they joined by consent (`joinedBy` `invitation`,
`creator`, `scim_owned` or `mapping`, "Members") applies to them; an organization's rule never
binds a `direct` or `legacy` member. Everyone can leave an organization ("Leaving an
organization"). A method turned off
keeps working for those who have it; it can no longer be set up. Where passkeys cannot work (Kalzit opened by an IP address), the authenticator app is offered instead even when only passkeys are allowed (`allowed` says so), so a required setup, the first owner's included, never dead-ends. Changing these settings (also by import or reset) needs a fresh confirmation (`403 confirmation_required`) when the admin has a second factor. There is no grace period: whoever
must have a second factor and has none sets one up at the next sign-in, before a session opens.
The break-glass administrator signs in through the same steps; nothing bypasses the policy.

### Sign-in

`POST /auth/login` answers as before when no second step follows (no method set up and none
required). Otherwise it opens no session and answers `200 { "secondFactor": Prompt }` with the
cookie `kalzit_pending` (`__Host-kalzit_pending` over HTTPS; `HttpOnly`, `SameSite=Lax`,
`Path=/`, 5 minutes). That cookie names the half-signed-in state, a server-side record (only the
SHA-256 of its token is stored) that lives five minutes and is deleted by the request that
completes it. It is not a session: every other route answers `401 unauthenticated` to it. A
password changed or an account disabled meanwhile ends it.

```ts
interface Prompt {
  email: string;
  setup: boolean;                 // no method yet and one is required: set one up first
  methods: ("passkey" | "totp" | "recovery")[];   // what the account can use now
  lastUsed: "passkey" | "totp" | null;
  allowed: { passkey: boolean; totp: boolean };   // what may be set up
  requiredBy: { kind: "server" } | { kind: "org"; id: string; name: string } | null;
  lockedUntil: number | null;
  expiresAt: number;
  linkPassword: boolean;          // the account's own password first (below)
}
type Proof =
  | { method: "totp"; code: string }
  | { method: "recovery"; code: string }
  | { method: "passkey"; credential: PublicKeyCredentialJSON };  // the browser's answer, base64url
```

| Method and path | Answer |
|---|---|
| `GET /auth/second-factor` | `200 Prompt` |
| `POST /auth/second-factor` | `200 { "me": Me, "recoveryCodesRemaining"?: number }` and the session cookie |
| `POST /auth/second-factor/passkey` | `200 { "publicKey": PublicKeyCredentialRequestOptionsJSON }` |
| `POST /auth/second-factor/setup/totp` | `200 TotpSetup` |
| `POST /auth/second-factor/setup/passkey` | `200 { "publicKey": PublicKeyCredentialCreationOptionsJSON }` |
| `POST /auth/second-factor/setup` | `200 { "me": Me, "recoveryCodes": string[] }` and the session cookie |
| `POST /auth/second-factor/password` | `200 { "me": Me }` and the session cookie, or `200 { "secondFactor": Prompt }` when a setup follows |

All are `Public` and need the pending cookie; without a valid one they answer `401
unauthenticated` with `reason` `second_factor.pending_expired`. `POST /auth/second-factor` takes a
`Proof`; `recoveryCodesRemaining` is set after a recovery code. With `setup: true` it answers
`validation` `second_factor.setup_needed`, and the setup routes answer `403` without it.
`POST /auth/second-factor/setup` takes `{ "method": "totp", "code" }` or `{ "method": "passkey",
"name"?, "credential" }` and stores the method with a first set of recovery codes, all in the
transaction that opens the session. A completed sign-in sets the session and device cookies as
`POST /auth/login` does, removes the pending cookie, and counts as a fresh confirmation of the new
session. `POST /auth/logout` also ends a half-signed-in state.

`linkPassword: true` comes after a sign-in through a provider whose identity was linked to an
existing account by its email address and is not confirmed yet, when that account has a password
and no second factor (docs/api/sso.md, "Linking by email"). `POST /auth/second-factor/password`
takes `{ "password" }`, the account's own password; it counts against the account's lockout and
the address's sign-in budget like a wrong code and answers `401 invalid_credentials` (field
`password`) when it is wrong. With `setup: true` the setup of a second factor follows, and the
setup routes and `POST /auth/second-factor` answer `validation` `second_factor.password_first`
until the password was confirmed. A sign-in completed with the password is not a fresh
confirmation of the session. Audit `auth.signed_in` with
`{ "secondFactor": method }`, `user.second_factor_enrolled` after a setup.

```ts
interface TotpSetup {
  secret: string;    // the key in Base32, in groups of four, for typing by hand
  uri: string;       // otpauth://totp/...
  qr: { size: number; path: string } | null;  // the QR code of `uri`: modules per side and an SVG path
  issuer: string;    // the product name and host, as the app shows it
  account: string;   // the email
}
```

### Limits

Wrong codes (app or recovery) are counted per account, whatever browser or address they come
from: 5 within 15 minutes lock the second step of the account for 15 minutes (`429
rate_limited`, `reason` `second_factor.locked`, `params.until` the end in milliseconds, with
`Retry-After`). An attempt is counted before its code is checked, under the account's row lock, so
parallel guesses cannot all be checked before the lock; more attempts at once than the budget are
refused (`second_factor.busy`). A correct code starts the count over. Passkeys cannot be guessed
and are not locked. On top, every wrong code counts against the address's budget of failed
sign-ins (see Sign-in rate limits). A lockout and each used recovery code are audited
(`auth.second_factor_locked`, `auth.recovery_code_used`; every wrong code
`auth.second_factor_failed`) and, once a mail server is set up, mailed to the person.

### Own account

For any signed-in user (`Authenticated`).

```ts
interface SecurityStatus {
  required: boolean;
  requiredBy: Prompt["requiredBy"];
  allowed: { passkey: boolean; totp: boolean };
  totp: { createdAt: number; lastUsedAt: number | null } | null;
  passkeys: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[];
  recoveryCodes: { remaining: number; total: number; createdAt: number } | null;
  confirmedUntil: number | null;   // this session's fresh confirmation, while it lasts
  lockedUntil: number | null;
  hasPassword: boolean;
}
```

| Method and path | Answer |
|---|---|
| `GET /me/security` | `200 SecurityStatus` |
| `POST /me/security/confirm` | `200 { "confirmedUntil": number }` |
| `POST /me/security/confirm/passkey` | `200 { "publicKey": ... }` (request options) |
| `POST /me/security/totp/setup` | `200 TotpSetup` |
| `POST /me/security/totp` | `200 { "recoveryCodes": string[] \| null }` |
| `DELETE /me/security/totp` | `204` |
| `POST /me/security/passkeys/setup` | `200 { "publicKey": ... }` (creation options) |
| `POST /me/security/passkeys` | `201 { "passkey", "recoveryCodes": string[] \| null }` |
| `PATCH /me/security/passkeys/{passkeyId}` | `200` the passkey |
| `DELETE /me/security/passkeys/{passkeyId}` | `204` |
| `POST /me/security/recovery-codes` | `200 { "recoveryCodes": string[] }` |

**Fresh confirmation.** `POST /me/security/confirm` takes a `Proof` (for a passkey, after
`POST /me/security/confirm/passkey`) and lets this session make changes for 5 minutes; codes
count against the account's lockout; a confirmation is audited (`user.second_factor_confirmed`, the method). Removing a method, new recovery codes, `POST /me/password`
and, on an account that already has a method, adding or replacing one answer `403
confirmation_required` without it. A sign-in with a second factor counts as one.

**`POST /me/security/totp`** `{ "code" }` checks the first code of the key from
`/totp/setup` (valid 10 minutes) and stores it, replacing an app set up before. A wrong code
answers `422 invalid_code` with `field` `code` and leaves the setup open. **`POST
/me/security/passkeys`** `{ "name"?, "credential" }` (name up to 60 characters, default
`Passkey`). Both answer the first set of recovery codes when the account had no method before.
Removing the last method while a second factor is required is `409 conflict` (checked again inside the removal's transaction under the account's row lock, so two removals at once cannot both pass)
(`second_factor.last_method`); removing the last method otherwise also removes the recovery
codes. Errors: `403 forbidden` `second_factor.method_off`, `422 validation`
`second_factor.setup_expired` (start again), `second_factor.passkey_refused` (the browser's answer
does not hold), `409 conflict` `second_factor.passkey_known`. Audit `user.second_factor_enrolled`,
`user.second_factor_removed` (`{ "userId", "method", "passkeyId"? }`), `user.passkey_renamed`,
`user.recovery_codes_generated`.

### Reset by an admin

| Method and path | Access | Answer |
|---|---|---|
| `POST /orgs/{orgId}/members/{userId}/second-factor/reset` | `users:write` | `200 { "removed", "sessionsEnded" }` |
| `POST /admin/users/{userId}/second-factor/reset` | server admin | `200 { "removed", "sessionsEnded" }` |
| `GET /admin/security/two-factor` | server admin | `200 { "server", "orgs": [{ "id", "name", "policy", "effective", "missing" }] }` |

A reset takes `{ "reason"? }` (up to 200 characters, kept in the audit entry), removes the app,
passkeys, recovery codes, lockout and any half-signed-in state of the account and ends all its
sessions; at the next sign-in the person sets up a new factor if one is required. The admin
confirms with their own second factor first (`POST /me/security/confirm`, then the reset within 5
minutes; `403 confirmation_required`), and must have one (`403` `second_factor.admin_needs_factor`).
Nobody resets their own here (`second_factor.reset_self`). An organization admin can reset only
members of their organization alone who are not server admins and hold nothing the admin does not;
other accounts need a server admin (`second_factor.reset_needs_server_admin`). Audit
`user.second_factor_reset` (`{ "userId", "removed", "sessionsEnded", "reason"? }`), and the person
is mailed once a mail server is set up.

Lists of people carry `secondFactor: { methods: ("passkey" | "totp")[], lockedUntil: number |
null, required: boolean }`: `GET /orgs/{orgId}/members` (required by the server or this
organization) and `GET /admin/users` (by the server or any of the person's organizations).
`GET /admin/security/two-factor` lists every organization with its own value, the rule that
applies there (the stricter of server and organization) and how many members must set up a
second factor at their next sign-in.

### Sign-ins through identity providers

`auth::second_factor::FirstStep` is the hook for sign-ins that do not use a local password:
`Provider { provider_id, mfa_done, provider_mfa_trusted, confirm_link }` skips Kalzit's second
factor only when the provider says it checked one (`mfa_done`, such as OIDC `amr`) and the
provider's switch in Kalzit trusts that (`provider_mfa_trusted`, off by default, and never on the
first sign-in that links an identity by email); otherwise Kalzit asks. `Directory` (LDAP) always
asks. `confirm_link` marks an unconfirmed link by email: the account's second factor, or without
one its password (`linkPassword`), is asked once, and the link counts as confirmed when that
second step completes. `routes::second_factor::finish_first_step` opens the session or starts the
second step for any of them.

## Reasons

Errors of the routes above carry `error.reason` and `error.params` like those of the data source
routes (docs/api/datasources.md, "Reasons"); the UI translates them. The request reasons
(`request.name_length`, ...) are listed there.

### Members

| Reason | Code | When |
|---|---|---|
| `members.invite_instead` | `409 conflict` | adding an account that belongs to another organization: invite the person instead |
| `members.last_owner` | `409 conflict` | the last owner of an organization leaving it |

### Second factor

| Reason | Code | When |
|---|---|---|
| `second_factor.pending_expired` | `401 unauthenticated` | the half-signed-in state is missing, expired, used or ended |
| `second_factor.locked` | `429 rate_limited` | too many wrong codes; `params.until` |
| `second_factor.busy` | `429 rate_limited` | more code attempts at once than the budget |
| `second_factor.setup_needed` | `422 validation` | the account must set up a second factor first |
| `second_factor.password_first` | `422 validation` | the account's password comes first (`linkPassword`) |
| `second_factor.password_not_asked` | `422 validation` | `POST /auth/second-factor/password` for a sign-in that does not ask for it |
| `second_factor.setup_done` | `409 conflict` | a forced setup when the account got a second factor meanwhile |
| `second_factor.setup_expired` | `422 validation` | the app setup or passkey dialog was not started or expired |
| `second_factor.no_totp` | `422 validation` | the account has no authenticator app |
| `second_factor.no_passkey` | `422 validation` | the account has no passkey |
| `second_factor.none` | `422 validation` | new recovery codes without any method |
| `second_factor.passkey_host` | `422 validation` | passkeys need a host name, not an IP address |
| `second_factor.passkey_refused` | `422 validation`, `422 invalid_code` | the browser's passkey answer does not hold |
| `second_factor.passkey_known` | `409 conflict` | this passkey is registered already |
| `second_factor.last_method` | `409 conflict` | the last method while a second factor is required |
| `second_factor.method_off` | `403 forbidden` | the method is turned off on this server |
| `second_factor.admin_needs_factor` | `403 forbidden` | a reset by an admin without a second factor of their own |
| `second_factor.reset_self` | `403 forbidden` | an admin's reset of their own second factor |
| `second_factor.reset_needs_server_admin` | `403 forbidden` | the account belongs to another organization or is a server admin |

`invalid_code` (`422`) is a wrong or used code; `confirmation_required` (`403`) a change that
needs a fresh confirmation.

### Service accounts and tokens

| Reason | Params | When |
|---|---|---|
| `serviceaccount.name_invalid` | `max` | `422 validation` on `name`: not 1 to `max` lowercase letters, digits and hyphens, or starts with a hyphen |
| `serviceaccount.name_taken` | | `409 conflict` on `name`: another service account of the organization has this name |
| `serviceaccount.role_owner` | | `422 validation` on `role`: a service account cannot be an owner |
| `token.expiry_out_of_range` | `maxDays` | `422 validation` on `expiresInDays` or `expiresAt`: not in the future, or more than `maxDays` days ahead |
| `token.ip_invalid` | `line`, `value` | `422 validation` on `allowedIps`: entry `line` (from 1) is no address or network |
| `token.ip_too_many` | `max` | `422 validation` on `allowedIps`: more than `max` entries |
| `token.not_for_this_route` | | `403 forbidden`: API tokens cannot manage service accounts or tokens, nor change an organization's sign-in rules (`security.two_factor_required`, `security.two_factor_methods`, `signin.local_password`) |
| `token.org_routes_only` | | `403 forbidden`: an API token was sent to a route outside its organization |
