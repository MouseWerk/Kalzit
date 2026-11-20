# Provisioning API

Provisioning sets (docs/guide/provisioning.md) and the Grafana dashboard import
(docs/guide/grafana-import.md). `kalzit provision` (its `import-grafana` also as `kalzit import grafana`) is the client of these
routes; the file format is described in the guide. All routes are under `/api/orgs/{orgId}/...`
and follow the API conventions (JSON in camelCase, times in Unix milliseconds, errors as
`{ error: { code, message, field?, reason?, params? } }`). The TypeScript types (`SetRequest`,
`Plan`, `ApplyResult`, `Provisioned`, `Export`, `ImportReport`, `GrafanaImportRequest`) are
generated into `ui/src/api/generated/shapes.ts`.

## Rights

| Permission | Built-in roles | Allows |
|---|---|---|
| `provisioning:read` | admin, owner | Listing the managed resources, planning a set, exporting |
| `provisioning:write` | admin, owner | Applying a set, unlocking a managed resource |

Planning and applying also need the permissions the API asks for each change: `datasources:write`
for data sources, `roles:write` and every permission a role holds (before and after) for roles,
`dashboards:write` on the dashboard and its folder (`dashboards:delete` to delete, `folders:write`
to make folders, `folders:permissions` to move across restricted folders) for dashboards,
`alerts:write` for rules, and `datasources:query` on every data source a dashboard or rule uses (a
source the same apply makes needs the organization-wide right). Exports leave out what the caller
may not read.

## Routes

| Route | Permission | Body | Answer |
|---|---|---|---|
| `GET /provisioning/resources` | `provisioning:read` | | `200 Page<Provisioned>`, one page, every set |
| `POST /provisioning/plan` | `provisioning:read` | `SetRequest` | `200 Plan` |
| `POST /provisioning/apply` | `provisioning:write` | `SetRequest` | `200 ApplyResult` |
| `GET /provisioning/export?set=` | `provisioning:read` | | `200 Export` |
| `POST /provisioning/resources/{kind}/{uid}/unlock` | `provisioning:write` | | `200 Provisioned` |
| `POST /dashboards/import/grafana` | member; `dashboards:write` where it goes | `GrafanaImportRequest` | `200 { report, model, dashboard \| null }` |
| `GET /dashboards/{dashboardId}/import-report` | member; `dashboards:read` on it | | `200 { source, sourceVersion, report, createdAt, createdBy }` |

```ts
interface SetRequest {
  set?: string;                       // default "default"; 1 to 64 letters, digits, . _ -
  files: { path: string; content: string }[];   // relative paths with "/", YAML or JSON
  prune?: boolean;                    // delete the set's resources whose files are gone
  secretValues?: Record<string, string>;        // values of the variables the files name
}
```

- The body may take up to 32 MiB; one file up to 4 MiB, a set up to 5000 files and 64 MiB once
  read. YAML aliases are refused. Paths are relative with `/`, no part starts with `.`, no `\` or
  `:`, YAML or JSON only, and no two differ only in case; exports follow the same rule.
- `plan` and `apply` first check that the caller holds the write permission of every kind the
  files hold (and, with `prune`, of every kind the set manages), then read every file, check it
  with the API's own rules, check the caller's rights per resource, and only then run the checks
  that may reach out (a plugin's settings check, the check on save). Folders are found among
  those the caller sees. All problems come at once (`422 validation`, reason
  `provisioning.invalid_files`, one problem per line in `message`).
- `apply` runs in one transaction under the organization's lock. When a managed resource or a
  record changed since the plan it made, it answers `409 conflict`, reason `provisioning.changed`,
  and nothing is applied. Afterwards it tests the connection of each data source it made or
  changed; a failure is a warning in `ApplyResult.warnings`, the apply stands.
- `secretValues` are only read for the `{ env: NAME }` (key `NAME`) and `{ fromFile: PATH }` (key
  `file:PATH`) references of the files; the server never reads its own environment or files for
  them, and refuses keys of Kalzit's own variables (`KALZIT_*`). `PATH` is relative to the set's
  folder or absolute; `..`, `~`, a drive-relative path, a network share, a device name, `/proc`,
  `/sys`, `/dev` and parts named like Kalzit are refused (`422`, reason
  `provisioning.invalid_files`). The server only checks the form, since it never reads these
  files: the command line reads an absolute path only inside a folder given with `--secret-dir`
  and follows a link only while it stays inside the set's folder or such a folder. They are
  stored encrypted like
  secrets entered in the interface, never in the answer, the log or the audit log. A record keeps
  an HMAC of them to see a change.
- `apply` also checks under the lock that each folder a dashboard goes into still exists outside
  the trash and every team space, and that no folder appeared where it makes one.
- `export` and `GET /provisioning/resources` leave out what the caller may not read: data
  sources without read rights, dashboards they may not read (through `check_resource`, which also
  records an org admin's look into a team space), and rules whose data source they may neither
  read nor query or whose linked dashboard they may not read. Left out of an export, such a
  resource is named by id and reason only.
- `unlock`: `{kind}` is `dashboard`, `datasource`, `role` or `alert_rule`. Audited as
  `provisioning.unlocked`; the next apply of the set overwrites the resource and locks it again.
- Normal changes of a managed, locked resource answer `409 conflict` with the reason
  `provisioning.read_only`: saving, moving, trashing, restoring and purging dashboards, changing
  their owner or restoring a version; renaming, moving, restricting, handing over, trashing and
  purging folders that hold them; changing, trashing, restoring, purging and the alerting opt-in
  of data sources; changing and deleting roles; changing and deleting alert rules. The check runs
  again inside the change's transaction under the organization's lock, which an apply holds.
  Outside the files, and so free to change: pausing and resuming a rule, silences, and a data
  source's AI access.

## Reasons

| Reason | Params | When |
|---|---|---|
| `provisioning.invalid_files` | `count`, `path`, `detail` | `422 validation`: files that do not read or do not pass their checks; `path` and `detail` name the first |
| `provisioning.changed` | | `409 conflict`: something the plan read changed before the apply took the lock |
| `provisioning.read_only` | `kind`, `set`, `uid`, `path` | `409 conflict`: the resource is managed by a provisioning set; change its file, or unlock it |
| `datasource.connection_failed` | | In `ApplyResult.warnings`: the connection test after the apply failed |
| `dashboards.import_unreadable` | | `422 validation`: the Grafana JSON is not a dashboard the import reads |
