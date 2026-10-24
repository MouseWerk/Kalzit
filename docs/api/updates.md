# API: updates

The update routes, exactly as the server implements them (`server/src/routes/updates.rs`). All
paths are below `/api`, every route is `Access::ServerAdmin`: without a session `401
unauthenticated`, as a signed-in non-admin `403 forbidden`, both before the body is read. General
rules (docs/ARCHITECTURE.md, "API conventions") apply. How it works and how to operate it:
docs/ARCHITECTURE.md, "Updates", and the operator guide docs/operations/updates.md.

Refusals carry a reason from the table "Updates" in docs/api/datasources.md, "Reasons", which the
UI translates: `422 validation` for files that fail verification, `409 conflict` for a state that
does not allow the step (another step running, nothing downloaded, a downgrade, this server not
installing on its own). Every route answers the status below, as it is after the step.

Every step is written to the audit log with `resourceType: "update"` and the version as
`resourceId`: `update.checked`, `update.downloaded`, `update.download_failed`, `update.uploaded`,
`update.upload_refused`, `update.discarded`, `update.skipped`, `update.scheduled`,
`update.unscheduled`, `update.applied`, `update.apply_failed`, `update.installed` (the new version
confirmed its health), `update.rolled_back` (Kalzit returned on its own), `update.rollback_started`
(a return asked for), `update.backed_up`, `update.backup_downloaded`. The daily check and a planned
installation are recorded with the administrator who turned them on or planned them, or without
an actor.

## Status

`GET /admin/updates` answers:

```jsonc
{
  "installed": { "version": "0.1.0", "platform": "linux", "arch": "x64", "since": 1800000000000 },
  "channel": "stable",                 // setting updates.channel
  "checkDaily": false,                 // setting updates.check_daily
  "window": "02:00-04:00",             // setting updates.window, the administrator's local time
  "lastCheck": { "at": 1800000000000, "latest": "0.2.0", "error": null },
  "available": {                       // the offered release; null when none (or skipped)
    "version": "0.2.0", "channel": "stable", "size": 48200000, "sha256": "9f3c...",
    "notes": "...", "notesUrl": "https://github.com/...", "releasedAt": "2026-10-22T00:00:00Z",
    "highlights": [{ "kind": "new", "text": "..." }],   // kind: new | improved | fixed | security
    "minimumVersion": null, "keyId": "17e204d64429eae4",
    "staged": true                     // downloaded and verified
  },
  "skipped": null,                     // a version the administrator chose to skip
  "staged": {                          // the release ready to install, downloaded or uploaded
    "version": "0.2.0", "source": "online", "size": 48200000, "sha256": "...", "keyId": "...",
    "notes": "...", "notesUrl": null, "highlights": []
  },
  "job": { "phase": "idle" },          // see below
  "mode": { "automatic": true, "reason": null },   // reason: an updates.mode_* reason
  "database": "sqlite",                // or "postgres": no backups by Kalzit
  "schedule": { "version": "0.2.0", "at": 1800003600000, "until": 1800010800000 },
  "trustedKeys": ["17e204d64429eae4"], // empty: this build cannot verify anything
  "preflight": { "backupBytes": 312000000, "freeBytes": 2100000000, "activeUsers": 3,
                 "healthTimeoutSecs": 60 },
  "maxPackageBytes": 536870912,
  "backups": [{ "file": "kalzit-0.1.0-1800000000000.db", "size": 298000000, "version": "0.1.0",
                "at": 1800000000000, "kind": "switch", "by": null }],   // kind: switch | manual
  "history": [{ "version": "0.2.0", "from": "0.1.0", "at": 1800000000000, "kind": "update",
                "outcome": "installed", "reason": null, "reasonCode": null, "source": "online",
                "scheduled": true, "actor": "<user id>", "durationMs": 41000 }],
  "people": [{ "id": "<user id>", "name": "Ada Lovelace" }],   // names for actor and by
  "rollbackTargets": [{ "version": "0.1.0", "keptAt": 1800000000000,
                        "needsDatabaseRestore": false, "restorePossible": true }]
}
```

`job.phase` is `idle`, `checking`, `downloading` (`version`, `bytesDone`, `bytesTotal`),
`applying` (`version`, `step`: `verify`, `backup` or `replace`), `restarting` (`version`; the
server stops right after its answer) or `failed` (`action`, `error` with `reason`, `params`,
`message`, and `at`). History `outcome` is `installed`, `rolledBack` (Kalzit returned on its own;
`reason` says why) or `aborted` (refused or failed before anything changed; `reasonCode` is the
reason). `source` is `online`, `offline` or `kept` (a return).

## Steps

| Route | Body | Does |
|---|---|---|
| `POST /admin/updates/check` | | asks GitHub for the newest release of the channel; a failure is reported in `lastCheck.error`, not as an error answer |
| `POST /admin/updates/download` | `{"version"}` | starts downloading the offered version in the background (`job.phase: downloading`); `409 updates.not_offered` without a check that offered it |
| `POST /admin/updates/upload` | multipart | an offline release: one part `bundle` (a `.kalzit-update` file), or the parts `manifest`, `signature` and `package`; verified like a download, then staged; one upload at a time (`409 updates.busy`), and only with twice its size free (`409 updates.disk_full`); a preview release on the stable channel is refused (`409 updates.channel_mismatch`) |
| `DELETE /admin/updates/staged` | | removes the staged release and its plan |
| `POST /admin/updates/skip` | `{"version"}` | hides the offered version until a newer one is offered |
| `POST /admin/updates/apply` | `{"version", "acknowledgeNoBackup"?}` | installs the staged version now (see below) |
| `PUT /admin/updates/schedule` | `{"version", "at", "until"?, "acknowledgeNoBackup"?}` | installs the staged version at `at` (Unix ms, at most 7 days ahead); a server that was down at `at` and starts after `until` does not install (`updates.schedule_missed`); on PostgreSQL the own backup is confirmed when planning (`409 updates.backup_unsupported` without) |
| `DELETE /admin/updates/schedule` | | cancels the plan |
| `POST /admin/updates/rollback` | `{"version", "restoreDatabase"?}` | returns to a kept version (see below) |
| `POST /admin/updates/backups` | | backs up the SQLite database now (`409 updates.backup_unsupported` on PostgreSQL) |
| `GET /admin/updates/backups/{file}` | | the backup file (`application/vnd.sqlite3`, attachment); only names in `backups`, else `404` |

The upload body may be up to the largest package (512 MiB) plus its two small files; each part
is limited on its own (`422 updates.too_large`). An offline package (`.kalzit-update`) is the line
`KALZIT-UPDATE-1\n`, then the manifest, its signature and the package, each as a little-endian
64-bit length followed by its bytes.

**Apply** checks the staged files again (signatures, size, SHA-256), refuses a downgrade, the
installed version and a release whose `minimumVersion` is above the installed one, runs the new
binary with `--version`, backs the SQLite database up (`VACUUM INTO`), keeps the running binary
under `updates/versions/<version>/`, writes the plan and swaps the binary. Then it answers
`job.phase: restarting` and the server restarts into the new version, which confirms its health or
returns on its own. On PostgreSQL, apply needs `"acknowledgeNoBackup": true`
(`409 updates.backup_unsupported` without). Where the server does not install on its own
(`mode.automatic: false`), apply, schedule and rollback answer `409 updates.manual_only` with the
`updates.mode_*` reason as `mode`; `kalzit update apply` installs from the command line.

**Rollback** puts a kept binary back. When the database schema is the same as when that version
ran, only the binary changes. Otherwise the backup taken when that version was left replaces the
database, and what changed since is lost: the request must say `"restoreDatabase": true`
(`409 updates.rollback_needs_restore` without; `409 updates.rollback_restore_unsupported` on
PostgreSQL). A downgrade is only possible this way.
