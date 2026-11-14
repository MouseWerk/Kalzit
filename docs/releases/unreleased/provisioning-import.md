## Improved

- Provisioning as code: dashboards, data sources, custom roles and alert rules as YAML or JSON files
  in a folder, planned, applied and exported with `kalzit provision plan`, `apply` and `export`
  through the API of a running server with a service account's token. A provisioning set belongs
  to one organization and owns its resources; an apply is all or nothing, removes resources only
  with `--prune`, and reports drift. Secrets stay out of the files: they name environment
  variables or keep what Kalzit stores. Managed resources are read-only in the interface; an
  organization admin can unlock one in an emergency until the next apply. New permissions
  `provisioning:read` and `provisioning:write` for organization admins.
- Grafana dashboards can be imported from their JSON (`kalzit import grafana` or the API): panels,
  queries, variables, rows, annotations, links and time settings are converted where Kalzit has a
  counterpart, with a report of what was converted, approximated or skipped that stays with the
  dashboard. Nothing is queried or contacted during the import.
