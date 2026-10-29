# Mail API: mail server, invitations, password reset

The mail server Kalzit sends with, invitations to an organization and password links. Implemented
in `server/src/routes/{mail,invitations,password_reset}.rs` and `server/src/mail/`; the design is
in `docs/ARCHITECTURE.md` ("Mail, invitations and password reset"). The conventions of
docs/api/access.md apply (paths under `/api`, errors, paging, `429` with `Retry-After`).

## Links

Invitation and password links carry a random 256-bit token (43 characters, base64url) in the
fragment: `<server.public_url>/invite#<token>` and `<server.public_url>/reset-password#<token>`.
Browsers never send a fragment to a server, so the token stays out of access logs, proxies and
`Referer`; the page sends it in a request body. The database holds only the token's SHA-256; no
token is ever written to a log or the audit log.

Links are built from `server.public_url` only. Without it no link is made: invitations answer
`409 conflict` with reason `mail.public_url_missing`, and password links are unavailable.

## Mail server (server administrators)

| Method and path | What |
|---|---|
| `GET /admin/mail` | The settings in force: `{settings, hasPassword, source, editable, version, publicUrl}` |
| `PUT /admin/mail` | Save `{settings, password?, version}` after a check; `settings: null` removes the mail server |
| `POST /admin/mail/test` | Send a test mail `{settings?, password?, to}` with the values given (or those in force) |

`settings` is `{host, port, security, username, fromName, fromAddress, replyTo}`; `security` is
`starttls` or `tls` (`none` only from `kalzit.toml`, for a relay on this machine); `port` 0 takes
the usual port of `security` (587, 465). `source` is `default` (no mail server), `database` (this
page), `file` or `environment` (`[smtp]` in `kalzit.toml`, `KALZIT_SMTP_*`); from the file or the
environment `editable` is false and `PUT` answers `409 conflict` with `mail.set_in_file`.

The fields depend on each other, so a save is one step: every field is checked, then the server
is connected to and signed in to (nothing is sent), and the first problem is answered as
`422 validation` with `field` and `reason`. Only then are the settings stored, versioned like
other settings (`409 version_conflict` with `current` when someone saved in between) and
audited as `mail.settings_changed` (host, port, encryption, whether a password changed).

`password`: left out keeps the stored password, but only while host, port and user name stay the
same, so a changed host cannot carry it elsewhere (else `mail.password_required`); `""` clears
it. The password is stored encrypted with the secrets key (`server_secrets`), never answered.

The mail server is a target like a data source: its address is resolved and checked once against
the target policy (`datasources.allowed_targets`, metadata addresses, Kalzit's own listeners and
database are refused with the `target.*` reasons) and that address is connected to. Credentials
only go over TLS; a certificate the platform does not trust is refused.

The test mail answers `{reply, elapsedMs, tls, certificateNotAfter}`: the server's last answer
(`250 2.0.0 OK`), the time it took, `TLS 1.3` or `null`, and when the server's certificate
expires. Test mails count against the connection test limit of the administrator.

## Invitations (`users:invite`)

| Method and path | What |
|---|---|
| `GET /orgs/{orgId}/invitations` | Open invitations (pending and expired), newest first, `Page<Invitation>` |
| `POST /orgs/{orgId}/invitations` | Invite `{emails, role, teamId?}`; `201 {items: [{invitation, link}], mailed}` |
| `GET /orgs/{orgId}/invitations/{id}/link` | The link of a pending invitation again `{link, expiresAt}` |
| `POST /orgs/{orgId}/invitations/{id}/resend` | A new link, seven days from now; the old link stops working; `{invitation, link}` |
| `DELETE /orgs/{orgId}/invitations/{id}` | Revoke (pending) or remove (expired); its link then answers like an unknown one |

`Invitation`: `{id, email, role, teamId, teamName, invitedByName, createdAt, expiresAt, state,
delivery, deliveryDetail, deliveredAt}`; `state` is `pending` or `expired`, `delivery` is `none`
(no mail server: the admin copies the link), `pending`, `sent` (the mail server took it) or
`failed` with the server's answer in `deliveryDetail`.

- One request invites 1 to 50 addresses, all or none: an address that is not complete, already a
  member or already invited (pending) is answered with `field` `emails` and the `email` param.
  An expired invitation of the address is replaced.
- The role must be one the caller holds entirely (`403 forbidden` otherwise); a team needs
  `teams:members` and must belong to the organization.
- With a mail server, the mails go out after the invitations are stored; `link` is `null`. When
  the server itself fails, the rest of the batch is marked with the same answer. Without one,
  `link` holds each link for the admin to pass on.
- A link works for seven days and once. While pending, the token is also kept encrypted with the
  secrets key, so `GET .../link` can show it again; accepting clears it.
- Audit: `invitation.created`, `invitation.resent`, `invitation.revoked`, `invitation.link_copied`,
  `invitation.delivery_failed` (the server's answer, addresses removed), `invitation.accepted`.
- Invitations of another organization answer `404 not_found`.

### Accepting (no session needed)

| Method and path | What |
|---|---|
| `POST /auth/invitation` | `{token}`: what the invitation page shows |
| `POST /auth/invitation/accept` | `{token, name?, password?}`: join; answers the user like `GET /me` |

`POST /auth/invitation` answers `{orgName, inviterName, email, role, roleName, teamName,
expiresAt, state, accountExists, signedInAs, password, sso}`; `state` is `valid`, `expired` or
`accepted`. A revoked or unknown token answers `404 not_found` with `mail.invite_invalid`, the
same for both, so valid links cannot be guessed. `sso` lists single sign-on providers the page
offers (empty until single sign-on exists; it accepts through `invitations::redeem` once the
provider confirmed the invited address).

Accepting:

- without a session and without an account for the address: `name` and `password` (the password
  policy of every account) make the account, the membership with the invitation's role and team,
  and a session (`Set-Cookie`);
- with an account for the address: `409 conflict` `mail.invite_account_exists`; sign in, then
  accept with the token alone;
- signed in as the invited address: joins with the token alone; the session stays;
- signed in as another account: `409 conflict` `mail.invite_other_account`;
- expired: `mail.invite_expired`; accepted already: `mail.invite_used`.

## Password reset

| Method and path | Access | What |
|---|---|---|
| `GET /auth/password-reset` | public | `{available}`: a mail server and `server.public_url` are set |
| `POST /auth/password-reset` | public | `{email}`: `202 {accepted: true}`, always the same |
| `POST /auth/password-reset/inspect` | public | `{token}`: `{email, expiresAt}` |
| `POST /auth/password-reset/complete` | public | `{token, password, signOutEverywhere?}`: `204` |
| `POST /orgs/{orgId}/members/{userId}/password-link` | `users:write` | Send the member the link; answers like a test mail |

- Asking answers `202` with the same body whether or not an account has the address; the lookup,
  the link and the mail run after the answer, so its timing tells nothing either. Accounts that
  sign in without a password of Kalzit's own get a mail saying where their password lives;
  disabled accounts get nothing. Without a mail server: `409 conflict` `mail.reset_unavailable`
  (an admin sets a new password in Verwaltung > Benutzer).
- Requests are limited per client address (10 per 15 minutes; IPv4 per address, IPv6 per /64),
  per network (30 per 15 minutes; /24, /48) and per address asked for (3 per hour, whether or not
  an account has it): `429 rate_limited` alike for every address.
- A link works for 60 minutes and once; a newer link replaces an older one, and a link stops
  working when the password changed some other way or the account's address changed. Such links,
  used, expired and unknown ones all answer `404 not_found` with `mail.reset_invalid`. Unknown
  tokens (invitation and password links) count against the client address: 20 per 15 minutes.
- Completing sets the password (policy of every account), ends every session of the account
  unless `signOutEverywhere` is false, and clears the account's failed sign-ins. A second factor
  is never changed.
- The admin's link: only for a member whose role the admin holds entirely, with a password of
  Kalzit's own (else `mail.reset_password_elsewhere`), within the same per-account limit.
- Audit: `auth.password_reset_requested` (account id, or the admin as actor),
  `auth.password_reset_completed` (account id, sessions ended).

## Reasons

As in docs/api/datasources.md, "Reasons": `reason` and `params` next to `code`, translated by the
UI, with `message` as the English fallback. The mail server is a target: refusals of its address
use the `target.*` reasons of the data sources.

| Reason | Params | When |
|---|---|---|
| `mail.host_invalid` | | the host is not a host name or address |
| `mail.port_invalid` | | the port is 0 after normalizing |
| `mail.port_speaks_tls` | | port 465 with STARTTLS |
| `mail.port_speaks_starttls` | `port` | port 25 or 587 with TLS |
| `mail.unencrypted_only_in_file` | | `security: none` from the settings page |
| `mail.unencrypted_not_local` | | no encryption towards a host that is not this machine |
| `mail.username_invalid` | | the user name is too long or has control characters |
| `mail.from_name_invalid` | | the sender name has more than 100 characters or control characters |
| `mail.address_invalid` | `email` (invitations) | not a complete email address |
| `mail.password_invalid` | | the password is too long or has control characters |
| `mail.password_required` | | a user name without a password for this server and user |
| `mail.set_in_file` | | the mail server comes from `kalzit.toml` or the environment |
| `mail.not_configured` | | no mail server is set up |
| `mail.connection_lost` | `detail` | the connection broke |
| `mail.no_answer` | | the server did not answer in time |
| `mail.no_greeting` | `port` | STARTTLS chosen, but the port sent no greeting (it speaks TLS directly) |
| `mail.not_smtp` | | the port does not speak SMTP |
| `mail.refused` | `reply` | the server refused the connection or the greeting |
| `mail.starttls_missing` | `reply`? | the server does not offer or refused STARTTLS |
| `mail.tls_failed` | `detail` | the TLS handshake failed, or data came before TLS |
| `mail.certificate_invalid` | `detail` | the server's certificate is not trusted |
| `mail.auth_unsupported` | | the server offers no sign-in, or neither PLAIN nor LOGIN |
| `mail.auth_rejected` | `reply` | user name or password refused |
| `mail.auth_required` | `reply` | the server wants a sign-in |
| `mail.sender_rejected` | `reply` | the sender address was refused |
| `mail.recipient_rejected` | `reply` | the recipient was refused |
| `mail.address_not_ascii` | | an address beyond ASCII to a server without SMTPUTF8 |
| `mail.message_rejected` | `reply` | the server refused the message |
| `mail.public_url_missing` | | `server.public_url` is not set |
| `mail.invite_count` | `max` | no address, or more than `max` |
| `mail.invite_already_member` | `email` | the address is a member |
| `mail.invite_pending` | `email` | the address has a pending invitation |
| `mail.invite_expired` | | the invitation expired |
| `mail.invite_link_unavailable` | | the link cannot be shown again (the secrets key changed); resend |
| `mail.invite_role_gone` | | the invitation's role was deleted |
| `mail.invite_invalid` | | the link was revoked or never existed |
| `mail.invite_used` | | the invitation was accepted already |
| `mail.invite_other_account` | | signed in with another account |
| `mail.invite_account_exists` | | the address has an account: sign in to join |
| `mail.reset_unavailable` | | no mail server or no public address |
| `mail.reset_invalid` | | the password link is used, expired, replaced or unknown |
| `mail.reset_password_elsewhere` | | the account has no password of Kalzit's own |
