# API: plugins

The plugin routes, exactly as the server implements them (`server/src/routes/plugins.rs`). All
paths are below `/api`. Every `/admin/...` route is `Access::ServerAdmin` (installing and trusting
plugins is a server action); the organization routes need `plugins:configure` in that
organization. General rules (docs/ARCHITECTURE.md, "API conventions") apply. How plugins work:
docs/ARCHITECTURE.md, "Plugins". This version hosts **data source** plugins; panel plugins and the
catalog follow.

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
connection the connector refused, with `datasourceId`, `host`, `port` and `reason`; at most once a
minute per target and reason, no actor), and in the organization's log `plugins.blocked` and
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
3. The manifest: valid, `kind = "datasource"`, `min_kalzit` not newer than this Kalzit, a binary
   for this server's platform.
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
    "running": true,                // its kind is registered (approved, enabled, trusted, runnable here)
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
- The local connection: Linux, `KALZIT_PLUGIN_ADDRESS` is `fd:3`, one end of a socket pair
  Kalzit made, inherited by the plugin: it serves the protocol on that one connection (it may
  open no socket itself; the pair reaches only Kalzit). Windows, Kalzit creates the
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

- Linux: `fd:4`, a `SOCK_SEQPACKET` socket pair Kalzit made and the plugin inherits; requests may
  overlap and carry a `request_id`. The plugin's sandbox lets it open no socket at all, so this
  and its connection to Kalzit (`fd:3`) are the only sockets it has.
- Windows: a named pipe Kalzit created; one pipe connection per request, Kalzit serves only the
  plugin's process, and the client checks that the pipe's server is Kalzit
  (`KALZIT_PLUGIN_HOST_PID`).

Kalzit then:

1. refuses an unknown token (`plugin.token_invalid`) and a data source the plugin was not given,
   or whose settings changed or which was deleted since (`plugin.datasource_unknown`: a change
   or the trash takes the data source back until the next call hands it over again);
2. refuses any host, port or protocol that is not one of the manifest's targets for that data
   source's settings as the plugin last received them, compared without case and trailing dot
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
4. refuses a connection beyond `64` at once per plugin (`plugin.connections_exhausted`), counted
   over every process of the plugin (Linux: all processes of its session, which none may leave),
   and refuses every connection while a process of the plugin hides its descriptors
   (`plugin.connections_uncountable`; making itself non-dumpable is refused in the sandbox);
   more than 16 requests under way at once are refused (`plugin.connector_busy`);
5. connects to the checked address, never resolving again, within one budget of 10 seconds for
   the lookup and every address (`target.unreachable` otherwise), and hands it over: on Linux the
   connected socket itself (`SCM_RIGHTS`), on Windows the pipe, which Kalzit relays to the TCP
   connection.

A connection without traffic for 15 minutes is closed (Linux: Kalzit takes a copy of the
socket from whichever process of the plugin holds it with `pidfd_getfd`, reads its last traffic
from `TCP_INFO` and shuts it down; Windows: the relay ends). Refusals of steps 1 to 4 answer
`ERROR_KIND_BLOCKED`, step 5 `ERROR_KIND_FAILED`; every refusal is written to the plugin's log
(`stream: host`), Kalzit's log and the audit log (`plugins.connect_refused`). The plugin speaks
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
- `network` (part of the seccomp filter): `socket` is refused with `EACCES` for every family,
  Unix sockets included: the plugin's two sockets to Kalzit are inherited, connected already
  (`fd:3`, `fd:4`), and a TCP connection comes only from the connector. So it reaches neither
  the network (tested: a direct connection fails, also to loopback) nor a Unix socket of the host
  such as a database's, Docker's or D-Bus's, named or abstract (tested), whatever Landlock's ABI
  and whether or not the network namespace took. `prctl(PR_SET_DUMPABLE)` is refused too
  (tested), so the connector can always count the plugin's connections.
- `network_namespace`: a network namespace of its own with nothing but an unconfigured loopback
  device, where unprivileged user namespaces are allowed; the connector's sockets stay in the
  host's namespace.
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
`plugin-api/panel/v1/kalzit-panel.d.ts`; Kalzit checks every event with
`kalzit_plugin_api::panel::parse_event`, whose constants are the limits below. The host side
(serving the bundle, the iframe, sending the messages) is not built yet; the API and an example
panel (`examples/plugins/panel-kpi`) are.

Every message is a JSON object with `kalzit: "panel"`, `api: 1` and `type`.

**Into the frame** (Kalzit to the panel):

| `type` | Fields | When |
|---|---|---|
| `init` | `options` (the panel's JSON options), `size` (`width`, `height` in CSS pixels), `theme` (`scheme`: `light` or `dark`; `tokens`: Kalzit's design tokens by custom property name, resolved), `locale` (`en`, `de`), `timeZone` (IANA), `title` | the answer to `ready` |
| `data` | `series` (per query: `refId` and `result` in its native shape as in docs/api/datasources.md, or `error`), `timeRange` (`from`, `to`), `revision` (grows with every run) | after `init`, and whenever the panel's queries ran |
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

Rules:

- Enforcement lies with the panel host, which is not built yet: it runs `parse_event` on every
  event and keeps the rate limit per panel. Until it exists, nothing receives panel events; the
  rules below are what the host will hold a bundle to.
- An event is at most 16 KiB of JSON; Kalzit takes at most 20 events per second per panel and
  drops the rest. An event of another `api`, an unknown `type` or a field out of its range is
  dropped (`panel.not_json`, `panel.not_envelope`, `panel.api_unsupported`, `panel.type_unknown`,
  `panel.field_invalid`, `panel.too_large`, shown in the browser console). Unknown fields are
  ignored and never passed on.
- `setVariable` sets a variable only when the dashboard has it; `click`, `select` and `range` act
  like the same gestures on built-in panels.
- Both sides accept messages only from the other window (`event.source`): the frame's origin is
  opaque (`null`), so origins say nothing.
- For the host's design: `connect-src 'none'` stops requests, but a frame can still carry data
  out by navigating, itself (`location = "https://elsewhere/?data"`), a new window or the top
  page. The host therefore loads the bundle with `sandbox="allow-scripts"` only (no
  `allow-top-navigation`, `allow-popups` or `allow-forms`), serves the frame document and the
  bundle with a strict Content Security Policy of their own (`default-src 'none'`, the bundle as
  the only script, no `form-action`, `base-uri 'none'`), and blocks the frame's own navigation
  away from the bundle's document (CSP `navigate-to` where browsers support it; otherwise the
  host treats a navigation of the frame, seen as a new `load` event, as a breach and removes the
  panel).
- Evolution: version 1 grows only by new optional fields and new message types. A panel ignores
  types and fields it does not know; Kalzit speaks to a bundle in the version its manifest names
  (`[panel] api`) and refuses versions it does not know at install.

## Not here yet

- The panel host: serving installed panel bundles, the sandboxed iframe and the message
  exchange above. Panel packages are refused at install meanwhile (`plugin.kind_unsupported`).
- The catalog (signed index, downloads).
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
| `plugin.kind_unsupported` | | a panel plugin; only data source plugins can be installed yet (`422`) |
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
| `plugin.connections_uncountable` | | a process of the plugin hides its descriptors, so its connections cannot be counted |
| `plugin.connector_busy` | `max` | the plugin has its maximum of connection requests under way |
| `target.own_address` | `address` | one of Kalzit's own listening addresses |
| `target.own_database` | `address` | Kalzit's own database |
| `target.unresolvable`, `target.unreachable` | `host`, `detail` | the name does not resolve or no address answers |
