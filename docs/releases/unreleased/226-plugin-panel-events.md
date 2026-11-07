## Improved

- Panels of plugins act like the built-in ones: a time range picked in one sets the dashboard's
  time range as the time picker does, a variable it sets changes only if the dashboard has it and
  it takes the value, and under "Clicks and selection" in the panel editor you choose which
  variable a click or a selection in the panel sets, and from which column, path or property.

## Checklist for Windows (manual)

- In Edge, edit a KPI tile panel (example panel plugin) on a dashboard with a `region` variable:
  "Clicks and selection" lists `$region`; choose it, enter `host` as the field and save. The
  dashboard saves, and the tile looks as before.
