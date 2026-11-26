## Improved

- Charts in small panels stay readable: a legend below the drawing leaves the chart a least
  height and shows names only in narrow panels, a short wide panel keeps its legend beside the
  chart, pie labels outside the circle give way before the circle shrinks to a dot, and long
  value axis labels drop their unit or are shortened instead of taking half the width.
- Bar chart category names turn at an angle when they do not fit side by side, so every name
  shows, and names at the panel's edges are no longer cut off.
- Gauges fill the space of their panel, also in short wide panels.
- Several values in one stat panel stand side by side in a short panel instead of the last one
  being cut off.
- Axis ticks use only the decimals they need ("€1,500" instead of "€1,500.00"); values keep the
  decimals set for the field.
- Annotations are thin dashed lines and light bands in their own color over the plot only, with a
  small marker on the time axis, so dense charts stay readable.

## Fixed

- A pie chart could show its donut pushed out of the panel and a cut-off legend on first load
  until it was drawn again.
