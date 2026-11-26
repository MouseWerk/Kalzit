## Improved

- Ad hoc filters show as chips in the filter bar: add one with field, comparison and value,
  change any part with a click on it, or remove it. The comparisons offered are those the data
  source can apply.
- Switch variables show as a switch in the filter bar, data source variables as a list of the
  sources you may query.
- The dashboard settings have forms for data source variables, ad hoc filters and switches.
- Dashboard settings > Variables has a "Dependencies" tab: a drawing and a table of which
  variable needs which, where each is used, and what is unused, in a cycle or missing.
- A panel says when the ad hoc filters do not narrow it because another data source is picked.
- Public pages show only the number of ad hoc filters.

## Checklist for Windows (manual)

- Add an ad hoc filter to a dashboard with a SQLite panel that writes `$__filter`, change its
  value through the chip, remove it; the panel follows each step.
- Open Dashboard settings > Variables > Dependencies and check the drawing and the table.
