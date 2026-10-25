# Calculated fields and statistics

Analysis steps work on the results of a panel's or an Explore query, one after the other. The
queries stay as they are; nothing is converted unless a step asks for it. The browser and the
server run the same steps with the same rules, so an [export](export.md) matches what the panel
shows. API reference: [analysis steps and expressions](../api/settings-dashboards.md#analysis-steps).

![The steps tab with a moving average and a trend line](../screenshots/panel-editor-steps-dark.png)

## Working with steps

In the panel editor (tab **Steps**) and in Explore (**Steps and actions**):

1. Choose the **Kind of step** and press **Add step**.
2. Fill in its fields. Most steps first name the **Query** (the query's id, such as A) whose result
   they read.
3. Use **Preview** after any step to see its table (first rows) or **Results of the queries** for
   the input. Each step shows its row and field count, or why it did not run ("Not run, an
   earlier step failed", "Turned off").
4. A step can be turned off (**Active**), moved up or down and removed. At most 50 steps.

A step writes its result back under the query's id, so later steps and the panel see the changed
table. A step that reads a hidden query gets no data until the query is shown again.

## Calculated field

Adds a field with the **Name of the new field** from an **Expression** over the fields of one
table.

Fields are written by name, or in brackets when the name has spaces or symbols:
`[Revenue (€)] * 1.19`. The expression language is parsed and type-checked and never run as code;
it is at most 2000 characters.

| Expression | Result |
|---|---|
| `betrag * 2` | the field `betrag` times two (empty stays empty) |
| `1 + 2 * 3` | 7 |
| `-2 ^ 2` | -4 (`^` binds tighter than the minus sign) |
| `2 ^ 3 ^ 2` | 512 (`^` goes right to left) |
| `betrag / 0` | empty (division by zero is empty, not an error) |
| `coalesce(betrag, -1)` | `betrag`, or -1 where it is empty |
| `if(ok, 'ja', 'nein')` | text depending on a true/false field |
| `ok and betrag > 15` | true or false |
| `isnull(land) or land = 'CH'` | true where the country is empty or CH |
| `round(betrag * 1.2, 1)` | rounded to one decimal |
| `concat(land, '-', stueck)` | `AT-1` |
| `weekday(zeit)` | 1 (Monday) to 7 (Sunday) |
| `startOf(zeit, 'week')` | the start of the week of a time |
| `(zeit - startOf(zeit, 'year')) / 86400000` | days since the start of the year |
| `[Umsatz (€)] / betrag` | a field with brackets in its name |

Types are number (also whole numbers), text, true/false and time (Unix milliseconds): time minus
time is a number of milliseconds, time plus a number is a time, text plus text joins. Operators by
precedence: `or` `||`, `and` `&&`, `not` `!`, comparisons (`=` `==` `!=` `<>` `<` `<=` `>` `>=`,
not chained), `+` `-`, `*` `/` `%`, `^`. Comparing with `null` is refused; use `isnull(x)`.

Functions: `if`, `coalesce`, `isnull`, `round(x, digits)`, `floor`, `ceil`, `abs`, `sqrt`, `exp`,
`ln`, `log10`, `pow`, `min`, `max`, `year`, `month`, `day`, `hour`, `minute`, `second`,
`weekday`, `startOf(t, unit)` with unit `minute`, `hour`, `day`, `week`, `month`, `quarter` or
`year`, `concat`, `text`, `number`, `lower`, `upper`, `length`, `contains`. Calendar functions use
the time zone the dashboard shows (the dashboard's, else yours), and a week starts on the first
day of the week set there; `weekday` stays 1 (Monday) to 7 (Sunday). An error names the place
(`unexpected input at 4`).

## Join queries

Matches the rows of a **Right query** to those of a **Left query**, **Join on** **Time** (the first
time field of each) or **Key fields** (choose the key on each side). **Rows**: only rows found on
both sides, all rows of the left query, or all rows of both. The result takes the place of the
left query; the right one is used up. Its first field is the key and the other fields are named
`<query>.<field>`, so a later calculated field can use both queries:

> Query A holds revenue per day (`betrag`), query B holds sessions per day (`sitzungen`). Join A
> and B on time, then add a calculated field `proSitzung` = `A.betrag / B.sitzungen`: revenue per
> session.

A join makes at most 500,000 rows.

## Statistics

**Statistics** answers one row per chosen field with the **Measures** you tick: Count, Sum, Mean,
Median, Minimum, Maximum, Standard deviation, **Percentiles** (such as `90, 99`; columns `p90`,
`p99`), First value, Last value. Empty values are left out. The standard deviation is the sample
standard deviation; percentiles interpolate between the closest ranks, as Excel's PERCENTILE.INC
does.

Example: for `betrag` = 10, 20, 30.5 and an empty value, count is 3, sum 60.5, mean 20.17, median
20, minimum 10, maximum 30.5 and the 90th percentile 28.4.

## Trend, moving average, correlation

- **Trend**: the least-squares line of a field **Over** the time field (else the row number).
  Choose **Trend line as a new field** or **Slope per day and R²** (also the intercept and
  number of points).
- **Moving average**: the trailing mean over a **Window in rows** (1 to 10,000), empty until the
  window is full.
- **Correlation**: Pearson's r of a **First field** and **Second field**, with the number of
  rows.

## Compare with previous period

Adds the value exactly one **Week**, **Month** or **Year** earlier (UTC; 31 March compares with
the last day of February), the difference, or the change in percent. The query has to cover both
periods: for a week, choose at least the last 14 days. With a field `v` of 5 a week before and 10
now, the difference is 5 and the change 100 %.

## Group and pivot

- **Group**: one row per distinct combination of the **Group by** fields, with **Summaries**
  (field, Calculation, optional name): count, sum, mean, median, min, max, standard deviation,
  first, last. A summary is named `sum(betrag)` unless you name it.
- **Pivot**: one row per value of **Rows from**, one field per value of **Columns from** (at most
  500), filled from **Values from** with a calculation.

## Documents as a table

The projection step turns the `documents` result of a query into a table: one column per field
path (`items.0.price`), with a name and type (from the first value, time, number, whole number,
text or true/false). A column's values that do not fit its type are empty. A result that already
is a table passes unchanged. You edit the projection in the documents panel's editor; steps after
it work on the table. At most 200 columns.

## Limits

A step makes at most 5,000,000 cells (rows times fields) and the steps of one run at most
67,108,864 UTF-16 units of text, in the browser and on the server alike. The steps work on the
results in memory, bounded by the data source's row limit. The reasons the interface can show are
in the [API reasons](../api/datasources.md#analysis-steps-and-expressions).
