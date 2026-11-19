## Improved

- Dashboards, data sources, alert rules and roles that a provisioning set manages are marked
  "Managed by files" for people who may read the sets: the badge opens the set, the file and the
  last apply, the settings are read-only, and Edit on a dashboard stays in place, locked, with the
  reason. Organization admins unlock one resource from there after a question that says what the
  next apply does. A refused change names the set and the file to change instead.
- Administration > Provisioning shows the sets of the organization, the managed resources with
  their files, the last applies from the audit log and where the server differs from the files
  (unlocked, changed, deleted). While nothing comes from files, it shows the first commands to
  copy.
- Grafana dashboards are imported in the interface under Dashboards > Import from Grafana: upload
  or paste the JSON, map each data source of the file to one of Kalzit's (proposed by name and
  kind) or leave it out, and read the report of what is converted, approximated and skipped before
  anything is created. The new dashboard opens with a line that leads to the report, which stays
  with the dashboard.
