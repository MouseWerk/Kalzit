# Provisioning API

Provisioning sets (docs/guide/provisioning.md) and the Grafana dashboard import
(docs/guide/grafana-import.md). `kalzit provision` and `kalzit import grafana` are clients of these
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

- The body may take up to 32 MiB; one file up to 4 MiB, a set up to 5000 files.
- `plan` and `apply` read every file, check it with the API's own rules and report all problems
  at once (`422 validation`, reason `provisioning.invalid_files`, one problem per line in
  `message`).
- `apply` runs in one transaction under the organization's lock. When a managed resource or a
  record changed since the plan it made, it answers `409 conflict`, reason `provisioning.changed`,
  and nothing is applied. Afterwards it tests the connection of each data source it made or
  changed; a failure is a warning in `ApplyResult.warnings`, the apply stands.
- `secretValues` are only read for the `{ env: NAME }` references of the files; the server never
  reads its own environment for them. They are stored encrypted like secrets entered in the
  interface, never in the answer, the log or the audit log. A record keeps an HMAC of them to see
  a change.
- `unlock`: `{kind}` is `dashboard`, `datasource`, `role` or `alert_rule`. Audited as
  `provisioning.unlocked`; the next apply of the set overwrites the resource and locks it again.
- Normal changes of a managed, locked resource answer `409 conflict` with the reason
  `provisioning.read_only`: saving, moving, trashing, restoring and purging dashboards (and
  folders holding them), changing their owner or restoring a version; changing, trashing,
  restoring, purging and the alerting opt-in of data sources; changing and deleting roles;
  changing and deleting alert rules (pausing stays possible).

## Reasons

| Reason | Params | When |
|---|---|---|
| `provisioning.invalid_files` | `count`, `path`, `detail` | `422 validation`: files that do not read or do not pass their checks; `path` and `detail` name the first |
| `provisioning.changed` | | `409 conflict`: something the plan read changed before the apply took the lock |
| `provisioning.read_only` | `kind`, `set`, `uid`, `path` | `409 conflict`: the resource is managed by a provisioning set; change its file, or unlock it |
| `datasource.connection_failed` | | In `ApplyResult.warnings`: the connection test after the apply failed |
| `dashboards.import_unreadable` | | `422 validation`: the Grafana JSON is not a dashboard the import reads |
