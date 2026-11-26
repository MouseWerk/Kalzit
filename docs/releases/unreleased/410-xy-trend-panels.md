## Improved

- New panel **XY chart**: two number fields against each other, a point per row, with a series
  per value of a field, size and colour by a field, and points, lines or both. Above 12,000
  points it draws an even sample, says so and offers a density view; drag a rectangle to zoom in.
  See [Panels](../../guide/panels.md#xy-chart).
- New panel **Trend**: a time series over an ascending number field instead of time. It never
  sorts or groups by itself; when the X values do not fit, it says where and, in the panel
  editor, offers the step that makes them fit or the XY chart.
- New analysis step **Sort**: orders the rows by up to five fields, ascending or descending.
- The analysis step "Trend" is now called **Trend line**.
- The Grafana import takes over XY charts and trend panels.
