English | [Deutsch](de/provisioning.md)

# Provisioning as code

Dashboards, data sources, custom roles and alert rules can live as files in a folder, typically a
Git checkout, and reach Kalzit through the command line: `kalzit provision plan` shows what would
change, `kalzit provision apply` changes it, `kalzit provision export` writes what is stored as
files. The command line talks to a running server's API with a service account's token; files
never reach the server another way, and the server does not read folders of its own.

## Sets

A **provisioning set** is one folder of files for one organization. It owns the resources it
made or took over: a resource belongs to at most one set, and another set cannot take it. An
organization may have several sets (one per team's repository, say), each with its own name;
without a name the set is `default`.

What a set manages is **read-only** for normal edits in the interface and the API: changing,
moving, deleting or restoring answers `409 conflict` with the reason `provisioning.read_only`, the
set and the file to change instead. So do renaming, moving, restricting, handing over or trashing
a folder that holds managed dashboards. Some settings are not part of the files and stay free:
whether an alert rule is paused, silences, and a data source's AI access.

In an emergency an organization admin may **unlock** a resource (`provisioning:write`, audited).
It can then be edited like any other until its set is applied again: the next apply overwrites
it with the file's state and locks it again.

In the interface a managed dashboard, data source, alert rule or role carries the badge **Managed
by files** for people with `provisioning:read`; it opens the set, the file and the last apply,
and holds the unlock. [**Administration > Provisioning**](app:/admin/provisioning) lists the sets, the managed resources,
the applies from the audit log and where the server differs from the files.

## The folder

```text
lager/
  org.yaml
  datasources/lager.yaml
  roles/auditors.yaml
  dashboards/lager.yaml
  alert-rules/lager-hoch.json
```

`org.yaml` names the organization by its id (`name` is for people reading the file) and the set:

```yaml
apiVersion: kalzit/v1
kind: Organization
id: 0199a0b1-...
name: MouseWerk
set: lager
```

Every other YAML or JSON file below the folder is one resource. Folders and files whose names
start with `.` (such as `.git`) and files of other types are skipped. Each file has the same
envelope:

```yaml
apiVersion: kalzit/v1      # optional
kind: Dashboard            # DataSource, Role, Dashboard or AlertRule
uid: lager-board           # stays when the file moves or is renamed
spec: { ... }
```

The `uid` (1 to 100 letters, digits, `.`, `_` and `-`) names the resource for good: renaming or
moving the file changes nothing else. A file whose `uid` is the id of a resource made in the
interface **adopts** it: the set takes it over as it is, and later applies change it. Inside the
files, `datasourceId` and `dashboard` name data sources and dashboards by their uid (or, for
resources the set does not manage, by their id).

### DataSource

```yaml
kind: DataSource
uid: lager
spec:
  name: Lager
  type: postgres
  settings:
    host: db.example.com
    database: lager
    user: leser
  secrets:
    password: { env: LAGER_PASSWORD }
  alerting:
    enabled: true
    maxConcurrent: 4
```

`settings` are those of the form in the interface ([data sources](data-sources.md)). Files never
hold secrets. A secret either names an **environment variable** (`{ env: NAME }`) or a **file**
(`{ fromFile: PATH }`; one line break at the end is dropped), which the command line reads where
it runs and sends with the request, or keeps what Kalzit's **encrypted store** holds for this
source (`{ store: true }`, set once in the interface). A file path is relative to the set's
folder, or absolute inside a folder you name on the command line with `--secret-dir`, such as a
container's mounted secrets:

```yaml
secrets:
  password: { fromFile: /run/secrets/pg_password }
```

```text
kalzit provision apply ./provisioning --server https://kalzit.example.com --secret-dir /run/secrets
```

Without `--secret-dir` only files inside the set's folder are read. Kalzit's own variables
(`KALZIT_*`), `..`, files on other machines, device names, `/proc`, `/sys`, `/dev` and paths with
a part named like Kalzit (its data folder, configuration and keys) are refused before anything is
read. A secret file must be a regular file of at most 64 KiB; a link is followed only when it
stays inside the set's folder or a `--secret-dir` folder. A secret whose value contains the value
of one of Kalzit's own variables (such as `KALZIT_API_TOKEN`) is not sent. Keep secret files out
of Git (`.gitignore`). A secret left out of the file is removed. When the
settings change where the source connects (host, port, user, TLS), a stored secret is not sent
there: name a variable for it, as the interface asks to type it again. `alerting` is the alerting
opt-in; without it the source is not opted in.

### Role

```yaml
kind: Role
uid: auditors
spec:
  name: Auditors
  description: Reads the audit log
  permissions: [audit:read, dashboards:read]
```

Custom roles only; who holds a role is not part of the files.

### Dashboard

```yaml
kind: Dashboard
uid: lager-board
spec:
  folder: Operations/Lager
  model:
    schemaVersion: 2
    title: Lager
    timeRange: { from: now-6h, to: now }
    panels:
      - id: p1
        type: table
        title: Values
        grid: { x: 0, y: 0, w: 12, h: 8 }
        targets:
          - refId: A
            datasourceId: lager
            query: { sql: "SELECT host, v FROM m" }
```

`model` is the dashboard model of the JSON editor ([dashboards](dashboards.md)); without
`timeRange` the organization's default applies. `folder` is a path of folder names (a list when
a name holds `/`); missing folders are made, team spaces are not used. Managed dashboards cannot
link library panels or saved analyses.

### AlertRule

The fields of a rule in the API ([alerting](../api/alerting.md)), with `contactPoints` (names) in
place of `contactPointIds` and `dashboard` (a uid) in place of `dashboardId`. Contact points and
notification policies themselves are not part of the files, nor is whether the rule is paused.
The rule's data source must be opted in to alerting.

YAML aliases (`*name`) are not read, so a file cannot grow when it is read.

## The command line

```text
kalzit provision plan   <folder> --server https://kalzit.example.com [--org ID] [--set NAME] [--prune] [--exit-code] [--secret-dir DIR]...
kalzit provision apply  <folder> --server https://kalzit.example.com [--org ID] [--set NAME] [--prune] [--secret-dir DIR]...
kalzit provision export <folder> --server https://kalzit.example.com --org ID [--set NAME]
kalzit provision import-grafana <file> ...   (see Importing Grafana dashboards)
```

- The token comes from `KALZIT_API_TOKEN`: a token of a service account of the organization
  (**Administration**, **Service accounts**) whose role holds `provisioning:read` (plan, export)
  and `provisioning:write` (apply), and the write permissions of every kind the set changes:
  `datasources:write`, `roles:write`, `dashboards:write`, `folders:write`, `alerts:write`, and
  `datasources:query` on the sources its dashboards and rules use. Organization admins and owners
  hold them all. `--server` may also come from `KALZIT_API_URL`, `--secret-dir` from
  `KALZIT_PROVISION_SECRET_DIRS` (folders separated by commas).
- The address must be `https://`; plain `http://` is accepted only for this machine, since the
  token and the secrets travel with the request. Redirects are not followed: give `--server` the
  address the server answers under. The organization (`--org` or `id` in `org.yaml`) is its id.
- **plan** checks every file with the same rules as the interface and lists per resource what an
  apply would do: create, update (with the changed fields), adopt, delete, unchanged or orphaned,
  and whether the stored resource **drifted** from what was applied last. All problems of the
  files are reported at once. With `--exit-code` it exits with 0 when nothing would change, 2
  when something would and 1 on an error, for checks in a pipeline.
- File paths follow one rule everywhere: relative, `/` between folders, no part starting with
  `.`, no `\` or `:`, YAML or JSON, and no two paths that differ only in case.
- **apply** applies all or nothing in one transaction. It refuses when anything it planned
  against changed in the meantime; plan and apply again. Resources whose files are gone stay
  (managed and read-only, reported as orphaned) unless `--prune` is given: then dashboards and data
  sources go to the trash and roles and rules are deleted. Afterwards every data source the apply
  made or changed is tested; a failed connection is a warning, not a reason to undo the apply.
- **export** writes the organization as files of the set: its own resources at their files and
  uids, resources no set manages under their ids (an apply of the export takes them over), and
  secrets as references. Resources of other sets, resources you may not read (a dashboard hidden
  from you, a rule whose data source you may neither read nor query, or whose dashboard you may
  not read) and dashboards that link library panels or saved analyses are listed as skipped,
  those you may not read without their name. Every path is checked before the first file is
  written, and nothing is written through a link. The list of managed resources leaves out the
  same ones.
- Output follows the system language (German or English); `--output json` prints the server's
  answer with English field names.

Every apply is in the audit log (**Provisioning files applied**, with the counts), and so is each
change it makes, with the set, uid and file.

## API

| Route | Permission | |
|---|---|---|
| `GET /api/orgs/{orgId}/provisioning/resources` | `provisioning:read` | The managed resources of all sets with drift |
| `POST /api/orgs/{orgId}/provisioning/plan` | `provisioning:read` | `{ set?, files: [{ path, content }], prune?, secretValues? }`, answers the plan |
| `POST /api/orgs/{orgId}/provisioning/apply` | `provisioning:write` | The same body; answers the plan and warnings |
| `GET /api/orgs/{orgId}/provisioning/export?set=` | `provisioning:read` | The files of the set |
| `POST /api/orgs/{orgId}/provisioning/resources/{kind}/{uid}/unlock` | `provisioning:write` | Unlocks one resource (`dashboard`, `datasource`, `role`, `alert_rule`) |
