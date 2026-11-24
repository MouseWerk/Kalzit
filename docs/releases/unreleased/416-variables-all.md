## Improved

- Variables with fixed values or values from a query can offer “All”. It stands first in the
  list, a dashboard can open with it, and it sends every value as a list, or one custom value for
  “All” (such as `.*`), always as a parameter.
- Variables with values from a query have a regex filter (named groups `text` and `value` split
  the shown name and the value), a sort order, a choice between reading the values on load or on
  every new time range, and fixed extra values. A preview in the dashboard settings shows the
  values as the filter bar will.
- Panels and links that use a variable from a query at “All” wait until its values are loaded,
  and show why when its query fails, instead of running first with an empty list.
- Share links, reports and AI answers keep “All” and read the variable’s values each
  time they run, with the rights of the person they belong to, instead of a list frozen when they
  were made.
- Variables can allow typed values outside their list.
- Choices in the filter bar keep a minimum width, so picking a shorter value no longer moves the
  variables after it.
- The Grafana import takes over “All” with its custom value, typed values, and the regex, sort
  order and refresh of query variables.
