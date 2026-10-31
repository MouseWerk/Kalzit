# Single sign-on API: identity providers, group mapping, local sign-in

How people sign in through an identity provider (OpenID Connect, SAML 2.0, LDAP and Active
Directory), how the groups a provider sends become organizations, teams and roles, and the rules
for the local password sign-in. Implemented in `server/src/sso/` and `server/src/routes/sso.rs`
(`routes/saml.rs` and `routes/ldap.rs` for their kinds); the screens are on the board
`docs/design/blueprint/Identity.dc.html` (frames 1A to 1D, 5A to 5G, 9).

The conventions of `docs/api/access.md` apply: paths under `/api`, JSON in `camelCase`, ids are
UUIDv7, times Unix milliseconds, request bodies reject unknown fields, errors are
`{"error": {"code", "message", "field"?, "reason"?, "params"?}}`, every change writes an audit
entry in its transaction.

## Model

- A **provider** has a kind (`oidc`, `saml` or `ldap`), a name (the button says "Mit <name> anmelden"), a `slug`
  (part of its redirect URI, fixed once created), a place among the buttons on the sign-in page
  (`position`) and can be paused (`enabled: false`): its people stay, but cannot sign in through
  it. Its client secret is stored encrypted with the server's secrets key and never sent back.
- An **identity** links a person at a provider (the provider's `sub`) to a Kalzit account. It
  keeps the groups of the last sign-in, which the mapping preview uses.
- A **group mapping** gives the members of a provider group a role in an organization, and
  optionally adds them to one of its teams. Roles are `viewer`, `editor` and `admin`.
  - Several groups for the same organization: the highest role wins, teams add up.
  - `idpDecides: true` ("IdP entscheidet"): role and membership follow the provider at every
    sign-in. The role is locked in Members (changing or removing the member answers
    `409 conflict` with the reason `sso.role_managed`); when no such group matches any more, the
    membership and the teams it gave end at the next sign-in.
  - `idpDecides: false` ("Kalzit ergänzt"): the group gives a minimum role. Admins may give more;
    a lower role is raised at the next sign-in; when the group falls away, the membership stays as
    it is.
  - Mappings never change the break-glass admin (see below), and never demote or remove the last
    enabled owner of an organization.
- **People without a matching group** (`unmapped`): `default` lets them in, with `defaultRole`
  in `defaultOrgId` when one is set (as a minimum role, like "Kalzit ergänzt"); `refuse` refuses
  the sign-in ("Für dein Konto gibt es hier keinen Zugang"). The rule applies at the first and
  every later sign-in, for every provider. Server admins are never refused by it, so a missing
  group mapping cannot lock them out.

## Signing in through a provider

### The buttons: `GET /auth/providers`

Public. What the sign-in page shows.

```json
{
  "providers": [{ "slug": "mueller-sso", "name": "Müller SSO", "kind": "oidc" }],
  "passwordForm": "collapsed",
  "localSignIn": true
}
```

`providers` are the enabled ones in their order. `passwordForm` is `expanded`, `collapsed` (under
the buttons, opened with "Mit Passwort anmelden") or `hidden` (only on the fixed page
`/anmelden/lokal`); without any provider the page shows its plain form whatever it says.
`localSignIn` is `false` when the server turned password sign-in off.

### Start: `GET /auth/sso/{slug}/start?returnTo=/path`

Public; the browser navigates here (a plain link, not `fetch`). Answers `303 See Other` to the
provider's authorization endpoint with the authorization code flow: `response_type=code`, the
configured scopes (always with `openid`), `state`, `nonce`, and PKCE (`code_challenge`,
`S256`) unless turned off for the provider. It sets the short-lived cookie `kalzit_sso`
(`__Host-kalzit_sso` over HTTPS; `HttpOnly`, `SameSite=Lax`, 10 minutes) that binds the sign-in to
this browser. `returnTo` must be a path on this server (`/` followed by anything but `/` or `\`);
anything else becomes `/`.

Starts are rate limited per address (30 per 10 minutes). An unknown or paused provider, or a
provider whose discovery cannot be read, answers `303` to the sign-in page with
`?sso=unavailable` (see below). For a SAML provider the start sends an AuthnRequest instead
(see "SAML 2.0").

### Callback: `GET /auth/oidc/{slug}/callback`

Outside `/api`; this is the redirect URI to register at the provider:
`<public URL>/auth/oidc/<slug>/callback` (`server.public_url`, or the address the admin uses).

The server checks, in this order: the `kalzit_sso` cookie and `state` belong to one unexpired
start for this provider (each start works once, taken together with its cookie); an `iss`
parameter (RFC 9207), when sent, is the provider's issuer; the provider sent no `error`; the code is
exchanged at the token endpoint (with the client secret, `client_secret_basic`, and the PKCE
verifier); the ID token's signature (RS256/384/512, PS256/384/512, ES256/384 or EdDSA, with the
key from the provider's JWKS; an unknown `kid` reloads the keys at most once a minute, so keys
the provider rotates are picked up), `iss` equals the issuer, `aud` contains the client id (and
`azp` is the client id when there are several audiences), `exp` is in the future and `iat`/`nbf`
not in the future (two minutes of clock skew allowed), and `nonce` is the one of the start. The
userinfo endpoint, when the provider has one, adds claims (its `sub` must match). Tokens are
never logged or stored.

Then the account:

1. An identity for this provider and `sub` exists: its account.
2. Otherwise an account with the token's email, when the provider says the email is verified
   (`email_verified: true`, read only when the email claim is `email`; or the provider's switch
   `trustEmail`) and the account's own email is confirmed. Emails are compared in an ASCII form
   (lowercase local part, IDNA domain), whichever form the account was made with (Unicode, NFC or
   NFD, or ASCII); an email with a non-ASCII local part is not used, since Unicode case folding
   makes different addresses look alike. Service accounts are never signed in to or linked
   (`sso=email_taken`, or `sso=failed` for an identity linked to one). Server admins and the break-glass
   admin are never linked by email (`sso=email_taken`). An account whose email is not confirmed
   (`users.email_confirmed`: made from an invitation link an admin passed on) is never taken over:
   `sso=email_taken`. One exception: an account an organization's SCIM made and still owns (no
   password and no identity linked yet, so this is the first link), whose SCIM user is active,
   counts as confirmed for this step (docs/api/scim.md, "Accounts"), so a
   directory's SCIM and its OIDC sign-in on the same address work together. It counts for nothing
   else, and never once the account's owner confirmed the address, it joined another organization,
   or it is a server admin, the break-glass admin or a service account.
3. Otherwise, when the provider may create accounts (`createAccounts`), a new account with the
   email and name of the token and no password (`auth.sso_account_created`). Its email counts as
   confirmed only when the provider verified it (as in 2.); otherwise it is unconfirmed: it cannot
   be added to an organization by that address or linked by email until its owner confirms it by
   mail, and, without a password, a password link gives it none (docs/api/mail.md).
4. Otherwise `sso=no_account`.

A disabled account answers `sso=disabled`, the unmapped rule `refuse` answers `sso=unmapped`
(the memberships the provider decided end then too). The account and its link exist from here on,
since the second step needs an account; it has no rights until the mapping applies. The group
mapping applies only once the sign-in is complete: at once without Kalzit's second factor, after
that step otherwise (one `sso.memberships_changed` entry when it changed something), and the
session opens: `auth.signed_in`.

Whether Kalzit asks for its own second factor after a provider sign-in is the provider's switch
`trustProviderMfa`: off ("Kalzit fragt", the default), Kalzit always asks when the account has a
second factor or must have one; on, Kalzit does not ask when the ID token's `amr` says the
provider checked several factors (`mfa`, or methods of two kinds such as `pwd` and `otp`).

When Kalzit asks for its second factor, the answer is `303` to
`/anmelden?secondFactor=1&redirect=<returnTo>` with the half-signed-in state of
`docs/api/access.md` ("Second factor"); the session opens after that step. Otherwise the answer
is `303` to `returnTo`. Every failure is `303` to
`/anmelden?sso=<outcome>&provider=<slug>&ref=<id>`, records `auth.sso_failed` with the cause
for admins (`{"provider", "ref", "reason", "detail"}`), and the page shows a message that never
names configuration details. `ref` is the error id (`7Q2K-91XD`) that leads admins to the entry.

| Outcome | When |
|---|---|
| `unavailable` | the provider cannot be reached or answers with an error (discovery, keys, token endpoint) |
| `failed` | the provider's answer is not valid (signature, issuer, audience, time, nonce) or it sent an error |
| `cancelled` | the person cancelled at the provider (`access_denied`) |
| `expired` | the sign-in took longer than 10 minutes, was used already, or the browser lost its cookie |
| `disabled` | the account is disabled |
| `unmapped` | no group matches and the rule is `refuse` |
| `no_account` | there is no account and the provider does not create accounts |
| `email_taken` | an account has this email but it is not confirmed, or the provider did not verify the email |

## Local sign-in and break-glass

The server settings `signin.local_password` (`on` or `off`), `signin.password_form`
(`expanded`, `collapsed`, `hidden`) and `signin.break_glass_user` are changed only through
`PUT /admin/sign-in/local`, which checks that nobody is locked out. They can also be set in the
environment (`KALZIT_SETTING_SIGNIN_LOCAL_PASSWORD=on` turns password sign-in back on when every
admin is locked out). An organization may only be stricter: its setting `signin.local_password`
is `inherit` or `off` (`PATCH /orgs/{orgId}/settings/signin.local_password`), and turns password
sign-in off for its members.

With password sign-in off (for the server, or for one of the person's organizations),
`POST /auth/login` answers `403 forbidden` with the reason `sso.password_sign_in_off`, but only
after a correct password, so nobody can probe accounts with it. An organization's `off` never
applies to server admins. With password sign-in off for the server or the inviting organization,
an invitation is accepted through a provider only: `POST /auth/invitation` answers
`password: false` and the providers in `sso`, and accepting with a password answers
`403 forbidden`, reason `sso.password_sign_in_off`; the person signs in through a provider with
the invited address and accepts with the token alone. The break-glass admin signs in
through `POST /auth/login/local`, the form of the fixed, unlinked page `/anmelden/lokal`:

### `POST /auth/login/local`

Public. Same body and answers as `POST /auth/login`. With password sign-in on it works for
everyone like `POST /auth/login`. With it off only the break-glass admin gets in; others get
`sso.password_sign_in_off` after a correct password. The break-glass admin always goes on to the
second factor, and sets one up first if the account has none; their last factor cannot be removed
and an admin cannot reset it (`sso.break_glass_protected`). Every attempt counts against a budget of its
own (10 per address in 15 minutes, `429 rate_limited`), on top of the sign-in limits. A
break-glass sign-in with password sign-in off records `auth.break_glass_signed_in` and sends a mail
to every server admin when a mail server is set up (`docs/api/mail.md`).

### `GET /admin/sign-in/local`

```json
{
  "localPassword": "off",
  "passwordForm": "collapsed",
  "breakGlass": { "userId": "...", "name": "Lea Hoffmann", "email": "lea@..." },
  "readOnly": false,
  "checks": {
    "providerReady": { "ok": true, "name": "Müller SSO" },
    "breakGlassReady": { "ok": true },
    "selfViaProvider": { "ok": true },
    "passwordOnlyAccounts": 3
  }
}
```

`readOnly` is `true` when the environment or `kalzit.toml` sets one of the three settings.
`checks` are what turning password sign-in off needs: an enabled OIDC provider that passed a
connection check (`providerReady`); a break-glass admin who is an enabled server admin with a
password and a second factor (`breakGlassReady`); and the caller can sign in through an enabled provider or is the
break-glass admin (`selfViaProvider`). `passwordOnlyAccounts` counts enabled accounts with a
password and no provider identity.

### `PUT /admin/sign-in/local`

Body: `{"localPassword", "passwordForm", "breakGlassUserId"}` (`breakGlassUserId` may be `null`).
Applies at once (the UI offers undo by sending the previous values) and answers like `GET`. Turning password sign-in
off with a check not met answers `409 conflict` with the reason `sso.local_off_blocked` and the
param `check` (`providerReady`, `breakGlassReady` or `selfViaProvider`). A break-glass admin who
is not an enabled server admin with a password: `422 validation`, field `breakGlassUserId`,
reason `sso.break_glass_invalid`. Audit: `sso.local_changed`.

The break-glass admin cannot be disabled or lose the server admin role while set
(`409 conflict`, reason `sso.break_glass_protected`).

## Administration: `/admin/sign-in`

Server admins only; organization admins cannot map groups to their organization yet.

### Overview: `GET /admin/sign-in`

```json
{
  "providers": [ProviderSummary],
  "accounts": 231,
  "viaProviders": 225,
  "redirectBase": "https://kalzit.mueller.internal",
  "samlBase": "https://kalzit.mueller.internal"
}
```

`ProviderSummary`: `{"id", "slug", "kind", "name", "issuer", "position", "enabled", "people",
"lastSignInAt", "checkedAt", "createAccounts", "trustProviderMfa", "redirectUri"}`. `people`
counts linked accounts, `accounts` all enabled accounts and `viaProviders` those with an identity
at an enabled provider. `redirectBase` is the start of the redirect URI of a provider not saved
yet. `samlBase` is `server.public_url`, from which SAML addresses are built, or `null` while it is
not set. For a SAML provider, `issuer` is its entity ID and `redirectUri` the ACS URL.

### One provider: `GET /admin/sign-in/providers/{providerId}`

```json
{
  "id": "...", "slug": "mueller-sso", "kind": "oidc", "name": "Müller SSO", "enabled": true,
  "position": 0, "version": 3, "createAccounts": true, "trustProviderMfa": false,
  "redirectUri": "https://kalzit.mueller.internal/auth/oidc/mueller-sso/callback",
  "oidc": {
    "issuer": "https://sso.muellersoehne.example/realms/kalzit",
    "clientId": "kalzit", "clientSecretSet": true,
    "scopes": ["openid", "email", "profile", "groups"],
    "groupsClaim": "groups", "emailClaim": "email", "nameClaim": "name",
    "pkce": true, "trustEmail": false
  }
}
```

### The form (`ProviderInput`)

```json
{
  "kind": "oidc", "slug": "mueller-sso", "name": "Müller SSO",
  "createAccounts": true, "trustProviderMfa": false,
  "oidc": {
    "issuer": "https://...", "clientId": "kalzit", "clientSecret": "...",
    "scopes": ["openid", "email", "profile"], "groupsClaim": "groups",
    "emailClaim": "email", "nameClaim": "name", "pkce": true, "trustEmail": false
  }
}
```

`clientSecret` is required for a new provider; when editing, leave it out to keep the stored one.
The stored secret is only used with the stored issuer and client id: a form with another one must
bring the secret again (`sso.client_secret_required` on `clientSecret`), so it never reaches an
address it was not given for.
`issuer` is an `https://` URL (`http://` only for `localhost` and loopback addresses) without
credentials, query or fragment. `slug` is 1 to 40 of `a-z`, `0-9` and `-`, starting with a letter
or digit, unique. Claims are 1 to 100 characters; `scopes` at most 20, each 1 to 100 of printable
ASCII without spaces.

### Check: `POST /admin/sign-in/providers/check`

Body: `ProviderInput`, plus `providerId` when editing (for the stored secret). Reads the
discovery document (`<issuer>/.well-known/openid-configuration`, whose `issuer` must match
exactly), loads the keys from `jwks_uri`, and offers the client to the token endpoint with a
made-up code: `invalid_grant` means the client was accepted, `invalid_client` that the id or the
secret is wrong. Answers

```json
{ "checkToken": "...", "keys": 2, "durationMs": 210, "clientAccepted": true }
```

`clientAccepted` is `null` when the provider's answer does not say. Failures are
`422 validation` with `field` (`issuer`, `clientId`, `clientSecret`) and a reason below. The
`checkToken` is valid for 30 minutes and only for this issuer, client id and secret.

### Create, change, remove

- `POST /admin/sign-in/providers`: `ProviderInput` and `checkToken`. `201` with the provider.
  Audit `sso.provider_created`.
- `PUT /admin/sign-in/providers/{providerId}`: `ProviderInput`, `version` and, when the issuer,
  client id or secret changed, `checkToken`. Subjects are only unique per issuer, so a new issuer
  needs `confirmIssuerChange: true` while people are linked (`409 conflict`, reason
  `sso.issuer_change_confirm`, param `people`); the links, the groups and what the provider
  decided for them are then removed: the memberships and teams it gave under "IdP entscheidet"
  end (one `sso.memberships_changed` per person) and the links go (audit
  `sso.provider_identities_removed`). A sign-in never
  uses a link made through another issuer. Without a valid one: `422 validation`, reason
  `sso.check_required`. A stale `version`: `409 version_conflict`. Audit `sso.provider_updated`
  with the changed field names.
- `PATCH /admin/sign-in/providers/{providerId}/enabled`: `{"enabled": false}` pauses, `true`
  resumes. Audit `sso.provider_paused` or `sso.provider_resumed`.
- `PUT /admin/sign-in/order`: `{"ids": [...]}`, every provider exactly once. Audit
  `sso.providers_reordered`.
- `DELETE /admin/sign-in/providers/{providerId}`: only without people (`409 conflict`, reason
  `sso.provider_in_use`, param `people`; pause it instead). Its mappings go with it. Audit
  `sso.provider_deleted`.

### Test sign-in

`POST /admin/sign-in/test-sign-ins` with `ProviderInput`, `providerId` (when editing) and
`checkToken` answers `201 {"id", "url"}`. The UI opens `url` in a new window; the person signs in
at the provider and lands on `/anmelden/sso-test`. Nobody is signed in to Kalzit by it.
`GET /admin/sign-in/test-sign-ins/{testId}` (only for the admin who started it, 10 minutes):

```json
{
  "status": "done",
  "result": {
    "subject": "f3a1...", "username": "l.hoffmann", "email": "lea@...",
    "groups": ["kalzit-admins", "vertrieb-analyse"],
    "outcome": Outcome
  }
}
```

`status` is `pending`, `done` or `failed` (then `error: {"reason", "message"}` with the outcome
codes of the callback as reasons `sso.outcome_<outcome>`).

### Group mappings

- `GET /admin/sign-in/mappings`:
  `{"mappings": [Mapping], "unmapped": {"rule", "defaultOrgId", "defaultRole"}, "orgs": [{"id",
  "name", "teams": [{"id", "name"}]}]}`; `orgs` lists every organization with its teams to choose
  from, since a server admin need not be a member.
  `Mapping`: `{"id", "providerId", "providerName", "group", "orgId", "orgName", "teamId",
  "teamName", "role", "idpDecides", "people"}`; `people` counts identities of the provider whose
  last sign-in had the group.
- `POST /admin/sign-in/mappings`: `{"providerId", "group", "orgId", "teamId"?, "role",
  "idpDecides"}`, `201` with the mapping. Audit `sso.mapping_created`.
- `PATCH /admin/sign-in/mappings/{mappingId}`: any of those fields (`teamId: null` removes the
  team). Audit `sso.mapping_updated`.
- `DELETE /admin/sign-in/mappings/{mappingId}`: `204`. Audit `sso.mapping_deleted`.
- `PUT /admin/sign-in/unmapped`: `{"rule": "default" | "refuse", "defaultOrgId": string | null,
  "defaultRole": "viewer" | "editor"}`. Answers the rule as stored. Audit `sso.unmapped_changed`.

Changes apply at the next sign-in. Groups are compared exactly (case matters); a group is 1 to
256 characters. The team must belong to the organization.

### Preview: `POST /admin/sign-in/mappings/preview`

Body `{"userId"}`. What the mapping would give the person now, from the groups of their last
sign-ins:

```json
{
  "groups": [{ "providerId": "...", "providerName": "Müller SSO", "groups": ["vertrieb-analyse"] }],
  "outcome": Outcome
}
```

`Outcome` (also in test sign-ins): `{"refused": false, "orgs": [{"orgId", "orgName", "role",
"group", "teams": [{"teamId", "teamName"}], "idpDecides", "default"}]}`. `role` is the
highest mapped role and `group` the group it came from (`null` for the default role); `default: true` marks the default role of
the unmapped rule. `refused` is `true` when the unmapped rule would refuse the person.

### Members

`GET /orgs/{orgId}/members` items carry `"idpManaged": true` when an "IdP entscheidet" mapping
decides the member's role.

## LDAP and Active Directory

An LDAP provider (`kind: "ldap"`) signs people in with their directory account in the password
form of the sign-in page, never with a button of its own (board frame 1B). It uses the same
identities, group mapping, unmapped rule, audit entries and local sign-in rules as OpenID Connect;
implemented in `server/src/sso/ldap.rs`, `server/src/sso/sync.rs` and the LDAP part of
`server/src/routes/sso.rs`.

### Signing in: `POST /auth/login`

With an enabled LDAP provider, the first field of the form is "E-Mail oder Benutzername" and the
server checks the directories first (in the order of the providers), then local accounts:

1. Kalzit binds with the provider's service account (`bindDn`, `bindPassword`) and searches the
   person below `userBaseDn` with `(&(objectClass=…)(<loginAttribute>=<typed>)<userFilter>)`. The
   typed text is escaped for the filter (RFC 4515); for Active Directory with the login attribute
   `sAMAccountName`, `DOMAIN\name` and `name@domain` (matched as `userPrincipalName`) work too.
   Exactly one entry must match. Every sign-in attempt counts against the usual budgets, keyed on
   the login as typed but lowercased and without a `DOMAIN\` prefix, and once the entry is found
   also against a budget of that entry, so `name`, `DOMAIN\name` and the UPN share it.
2. Kalzit binds as that entry with the typed password, on a connection of its own. An empty
   password is refused before anything is sent (an empty password would be an unauthenticated
   bind, which servers accept). Active Directory entries with the `userAccountControl` flag
   "account disabled" (`0x2`) are refused.
3. The groups of the entry: Active Directory reads `memberOf`, or, with `nestedGroups`, searches
   below `groupBaseDn` with `member:1.2.840.113556.1.4.1941:=<dn>`
   (LDAP_MATCHING_RULE_IN_CHAIN, groups in groups); other directories search below `groupBaseDn`
   for `member`, `uniqueMember` or `memberUid`. A group is its DN; mappings name it as the
   directory spells it (compared without regard to case for this provider).
4. The account as for a provider: an identity for the entry's stable id (`objectGUID` for Active
   Directory, `entryUUID` otherwise), else an account with the entry's email (`emailAttribute`;
   trusted for linking only with `trustEmail`, off by default as for OpenID Connect), else a new account when
   `createAccounts` is on. An account the sync disabled (below) is enabled again: the directory
   just confirmed the person; when Kalzit's second factor follows, only once that step succeeds.
   An account an admin enabled or disabled since is never changed by the directory.
5. Kalzit's own second factor always follows when the account has one or must have one (the
   server's or the organization's policy); the mapping applies once the sign-in is complete, as
   for OpenID Connect.

A person the directory does not know, or a wrong directory password, goes on to the local
accounts; when neither confirms the person, the answer is the usual `401 invalid_credentials`,
and the attempt counts against the same sign-in limits. When a directory could not be reached
and the sign-in failed, the answer is `503 busy` with the reason `ldap.directory_unreachable`, whether
or not a local account has the login, so the answer tells nothing about local accounts.
A person the directory confirmed but Kalzit refuses gets `403 forbidden` with the reason
`ldap.sign_in_refused` and the params `outcome` (the outcomes of the provider sign-in:
`disabled`, `unmapped`, `no_account`, `email_taken`, `failed`) and `ref` (the error id of the
`auth.sso_failed` entry). The break-glass form `POST /auth/login/local` never asks a directory,
and "password sign-in off" does not apply to directory accounts.

Connections: at most 16 at once to all directories for sign-ins and checks (more wait up to 5
seconds, then `ldap.directory_unreachable`) and 4 more for syncs, 10 seconds to connect across
all addresses of the server, 10 seconds per operation, 30 seconds per directory for one sign-in
and 10 minutes for the reading of one sync. The target
rules of providers apply (private networks and this computer are allowed, metadata addresses and
Kalzit itself are not).

### Encryption

`encryption` is `ldaps` (TLS from the start, `ldaps://`, port 636 by default) or `starttls`
(`ldap://`, then StartTLS before anything else is sent). `none` is allowed only for a host on
this computer or in a private network (loopback, RFC 1918, unique local IPv6; a name must resolve
only to such addresses), the same rule as the default TLS policy of data sources; for any other
host it is refused, also from `kalzit.toml`. An `ldaps://` URL with `starttls`, or `ldap://` with
`ldaps`, is refused at the field. Certificates are checked against the system's certificate store,
or against the CAs in `caPem` (`certificate: "custom"`).

### The form (`LdapInput`)

```json
{
  "slug": "zentrale", "name": "Verzeichnis Zentrale", "createAccounts": true,
  "ldap": {
    "flavor": "ad",
    "url": "ldaps://dc01.zentrale.muellersoehne.example:636",
    "encryption": "ldaps",
    "certificate": "system", "caPem": null,
    "bindDn": "CN=svc-kalzit,OU=Dienste,DC=zentrale,DC=muellersoehne,DC=example",
    "bindPassword": "...",
    "userBaseDn": "OU=Mitarbeitende,DC=zentrale,DC=muellersoehne,DC=example",
    "loginAttribute": "sAMAccountName",
    "userFilter": "(department=Vertrieb)",
    "groupBaseDn": "OU=Gruppen,DC=zentrale,DC=muellersoehne,DC=example",
    "nestedGroups": true,
    "emailAttribute": "mail", "nameAttribute": "displayName",
    "trustEmail": false,
    "syncSchedule": "daily", "syncHour": 2, "syncThreshold": 10
  }
}
```

- `flavor`: `ad` (Active Directory) or `ldap`. `loginAttribute`: `sAMAccountName`,
  `userPrincipalName` or `mail` for `ad`; `uid`, `mail` or `cn` for `ldap`.
- `bindPassword` is required for a new provider; when editing, leave it out to keep the stored
  one. The stored password is only used with the stored `url`, `bindDn`, `encryption`,
  `certificate` and `caPem`: a form with another one must bring it again (`ldap.bind_password_required`). It is stored encrypted with the
  server's secrets key and never sent back (`bindPasswordSet: true`).
- DNs are 1 to 1024 characters; `userFilter` is empty or one parenthesized filter (at most 1024
  characters, balanced parentheses); attributes are 1 to 64 of letters, digits and `-`.
  `groupBaseDn` empty means `userBaseDn`. `nestedGroups` only applies to `ad`.
- `trustEmail` (off by default) links a directory person to an existing local account with the
  same confirmed address at the first sign-in, as for OpenID Connect (never a server admin, the
  break-glass admin, a service account or an unconfirmed account). Turn it on only when people
  cannot change their own mail attribute in the directory: whoever can set an address there could
  otherwise take over the local account that has it. Off, such a person gets
  `outcome: email_taken`. The sync takes over a changed address only when no other account has
  it, and with `trustEmail` off the new address counts as unconfirmed.
- `syncSchedule`: `daily` (at `syncHour`, 0 to 23, server time), `every6h` or `off`.
  `syncThreshold`: 1 to 100, the percentage of the provider's accounts a sync may disable before
  it halts (default 10).

`GET /admin/sign-in/providers/{providerId}` answers an LDAP provider with `"kind": "ldap"` and
`"ldap": {…}` (the form's fields without `bindPassword`, with `bindPasswordSet`) instead of
`oidc`; `ProviderSummary.issuer` is its `url`, and `ProviderSummary.flavor` is `ad` or `ldap`
(`null` for other kinds).

### Check: `POST /admin/sign-in/ldap/check`

Body: `LdapInput`, plus `providerId` when editing (for the stored password) and optionally
`testLogin` and `testPassword` ("Testanmeldung mit"). Connects, binds with the service account,
reads `userBaseDn` (and `groupBaseDn`) and searches a few people and groups; with `testLogin` it
also finds that person, binds as them when `testPassword` is given, and reads their groups and
what the mapping would give them. Answers

```json
{
  "checkToken": "...", "durationMs": 180, "tls": "LDAPS",
  "sample": { "users": ["e.schroeder", "g.vogel"], "groups": ["CN=Kalzit-Leser,OU=Gruppen,…"] },
  "test": { "dn": "CN=Lea Hoffmann,…", "login": "l.hoffmann", "email": "lea@…", "name": "Lea Hoffmann",
            "disabled": false, "bound": true, "groups": ["CN=Kalzit-Leser,OU=Gruppen,…"], "outcome": Outcome }
}
```

`tls` is `LDAPS`, `StartTLS` or `null` for an unencrypted connection, `test` is `null` without `testLogin`. Failures are
`422 validation` with `field` (`url`, `encryption`, `caPem`, `bindDn`, `bindPassword`,
`userBaseDn`, `groupBaseDn`, `userFilter`, `testLogin`, `testPassword`) and a reason below; the
check stops at the first failing step. The `checkToken` is valid for 30 minutes and only for this
URL, encryption, certificate, bind DN and password.

### Create and change

- `POST /admin/sign-in/ldap`: `LdapInput` and `checkToken`. `201` with the provider. Audit
  `sso.provider_created` (`kind: "ldap"`).
- `PUT /admin/sign-in/ldap/{providerId}`: `LdapInput`, `version` and, when the URL, encryption,
  certificate, bind DN or password changed, `checkToken`. Audit `sso.provider_updated`.
  `PUT /admin/sign-in/providers/{providerId}` refuses an LDAP provider (and the LDAP route an
  OpenID Connect one) with `422`, reason `sso.kind_mismatch`.

Pausing, ordering and removing work as for every provider. A connection check of an LDAP provider
counts for "an enabled provider that passed a connection check" when password sign-in is turned
off.

### Sync

A sync reads the people and groups below `userBaseDn` and, for every account linked to the
provider: updates name, email (when no other account has it) and groups, and applies the group
mapping as a sign-in would; disables the account (and ends its sessions) when the entry is gone
or outside the filter (`not_in_directory`), disabled in Active Directory
(`disabled_in_directory`), or no longer in any mapped group while the unmapped rule is `refuse`
(`no_mapped_group`); and enables again an account it disabled whose entry is fine again. It never
deletes an account, and never disables the break-glass admin, the last enabled server admin or the
last enabled owner of an organization (those are skipped and counted in `skipped`).

It runs on one server only (the leader of a cluster), at the provider's schedule, and on demand.
When it would disable more than `syncThreshold` percent of the provider's enabled accounts, it
**halts** before changing anything: the run keeps the list, every server admin gets a mail (when a
mail server is set up), and an admin may apply it anyway. A failed run changes nothing.

- `GET /admin/sign-in/providers/{providerId}/sync`:

  ```json
  {
    "schedule": "daily", "hour": 2, "threshold": 10, "nextRunAt": 1793500000000,
    "failuresInRow": 0, "runs": [SyncRun], "deactivated": [Deactivated]
  }
  ```

  `runs` are the last 20, newest first. `Deactivated`: `{"userId", "name", "email", "login",
  "at", "reason"}`, the accounts the sync disabled that are still disabled.
- `POST /admin/sign-in/providers/{providerId}/sync` ("Jetzt abgleichen"): runs a sync now and
  answers its `SyncRun` (`409 conflict`, reason `ldap.sync_running`, while one runs).
- `GET /admin/sign-in/providers/{providerId}/sync/runs/{runId}`: the `SyncRun` with `pending`,
  the accounts a halted run would disable: `[{"userId", "name", "email", "login", "reason"}]`.
- `POST /admin/sign-in/providers/{providerId}/sync/runs/{runId}/apply` ("Trotzdem anwenden"):
  needs a second factor confirmed in this session within the last 5 minutes
  (`403 confirmation_required`; an admin without a second factor gets `409 conflict`, reason
  `ldap.sync_needs_second_factor`). Runs the sync again without the threshold, but disables only
  accounts from the halted run's list; answers the new `SyncRun` and marks the halted one
  `applied`. A run that is not halted: `409 conflict`, reason `ldap.sync_not_halted`.

`SyncRun`: `{"id", "trigger": "schedule" | "manual" | "apply", "status": "running" | "done" |
"halted" | "failed" | "applied", "startedAt", "finishedAt", "checked", "changed", "deactivated",
"reactivated", "skipped", "wouldDeactivate", "accounts", "threshold", "error", "appliedBy",
"appliedAt"}`. `checked` counts the directory entries read, `accounts` the provider's enabled
accounts at the start, `error` is an English text for a failed run.

Audit: `ldap.sync_finished`, `ldap.sync_halted`, `ldap.sync_failed`, `ldap.sync_applied` (with
the admin), and per account `user.disabled` / `user.enabled` with `"cause": "ldap_sync"` and the
reason.

## SAML 2.0

Kalzit is the service provider of the SAML 2.0 Web Browser SSO profile. The AuthnRequest goes to
the provider with the HTTP-Redirect binding, the answer comes back to the ACS with HTTP-POST.
SAML providers share the model above: the buttons, the group mapping, accounts and the second
factor work as for OpenID Connect. XML signatures are checked by bergshamra (pure Rust, no
libxml2 or xmlsec), through gamlastan's hardened parser.

All SAML addresses are built from `server.public_url` and never from the request's headers, so
they stay the same behind a proxy or under a sub-path. Without it, the check, saving and sign-in
answer `saml.public_url_missing`.

| Address | |
|---|---|
| `<public URL>/auth/saml/<slug>` | Kalzit's entity ID for the provider (the audience it must name) |
| `<public URL>/auth/saml/<slug>/acs` | the assertion consumer service (HTTP-POST) |
| `<public URL>/auth/saml/<slug>/metadata` | Kalzit's metadata (`application/samlmetadata+xml`): the entity ID, the ACS and `WantAssertionsSigned`; public and stable, to give to the provider |

### Signing in

`GET /auth/sso/{slug}/start` sends `303` to the provider's sign-in URL with an unsigned
AuthnRequest (Kalzit holds no SAML key; the answer is what is checked) whose ID is a fresh random
value, kept as the single-use request of this sign-in (10 minutes), and sets the `kalzit_sso`
cookie as for OpenID Connect.

`POST /auth/saml/{slug}/acs` (outside `/api`, the provider's form post; exempt from the origin
check, since it acts on no cookie) takes `SAMLResponse` and checks, in this order:

1. The XML parses with DTDs, entities, comments, processing instructions and CDATA refused (so a
   comment cannot split a NameID), and is at most 256 KiB.
2. Its `InResponseTo` names an unexpired, unused request (taken once, so the same answer never
   works twice). An answer without `InResponseTo` is an IdP-initiated sign-in, which Kalzit does
   not accept (`saml.unsolicited`).
3. The document holds exactly one `Assertion` anywhere (none in `Advice`, none encrypted), as a
   child of the `Response`, and every ID in it is unique.
4. `Status` is `Success`.
5. Every signature sits on the `Response` or that `Assertion`, at most one on each (more are
   refused before any signature is checked), references exactly that element
   (`#ID`), uses enveloped-signature and exclusive or inclusive C14N without comments, RSA or
   ECDSA with SHA-256 or stronger (SHA-1 is refused), carries no `Object`, and verifies with one
   of the pinned certificates; keys in the message's `KeyInfo` are never used, and a pinned
   certificate's dates are not checked. The signature check names the nodes it verified in the
   same parsed document: the consumed `Assertion` must be one of them, or a child of the verified
   `Response`. So the assertion that is read is the one that is signed (no signature wrapping).
6. The `Response`'s `InResponseTo` is the request, its `Destination` the ACS, its `Issuer` (when
   present) the provider's entity ID.
7. The assertion's `Issuer` is the provider's entity ID; its subject has a `NameID` (not
   `transient`) and a bearer `SubjectConfirmationData` with the ACS as `Recipient`, the request
   as `InResponseTo`, no `NotBefore` and a `NotOnOrAfter` in the future; its `Conditions` have
   `NotBefore` not in the future and `NotOnOrAfter` in the future (two minutes of clock skew
   allowed) and every `AudienceRestriction` names Kalzit's entity ID; it has an
   `AuthnStatement` whose `SessionNotOnOrAfter`, when present, is in the future.
8. The assertion ID was not used before (replay): it is remembered, per entity ID, until its
   earliest `NotOnOrAfter` plus the skew (`saml_assertions`).

The ACS then keeps the checked assertion with the sign-in and answers `303` to
`<public URL>/auth/saml/<slug>/finish?s=<id>`. A cross-site POST carries no `SameSite=Lax`
cookie, so the session opens only in that same-site step, which needs the `kalzit_sso` cookie of
the browser that started the sign-in: an answer posted from another browser ends there
(`sso.state_unknown`). From there it goes on as the OIDC callback ("Then the account"), with the
`NameID` as the subject and the provider's entity ID as its issuer. Failures answer as there, with
the reasons of the table below in the audit entry.

The person: the email from the email attribute (`mail` by default), else a `NameID` of the format
`emailAddress`; the name from the name attribute (`displayName`); the groups are every value of the
groups attribute (`memberOf`), kept whole (a DN has commas). Attributes match by `Name` or
`FriendlyName`. SAML has no "email verified": an email counts as verified only with the
provider's switch `trustEmail` (off by default). `trustProviderMfa` (off, "Kalzit fragt", by
default) skips Kalzit's second factor when the assertion's `AuthnContextClassRef` says the
provider checked several factors (REFEDS MFA, `multipleauthn` as AD FS sends it,
`MobileTwoFactor*`, `TimeSyncToken`, `SmartcardPKI`). Attributes never count, Entra ID's
`authnmethodsreferences` included: Entra ID reports MFA there and not in the context, so with
Entra ID Kalzit asks for its own second factor.

Single logout is not offered: signing out of Kalzit ends the Kalzit session only, and the
provider's session stays. Encrypted assertions and signed AuthnRequests are not supported.

### One provider

`GET /admin/sign-in/providers/{providerId}` for a SAML provider:

```json
{
  "id": "...", "slug": "partnerportal", "kind": "saml", "name": "Partnerportal", "enabled": true,
  "position": 1, "version": 2, "createAccounts": true, "trustProviderMfa": false, "checkedAt": 1793000000000,
  "spEntityId": "https://kalzit.mueller.internal/auth/saml/partnerportal",
  "acsUrl": "https://kalzit.mueller.internal/auth/saml/partnerportal/acs",
  "spMetadataUrl": "https://kalzit.mueller.internal/auth/saml/partnerportal/metadata",
  "saml": {
    "metadataUrl": "https://idp.partnerportal.example/saml/metadata.xml",
    "idpEntityId": "https://idp.partnerportal.example/saml",
    "ssoUrl": "https://idp.partnerportal.example/saml/sso",
    "certificates": ["MIIC..."],
    "certificateInfo": [{ "fingerprint": "3A:...:9F", "subject": "CN=idp.partnerportal.example",
                          "notAfter": 1830000000000, "expired": false }],
    "emailAttribute": "mail", "nameAttribute": "displayName", "groupsAttribute": "memberOf",
    "trustEmail": false
  }
}
```

The three addresses are `null` while `server.public_url` is not set.

### The form (`SamlInput`)

```json
{
  "kind": "saml", "slug": "partnerportal", "name": "Partnerportal",
  "createAccounts": true, "trustProviderMfa": false,
  "saml": {
    "metadataUrl": "https://idp.partnerportal.example/saml/metadata.xml",
    "metadataXml": "<md:EntityDescriptor ...>",
    "idpEntityId": "https://idp.partnerportal.example/saml",
    "ssoUrl": "https://idp.partnerportal.example/saml/sso",
    "certificates": ["-----BEGIN CERTIFICATE-----..."],
    "emailAttribute": "mail", "nameAttribute": "displayName", "groupsAttribute": "memberOf",
    "trustEmail": false
  }
}
```

The provider's entity ID, sign-in URL (its `SingleSignOnService` for HTTP-Redirect, `https://`
or `http://` to loopback) and signing certificates are **pinned**: read once from the metadata or
typed in, checked, and changed only by an admin, never by the provider. One certificate, or two
during a rollover (both are accepted until the old one is removed); PEM or bare base64. Attribute
names have 1 to 256 characters.

### Check: `POST /admin/sign-in/saml/check`

Takes the form. With `metadataXml` (an uploaded file, at most 1 MB) or `metadataUrl` (read with
the same address rules as an OIDC discovery), the metadata names the provider's values: an
`EntityDescriptor`, or an `EntitiesDescriptor` with exactly one identity provider; its signing
`KeyDescriptor` certificates (at most two). Without either, the values as typed are checked.
Answers what it found, ready to save, with a `checkToken` (30 minutes) for exactly these values:

```json
{
  "checkToken": "...", "durationMs": 120,
  "saml": { "metadataUrl": "...", "idpEntityId": "...", "ssoUrl": "...", "certificates": ["MIIC..."] },
  "certificates": [{ "fingerprint": "3A:...:9F", "subject": "CN=...", "notAfter": 1830000000000, "expired": false }],
  "spEntityId": "...", "acsUrl": "...", "spMetadataUrl": "..."
}
```

Every problem is answered at its field (`metadataUrl`, `metadataXml`, `idpEntityId`, `ssoUrl`,
`certificates`, an attribute).

### Create, change and test

`POST /admin/sign-in/saml` creates (`201`), `PUT /admin/sign-in/saml/{providerId}` changes (with
`version`); both take the form with the provider's values the check found and its `checkToken`.
A change keeps the stored trust without a new check as long as the entity ID, sign-in URL and
certificates stay the same. A new entity ID removes the links of the people who signed in
through the old one, after `confirmIssuerChange: true` (`sso.issuer_change_confirm` on
`idpEntityId`), as a new OIDC issuer does. The metadata is never read again on its own; a new
check reads it.

`POST /admin/sign-in/saml/test-sign-ins` takes the form with its `checkToken` and answers
`201 {"id", "url"}`: open `url` to sign in at the provider. The ACS and finish steps then keep the
result instead of signing in; `GET /admin/sign-in/test-sign-ins/{testId}` answers it as for OIDC.
A failed test names the reason of the table below, with its `params`.

Pausing, ordering, removing and the group mapping are the routes of every provider.

## Reasons

| Reason | Params | When |
|---|---|---|
| `sso.slug_invalid` | | `422` on `slug`: not 1 to 40 of `a-z`, `0-9`, `-`, starting with a letter or digit |
| `sso.slug_taken` | | `409 conflict` on `slug`: another provider has it |
| `sso.issuer_invalid` | | `422` on `issuer`: not an `https://` URL (or `http://` for loopback) without credentials, query or fragment |
| `sso.issuer_mismatch` | `issuer` | `422` on `issuer`: the discovery document names another issuer |
| `sso.discovery_unreachable` | `detail` | `422` on `issuer`: the discovery document cannot be read |
| `sso.discovery_invalid` | `detail` | `422` on `issuer`: the discovery document lacks an endpoint or is not JSON |
| `sso.keys_unreachable` | `detail` | `422` on `issuer`: the provider's keys (`jwks_uri`) cannot be read |
| `sso.keys_invalid` | | `422` on `issuer`: the provider offers no key Kalzit can use |
| `sso.token_unreachable` | `detail` | `422` on `issuer`: the token endpoint cannot be reached or gives no usable answer |
| `sso.client_rejected` | | `422` on `clientSecret`: the token endpoint refused the client id or secret |
| `sso.client_id_required` | | `422` on `clientId`: empty |
| `sso.client_secret_required` | | `422` on `clientSecret`: a new provider needs a secret |
| `sso.claim_invalid` | | `422` on a claim field: empty, longer than 100 or with control characters |
| `sso.scopes_invalid` | | `422` on `scopes`: more than 20, or one is empty, too long or has spaces |
| `sso.check_required` | | `422` on `issuer`: the connection was not checked with these values (or the check is older than 30 minutes) |
| `sso.issuer_change_confirm` | `people` | `409 conflict` on `issuer`: changing the issuer removes the links of `people` people; send `confirmIssuerChange: true` |
| `sso.provider_in_use` | `people` | `409 conflict`: people sign in through the provider; pause it instead |
| `sso.group_invalid` | | `422` on `group`: empty, longer than 256 or with control characters |
| `sso.role_invalid` | | `422` on `role` or `defaultRole`: not one of the roles a mapping may give |
| `sso.org_unknown` | | `422` on `orgId` or `defaultOrgId`: no such organization |
| `sso.team_unknown` | | `422` on `teamId`: no such team in the organization |
| `sso.role_managed` | | `409 conflict`: an "IdP entscheidet" group mapping decides this member's role |
| `sso.password_sign_in_off` | | `403 forbidden`: password sign-in is off for this account; sign in through a provider |
| `sso.local_off_blocked` | `check` | `409 conflict`: password sign-in cannot be turned off while `check` is not met |
| `sso.break_glass_invalid` | | `422` on `breakGlassUserId`: not an enabled server admin with a password |
| `sso.break_glass_protected` | | `409 conflict`: the break-glass admin cannot be disabled or lose the server admin role |
| `sso.settings_read_only` | | `409 conflict`: the environment or `kalzit.toml` sets the sign-in settings |
| `sso.test_unknown` | | `404`-like answer of a test sign-in that does not exist, expired or belongs to someone else (`not_found`) |
| `sso.outcome_unavailable` | | test sign-in: the provider could not be reached |
| `sso.outcome_failed` | | test sign-in: the provider's answer was not valid |
| `sso.outcome_cancelled` | | test sign-in: cancelled at the provider |
| `sso.outcome_expired` | | test sign-in: took too long or was used already |
| `sso.outcome_email_taken` | | test sign-in: the email belongs to an unconfirmed account, or the provider did not verify it |
| `sso.kind_mismatch` | | `422`: the route is for another kind of provider (OpenID Connect, SAML or LDAP) |
| `saml.public_url_missing` | | `422`: `server.public_url` is not set; SAML addresses are built from it (also an audit cause at sign-in) |
| `saml.metadata_url_invalid` | | `422` on `metadataUrl`: not an `https://` URL (or `http://` for loopback) |
| `saml.metadata_unreachable` | `detail` | `422` on `metadataUrl`: the metadata cannot be read |
| `saml.metadata_invalid` | `detail` | `422` on `metadataUrl` or `metadataXml`: not SAML metadata of one identity provider with an HTTP-Redirect sign-in and one or two signing certificates |
| `saml.entity_id_invalid` | | `422` on `idpEntityId`: empty, longer than 1024 or with control characters |
| `saml.sso_url_invalid` | | `422` on `ssoUrl`: not an `https://` URL (or `http://` for loopback) |
| `saml.certificate_required` | | `422` on `certificates`: none given |
| `saml.certificate_invalid` | `detail` | `422` on `certificates`: not an X.509 certificate in PEM or base64, or more than two |
| `saml.attribute_invalid` | | `422` on `emailAttribute`, `nameAttribute` or `groupsAttribute`: longer than 256 or with control characters |
| `saml.check_required` | | `422` on `idpEntityId`: the values were not checked (or the check is older than 30 minutes) |
| `saml.response_missing` | | sign-in or test: the provider posted no `SAMLResponse` |
| `saml.xml_invalid` | | sign-in or test: not base64, UTF-8 or XML, too large, or with a DTD, entity, comment, processing instruction or CDATA |
| `saml.not_response` | | sign-in or test: not a SAML 2.0 `Response` |
| `saml.status` | | sign-in or test: the provider answered another status than `Success` (`detail` has its URI when it is one of SAML core's status codes, else `other`; `AuthnFailed` and `RequestDenied` read as cancelled) |
| `saml.unsolicited` | | sign-in: no `InResponseTo` (an IdP-initiated sign-in) |
| `saml.request_unknown` | | sign-in or test: no unexpired, unused request has this ID |
| `saml.in_response_to` | | sign-in or test: the response or its confirmation answers another request |
| `saml.destination` | | sign-in or test: the `Destination` is not the ACS, or the public address changed during the sign-in |
| `saml.issuer` | | sign-in or test: the response or assertion comes from another entity ID |
| `saml.assertion_count` | | sign-in or test: not exactly one assertion in the document |
| `saml.encrypted_assertion` | | sign-in or test: an encrypted assertion or NameID |
| `saml.unsigned` | | sign-in or test: no signature |
| `saml.signature_invalid` | | sign-in or test: a signature does not verify with the pinned certificates |
| `saml.signature_unsupported` | | sign-in or test: a signature uses another method, transform or form than listed above, or an element has more than one |
| `saml.wrapping` | | sign-in or test: a signature is elsewhere or signs another element than the assertion that would be read, or IDs repeat |
| `saml.subject_missing` | | sign-in or test: no NameID or no bearer confirmation |
| `saml.name_id_transient` | | sign-in or test: a transient NameID, which names nobody twice |
| `saml.recipient` | | sign-in or test: the confirmation's `Recipient` is not the ACS |
| `saml.audience` | | sign-in or test: no audience restriction, or one without Kalzit's entity ID |
| `saml.expired` | | sign-in or test: a `NotOnOrAfter` or `SessionNotOnOrAfter` passed (two minutes of skew allowed) |
| `saml.not_yet_valid` | `minutes` | sign-in or test: `NotBefore` lies more than two minutes ahead; the provider's clock is `minutes` ahead |
| `saml.authn_missing` | | sign-in or test: no `AuthnStatement` |
| `saml.replay` | | sign-in or test: the assertion ID was used before |
| `ldap.url_invalid` | | `422` on `url`: not an `ldap://` or `ldaps://` URL with a host, or with credentials, a path, query or fragment |
| `ldap.plain_not_allowed` | | `422` on `url`: an unencrypted connection to a host that is not on this computer or in a private network |
| `ldap.scheme_conflict` | | `422` on `encryption`: `ldaps://` with StartTLS, or `ldap://` with LDAPS |
| `ldap.dn_invalid` | | `422` on `bindDn`, `userBaseDn` or `groupBaseDn`: empty (where required), longer than 1024 characters or not a DN |
| `ldap.filter_invalid` | | `422` on `userFilter`: not one parenthesized filter with balanced parentheses |
| `ldap.attribute_invalid` | | `422` on `loginAttribute`, `emailAttribute` or `nameAttribute`: not an attribute name, or a login attribute the flavor does not offer |
| `ldap.bind_password_required` | | `422` on `bindPassword`: a new provider, or a changed URL, bind DN, encryption or certificate, needs it |
| `ldap.ca_invalid` | | `422` on `caPem`: no PEM certificate, or one that cannot be read |
| `ldap.threshold_invalid` | | `422` on `syncThreshold`: not 1 to 100 |
| `ldap.schedule_invalid` | | `422` on `syncSchedule` or `syncHour`: not `daily`, `every6h` or `off`, or an hour outside 0 to 23 |
| `ldap.unreachable` | `detail` | `422` on `url`: the server cannot be reached |
| `ldap.timeout` | | `422` on `url`: the server did not answer within 10 seconds |
| `ldap.target_refused` | `detail` | `422` on `url`: the address is a metadata address or Kalzit itself |
| `ldap.certificate_untrusted` | `detail` | `422` on `caPem`: the server's certificate is not trusted, expired or names another host |
| `ldap.tls_failed` | `detail` | `422` on `encryption`: StartTLS was refused or the TLS handshake failed |
| `ldap.bind_failed` | `code`, `detail` | `422` on `bindPassword`: the service account's bind was refused (`code` is the LDAP result code, `detail` the server's text, such as Active Directory's `data 52e`) |
| `ldap.base_not_found` | | `422` on `userBaseDn`: no such entry (result code 32) |
| `ldap.group_base_not_found` | | `422` on `groupBaseDn`: no such entry (result code 32) |
| `ldap.search_failed` | `code`, `detail` | `422` on `userFilter`: the search was refused |
| `ldap.test_user_not_found` | | `422` on `testLogin`: no entry matches the login below the base DN with the filter |
| `ldap.test_user_ambiguous` | | `422` on `testLogin`: more than one entry matches |
| `ldap.test_user_disabled` | | `422` on `testLogin`: the entry is disabled in Active Directory |
| `ldap.test_bind_failed` | `code` | `422` on `testPassword`: the bind as the test person was refused |
| `ldap.check_required` | | `422` on `url`: the connection was not checked with these values (or the check is older than 30 minutes) |
| `ldap.directory_unreachable` | | `503` at sign-in: a directory could not be reached and the sign-in failed (whether or not a local account has the login) |
| `ldap.sign_in_refused` | `outcome`, `ref` | `403 forbidden` at sign-in: the directory confirmed the person, but Kalzit refuses the sign-in |
| `ldap.sync_running` | | `409 conflict`: a sync of this provider is running |
| `ldap.sync_not_halted` | | `409 conflict`: the run is not halted, or was applied already |
| `ldap.sync_needs_second_factor` | | `409 conflict`: "apply anyway" needs a second factor; set one up first |

## Causes in the audit log

`auth.sso_failed` entries carry one of the reasons above (the `saml.*` ones of a SAML sign-in
among them) or one of these as `reason`, with an English `detail`; the person only sees the
outcome. They are not answered as API errors.

| Cause | When |
|---|---|
| `sso.state_missing` | the provider sent the browser back without `state` |
| `sso.state_unknown` | no unexpired, unused sign-in has this `state` for this browser |
| `sso.provider_unavailable` | the provider was paused or removed during the sign-in |
| `sso.provider_error` | the provider answered with an `error` (its code is in `detail`) |
| `sso.code_missing` | the provider sent no authorization code |
| `sso.token_refused` | the token endpoint refused the code |
| `sso.token_invalid` | the token endpoint's answer has no ID token or is not JSON |
| `sso.id_token_invalid` | the ID token failed a check (signature, issuer, audience, time, nonce) |
| `sso.userinfo_failed` | the userinfo endpoint failed or spoke about another subject |
| `sso.issuer_is_kalzit` | an address of the provider points at this Kalzit server |
| `sso.email_missing` | a new person came without a usable email |
| `sso.email_unverified` | an account has the email, but the provider or the account did not confirm it |
| `sso.no_account` | no account matches and the provider does not create accounts |
| `sso.account_disabled` | the account is disabled |
| `sso.unmapped` | no group matches and the unmapped rule refuses |
| `sso.internal` | the server failed (its log has the request) |
| `sso.iss_mismatch` | the answer's `iss` parameter (RFC 9207) names another issuer |
| `sso.identity_issuer_mismatch` | the identity was linked through another issuer than the provider has now |
| `sso.email_ambiguous` | two accounts have the address in two forms of its domain, left from before the forms were compared as one (new accounts with another form of a taken address are refused) |
| `sso.email_link_admin` | the email belongs to a server admin or the break-glass admin, who are never linked by email |
| `sso.service_account` | the identity is linked to a service account, or a service account has the email; service accounts never sign in through a provider |
| `ldap.unreachable` | a directory could not be reached at sign-in (`detail` says why) |
| `ldap.service_bind_failed` | the service account's bind was refused at sign-in |
| `ldap.search_failed` | the search for the person failed |
| `ldap.ambiguous_login` | more than one entry matches the typed login |
| `ldap.disabled_in_directory` | the entry is disabled in Active Directory |
| `ldap.id_missing` | the entry has no `objectGUID` or `entryUUID` |
