## Improved

- Time series, bar charts and histograms have a new option group "Axes": placement (auto, left,
  right, off), a label, a fixed width, grid lines, the axis color and line, a linear, logarithmic
  (base 2 or 10) or "log around zero" scale, zero in the middle and soft limits. A field with a
  second unit gets the right axis automatically, and an override can put any field there. A log
  scale says how many points it leaves out (values of zero or below) instead of dropping them
  silently.
- The legend shows any of 19 values per series, picked in four groups (frequent, over time,
  distribution, count) with a search: among them total, count, first, difference, change in %,
  range, standard deviation, variance, median and any percentile. At most six per panel; the list
  shows the first two, the table all of them and sorts by a click on a column. The legend takes a
  width beside the chart and a limit of series, with "show all" for the rest.
- The time series tooltip sorts its series by value, can hide series at zero (and says how many)
  and takes a largest width and height; beyond that it scrolls with the time kept at the top.
- The panel editor's group "Panel" has the description and the transparent background. The
  description shows behind the info sign in the panel header, with links, emphasis and
  dashboard variables filled in.
- The Grafana import keeps axis placement, label, width, grid lines, scale and soft limits, legend
  values (including total) and legend width, tooltip sort, hidden zeros and size; legend values
  without a counterpart are named in the import report.

## Checklist for Windows (manual)

- In the panel editor of a time series, set the scale to "Logarithmic" on data with zeros: the
  chart draws with ticks at 1, 10, 100, ... and names the left-out points below it.
- Pick "Total" and a percentile as legend values, switch the legend to a table and sort by a
  column; check the chips, the picker and the table at 100 % and 150 % display scaling in the light,
  dark and high contrast themes.
