## Improved

- Tables can show a footer: one calculation per column, such as the total, the mean, the count
  ("4 of 2,000 rows") or the 95th percentile, over all rows of the query or only the filtered
  ones. It stays in place while you scroll and always says what it calculates over. Imported
  Grafana tables keep their footer.
- Saving a dashboard shows what changed, in words (with which parts of a panel) or line by line
  as JSON, and offers "Save as copy".
- When someone else saved in the meantime, the conflict dialog can also save your changes as a
  copy, so both versions stay.
- Panels have query options above their queries: the maximum data points, the smallest interval
  (with the interval that results), their own time range and time shift (moved here), a cache
  time and hiding the time note in the header. The server applies the points, the interval and
  the cache time to the saved panel everywhere it runs. Grafana imports carry them over.

## Checklist for Windows (manual)

- Edit a panel, open "Query options", set 100 data points and a smallest interval of 5m, apply
  and save: the save dialog lists the change, "As JSON" shows it, and the panel stays in edit
  mode after saving.
- Turn on a table's footer with "All number columns: Total" and a column filter, switch
  "Calculates over" to the filtered rows, and check the footer and the line under the table.
