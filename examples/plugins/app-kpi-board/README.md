# KPI board

An example app plugin for Kalzit, grown from the KPI tile panel: one page, "KPI board", that lists
the dashboards the signed-in person may read and keeps a note per dashboard in the app's own
storage. Plugin id: `dev.kalzit.app-kpi-board`.

It asks for two capabilities (docs/api/plugins.md, "App plugins"), which an administrator approves
with the plugin:

- `dashboards:read`: Kalzit's page lists the dashboards with the person's rights;
- `storage`: the notes, at most 50 MiB per organization.

The page runs in a sandboxed frame without network and talks to Kalzit only through the app
message API (version 1): `{kalzit: "app", api: 1, type, id, ...}` out, `{kalzit: "app", api: 1,
replyTo, result | error}` back. It never sees a session, a secret or anything it could write to
Kalzit's data. Organization admins can block it or limit it to a role and up under
Verwaltung > Apps.

Package it like the panel example:

```sh
kalzit-plugin package --manifest examples/plugins/app-kpi-board/kalzit-plugin.toml \
  --file board.js=examples/plugins/app-kpi-board/board.js \
  --file README.md=examples/plugins/app-kpi-board/README.md \
  --unsigned --out app-kpi-board.zip
```