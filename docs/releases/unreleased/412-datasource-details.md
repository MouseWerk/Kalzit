## Improved

- Choose a default data source for your organization: **Make default** in a source's menu in the list, or **Default data source** in the form. Explore and new panels start with it when no source is chosen, and a Grafana import proposes it for Grafana's default source.
- Grafana addresses work in Kalzit: `/datasources` and `/connections/datasources` open the data sources, `/connections/datasources/new` adds one, and `/d/<uid>` opens a dashboard imported from Grafana (or the dashboards list when the uid is unknown).

## Fixed

- A data source that passed **Test connection** in the form no longer shows "Not tested" in the list right after saving.
