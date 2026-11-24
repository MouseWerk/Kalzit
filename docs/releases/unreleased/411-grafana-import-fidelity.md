## Improved

- Import from Grafana carries over much more of a panel: units become Kalzit's units (a euro
  value reads as euros, not "40 k currencyEUR"), field overrides by name and pattern, value
  mappings with their colours, series names from Prometheus and Loki legend formats, the time
  series' graph style, stacking, threshold display, legend and tooltip, table column names and
  cell displays, and heatmap bucket options. The import report lists only what has no
  counterpart, such as a table footer or horizontal bars.
- Variables that stand on "All" in Grafana start with every value picked. Every multi-value
  variable can do so too: **Start with every value picked** in its settings.

## Fixed

- A unit Kalzit does not know (stored by an earlier import) is no longer printed after values;
  the panel editor names it as an unknown unit instead of showing "From the data source".
- Dashboards imported from Grafana before this release get their units taken over at the next
  start of the server, once, as a new version of each dashboard with an entry in the audit log;
  the previous version stays in the history and units Kalzit cannot map stay as they were.
  Dashboards managed by provisioning files and dashboards in the trash are left alone.
