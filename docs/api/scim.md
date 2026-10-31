# SCIM provisioning API

How an organization's directory (Entra ID, Okta and others) creates, changes and deactivates the
people and groups of that organization with SCIM 2.0 (RFC 7643, RFC 7644). Implemented in
`server/src/scim/`; the organization's SCIM token and switch are managed under
Organisation > Dienstkonten (`server/src/routes/service_accounts.rs`, board
`docs/design/blueprint/Identity.dc.html`, frame 8).

SCIM never deletes. A `DELETE` deactivates exactly like `active: false`, so dashboards, what
people made and the audit log stay intact.

## Endpoint and sign-in

The base URL of an organization is `{public URL}/scim/v2/o/{orgId}`; Organisation > Dienstkonten
shows it ready to copy. `server.public_url` sets the public URL, otherwise the request's host is
used.

Every request needs the organization's SCIM token as a bearer token:
`Authorization: Bearer kz_scim_...`. The token is made, replaced and revoked by people who hold
every permission of the built-in admin role (docs/api/access.md, "SCIM token"); it is shown once,
stored only as its SHA-256, expires after 90 days by default and after a year at the latest. It
works on the SCIM routes of its organization only, and only it does: a service account token, a
token of another organization, an unknown, revoked or expired token and a missing token all
answer `401` with `WWW-Authenticate: Bearer`. Every refusal of a token is counted per client
address with the budget of failed sign-ins and written to the audit log (`api_token.refused` with
the reason, `wrong_kind` for a service account token, `other_org` for another organization's);
once the budget is used up, refused tokens from that address answer `429` with `Retry-After`
(docs/api/access.md, "Using a token"). The SCIM token on any `/api` route answers `401` the same
way.

The organization's switch (`PUT /api/orgs/{orgId}/scim`, below) turns SCIM off without revoking
the token: requests then answer `403` (reason `scim.disabled`).

## Messages

Requests and answers are `application/scim+json` (`application/json` is accepted too). Errors
follow RFC 7644, section 3.12:

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
  "status": "409",
  "scimType": "uniqueness",
  "detail": "another user of this organization has this userName"
}
```

A refused change (any `4xx` except `404` to a `POST`, `PUT`, `PATCH` or `DELETE`) is written to
the audit log as `scim.request_refused` with the method, the resource, the status, `scimType`,
the reason below and `detail`. Organisation > Dienstkonten shows the latest one of the last 30
days as "Letzter Fehler".

## Routes

All paths are relative to the base URL.

| Method and path | Answer |
|---|---|
| `GET /ServiceProviderConfig` | `200`: PATCH and filters supported (at most 200 results), no bulk, sort, ETags or password changes, bearer token |
| `GET /ResourceTypes`, `GET /ResourceTypes/{User,Group}` | `200` |
| `GET /Schemas`, `GET /Schemas/{id}` | `200`: the User and Group attributes Kalzit keeps |
| `GET /Users?filter=&startIndex=&count=` | `200 ListResponse` |
| `POST /Users` | `201` with `Location` |
| `GET /Users/{id}` | `200` |
| `PUT /Users/{id}` | `200` |
| `PATCH /Users/{id}` | `200` |
| `DELETE /Users/{id}` | `204`: deactivates |
| `GET /Groups?filter=&startIndex=&count=&excludedAttributes=members` | `200 ListResponse` |
| `POST /Groups` | `201` with `Location` |
| `GET /Groups/{id}` | `200` |
| `PUT /Groups/{id}` | `200` |
| `PATCH /Groups/{id}` | `200` |
| `DELETE /Groups/{id}` | `204`: deactivates |

`/Bulk` and `/Me` answer `501`; other paths `404`, other methods `405`.

**Lists.** `startIndex` counts from 1 (below is 1), `count` is 100 by default and at most 200 (`0`
answers only `totalResults`). Resources are in the order they were created. `filter` supports
what directories use to find what they provisioned: `attribute eq "value"`, several joined with
`and`. Users: `userName` (case-insensitive), `externalId`, `id`, `active`. Groups: `displayName`
(case-insensitive), `externalId`, `id`. Anything else answers `400 invalidFilter`, so a directory
never acts on a list that ignored part of its filter. `excludedAttributes=members` (and
`attributes` without `members`) leaves the members out of groups, `groups` out of users.

### Users

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "id": "0192f1c4-...",
  "externalId": "5c1f...",
  "userName": "anna.berg@mueller.example",
  "name": { "givenName": "Anna", "familyName": "Berg" },
  "displayName": "Anna Berg",
  "emails": [{ "value": "anna.berg@mueller.example", "type": "work", "primary": true }],
  "active": true,
  "groups": [{ "value": "0192f1c5-...", "display": "kalzit-vertrieb", "$ref": ".../Groups/0192f1c5-..." }],
  "meta": { "resourceType": "User", "created": "...", "lastModified": "...", "location": "...", "version": "W/\"3\"" }
}
```

The `id` is the id of the Kalzit account. `userName` is required and unique in the organization
(case-insensitive). The account's address is the primary email, else the first, else `userName`
when it is an address; one is required (`400 invalidValue`, `scim.email_missing`). Its name is
`displayName`, else `name.formatted`, else given and family name, else the part of `userName`
before the `@`. `groups` is read-only. Other attributes (title, phone numbers, the enterprise
extension, ...) are accepted and not kept, so a directory's full attribute mapping does not fail.

**Creating a user** links it to the account with its address when there is exactly one, it is a
person's account, its address is confirmed and it is not a server admin or the break-glass admin;
it then joins the organization through the group mapping. An account that is already a SCIM user
of this organization answers `409` (`scim.account_linked`), one with an unconfirmed address `409`
(`scim.email_unconfirmed`), a server admin's `403` (`scim.account_protected`). Without such an
account a new one is made without a password and with its address unconfirmed (the rules of
docs/api/mail.md, "Email confirmation"): the person signs in through a provider or sets a password
with a reset link, which also confirms the address. Single sign-on never links a provider's person
to an unconfirmed account by address (docs/api/sso.md), so until then such a person signs in with
the reset link. Service accounts are never linked, listed or changed through SCIM.

**Changing a user.** `PUT` replaces the attributes (an `active` it leaves out stays as it is).
`PATCH` takes `add`, `replace` and `remove` with or without a path, as Entra ID and Okta send them:
`op` in any case (`"Replace"`), booleans as JSON or as the strings `"True"` and `"False"`, paths such
as `active`, `name.givenName`, `emails[type eq "work"].value` and
`urn:ietf:params:scim:schemas:core:2.0:User:userName`, and an object of attributes without a path
(`{"op": "replace", "value": {"active": false}}`). SCIM changes the name and address of accounts
it made; a new address must not belong to another account (`409`, `scim.email_taken`) and is
unconfirmed again. For a linked account, the directory's name and emails are kept on the SCIM user
only.

**Deactivating** (`active: false` or `DELETE`): an account SCIM of this organization made, that is
in no other organization and is not a server admin, is locked: disabled and signed out
everywhere; its membership stays, so reactivating brings it back as it was. Any other account keeps
its access elsewhere: its membership in this organization ends (with its teams and grants there;
what it made stays). The organization's last owner is never deactivated (`409`,
`scim.last_owner`), and the break-glass admin is never changed through SCIM (`403`,
`scim.account_protected`). The user stays in SCIM with `active: false`.

**Reactivating** (`active: true`) unlocks an account deactivating locked (never one an admin
disabled) and applies the group mapping again.

### Groups

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"],
  "id": "0192f1c5-...",
  "displayName": "kalzit-vertrieb",
  "externalId": "9a7e...",
  "members": [{ "value": "0192f1c4-...", "display": "Anna Berg", "$ref": ".../Users/0192f1c4-..." }],
  "meta": { "resourceType": "Group", ... }
}
```

`displayName` is required and unique among the organization's active groups (case-insensitive).
Members are SCIM users of this organization (`400 invalidValue`, `scim.member_unknown`
otherwise). `PATCH` adds and removes members as Entra ID (`{"op": "Add", "path": "members",
"value": [{"value": "..."}]}`, `Remove` with a value) and Okta (`remove` with
`members[value eq "..."]`, `replace` with an object) send them. `DELETE` deactivates the group: it
disappears from SCIM, stops counting for the mapping, and its row stays for the audit log.

## Groups and roles

A SCIM group gives nothing by itself. The group mapping under Verwaltung > Anmeldung >
Gruppen-Zuordnung (docs/api/sso.md, "Model") decides: every mapping rule that gives a role in this
organization, whichever provider it was made for, applies to a SCIM group whose `displayName` or
`externalId` equals its group name. The highest mapped role wins, teams add up, and the result
applies at once with every change of a group's name or members and with every new or reactivated
user:

- "IdP entscheidet" (`idpDecides`): role and membership follow the directory. The role is locked
  in Members (`409`, `sso.role_managed`), and when no such group holds the person any more, the
  membership and the teams it gave end.
- "Kalzit ergänzt": the group gives a minimum role; admins may give more.
- A user without a mapped group gets the server's default role (Verwaltung > Anmeldung, "Personen
  ohne passende Gruppe") in this organization, or no membership when that rule refuses.
- Owners are never changed, so the organization never loses its last owner; the break-glass admin
  is never changed.

A SCIM directory only ever changes memberships in its own organization; a group mapping rule for
another organization never applies to it.

## Administration

Under `/api`, with the access of the SCIM token's routes (docs/api/access.md, "SCIM token":
`serviceaccounts:write` and every permission of the built-in admin role, never an API token).

| Method and path | Answer |
|---|---|
| `GET /orgs/{orgId}/scim?since=` | `200 ScimStatus` |
| `PUT /orgs/{orgId}/scim` | `200 ScimStatus` |

```ts
interface ScimStatus {
  enabled: boolean;          // the organization's switch
  endpoint: string;          // the base URL to enter in the directory
  token: ApiToken | null;    // docs/api/access.md
  stats: {
    since: number;           // the start of the counted span: `since` (the viewer's start of day), within 31 days; 24 hours ago by default
    created: number;         // users created since then
    deactivated: number;     // users deactivated since then
    groups: number;          // active SCIM groups
    mappedGroups: number;    // of them, named by a group mapping rule of this organization
    lastError: { at: number; action: string; reason: string | null; status: number | null } | null;  // last 30 days
  };
}
```

`PUT` `{ "enabled": boolean }` turns SCIM on or off at once; the token stays. Audit
`scim.turned_on` or `scim.turned_off`.

## Audit log

Entries of SCIM changes name the SCIM token (`actorTokenId`, `actorTokenPrefix`) and no person.

| Action | When |
|---|---|
| `scim.user_created` | a user was created (`accountCreated`: a new account was made, else an account was linked) |
| `scim.user_updated` | a user's attributes changed (`fields`) |
| `scim.user_deactivated` | `active: false` or `DELETE` (`scope`: `account` locked, or `organization` membership ended) |
| `scim.user_reactivated` | `active: true` again |
| `scim.memberships_changed` | the group mapping changed a role, membership or team (`changes`) |
| `scim.group_created`, `scim.group_updated`, `scim.group_deactivated` | groups |
| `scim.request_refused` | a change was refused |
| `scim.token_created`, `scim.token_revoked`, `scim.turned_on`, `scim.turned_off` | administration |

## Reasons

Kalzit's reasons of refused SCIM requests, in the audit log (`scim.request_refused`) and in
`detail`:

| Reason | Status | When |
|---|---|---|
| `scim.disabled` | `403` | SCIM is turned off for the organization |
| `scim.body_invalid` | `400 invalidSyntax` | the body is not a JSON object, not JSON, or a PATCH without valid `Operations` |
| `scim.filter_unsupported` | `400 invalidFilter` | a filter other than `eq` comparisons of the supported attributes joined with `and` |
| `scim.path_invalid` | `400 invalidPath`, `noTarget` | a PATCH path Kalzit cannot read, or `remove` without a path |
| `scim.value_invalid` | `400 invalidValue`, `tooMany` | a value of the wrong type, too long (256 characters, 254 for addresses), with control characters, or too many emails or members |
| `scim.read_only` | `400 mutability` | a change of a user's `groups` |
| `scim.user_name_missing` | `400 invalidValue`, `mutability` | a user without `userName`, or removing it |
| `scim.user_name_taken` | `409 uniqueness` | another user of the organization has this `userName` |
| `scim.email_missing` | `400 invalidValue` | a new user without an address |
| `scim.email_taken` | `409 uniqueness` | another account (or several, or a service account) has the address |
| `scim.email_unconfirmed` | `409 uniqueness` | the account with the address has not confirmed it |
| `scim.account_linked` | `409 uniqueness` | the account with the address is already a SCIM user of this organization |
| `scim.account_protected` | `403` | a server admin's account (linking) or the break-glass admin (any change) |
| `scim.last_owner` | `409` | deactivating the organization's last owner |
| `scim.group_name_missing` | `400 invalidValue`, `mutability` | a group without `displayName`, or removing it |
| `scim.group_name_taken` | `409 uniqueness` | another active group of the organization has this `displayName` |
| `scim.member_unknown` | `400 invalidValue` | a member that is not a SCIM user of this organization |
