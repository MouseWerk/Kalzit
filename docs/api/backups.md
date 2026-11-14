# API: backups

Scheduled backups and the backup target, for server administrators. The step-by-step guide for
operators (what to back up, restore, PostgreSQL) is docs/guide/backup.md.

A backup is one file, `kalzit-backup-<UTC time>.zip.enc` (such as
`kalzit-backup-20261114T020000.000Z.zip.enc`; `.zip` with `backups.encrypt` off), a zip with

- `kalzit.db`: a consistent copy of the SQLite database (`VACUUM INTO`, safe while Kalzit runs);
  with PostgreSQL instead a `README.txt` that points to `pg_dump`;
- `acme/`: the ACME account and certificate, encrypted with the secrets key;
- `plugins/`: the installed plugin packages (without the `run` and `uploads` folders);
- `kalzit.toml`: the configuration file the server was started with, if any.

The secrets key is never part of a backup: keep it apart (docs/guide/backup.md). With
`backups.encrypt` (on by default) the zip is encrypted with AES-256-GCM under a random key, which
is sealed with the secrets key; restoring needs the secrets key the backup was taken with.
Restoring is only `kalzit backup restore <file> --yes` on the stopped server, never through the
API.

## Schedule and retention

Server settings with undo, lockable by `KALZIT_SETTING_*`:

| Key | Default | Meaning |
|---|---|---|
| `backups.schedule_enabled` | `false` | Takes a backup on the schedule and stores it at the target. |
| `backups.interval_hours` | `24` | Hours between two scheduled backups, 1 to 744. |
| `backups.keep_count` | `14` | Backups kept at the target, 1 to 1000. |
| `backups.encrypt` | `true` | Encrypts backups with the secrets key. |
| `backups.allowed_dirs` | `[]` | Directories a local target may be in (or below). |

Every minute the leader (with several servers on one database; alone, the server itself) looks
whether a scheduled backup is due: `backups.interval_hours` after the last scheduled run started,
at once when there was none. One run at a time per server. After a successful store, retention
deletes at the target the backup files (only names of the form above, directly in the folder or
under the prefix) beyond the newest `keep_count`.
## Target

The target's fields depend on each other, so it is saved in one explicit step after a
connection test (like the mail server); a refusal names its `field`. It is stored as the
versioned server setting `backups.target`; an S3 secret access key lives encrypted in the secret
store (`server_secrets`, re-encrypted by `kalzit secrets rotate`) and is never sent back.

```json
{ "kind": "local", "path": "D:\\Backups\\Kalzit" }
{ "kind": "s3", "endpoint": "https://s3.eu-central-1.amazonaws.com", "region": "eu-central-1",
  "bucket": "kalzit-backups", "prefix": "prod/", "pathStyle": false, "accessKeyId": "AKIA..." }
```

- **Local**: an absolute path of an existing directory at or below one of
  `backups.allowed_dirs`, compared after links are resolved. Kalzit's data directory and the
  folder of its own database are always refused. Files are written as `<name>.partial`, then
  renamed; on Linux with mode 0600.
- **S3-compatible** (Amazon S3, MinIO, Ceph, Garage, ...): `endpoint` is `http://` or `https://`
  with a host and no path; `region` defaults to `us-east-1`; `pathStyle` addresses
  `endpoint/bucket/key` (most self-hosted stores), else `bucket.host/key`. Requests are signed with
  AWS Signature Version 4 and go through Kalzit's HTTP client: the data source target rules
  (`datasources.allowed_targets`, never metadata addresses) and the outbound proxy
  (`network.proxy_url`) apply, redirects are not followed, and an endpoint that is Kalzit itself is
  refused. Kalzit never creates a bucket. Files up to 32 MiB go up in one request, larger ones as a multipart upload in 32 MiB
  parts (aborted on failure). A stored secret is only used again while endpoint, bucket and key id
  stay the same.

Saving needs a passed connection test: it writes a small file `.kalzit-test-<id>` and deletes it again, which proves
that backups can be stored and retention can delete them.

## Routes

| Method and path | What |
|---|---|
| `GET /admin/backups` | `BackupsView` |
| `PUT /admin/backups/target` | `{target, secretAccessKey?, version}`: tests, then saves; `target: null` removes it. Answers `BackupsView`; `409 version_conflict` with `current` |
| `POST /admin/backups/target/test` | `{target?, secretAccessKey?}`: tests the form's values, or the saved target without `target`; `{ok: true}` |
| `POST /admin/backups/run` | Takes a backup now and stores it at the saved target; answers the `Run` (also when it failed) |
| `GET /admin/backups/runs?limit=&cursor=` | `Page<Run>`, newest first |

All need a server admin. Tests and saves count like data source connection tests per admin.

`BackupsView`: `{databaseIncluded, database ("sqlite" | "postgres"), target (as above, or null),
hasSecret, version, schedule: {enabled, intervalHours, keepCount, encrypt, nextRunAt}, lastRun}`.

`Run`: `{id, kind ("scheduled" | "manual"), targetKind ("local" | "s3"), status ("running" |
"succeeded" | "failed"), fileName, sizeBytes, deletedCount, reason, detail, startedBy, startedAt,
finishedAt}`. The history keeps a year. A run left `running` by a stop or crash is marked failed
with `backup.interrupted` at the next run.

Audit: `backup.target_changed` (kind, endpoint and bucket of an S3 target; never a key),
`backup.completed` and `backup.failed` (run id, kind, target kind, file or reason; scheduled runs
have no actor), and the schedule settings as `settings.updated`.

## Reasons

| Reason | Code | When |
|---|---|---|
| `backup.path_invalid` | `422 validation` on `path` | not an absolute path |
| `backup.path_refused` | `422 validation` on `path` | not below `backups.allowed_dirs`, not an existing directory, or in Kalzit's data directory |
| `backup.path_not_writable` | `422 validation` on `path` | Kalzit cannot write or delete a file there |
| `backup.endpoint_invalid` | `422 validation` on `endpoint` | not an `http(s)://` address with a host and without a path, user or query |
| `backup.region_invalid` | `422 validation` on `region` | not letters, digits, `-` or `_` |
| `backup.bucket_invalid` | `422 validation` on `bucket` | not 3 to 63 lowercase letters, digits, dots or hyphens |
| `backup.prefix_invalid` | `422 validation` on `prefix` | longer than 512 characters, control characters or `..` |
| `backup.access_key_invalid` | `422 validation` on `accessKeyId` | empty or too long |
| `backup.secret_invalid` | `422 validation` on `secretAccessKey` | too long or control characters |
| `backup.secret_required` | `422 validation` on `secretAccessKey` | no secret sent and none stored for this store, bucket and key id |
| `backup.target_blocked` | `422 validation` / `502` on `endpoint` | the target rules refuse the store's address, or it is Kalzit itself |
| `backup.target_unreachable` | `502 datasource_error` on `endpoint` | the store cannot be reached; `params.detail` |
| `backup.target_timeout` | `502 datasource_error` | the store did not answer in time |
| `backup.credentials_refused` | `502 datasource_error` on `secretAccessKey` | the store refused the key (`403`, `InvalidAccessKeyId`, `SignatureDoesNotMatch`) |
| `backup.bucket_not_found` | `502 datasource_error` on `bucket` | the bucket does not exist (`404`, `NoSuchBucket`) |
| `backup.target_failed` | `502 datasource_error` | any other answer of the store; `params.detail` |
| `backup.snapshot_failed` | (run) | the copy of the database or the zip could not be made |
| `backup.no_target` | `409 conflict` | no target is saved |
| `backup.running` | `409 conflict` | a backup is running already |
| `backup.interrupted` | (run) | a stop or crash cut the run short |
