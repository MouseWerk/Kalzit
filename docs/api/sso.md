# Single sign-on API: identity providers, group mapping, local sign-in

How people sign in through an identity provider (OpenID Connect in this version; SAML 2.0, LDAP
and Active Directory follow on the same model), how the groups a provider sends become
organizations, teams and roles, and the rules for the local password sign-in. Implemented in
`server/src/sso/` and `server/src/routes/sso.rs`; the screens are on the board
`docs/design/blueprint/Identity.dc.html` (frames 1A to 1D, 5A to 5G).

The conventions of `docs/api/access.md` apply: paths under `/api`, JSON in `camelCase`, ids are
UUIDv7, times Unix milliseconds, request bodies reject unknown fields, errors are
`{"error": {"code", "message", "field"?, "reason"?, "params"?}}`, every change writes an audit
entry in its transaction.

## Model

- A **provider** has a kind (`oidc`), a name (the button says "Mit <name> anmelden"), a `slug`
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
`?sso=unavailable` (see below).

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
   `sso=email_taken`. One exception: an account an organization's SCIM made and still owns, whose
   SCIM user is active, counts as confirmed for this step (docs/api/scim.md, "Accounts"), so a
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
  "redirectBase": "https://kalzit.mueller.internal"
}
```

`ProviderSummary`: `{"id", "slug", "kind", "name", "issuer", "position", "enabled", "people",
"lastSignInAt", "checkedAt", "createAccounts", "trustProviderMfa", "redirectUri"}`. `people`
counts linked accounts, `accounts` all enabled accounts and `viaProviders` those with an identity
at an enabled provider. `redirectBase` is the start of the redirect URI of a provider not saved
yet.

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

## Causes in the audit log

`auth.sso_failed` entries carry one of the reasons above or one of these as `reason`, with an
English `detail`; the person only sees the outcome. They are not answered as API errors.

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
