# API: plugins

The plugin routes, exactly as the server implements them (`server/src/routes/plugins.rs`). All
paths are below `/api`. Every `/admin/...` route is `Access::ServerAdmin` (installing and trusting
plugins is a server action); the organization routes need `plugins:configure` in that
organization. General rules (docs/ARCHITECTURE.md, "API conventions") apply. How plugins work:
docs/ARCHITECTURE.md, "Plugins". This version hosts **data source** and **panel** plugins and
the **catalog**. The panel types of an organization and a panel's frame are routes for its
members ("Panel plugins" below).

Refusals carry a reason from the table at the end: `422 validation` for packages and requests that
fail a check, `409 conflict` for a state that refuses the step (a downgrade, a changed key, a key
still in use, nothing to approve), `404 not_found` for a plugin or key that does not exist.

Every change is written to the audit log with `resourceType: "plugin"` and the plugin id (or the
key id, or `server`) as `resourceId`: `plugins.installed`, `plugins.updated`,
`plugins.update_pending`, `plugins.approved`, `plugins.enabled`, `plugins.disabled`,
`plugins.restarted`, `plugins.removed`, `plugins.install_refused` (with the reason),
`plugins.publisher_changed` (a removed plugin's id installed with another key: both key ids, the
data sources whose secrets were cleared and how many secrets),
`plugins.key_added`, `plugins.key_removed` (with the plugins it stopped and the updates it
dropped), `plugins.handover_added`, `plugins.unsigned_allowed`, `plugins.unsigned_refused`,
`plugins.landlock_optional`, `plugins.landlock_required`, `plugins.connect_refused` (a network
connection the connector refused, with `datasourceId`, `host`, `port` and `reason`; bounded as
"Network connector" says, no actor), `plugins.connect_refusals_suppressed` (refusals not logged
one by one, with `total` and `byReason`), `plugins.key_catalog_allowed`, `plugins.key_catalog_disallowed`, `plugins.catalog_refreshed` (a refresh an administrator asked for: the sequence and number of entries, or the reason it failed, and the catalog's host; when the key of the address changed, `keyId`, `previousKeyId` and `keyChangeAccepted`;
`resourceId` `catalog`), `plugins.catalog_installed` (version, SHA-256, key id and host of a
package installed from the catalog, next to its `plugins.installed` or `plugins.updated`), and in
the organization's log `plugins.blocked` and `plugins.unblocked`. A package the catalog's own
checks refuse is recorded as `plugins.install_refused` with `source: "catalog"`, the plugin id and
the version. Changes of the catalog settings are `settings.updated` like every server setting.
Summaries carry versions, key ids and the approved network targets, never secrets.

## Packages

A package is a zip file with, at its root, `kalzit-plugin.toml` (the manifest,
docs/ARCHITECTURE.md, "Manifest"), optionally `kalzit-plugin.sig`, and exactly the files the
manifest lists in `[files]`. The signature file is JSON, like a release signature:

```json
{ "keyId": "17e204d64429eae4", "signature": "<base64 of the 64-byte Ed25519 signature>" }
```

The signature covers `kalzit-plugin-manifest-v1\n` followed by the manifest's exact bytes; the
manifest pins every file by SHA-256.

What the host checks, in this order, before anything runs:

0. First the manifest and the signature, read from the archive without unpacking anything:
   steps 3 to 5 run on them, and the manifest's fixed hosts must pass the data source target
   rules (`plugin.target_refused`). Only then is anything written; a refused package is recorded
   as `plugins.install_refused`.
1. The archive: at most 256 MiB, at most 1 GiB unpacked (counted while unpacking, not from the
   archive's sizes), at most 8192 entries. Every entry path must be a valid package path (relative,
   `/` between parts, no `..`, no Windows device names, no part ending in a dot or space, no
   characters Windows refuses); links, devices, encrypted entries and two paths that differ only
   in case are refused, all before anything is written.
2. The archive is unpacked into a fresh directory that only Kalzit's account may write (Windows:
   a protected ACL for SYSTEM, Administrators and Kalzit's account, read and execute for the
   `RESTRICTED` group of plugin processes; Linux: mode 0700). The entries there are listed
   without following links, hashed, and compared with the manifest (`Manifest::check_package`):
   unlisted files, missing files, other hashes, links, junctions, reparse points and files with
   more than one hard link are refused, and so is a manifest other than the one checked first.
   The binary is made executable only after that. The plugin later runs from this directory.
3. The manifest: valid, `min_kalzit` not newer than this Kalzit; a data source has a binary for
   this server's platform. A panel's bundle is checked once it is unpacked (step 2): UTF-8
   without NUL characters, at most 8 MiB, and without `</script` or `<!--`, since Kalzit serves it
   inside an HTML document (`plugin.bundle_invalid`).
4. The signature, against the trusted keys: Kalzit's own plugin key and the publisher keys an
   administrator added (below). A signature that names a trusted key but does not verify is
   always refused, also when unsigned plugins are allowed; a signature by a key nobody trusts is
   refused; a package without a signature is accepted only with `allowUnsigned`. Ids under
   `io.kalzit.` and `dev.kalzit.` need Kalzit's own key.
5. For an update: the same id, not older, and signed by the installed version's key or a key it
   was handed over to (`signing::check_update`); a signed install never becomes unsigned.

## Plugins

### List: `GET /admin/plugins`

```jsonc
{
  "items": [{
    "id": "dev.example.redis",
    "name": "Redis",
    "version": "1.2.0",
    "kind": "datasource",
    "description": "...", "publisher": "Example", "license": "MIT",    // when the manifest has them
    "shapes": ["frame", "documents"],
    "capabilities": ["watch"],
    "platforms": ["linux-x64", "windows-x64"],
    "signer": "publisher",          // kalzit | publisher | unsigned
    "keyId": "17e204d64429eae4",    // the signing key; absent when unsigned
    "trusted": true,                // the key is still trusted (always true when unsigned)
    "approved": true,               // the permissions of this version are approved
    "enabled": true,                // the administrator's switch
    "running": true,                // its kind is registered (approved, enabled, trusted, runnable here);
                                    // a panel: it may be shown
    "sandboxWarning": "landlock_missing",  // Linux without Landlock: the plugin is refused there
                                    // (landlock_missing_allowed: it runs anyway); absent otherwise
    "permissions": [                // the network targets, as approved
      { "setting": "host", "form": "host", "portSetting": "port", "defaultPort": "6379", "protocol": "tls" },
      { "host": "license.example.dev", "port": "443", "protocol": "tls" }
    ],
    "pending": {                    // an update that waits for approval; absent otherwise
      "version": "1.3.0", "signer": "publisher", "keyId": "17e204d64429eae4",
      "permissions": [ ... ], "addedPermissions": [ ... ]
    },
    "process": {                    // while the kind is registered
      "state": "running",           // idle | running | waiting | stopped
      "pid": 4242, "startedAt": 1800000000000,
      "starts": 1, "failures": 0,
      "lastError": { "reason": "plugin.crashed", "message": "...", "at": 1800000000000 },
      "retryAt": 1800000010000,     // while waiting
      "sandbox": ["no_new_privs", "landlock", "seccomp", "network", "memory_limit", "signals"],
      "sandboxMissing": ["user_namespace", "ipc_namespace", "network_namespace"],
      "warnings": [                 // only when there are any
        { "reason": "plugin.without_landlock", "params": {}, "message": "..." }
      ]
    },
    "installedAt": 1800000000000,
    "updatedAt": 1800000000000
  }],
  "allowUnsigned": false,
  "allowWithoutLandlock": false,
  "landlockAvailable": true,
  "platform": "linux-x64"
}
```

`GET /admin/plugins/{pluginId}` answers one item with two more fields: `manifest`, the manifest
exactly as signed (TOML), and `usedIn`, the data sources of its kind in every organization (not
in the trash), for "Used in" and the question before removing it:

```json
{ "...": "...", "manifest": "manifest = 1\nid = \"dev.example.redis\"\n...",
  "usedIn": [{ "id": "0190...", "name": "Cache", "orgId": "0190...", "orgName": "MouseWerk" }] }
```

### Install or update: `POST /admin/plugins`

The request body is the package itself (`Content-Type: application/zip`), at most 256 MiB (`413
payload_too_large` above). Answers `201` with the plugin.

- A new plugin is installed **disabled and not approved**. Its permissions are shown
  (`permissions`); it runs after `approve` and `enable`.
- An update of a plugin that is not approved yet replaces it.
- An update of an approved plugin that adds no network targets replaces it at once; its process
  restarts with the next call.
- An update of an approved plugin that adds network targets waits in `pending`: the installed
  version keeps running until the administrator approves the update.
- A plugin installed again after it was removed is checked against what the removal left (the
  last installed version and the key that signed it, kept per id): it must be signed with that
  key or one it was handed over to, like an update (an older version may come back). Another key,
  or no signature for a signed one, is a change of publisher; so is any reinstall, signed or not,
  of a plugin that was removed unsigned, since nothing ties a package to it. Only the same key, or one
  it was handed over to, keeps the secrets. With data sources of the kind left
  (in any organization, in the trash too) it is refused with `409 plugin.publisher_changed`
  (`datasources`: their number, `previousKeyId`, `removedVersion`) until the administrator
  repeats it with `?confirmPublisherChange=true`. Then the stored secrets of those data sources
  are cleared, so the new publisher's binary never receives them (they must be entered again),
  the id's hand-overs are dropped, and `plugins.publisher_changed` is recorded. A plugin removed
  before Kalzit 0.3.2 has no known key: with data sources left, its reinstall needs the same
  confirmation. Without data sources a change of publisher is installed and recorded.

### Approve: `POST /admin/plugins/{pluginId}/approve`

`{ "version": "1.3.0" }`: the installed version (when not approved yet) or the update in
`pending`, which then replaces the installed version. Other versions are refused
(`plugin.version_mismatch`), an approved version without a pending update too
(`plugin.nothing_to_approve`).

### Enable, disable, restart: `POST /admin/plugins/{pluginId}/enable|disable|restart`

Enabling needs the approval (`plugin.not_approved`). Disabling takes the kind out of the registry
and ends the process: data sources of the kind stay stored and answer
`datasource.kind_unavailable`. `restart` starts the count of failures afresh after the plugin
stopped (below); the next call starts it. All three answer the plugin.

### Remove: `DELETE /admin/plugins/{pluginId}`

Ends the process and deletes the plugin and its files (`204`). Its data sources stay and answer
`datasource.kind_unavailable`; blocks of organizations, its hand-overs and its last version and
signing key stay for a reinstall (see Install).

### Logs: `GET /admin/plugins/{pluginId}/logs`

```json
{ "lines": [{ "at": 1800000000000, "stream": "stderr", "text": "..." }], "dropped": 0 }
```

The plugin's stdout (after the handshake) and stderr, without terminal escape sequences, control
characters and bidirectional overrides, also written to Kalzit's log with the plugin
id. Kept: the last 2000 lines and at most 512 KiB, lines cut at 4 KiB (marked ` [cut]`), at most
200 lines per second; more are dropped and counted (`dropped`, and a `host` line saying how many).
Empty while the plugin is not registered.

## Trust

### Publisher keys: `GET|POST /admin/plugin-keys`, `DELETE /admin/plugin-keys/{keyId}`

`POST` `{ "name": "Example GmbH", "publicKey": "<32 bytes, base64 or hex>" }` answers `201`:

```json
{ "keyId": "17e204d64429eae4", "publicKey": "<base64>", "name": "Example GmbH", "addedAt": 1800000000000, "plugins": [], "maySignCatalog": false }
```

A key that is trusted already is refused (`plugin.key_exists`); a weak or malformed key too
(`plugin.key_invalid`). Plugins signed with the key run again when it is added back.

`DELETE` of a key that signed the installed version of plugins, or updates that wait for
approval, answers `409` with `plugin.key_in_use`: the plugins that would stop in
`params.plugins`, those whose waiting update would be dropped in `params.pending`.
`DELETE ...?confirm=true` removes the key, stops the first (`{ "stopped": ["dev.example.redis"] }`;
their rows stay with `trusted: false`) and drops the updates (the installed version keeps
running). After a restart the same holds.

Kalzit's own plugin keys are compiled in (`server/src/plugins/package.rs`): the main key
`581c30a0d8384cfd`, which the release workflow signs Kalzit's plugins with, and the offline backup
key `df87ab1649696788`; a build may add more with `KALZIT_PLUGIN_PUBLIC_KEYS`. They are never listed
here; release keys are never trusted for plugins.

### Catalog signing: `PUT /admin/plugin-keys/{keyId}/catalog`

`{ "maySignCatalog": true }` allows a trusted publisher key to sign the catalog index too, `false`
takes that back; answers the key as above (`404` for an unknown key). Trusting a key for plugins
alone does not let it sign the catalog; Kalzit's own plugin keys always may. Recorded as
`plugins.key_catalog_allowed` and `plugins.key_catalog_disallowed`. The UI asks before allowing.

### Hand-overs: `POST /admin/plugins/{pluginId}/handovers`

```json
{ "fromKey": "<old key, 64 hex digits>", "toKey": "<new key, 64 hex digits>", "fromVersion": "2.0.0", "signature": "<128 hex digits>" }
```

The old key's signature over `kalzit-plugin-handover-v1\n` followed by
`plugin=<id>\nfrom=<fromKey>\nto=<toKey>\nfrom_version=<fromVersion>\n`. A statement that does
not verify is refused (`plugin.handover_invalid`). Kept with the plugin id: updates from
`fromVersion` on may be signed by the new key (chains are followed).

### Host switches: `GET|PATCH /admin/plugin-host`

`{ "allowUnsigned": false, "allowWithoutLandlock": false, "landlockAvailable": true }`; `PATCH`
takes either switch, each change is recorded on its own.

- `allowUnsigned`, off by default: unsigned packages may be installed. An invalid signature is
  refused either way; unsigned plugins are marked `signer: "unsigned"`, and those installed while
  the switch was on keep running when it is turned off.
- `allowWithoutLandlock`, off by default: on a Linux host without Landlock, plugins start anyway;
  so they do where neither the seccomp network filter nor a network namespace took (otherwise
  `plugin.network_missing`). Both show as warnings on the plugin.
  Without the switch they are refused there (`plugin.landlock_missing`): nothing would keep them
  from reading Kalzit's files. `landlockAvailable` says whether this host has Landlock.

## Catalog

A signed index of plugins, hosted by the project or a mirror (docs/ARCHITECTURE.md, "Catalog").
It is **off by default**; while it is off Kalzit makes no connection for it. Installing from a
file always works, with or without it. Kalzit itself loads the index and the packages (never a
plugin), through the one HTTP client with the data source target rules
(`datasources.allowed_targets`, metadata addresses and Kalzit's own database refused), HTTPS only
(redirects too), 30 seconds for the index and its signature, 10 minutes per package, at most
4 MiB of index, 4 KiB of signature and 256 MiB of package. Requests carry Kalzit's version (user
agent) and platform (`x-kalzit-platform`) and nothing else.

Addresses: requests to the configured host and port may reach whatever that host resolves to,
so an administrator can point the catalog at a private mirror, but never Kalzit's own listening
ports (`catalog.own_address`); when the configured host resolves to public addresses, only public
addresses are used for it. Every other host, a package host named in the index or a redirect
elsewhere, must resolve to public addresses only: loopback, private, shared, link-local and
unique-local addresses are refused (`catalog.private_target`). Redirects (at most 5) are followed
hop by hop, each over HTTPS and checked this way; names are resolved once per connection and the
connection goes to the checked address.

Settings (server, `PATCH /admin/settings/{key}`, recorded as `settings.updated`; environment
variables `KALZIT_SETTING_PLUGINS_CATALOG_*` override them):

| Key | Default | |
|---|---|---|
| `plugins.catalog_enabled` | `false` | Load the catalog. |
| `plugins.catalog_url` | `""` | The index's `https://` address. No default host: the project's address is set when its hosting is decided. |
| `plugins.catalog_refresh_hours` | `24` | How often it is loaded again while it is on (1 to 168); after a failure it is tried again within an hour. |

**The index** is the JSON of `kalzit_plugin_api::catalog::CatalogIndex`, its signature a file next
to it at the same address with `.sig` appended, JSON like a package's
(`{ "keyId", "signature" }`), an Ed25519 signature over `kalzit-plugin-catalog-v1\n` followed by
the index's exact bytes. It must be signed by a key allowed for the catalog: Kalzit's own plugin
keys, or a trusted publisher key an administrator explicitly allowed to
(`PUT /admin/plugin-keys/{keyId}/catalog`); trusting a key for plugins alone is not enough. An
index is taken only when

- its signature verifies (`catalog.signature_missing`, `catalog.signer_untrusted`,
  `catalog.signature_invalid`), and with the key pinned for this address: the first list taken
  from an address pins its key, another trusted key is refused (`catalog.key_changed`) until an
  administrator confirms with `POST /admin/plugin-catalog/refresh?acceptKeyChange=true`,
- its `sequence` is higher than any index taken before from the same key and from the same
  address (whatever key signed it), kept in the database and never lowered, also when the address
  changes or the catalog is turned off and on (`catalog.rollback`); the same bytes served again
  count as unchanged,
- it is published at most 5 minutes in the future, valid for at most 31 days and not past its
  `expiresAt` (`catalog.times_implausible`, `catalog.expired`; served unchanged past its expiry it
  is refused as well),
- every entry and every withdrawal is well formed (`catalog.entry_invalid`,
  `catalog.revocation_invalid`).

```jsonc
{
  "format": 1, "sequence": 42, "publishedAt": 1800000000, "expiresAt": 1802592000,
  "plugins": [{
    "id": "dev.example.redis", "version": "1.2.0", "kind": "datasource", "name": "Redis",
    "keyId": "17e204d64429eae4",                 // the key that signs the package
    "url": "https://plugins.example.dev/redis-1.2.0.kalzit-plugin",
    "sha256": "<64 hex digits>", "size": 1840000,
    "description": "Keys and streams as frames.",  // optional, at most 280 characters
    "publisher": "Example GmbH",                   // optional, a label, not a verified identity
    "network": ["*.example.dev:6379"]              // optional, for browsing only
  }],
  "revoked": [{ "id": "dev.example.redis", "versions": "<1.2.0", "reason": "CVE-2026-0001" }]  // optional
}
```

A failed load keeps the index taken before (and says why); an index past its expiry offers
nothing to install. `description`, `publisher` and `network` are what the catalog says: before
anything runs, the review shows the package's own manifest and its network targets for approval.

### State and entries: `GET /admin/plugin-catalog?q=&kind=`

`q` searches name, id, description and publisher (at most 200 characters), `kind` is
`datasource` or `panel`.

```jsonc
{
  "state": "ready",        // off | unconfigured (on without address) | not_loaded | unreachable | untrusted (its key is trusted no more) | expired | ready
  "settings": {            // with the version a change names; editable is false when set in the environment or kalzit.toml
    "enabled": { "value": true, "version": 3, "editable": true },
    "url": { "value": "https://plugins.example.dev/index.json", "version": 1, "editable": true },
    "refreshHours": { "value": 24, "version": 0, "editable": true }
  },
  "index": { "sequence": 42, "publishedAt": 1800000000000, "expiresAt": 1802592000000,
             "fetchedAt": 1800000100000, "keyId": "581c30a0d8384cfd",
             "signer": "Kalzit",   // or the trusted key's name; absent when the key is trusted no more
             "host": "plugins.example.dev" },
  "checkedAt": 1800000100000,
  "lastError": { "reason": "catalog.unreachable", "message": "...", "params": {}, "at": 1800000200000 },  // until a check succeeds
  "items": [{              // per plugin, the newest version not withdrawn
    "id": "dev.example.redis", "name": "Redis", "version": "1.2.0", "kind": "datasource",
    "description": "...", "publisher": "Example GmbH",
    "keyId": "17e204d64429eae4", "keyName": "Example GmbH",   // keyName absent: nobody here trusts the key
    "network": ["*.example.dev:6379"], "size": 1840000, "sha256": "...", "urlHost": "plugins.example.dev",
    "installedVersion": "1.1.0", "pendingVersion": "1.2.0",
    "revoked": "...",              // the offered version is withdrawn: why
    "installedRevoked": "...",     // the installed version is withdrawn: why
    "action": "update"             // install | update | installed | pending | untrusted | revoked
  }],
  "counts": { "all": 48, "datasource": 31, "panel": 17 },   // after q, before kind
  "revoked": [{ "id": "dev.example.redis", "versions": "<1.2.0", "reason": "...", "installedVersion": "1.1.0" }]
}
```

### Load now: `POST /admin/plugin-catalog/refresh`

Loads and checks the index at once and answers the state as above, or the refusal
(`catalog.*`, a `target.*` reason of the target rules, `409` while off or without address).
Turning the catalog on or changing its address does not load it by itself; the UI asks for this
right after. In the background Kalzit checks every 5 minutes whether a refresh is due.

### Install or update: `POST /admin/plugin-catalog/install`

`{ "id": "dev.example.redis", "version": "1.2.0", "confirmPublisherChange": false }` answers `201`
with the plugin, exactly as `POST /admin/plugins`. Before that:

1. The catalog must be on, its index taken from the current address, not expired and signed by a
   key still trusted (`catalog.disabled`, `catalog.url_missing`, `catalog.not_loaded`,
   `catalog.expired`, `catalog.signer_untrusted`), the entry listed (`404 catalog.entry_unknown`)
   and not withdrawn (`409 catalog.entry_revoked`; a pre-release counts as its release). These
   checks run again after the download, right before the install (`catalog.package_mismatch`
   with `field: entry` when the entry changed meanwhile).
2. The package is downloaded into the host's private upload directory, at most its listed size;
   size and SHA-256 must match the entry (`catalog.package_mismatch`, `field`: `size`, `sha256`).
3. Its manifest must have the entry's id and version (`field`: `id`, `version`), and it must be
   signed by a trusted key with the entry's key id (`field`: `keyId`): a package from the catalog
   is never installed unsigned, whatever `allowUnsigned` says (`plugin.unsigned_refused`), and an
   invalid signature is refused as always (`plugin.signature_invalid`).
4. Then it goes through `POST /admin/plugins`'s path unchanged: every check of "Packages", the
   update rules, a change of publisher (`confirmPublisherChange`), the approval of its
   permissions and network targets before it runs, and the sandbox.

Only one package is downloaded at a time.

## Organizations

`GET /orgs/{orgId}/plugins` lists the installed plugins with `blocked` for this organization:
`{ "items": [{ "id", "name", "version", "kind", "blocked" }] }`.

`PUT /orgs/{orgId}/plugins/{pluginId}/block` and `DELETE .../block` (`204`) block and unblock a
plugin for the organization: its kind is not offered there (`GET /orgs/{orgId}/datasource-kinds`
leaves it out, creating a source of it answers `datasource.kind_unknown`) and the organization's
sources of the kind answer `datasource.kind_unavailable`.

## Panel plugins

A panel plugin runs in the browser, never on the server: no process, no network target. Once it
is approved, enabled and its key is trusted, its panel type (the plugin id) may be used in every
organization that has not blocked it. Its panels are drawn in a sandboxed frame and spoken to
through the panel message API (below).

### Panel types: `GET /orgs/{orgId}/panel-plugins`

`Access::OrgMember`. The panel plugins that may be shown in the organization, for the
visualization picker and the options editor:

```json
{ "items": [{
  "id": "dev.kalzit.panel-kpi", "name": "KPI tile", "version": "0.1.0",
  "description": "...", "publisher": "Kalzit",       // when the manifest has them
  "signer": "kalzit",                                 // kalzit | publisher | unsigned
  "shapes": ["frame"], "api": 1,
  "options": [{ "name": "decimals", "label": { "en": "Decimals", "de": "Nachkommastellen" },
                "type": "integer", "min": 0.0, "max": 10.0 }]
}] }
```

`options` are the manifest's `[[panel.options]]` (docs/ARCHITECTURE.md, "Manifest"). The UI
builds the options editor from them, and gives a panel only declared options whose values fit,
with the defaults for the rest. Creating, saving and restoring a dashboard check the options of
the plugin panels they add or change against the manifest (`422 validation`,
`dashboards.panel_options`, naming the panel and the option), while the plugin may be shown;
library panels and saved analyses keep their options unchecked for now.

### Frame: `GET /orgs/{orgId}/panel-plugins/{pluginId}/frame?dashboard={dashboardId}`

`Access::OrgMember`, then per request:

- With `dashboard`: the dashboard must exist in the organization and not be in the trash. If its
  current version shows a panel of this type (its own, or through a linked library panel or
  saved analysis), `dashboards:read` on the dashboard is enough (viewers); otherwise the caller adds the panel and needs `dashboards:write` on it. A dashboard
  the caller cannot see answers `404`, one they may only read `403`.
- Without `dashboard` (a dashboard not saved yet): `dashboards:write` in the organization.
- The plugin must be approved, enabled, trusted and not blocked for the organization; else
  `404` with `plugin.panel_unavailable`.
- The bundle is read from the installed package and its SHA-256 compared with the manifest's
  `[files]` on every request; a file that differs is never served (`409` with
  `plugin.bundle_changed`, and an error in Kalzit's log). An optional `v` (the plugin's version)
  only makes a new version load afresh.

The answer is an HTML document (`text/html; charset=utf-8`) with the bundle inline as its only
script (`<script type="module">`, line breaks as `\n`), and these headers of its own (Kalzit's
page policy does not replace them):

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'sha256-<bundle>';
  style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:;
  connect-src 'none'; webrtc 'block'; frame-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none';
  form-action 'none'; base-uri 'none'; frame-ancestors 'self'
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Cache-Control: no-store
Referrer-Policy: no-referrer
X-DNS-Prefetch-Control: off
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), fullscreen=()
```

- `sandbox allow-scripts` without `allow-same-origin`, as the UI's `<iframe sandbox="allow-scripts">`
  has it, so the document runs in an opaque origin also when it is opened on its own: no cookies,
  no storage, no access to Kalzit's page, its session or its API (a request from the frame carries
  no session, and `connect-src 'none'` stops it anyway).
- The hash of the bundle is the only script source: nothing else runs, inline or loaded.
- No `Set-Cookie`; the response is never cached.
- Left to the browser: `connect-src` does not cover WebRTC, so `webrtc 'block'` stops it only
  where the browser knows that directive (Chromium does not yet, and reports it in the console as
  an unrecognized directive once per frame); a panel could otherwise reach a STUN or TURN server. DNS prefetching is turned off, but a browser may still resolve
  names it is given. Both rest on the bundle's signature and the administrator's trust.
- Inline, because a separate request for the bundle from the opaque origin would carry no session
  and could not be authorized.

## Data sources of plugin kinds

- A registered plugin kind appears in `GET /orgs/{orgId}/datasource-kinds` like a built-in kind
  (its `kind` is the plugin id), with `plugin`: `{ "plugin", "version", "publisher", "labels",
  "help" }`, the publisher as the manifest names it (absent when it names none), and the labels
  and help texts of its settings by field and language (`en`, optionally `de`) from the manifest. `labelKey` of a plugin field is `datasources.settings.<name>`, so known names keep
  their own translation.
- The manifest's form rules are checked like a built-in kind's; the plugin's own `CheckSettings`
  follows. A plugin that cannot be started or reached does not refuse the settings.
- Before every call, `CheckOnSave` included (a connection with its secrets goes only to allowed
  targets), the host checks every target of the manifest against the data source target rules
  (Kalzit's own database by address, metadata addresses, `datasources.allowed_targets`): the hosts
  and URLs it takes from the settings and its fixed hosts. A target setting that is not text
  (`settings.expected_text`), a URL that does not parse (`settings.url_invalid`) or has no host
  (`settings.url_no_host`), and an empty host (`settings.host_invalid`) are refused. Every
  connection the plugin then asks for is checked again by the connector ("Network connector").
- Results pass `plugins::wire::Assembler` with the query's limits: rows, documents and graph
  elements beyond the limit and parts beyond the response budget are cut with the notices of
  built-in sources; parts out of order, of another shape, values that do not fit their field type
  and a stream without its end fail the query with `plugin.protocol`.
- The plugin's reasons reach the API when they are reasons of docs/api/datasources.md that plugins
  may use (`health.connected`, `health.connected_admin_login`, `source.error`,
  `source.no_answer`, `query.invalid_form`, `query.write_refused`, `query.timeout`,
  `query.time_out_of_range`, the `settings.*` reasons of host, port, URL, PEM and `invalid`, and
  the target reasons); any other reason becomes `plugin.error` with the plugin's reason in
  `params.reason`. `params.plugin` always names the plugin. Error kinds keep their codes
  (`query_rejected`, `datasource_target_blocked`, `query_timeout`, `datasource_error`).

## Processes

- A registered plugin's process starts with the first call that needs it, with `KALZIT_PLUGIN_ADDRESS`,
  `KALZIT_PLUGIN_TOKEN`, `KALZIT_PLUGIN_HOST_PID` (the plugin serves that process only) and
  `KALZIT_PLUGIN_CONNECTOR` (the network connector, below) and nothing else of Kalzit's
  environment (on Windows also `SystemRoot`, `SystemDrive`, `windir`, `NUMBER_OF_PROCESSORS`,
  `PROCESSOR_ARCHITECTURE`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA` (Windows needs them to start
  an AppContainer process) and a `PATH` of `System32`; on Linux `PATH=/usr/bin:/bin`, `HOME` and
  `LANG`), and `TMP`, `TEMP` and `TMPDIR` pointing at its private temporary directory (on Windows
  Windows sets `TMP` and `TEMP` to the AppContainer's own `AC\Temp`, emptied at every start).
- The local connection: Linux, `KALZIT_PLUGIN_ADDRESS` is `fd:<n>`, one end of a socket pair
  Kalzit made, inherited by the plugin with that descriptor number: it serves the protocol on
  that one connection (it may open no socket itself; the pair reaches only Kalzit). The SDK
  makes it and the connector's descriptor close-on-exec at start. Windows, Kalzit creates the
  named pipe `KALZIT_PLUGIN_ADDRESS` and keeps an instance waiting; the plugin connects to it as a
  client (an AppContainer cannot create pipes), checks that the pipe's server is
  `KALZIT_PLUGIN_HOST_PID`, and serves the protocol over each connection it makes, always keeping
  one ready; Kalzit uses a connection only when its client process is the child.
- Start: within 10 seconds it prints `kalzit-plugin 1 ready` on stdout, Kalzit connects and its
  `Describe` answer must fit the manifest (protocol, kind, shapes, capabilities). `Describe`
  announces protocol minor 1 with the feature `network_connector`.
- Health: every 30 seconds Kalzit asks `Describe`; two failed answers in a row end the process
  (`plugin.unresponsive`).
- Restarts: after the n-th failure in a row (crash, failed start, unresponsive) the plugin waits
  10 s, 30 s, 1, 2, 5 and 10 minutes before its next start; calls in between answer
  `plugin.restarting`. After that it stays stopped (`plugin.stopped`) until `restart`. A process
  that ran 10 minutes before it failed starts the count afresh.
- A crash fails only the calls of its kind. Disabling, removing, a removed key and Kalzit's stop
  end the process and everything it started.

## Network connector

A plugin has no network of its own (Sandbox, below): every connection goes through Kalzit
(`ConnectRequest` in the protocol, `kalzit_plugin_api::connector::Connector` with the crate's
feature `connector`, `kalzit_plugin_sdk::net::connect` in the SDK). The plugin sends the start's
token, the data source id it got in `Connection`, host, port and protocol (`tcp` or `tls`) to
`KALZIT_PLUGIN_CONNECTOR`:

- Linux: `fd:<n>`, a `SOCK_SEQPACKET` socket pair Kalzit made and the plugin inherits; requests
  may overlap and carry a `request_id` (the connector belongs to the process that opened it).
  The plugin's sandbox lets it open no socket at all, so this, its connection to Kalzit and the
  relayed connections are the only sockets it has.
- Windows: a named pipe Kalzit created; one pipe connection per request, Kalzit serves only the
  plugin's process, and the client checks that the pipe's server is Kalzit
  (`KALZIT_PLUGIN_HOST_PID`).

Kalzit then:

1. refuses an unknown token (`plugin.token_invalid`), a host longer than 253 bytes or a data
   source id longer than 64 (`plugin.request_invalid`, before anything else looks at them), and
   a data source the plugin was not given, that changed or went to the trash since, that does
   not exist, belongs to another kind or to an organization that blocked the plugin
   (`plugin.datasource_unknown`: a change, the trash or the block takes the data source back,
   and closes its open connections, until the next call hands it over again);
2. reads the data source's settings and the target rules as they are now, and refuses any host,
   port or protocol that is not one of the manifest's targets for those settings, compared without case and trailing dot
   (`plugin.target_undeclared`): a `host` target's setting with its port setting or default
   port and protocol, a `url` target's host and port (`https` and `wss` are `tls`), a fixed host
   with its port and protocol. The protocol is a label of the permission: Kalzit checks it
   against the manifest but does not enforce TLS on the stream;
3. resolves the name itself and applies the data source target rules to every address
   (`target.metadata_address`, `target.not_allowed`; any metadata address refuses the whole
   name), and refuses Kalzit's own addresses: the HTTP and HTTPS ports on any address of the
   machine (`target.own_address`; Kalzit opens no other listener) and its PostgreSQL database
   (`target.own_database`; its addresses are resolved at start and again with every request,
   and when neither lookup yields an address every address with the database's port is
   refused);
4. refuses a connection beyond `64` at once per plugin (`plugin.connections_exhausted`; every
   connection is relayed by Kalzit, so the count is exact); more than 16 requests under way at
   once are refused (`plugin.connector_busy`);
5. connects to the checked address, never resolving again, within one budget of 10 seconds for
   the data source, the lookups of the target and of Kalzit's database, and every address
   (`target.unreachable` otherwise), and relays it: on Linux the plugin gets one end of a new
   stream socket pair (`SCM_RIGHTS`), on Windows the pipe itself. The TCP connection stays with
   Kalzit, so the plugin can neither point it elsewhere nor listen on the host's network.

"Test connection" and the check before a save may carry settings that are not stored (yet): a
new source, an edited one, or one provisioned from a file. For such a call the plugin gets an id
of its own (`Connection.datasource_id` starting with `draft-`) under which it may connect to the
targets these settings declare, checked by the same rules (steps 2 to 5), until the call ends;
then its connections close. A plugin should not keep a pool for a `draft-` id. Targets come from
settings, never from secret fields (the manifest allows only non-secret target fields).

A relayed connection ends when either side closes it, after 15 minutes without traffic, when
its data source changes, goes to the trash or is blocked, and when the plugin process ends.
Refusals of steps 1 to 4 answer
`ERROR_KIND_BLOCKED`, step 5 `ERROR_KIND_FAILED`; every refusal is written to the plugin's log
(`stream: host`), Kalzit's log and the audit log (`plugins.connect_refused`), at most once a
minute per target and reason and at most 20 at once per plugin, then one every 3 seconds,
whatever the targets; at most 1000 distinct ones are remembered, and only those the per-plugin
limit let through. Refusals for Kalzit's own addresses and database, metadata addresses and
addresses outside `datasources.allowed_targets` are always logged and audited, once a minute
per reason, whatever else the plugin sends. What is not logged one by one is counted by reason
and written once a minute, and when the process ends, as `plugins.connect_refusals_suppressed`
(`total`, `byReason`). The plugin speaks
TLS itself over the stream.

## Sandbox

What a plugin process gets. The layers in force are listed in `process.sandbox`, the missing ones
in `process.sandboxMissing`. On Linux Landlock is required unless `allowWithoutLandlock`: a host
without it is refused before anything starts, and a plugin whose Landlock does not take never
runs (the start fails before its program is loaded). Plugins do not run at all while Kalzit runs
as root (`plugin.root_refused`).

**Linux**

- `no_new_privs`; its own session and process group (`setsid`, killed as a whole), outside
  Kalzit's, and it may not change either (`setpgid` and `setsid` refused): `kill(0)` reaches
  only the plugin's own group (tested); killed when Kalzit ends (`PR_SET_PDEATHSIG`); no core
  dumps.
- `landlock` (kernel 5.13 and later): the file system is read-only and visible only where a
  process needs it: `/usr`, `/lib*`, `/bin`, `/sbin`, `/proc`, `/sys`, the certificate
  directories and a few files of `/etc` (name lookup, time zone, users), the device files `null`,
  `zero`, `full`, `random`, `urandom`, its package (read and run) and its private run directory
  (read and write, not run: the sockets `socket` and `connector`, and `tmp`). Kalzit's data directory, configuration and
  secrets are out of reach, and so are other processes' `/proc` entries (Kalzit's environment and
  memory included).
- `seccomp`: refused with `EPERM` are `ptrace`, `process_vm_readv/writev`, `pidfd_getfd`,
  `pidfd_send_signal`, `tkill`, mounts (old and new API), `pivot_root`, `setns`, `unshare`,
  `clone` with any `CLONE_NEW*` flag, swap, reboot, `kexec`, kernel modules, `bpf`,
  `perf_event_open`, `userfaultfd`, `io_uring_*`, the keyrings, `open_by_handle_at`,
  `name_to_handle_at`, `setpgid`, `setsid`, `acct`, `quotactl`, `lookup_dcookie`, `iopl` and `ioperm`, and
  `truncate`/`ftruncate` where Landlock is older than ABI 3 (which guards truncation itself);
  `clone3` answers `ENOSYS` (its flags are out of a filter's reach; the C library falls back to
  `clone`); other architectures than the server's (and the x32 ABI) are killed.
- `network` (part of the seccomp filter): `socket`, `connect`, `bind`, `listen`, `accept` and
  `accept4` are refused with `EACCES` for every family, Unix sockets included; `socketpair`
  makes stream and sequenced-packet pairs only (no datagram pair that could `sendto` a socket of
  the host such as `/dev/log`); `sendto`, `sendmsg` and `sendmmsg` with `MSG_FASTOPEN` are
  refused. The plugin's sockets to Kalzit are inherited socket pairs, and every network
  connection is a socket pair Kalzit relays. So it reaches neither the network (tested: a direct
  connection fails, also to loopback) nor a Unix socket of the host, named or abstract (tested),
  and cannot point a handed connection elsewhere (tested), whatever Landlock's ABI and whether
  or not the network namespace took.
- `network_namespace`: a network namespace of its own with nothing but an unconfigured loopback
  device, where unprivileged user namespaces are allowed.
- `signals`: the plugin may signal only itself and its process group (`kill(0)`, `kill(-pid)`,
  its own threads): Landlock's signal scope where the kernel has ABI 6, else a seccomp filter on
  `kill`, `tgkill` and `rt_(tg)sigqueueinfo`. With the filter it cannot signal its children one
  by one (only the whole group).
- `user_namespace` and `ipc_namespace`: the account mapped to itself (no capabilities after the
  start); not where the host forbids unprivileged user namespaces (some distributions, most
  containers).
- `memory_limit`: the data segment (`RLIMIT_DATA`, 2 GiB).
- **Not limited**: the number of processes and the CPU.

**Windows**

- `restricted_token`: no privileges except bypass traverse checking, Administrators for deny
  only, and the restricting SIDs Everyone, Users, `RESTRICTED`, a SID of the plugin (from its
  id) and a SID of this start (not the logon session, which Kalzit's own process grants read
  access): the plugin opens only what one of these may open. Kalzit's data directory (SYSTEM,
  Administrators and Kalzit's account only) and the account's profile are out of reach. Its
  package grants read and run to the plugin's SID only, its run directory read and write (not
  run) to the start's SID only, so plugins cannot reach each other's packages or run
  directories (tested). Its default DACL grants only Kalzit's account, SYSTEM and the start's
  SID, so other plugins cannot open its process or objects (tested). Kalzit's pipes for the
  plugin grant Kalzit's account full access and the start's SID and the plugin's AppContainer
  read and write only (not the right to change their security), labelled low.
  Everyone and Users stay restricting SIDs (System32 grants Users, the `NUL` device Everyone;
  `ALL APPLICATION PACKAGES` cannot be one, Windows then refuses to start the process); what any
  local account may read is closed by the AppContainer check: files such as `kalzit.toml` in
  `%ProgramData%\Kalzit` or a TLS key inheriting ProgramData's entries have no entry for
  AppContainers, so the plugin cannot read them (tested with a file readable by Users and
  Everyone).
- Kalzit's own files that hold secrets: `kalzit.toml` with a password, secret, token or a URL
  with a password; the TLS key; `secrets.key` and `secrets.key.dpapi`; a SQLite database outside
  the data directory. When one grants reading to Everyone, Users or `RESTRICTED` and to all
  AppContainers (`ALL APPLICATION PACKAGES` or `ALL RESTRICTED APPLICATION PACKAGES`, as files
  under `C:\Program Files` do), a plugin could read it: plugins do not start
  (`plugin.secrets_exposed`) until it is limited to SYSTEM, Administrators and Kalzit's account.
  When only Everyone, Users or Authenticated Users may read it, plugins cannot, but other local
  accounts can: `process.warnings` says so, and it is logged when a plugin is enabled. On Linux
  `process.warnings` also says when a plugin runs without Landlock (`allowWithoutLandlock`). The
  plugin page shows these warnings.
- `app_container`: the plugin runs in an AppContainer of its own (a profile named
  `kalzit.plugin.<hash of the installation's plugin directory and its id>`, removed with the
  plugin) without any capability; Windows
  combines it with the restricted token, so every access passes both checks. Its package and run
  directory also grant `ALL APPLICATION PACKAGES`; the plugin's and the start's SIDs still decide
  which plugin gets in. On Windows Server the plugin cannot open the `NUL` device: give child
  processes pipes, not `NUL`, as their standard handles.
- `network`: an AppContainer without the `internetClient`, `internetClientServer` and
  `privateNetworkClientServer` capabilities and without a loopback exemption opens no network
  connection, not even to loopback (tested); the connector is the only way out.
- `low_integrity`: the plugin runs at low integrity. It cannot open Kalzit's process (or any
  process above low) for reading or writing its memory, and it can write only objects labelled
  low: its run directory carries that label; files and directories that only Everyone or Users may
  write (such as parts of `ProgramData`) stay closed to it unless they are labelled low as well
  (the account's own `LocalLow` folder is, but the restricting SIDs keep the plugin out of the
  profile).
- `job_object`, `kill_on_close`, `memory_limit` (2 GiB for the whole job), `process_limit`
  (16 processes), `ui_restrictions` (no desktop, clipboard, global atoms, display or system
  settings), no breakaway: the plugin and everything it starts end with the job, also when Kalzit
  crashes. A CPU cap can be set (`cpu_limit`), none by default.
- `image_load_policy`: DLLs from System32 first, none from remote shares or with a low label (so
  none from its run directory), and only the listed files in the package directory.
- Its pipe ends are inheritable only while it is created, and only they are in its handle list.

On both systems a plugin reaches the network only through the connector, so only the targets its
manifest declares for a data source's current settings, after the target rules. The contract
tests check per system that a plugin cannot open Kalzit's process or another plugin's, cannot
write or read Kalzit's data directory, sees nothing of Kalzit's environment, cannot open a
network connection of its own, reaches a declared target through the connector, and is refused
an undeclared target, an undeclared port or protocol and Kalzit's own port, and (Linux) cannot
`ptrace` or signal Kalzit. Where the Linux seccomp filter cannot be applied (no `no_new_privs`),
`network` is missing and the plugin's network is not limited; the plugin page shows it.

## Panel message API

Version 1, what a panel plugin's bundle and Kalzit say to each other through `postMessage` across
the sandboxed iframe (docs/ARCHITECTURE.md, "Panel plugins"). The TypeScript types are
`plugin-api/panel/v1/kalzit-panel.d.ts`. The host runs in the browser
(`ui/src/features/plugins/panel`): it checks every event exactly as
`kalzit_plugin_api::panel::parse_event` does, whose constants are the limits below; both run the
cases of `plugin-api/panel/v1/events.fixture.json` and `options.fixture.json`. The example panel
is `examples/plugins/panel-kpi`.

Every message is a JSON object with `kalzit: "panel"`, `api: 1` and `type`.

**Into the frame** (Kalzit to the panel):

| `type` | Fields | When |
|---|---|---|
| `init` | `options` (the panel's JSON options: the declared ones that fit, with defaults), `size` (`width`, `height` in CSS pixels), `theme` (`scheme`: `light` or `dark`; `tokens`: Kalzit's design tokens by custom property name, colors resolved), `locale` (`en`, `de`), `timeZone` (IANA), `title`, `mode` (`view`, or `edit` in the panel editor) | the answer to `ready` |
| `data` | `series` (per query: `refId` and `result` in its native shape as in docs/api/datasources.md, after the panel's steps, or `error`), `timeRange` (`from`, `to`), `revision` (grows with every new result) | after `init`, and whenever the panel's results change |
| `options` | `options` | the options changed |
| `size` | `width`, `height` | the frame was resized |
| `theme` | `scheme`, `tokens` | the theme changed |
| `state` | `loading` | the panel's queries started (`true`) or ended |

Results keep the query's limits; a panel cannot run queries of its own.

**Out of the frame** (events, the panel to Kalzit):

| `type` | Fields | Limits |
|---|---|---|
| `ready` | | once, after the panel listens |
| `click` | `refId`, `target` (`row`, `document`, `node`, `edge`), `index` (row or document) or `id` (node or edge) | `refId` 1 to 64 characters, `id` at most 1024 |
| `select` | `refId`, `rows` (indices) | at most 1000 rows |
| `range` | `from`, `to` (Unix milliseconds) | `from` before `to` |
| `setVariable` | `name`, `value` (a text, or a list for a multi-value variable) | a variable name of at most 64 characters; at most 100 values of at most 1024 characters, no control characters |
| `resize` | `height` | 16 to 4000 CSS pixels; Kalzit may give less |
| `setOptions` | `options` (the whole object) | in `edit` mode only; only options the manifest declares, each fitting (`panel.option_unknown`, `panel.option_invalid`) |
| `link` | `url`, `title` (optional) | `url` at most 2048 characters: `http`/`https` with a host and no user name, or a path in Kalzit starting with `/` (not `//`, no `.` or `..` segments, no `%2e`, `%2f` or `%5c`, not the API under `/api`); `title` at most 200 |
| `log` | `level` (`debug`, `info`, `warn`, `error`), `text` | at most 1024 characters, no control characters; at most 5 lines per second |

What the host does with them:

- `ready`: `init`, then `data`; after that `options`, `size`, `theme` and `data` whenever they
  change. A frame that does not send `ready` within 10 seconds is shown as failed, with "Try
  again".
- `resize`: the frame takes that height (the panel scrolls when it is taller than its place).
- `setOptions`: in the panel editor, the options replace the panel's options (as if typed in its
  options editor); outside it the event is dropped.
- `link`: a dialog shows the address and the plugin's name, with Cancel focused; only "Open"
  opens it: an address in a new tab with `noopener,noreferrer`, a path in Kalzit in place.
- `log`: into the browser console as `[panel <id>] <text>` at its level.
- `click`, `select`, `range`, `setVariable`: checked, then not acted on (a `debug` line says so).
  Kalzit acts on what a panel may ask for: a size, its options while edited, a link the viewer
  confirms, and its log.

Rules:

- The host checks every event and keeps the rate limits per panel. An event is at most 16 KiB of JSON; Kalzit takes at most 20 events per second per panel and
  drops the rest. An event of another `api`, an unknown `type` or a field out of its range is
  dropped (`panel.not_json`, `panel.not_envelope`, `panel.api_unsupported`, `panel.type_unknown`,
  `panel.field_invalid`, `panel.too_large`, shown in the browser console with the plugin id).
  Unknown fields are ignored and never passed on.
- Both sides accept messages only from the other window (`event.source`). Kalzit also requires
  the opaque origin `"null"` of the sandboxed frame and drops anything else; it sends with the
  target origin `"*"`, since an opaque origin cannot be named. What it sends is only the panel's
  own options and results, which the viewer may see anyway.
- `connect-src 'none'` stops requests, but a frame can still carry data out by navigating,
  itself (`location = "https://elsewhere/?data"`), a new window or the top page. Kalzit therefore
  loads the bundle with `sandbox="allow-scripts"` only (no `allow-top-navigation`,
  `allow-popups` or `allow-forms`), serves the frame with the policy of "Frame" above, and
  treats a second `load` of the frame (a navigation away from the bundle's document) as a
  breach: the panel is removed and shows an error with "Try again".
- Evolution: version 1 grows only by new optional fields and new message types. A panel ignores
  types and fields it does not know; Kalzit speaks to a bundle in the version its manifest names
  (`[panel] api`) and refuses versions it does not know at install.

## Not here yet

- `Release` calls when a data source changes or is deleted (plugins key their pools by
  `Connection.revision` meanwhile).

## Reasons

| Reason | Params | When |
|---|---|---|
| `plugin.package_unreadable` | | the upload is empty, not a zip archive, or broken (`422`) |
| `plugin.package_too_large` | `maxBytes` | the package is larger than allowed unpacked (`422`) |
| `plugin.package_invalid` | `issues` | a bad entry path, a link, a device, an encrypted entry, two paths differing only in case, or files that do not match the manifest (`package.*` codes in the message) (`422`) |
| `plugin.manifest_missing` | | the package has no readable `kalzit-plugin.toml` (`422`) |
| `plugin.manifest_invalid` | `issues` | the manifest is not valid (`manifest.*` codes) (`422`) |
| `plugin.kalzit_too_old` | `minKalzit` | the plugin needs a newer Kalzit (`422`) |
| `plugin.platform_missing` | `platform` | the package has no binary for this server's platform (`422`) |
| `plugin.platform_unsupported` | | plugins cannot run on this server's platform (`422`) |
| `plugin.unsigned_refused` | | the package is not signed and unsigned plugins are not allowed (`422`) |
| `plugin.signer_untrusted` | `keyId` | the package is signed with a key this server does not trust (`422`) |
| `plugin.signature_invalid` | | the signature does not verify or cannot be read; always refused (`422`) |
| `plugin.id_reserved` | | an id under `io.kalzit.` or `dev.kalzit.` without Kalzit's key (`422`) |
| `plugin.update_other_id` | | the package is for another plugin (`422`) |
| `plugin.downgrade` | | the package is older than the installed version (`409`) |
| `plugin.key_changed` | | the update is not signed by the installed version's key or a key it was handed over to, or it is unsigned (`409`) |
| `plugin.publisher_changed` | `datasources`, `previousKeyId`, `removedVersion` | a removed plugin's id is installed without its signing key (or it was unsigned or removed before 0.3.2) while data sources of its kind exist; repeat with `confirmPublisherChange=true` to clear their secrets (`409`) |
| `plugin.kind_taken` | | another kind has this id (`422`) |
| `plugin.bundle_invalid` | `maxBytes` (when too large) | a panel's bundle is not UTF-8, holds a NUL character, `</script` or `<!--`, or is larger than 8 MiB (`422`) |
| `plugin.bundle_changed` | | the installed bundle's SHA-256 differs from its manifest; it is not served (`409`) |
| `plugin.panel_unavailable` | | the panel plugin is not installed, approved, enabled or trusted, or blocked for the organization (`404`) |
| `plugin.target_refused` | `host` | a fixed network target of the manifest is refused by the data source target rules (`422`) |
| `plugin.io` | `detail` | a file of the host could not be written or read (`422`) |
| `plugin.upload_incomplete` | | the upload broke off (`422`) |
| `plugin.not_installed` | | no such plugin (`404`) |
| `plugin.not_approved` | | enabling before the permissions are approved (`409`) |
| `plugin.nothing_to_approve` | | the version is approved already and no update waits (`409`) |
| `plugin.version_mismatch` | `version` | the version to approve is neither installed nor waiting (`409`) |
| `plugin.not_running` | | restarting a plugin that is not enabled or cannot run (`422`) |
| `plugin.untrusted` | | the key that signed the plugin is no longer trusted (status, log) |
| `plugin.key_invalid` | | `publicKey` is not an Ed25519 public key (`422`, `field: publicKey`) |
| `plugin.key_exists` | | the key is trusted already (`409`) |
| `plugin.key_unknown` | | no such trusted key (`404`) |
| `plugin.key_in_use` | `plugins` (comma-separated) | removing the key stops these plugins; repeat with `confirm=true` (`409`) |
| `plugin.handover_invalid` | | the hand-over does not verify (`422`) |
| `plugin.start_failed` | `detail` | the process could not be started (`datasource_error`) |
| `plugin.root_refused` | | Kalzit runs as root on Linux; plugins do not start (`datasource_error`) |
| `plugin.network_missing` | | Linux: neither the seccomp network filter nor a network namespace took, and plugins without Landlock are not allowed (`datasource_error`) |
| `plugin.without_network_limit` | | Linux: the plugin's network is not limited, allowed with `allowWithoutLandlock` (`process.warnings`) |
| `plugin.secrets_exposed` | `path` | a file of Kalzit's with secrets is readable by plugins (Windows); plugins do not start (`datasource_error`) |
| `plugin.secrets_readable` | `path`, `accounts` | a file of Kalzit's with secrets is readable by other local accounts, not by plugins (`process.warnings`) |
| `plugin.without_landlock` | | the plugin runs without Landlock (`process.warnings`) |
| `plugin.landlock_missing` | | this Linux host offers no Landlock and plugins without it are not allowed (`datasource_error`) |
| `plugin.exited` | `exit` | the process ended before it was ready (`datasource_error`) |
| `plugin.start_timeout` | | the process was not ready within the start time (`datasource_error`) |
| `plugin.handshake_invalid` | `line` | the first stdout line is not `kalzit-plugin <version> ready` (`datasource_error`) |
| `plugin.protocol_unsupported` | `version` | the plugin speaks a protocol version Kalzit does not (`datasource_error`) |
| `plugin.connect_failed` | `detail` | the local connection failed, or it does not end at the plugin's process (`datasource_error`) |
| `plugin.describe_failed` | `detail` | the plugin did not answer `Describe` (`datasource_error`) |
| `plugin.describe_mismatch` | `field` | the `Describe` answer contradicts the manifest (`datasource_error`) |
| `plugin.crashed` | `exit` | the process ended while running (status) |
| `plugin.unresponsive` | | the process stopped answering its health checks and was ended (status) |
| `plugin.restarting` | `seconds` | the plugin failed and waits before its next start (`datasource_error`) |
| `plugin.stopped` | | the plugin failed too often and waits for an administrator's restart (`datasource_error`) |
| `plugin.call_failed` | `detail` | a call to the plugin broke (`datasource_error`) |
| `plugin.unsupported_call` | | the plugin does not implement a call (`datasource_error`) |
| `plugin.protocol` | | the plugin broke the protocol: parts out of order or of another shape, values that do not fit, too many parts, a result without its end, an unknown schema form (`datasource_error`) |
| `plugin.error` | `reason` | the plugin answered with a reason of its own; its text is the message |
| `plugin.connected` | | "Test connection" passed, with the plugin's own text |
| `catalog.disabled` | | the catalog is turned off (`409`) |
| `catalog.url_missing` | | the catalog is on but has no address (`409`) |
| `catalog.url_invalid` | | the catalog address or an entry's URL does not parse (`422`) |
| `catalog.unreachable` | `detail` | the index or its signature could not be loaded: no answer, a time-out, an HTTP error status (`502 datasource_error`) |
| `catalog.https_required` | `host` | a request or a redirect of the catalog left HTTPS (`422`) |
| `catalog.too_large` | `bytes` | the index, its signature or a package is larger than allowed (`422`) |
| `catalog.signature_missing` | | there is no signature next to the index (`422`) |
| `catalog.signature_invalid` | | the index does not match its signature, or the signature cannot be read; always refused (`422`) |
| `catalog.signer_untrusted` | `keyId` | the index is signed with a key not allowed for the catalog, or the stored index's key is allowed no more (install) (`422`) |
| `catalog.private_target` | | a host other than the configured one (a package host, a redirect) resolves to a loopback, private or link-local address, or the configured public host does (`422 datasource_target_blocked`) |
| `catalog.own_address` | | the catalog address points at one of Kalzit's own listening ports on this computer (`422 datasource_target_blocked`) |
| `catalog.key_changed` | `keyId`, `previousKeyId` | the index of this address is signed by another key than the one pinned for it; repeat the refresh with `acceptKeyChange=true` (`409`) |
| `catalog.invalid` | | the index is not valid JSON of the index format (`422`) |
| `catalog.format_unsupported` | `format` | the index has a format this Kalzit does not read (`422`) |
| `catalog.rollback` | `sequence`, `accepted` | the index's sequence is not higher than one taken before from the same key (`422`) |
| `catalog.expired` | `expiresAt` | the index is past its expiry; nothing is installed from it (`422`) |
| `catalog.times_implausible` | | the index is published in the future or valid for more than 31 days (`422`) |
| `catalog.entry_invalid` | `index`, `field` | an entry of the index is not well formed, or an id is listed twice with one version (`422`) |
| `catalog.revocation_invalid` | `index`, `field` | a withdrawal of the index is not well formed (`422`) |
| `catalog.not_loaded` | | no index has been taken from the current address (`409`) |
| `catalog.entry_unknown` | | the index does not list this id and version (`404`) |
| `catalog.entry_revoked` | `reason` | the index withdraws this version (`409`) |
| `catalog.download_failed` | `detail` | the package could not be downloaded or written (`502 datasource_error`) |
| `catalog.package_mismatch` | `field` | the downloaded package is not the entry's: `size`, `sha256`, `id`, `version` or `keyId` (`422`) |

Reasons of the network connector, answered to the plugin (`ConnectResponse.error`) and in
`plugins.connect_refused`, besides the data source target reasons (`target.metadata_address`,
`target.not_allowed`, docs/api/datasources.md); a plugin may pass the `target.*` ones on:

| Reason | Params | When |
|---|---|---|
| `plugin.token_invalid` | | the request does not carry the start's token |
| `plugin.datasource_unknown` | `datasourceId` | the plugin was not given this data source |
| `plugin.protocol_unknown` | | the protocol is neither `tcp` nor `tls` |
| `plugin.target_undeclared` | `host`, `port` | not a target the manifest declares for the data source's settings |
| `plugin.connections_exhausted` | `max` | the plugin holds its maximum of connections |
| `plugin.request_invalid` | | the host is longer than 253 bytes or the data source id longer than 64 |
| `plugin.connector_busy` | `max` | the plugin has its maximum of connection requests under way |
| `target.own_address` | `address` | one of Kalzit's own listening addresses |
| `target.own_database` | `address` | Kalzit's own database |
| `target.unresolvable`, `target.unreachable` | `host`, `detail` | the name does not resolve or no address answers |
