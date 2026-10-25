# Panels

A panel turns the result of its queries into a visualization. Every result has one of three
shapes, and a panel says which shapes it understands:

| Shape | Typical source | Panels |
|---|---|---|
| `frame` (table, time series) | SQL, Prometheus, CSV files, search aggregations | Time series, Stat, Gauge, Bar gauge, Bar chart, Table, Pie chart, Histogram, Heatmap, State timeline, Status history, Text |
| `documents` | MongoDB, JSON files, HTTP JSON, search hits | Document explorer, Schema, Field distribution, Document card |
| `graph` | Neo4j, Memgraph, TigerGraph | Network, Hierarchy, Paths |

In the panel editor the **Visualization** picker shows each type with a small drawing and a short
description, and offers the ones that fit the result first; **Show N more that do not fit this
result** lists the rest. Documents become a table only through an explicit step (see
[Documents as a table](calculated-fields.md#documents-as-a-table)); nothing is converted behind your back.
How panels are placed, edited and saved is on the [Dashboards](dashboards.md) page.

![Text, grouped bar chart, bar gauge and pie panels](../screenshots/dashboard-panels-light.png)

## Options every panel has

**Field options** (for frame panels) are set for all fields and can be overridden per field or
series. They are grouped as:

- **Unit and display**: **Unit**, **Decimals**, **Display name**, **Text for no value**.
- **Min and max**: empty follows the data.
- **Thresholds**: see below.
- **Value mappings**: see below.
- **Color**: see below.
- **Table cells**: table only.
- **Overrides**: see below.

### Units

The **Unit** menu is grouped: General (number without unit, short, percent 0 to 100, percent 0 to
1, parts per million), Data (bytes binary and decimal, bits), Rates (bytes, bits, operations,
requests per second, requests per minute), Durations (nanoseconds to days), Currency, Energy and
electricity (watt, watt-hour, volt, ampere, hertz), Temperature (Celsius, Fahrenheit, Kelvin) and
Date and time (date and time, ISO 8601, time from now). **From the data source** keeps the unit
the source reports; **Custom suffix...** writes your own text after the value. Units typed by hand
in older panels stay a plain suffix. **Decimals** empty picks a sensible number per value.

### Thresholds

Thresholds are steps with a colour. **Add thresholds** creates a base ("below every step") and
**Add step** adds a **From** value with a colour. **Steps are** either absolute **Values** or a
**Percent between min and max**. Time series can **Show in the chart** the thresholds as **Lines**,
**Areas** or both. Stat, gauge, bar gauge, table cells and the colour scheme **By threshold** use
the steps to colour values.

### Value mappings

Replace what is shown for a value. **Match** by **Value**, **Range** (From, To) or **Regular
expression** (RE2 syntax: no lookaround or backreferences), then **Show as** a text and a colour.
The first mapping that fits a value decides. A dashboard with an invalid pattern is not saved, and
the message names the panel.

### Colours

Under **Colors**, the **Color scheme**:

| Scheme | Effect |
|---|---|
| Palette (Kalzit default) | One palette colour per series, in series order |
| One color | The same colour for every series |
| By threshold | Lines and values take the colour of the threshold step their value is in |
| Ramp green-yellow-red, blue, gray | A ramp from the first series to the last |

For each series (the first few; the rest through **Overrides**) pick a colour, a line style and an
opacity. A colour is a palette colour, a tone (OK, Warning, Critical, Neutral) or **Custom color**
as `#rrggbb`; a custom colour stays the same in light and dark theme, and the editor shows its
contrast to the panel and warns when it is too low for lines (3:1).

### Overrides

**Add override** sets options for some fields only: match **With the name** or **Matching a
regular expression**, then any option. A later override wins over an earlier one; **Clear a
default for these fields** shows the option as if the defaults had not set it.

## Time series

Values over time as lines. Options: **Legend** (List, Table, Hidden; position Below or Right;
values Last, Min, Max, Mean), **Tooltip** (Nearest series, All series, Hidden), **Series names**
(label names in double braces, such as `{{job}} on {{instance}}`), and the **Graph style**:

- **Draw as**: lines, bars or points.
- **Line interpolation**: linear, smooth, step before, step after. **Line width** (0 to 10 px) and
  **Line style** (solid, dashed, dotted).
- **Fill**: none, solid or hatched, with **Fill opacity** and a **Gradient** (fading, hue, or a
  scheme from the thresholds).
- **Show points**: when there is room, always, never, with a **Point size**.
- **Connect gaps**: never, always, or up to a duration; **Break line after** a duration.
- **Stack series**: off, normal or percent (100 %), in **Stack group**s; positive values stack
  upward and negative values downward.
- **Bar alignment** and **Bar width** (10 to 100 % of the room between two points).
- **Comparison series**: drawn muted and dashed.

Every graph option can be set per series through an override. A panel with one series draws in a
quiet look: a light line on dark (dark on light), 2 px, smooth, with a fading hatch beneath.
For the older look (1 px, straight, unfilled), set line width 1, linear interpolation and fill none,
and pick a series colour under Color. Left and right arrow keys read out the values at a point in
time.

![Time series graph styles](../screenshots/graph-styles-light.png)

## Stat

One big number per field with an optional trend line. Options: **Value** (Last, Mean, Minimum,
Maximum, Sum), **Color** (None, Value, Background), **Trend** (None, Line with area), **Text**
(Automatic, Value, Name and value, Name).

## Gauge

A value on a dial between min and max, with **Show threshold markers**.

## Bar gauge

Values as filled bars. **Style**: **Bar** or **Lit cells**. A result with a name and a value per
row shows one bar per row; otherwise every field becomes one bar, reduced with **Value**. Options:
**Value** (in the text colour, in the bar's colour, hidden), **Names** (before the bar, above it,
hidden), orientation.

## Bar chart

One bar per row, grouped by field. Options: **Orientation** (Horizontal, Vertical), **Category
names** (as many as fit, hidden), **Show values on bars**, legend. A bar chart of one series takes
the quiet monochrome look of the time series. Only the first rows are drawn when there are many;
the panel says so.

## Table

Every row and column, sortable by clicking a header. Options: **Column filters** (text, or `>`, `<`,
`=` and `!=` on numbers), **Show in pages** with **Rows per page**. Under **Table cells**, per
column or field: **Cell display** (Value, Colored text, Colored background, Gauge, Link), a **Link**
(web address, email address or path on this server; `${__value}` is the cell's value) and **Column
width (px)**.

## Pie chart

**Shape** Pie or Donut. **Labels** None, Percent, Name or Value; **Label position** On the slices
(a slice too small for its label leaves it out; the legend and tooltip still show it) or Beside
the circle. The legend table can list the value, the share or both. **Value** reduces fields to
slices when every field becomes one.

## Histogram

How values are spread over equal buckets. Options: **Buckets** (count; empty picks a number from
the data amount), **Bucket size**, **Count all fields together**.

## Heatmap

Density over time in coloured buckets. **Buckets**: **Count the values** (with **Time buckets**
and **Value buckets**) or **One field per bucket**. **Color scale**: Linear or Square root.

## State timeline and Status history

State timeline: states over time as coloured stretches, also over several queries. Status history:
the status per point in time as a grid of cells. **Color known state words** colours values such as
ok, up, healthy, success and passed as good; warning, degraded and pending as warning; and down,
error, failed, failure and critical as critical.

## Text

Text or Markdown (**Format**: Markdown or Plain text) in **Content**, with dashboard variables as
`$name` or `${name}`. HTML is shown as text.

## Documents panels

For `documents` results (see [Explore](explore.md#documents)):

- **Document explorer**: every document as a tree with the type of each value. Select a value to
  copy its path or filter by it; arrow keys move through the tree.
- **Schema**: every field path with its types and **Coverage**, marking fields missing in some
  documents or with mixed types; **Only outliers** narrows the list.
- **Field distribution**: how the values of one field (a path such as `items[].price`) are spread,
  with the most common values.
- **Document card**: one document readably, field by field, paging through the rest; **Title
  field** names the card.

![Documents as a tree, schema and distribution](../screenshots/dashboard-documents-dark.png)

## Graph panels

For `graph` results (see [Explore](explore.md#graphs)): **Network** (nodes and edges in a free
layout, WebGL; groups and an explorer), **Hierarchy** (directed structures in layers) and **Paths**
(paths as sequences of nodes and edges, for example from `shortestPath`).

Options include **Node name property**, **Color by** (Label, Community, Component), **Node size**,
**Edge width property**, **Node limit**, **Group nodes by label** (for large graphs, always,
never) and a **Time property of edges** that adds a time slider. **Explorer mode** loads a clicked
node's neighbours step by step (**Neighbours per step**), each step undoable, and **Clicking a node
sets** a dashboard variable so other panels follow the node. Browsers without WebGL 2 show the
graph as a table; **Show as table** is also available on demand.

![Graph styles in the dark theme](../screenshots/graph-styles-dark.png)
