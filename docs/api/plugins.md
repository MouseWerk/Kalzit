# API: plugins

The plugin routes, exactly as the server implements them (`server/src/routes/plugins.rs`). All
paths are below `/api`. Every `/admin/...` route is `Access::ServerAdmin` (installing and trusting
plugins is a server action); the organization routes need `plugins:configure` in that
organization. General rules (docs/ARCHITECTURE.md, "API conventions") apply. How plugins work:
docs/ARCHITECTURE.md, "Plugins". This version hosts **data source** and **panel** plugins; the
catalog follows. The panel types of an organization and a panel's frame are routes for its
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
`plugins.landlock_optional`, `plugins.landlock_required`, and in the organization's log `plugins.blocked` and
`plugins.unblocked`. Summaries carry versions, key ids and the approved network targets, never
secrets.

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
      "sandbox": ["no_new_privs", "landlock", "seccomp", "memory_limit"],
      "sandboxMissing": ["user_namespace", "ipc_namespace", "network"]
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
{ "keyId": "17e204d64429eae4", "publicKey": "<base64>", "name": "Example GmbH", "addedAt": 1800000000000, "plugins": [] }
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
- `allowWithoutLandlock`, off by default: on a Linux host without Landlock, plugins start anyway.
  Without the switch they are refused there (`plugin.landlock_missing`): nothing would keep them
  from reading Kalzit's files. `landlockAvailable` says whether this host has Landlock.

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
with the defaults for the rest. The dashboard routes store a plugin panel's options as they are
given; they are not checked against the manifest on save.

### Frame: `GET /orgs/{orgId}/panel-plugins/{pluginId}/frame?dashboard={dashboardId}`

`Access::OrgMember`, then per request:

- With `dashboard`: the dashboard must exist in the organization and not be in the trash. If its
  current version shows a panel of this type, `dashboards:read` on the dashboard is enough
  (viewers); otherwise the caller adds the panel and needs `dashboards:write` on it. A dashboard
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
  connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none';
  form-action 'none'; base-uri 'none'; frame-ancestors 'self'
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Cache-Control: no-store
Referrer-Policy: no-referrer
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), fullscreen=()
```

- `sandbox allow-scripts` without `allow-same-origin`, as the UI's `<iframe sandbox="allow-scripts">`
  has it, so the document runs in an opaque origin also when it is opened on its own: no cookies,
  no storage, no access to Kalzit's page, its session or its API (a request from the frame carries
  no session, and `connect-src 'none'` stops it anyway).
- The hash of the bundle is the only script source: nothing else runs, inline or loaded.
- No `Set-Cookie`; the response is never cached.
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
  (`settings.url_no_host`), and an empty host (`settings.host_invalid`) are refused. The plugin
  then connects on its own (see "Sandbox"), so this checks the configured targets, not the
  connections it makes.
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
  `KALZIT_PLUGIN_TOKEN` and `KALZIT_PLUGIN_HOST_PID` (the plugin accepts connections from that
  process only) and nothing else of Kalzit's environment (on Windows also
  `SystemRoot`, `SystemDrive`, `windir`, `NUMBER_OF_PROCESSORS`, `PROCESSOR_ARCHITECTURE` and a
  `PATH` of `System32`; on Linux `PATH=/usr/bin:/bin`, `HOME` and `LANG`), and `TMP`, `TEMP` and
  `TMPDIR` pointing at its private temporary directory.
- Start: within 10 seconds it prints `kalzit-plugin 1 ready` on stdout, Kalzit connects (Windows:
  the named pipe's server process must be the child; Linux: `SO_PEERCRED` of the socket must be
  the child) and its `Describe` answer must fit the manifest (protocol, kind, shapes,
  capabilities).
- Health: every 30 seconds Kalzit asks `Describe`; two failed answers in a row end the process
  (`plugin.unresponsive`).
- Restarts: after the n-th failure in a row (crash, failed start, unresponsive) the plugin waits
  10 s, 30 s, 1, 2, 5 and 10 minutes before its next start; calls in between answer
  `plugin.restarting`. After that it stays stopped (`plugin.stopped`) until `restart`. A process
  that ran 10 minutes before it failed starts the count afresh.
- A crash fails only the calls of its kind. Disabling, removing, a removed key and Kalzit's stop
  end the process and everything it started.

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
  (read and write, not run: the socket and `tmp`). Kalzit's data directory, configuration and
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
- `signals`: the plugin may signal only itself and its process group (`kill(0)`, `kill(-pid)`,
  its own threads): Landlock's signal scope where the kernel has ABI 6, else a seccomp filter on
  `kill`, `tgkill` and `rt_(tg)sigqueueinfo`. With the filter it cannot signal its children one
  by one (only the whole group).
- `user_namespace` and `ipc_namespace`: the account mapped to itself (no capabilities after the
  start); not where the host forbids unprivileged user namespaces (some distributions, most
  containers).
- `memory_limit`: the data segment (`RLIMIT_DATA`, 2 GiB).
- **Not limited**: the network (no network namespace: Kalzit's connector, through which a plugin
  would reach only its declared targets, is not built yet; a plugin can open connections to any
  address the server can reach), the number of processes and the CPU.

**Windows**

- `restricted_token`: no privileges except bypass traverse checking, Administrators for deny
  only, and the restricting SIDs Everyone, Users, `RESTRICTED`, a SID of the plugin (from its
  id) and a SID of this start (not the logon session, which Kalzit's own process grants read
  access): the plugin opens only what one of these may open. Kalzit's data directory (SYSTEM,
  Administrators and Kalzit's account only) and the account's profile are out of reach. Its
  package grants read and run to the plugin's SID only, its run directory read and write (not
  run) to the start's SID only, so plugins cannot reach each other's packages or run
  directories (tested). Its default DACL grants only Kalzit's account, SYSTEM and the start's
  SID, so other plugins cannot open its process or objects (tested). A plugin
  creates its pipe instances with a DACL for Kalzit's account and `RESTRICTED` (the restricting
  SIDs could not create the next instance otherwise).
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
- **Not limited**: the network. A restricted token does not stop a process from opening sockets;
  holding a plugin to its declared targets needs an AppContainer without network capabilities or
  a Windows Filtering Platform rule per process, which are not built yet.

On both systems the network rule of the manifest therefore rests on the signature and the
administrator's approval of the declared targets, plus the host's check of every target before
each call. The contract tests check per system that a plugin cannot open Kalzit's process or
another plugin's, cannot write or read Kalzit's data directory, sees nothing of Kalzit's
environment, and (Linux) cannot `ptrace` or signal Kalzit.

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
| `link` | `url`, `title` (optional) | `url` at most 2048 characters: `http`/`https` with a host and no user name, or a path in Kalzit starting with `/` (not `//`); `title` at most 200 |
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

- The catalog (signed index, downloads).
- Kalzit's connector for plugin network access, and with it network isolation on both systems.
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
