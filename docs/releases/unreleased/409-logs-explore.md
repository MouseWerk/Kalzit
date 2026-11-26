## Improved

- Explore has a **Logs** view for log lines from Loki, Elasticsearch, OpenSearch and other document
  sources: time, level as a dot and a word, and the line, with the volume by level over the whole
  range above them (for Loki counted by a query of its own, otherwise from the loaded lines, as it
  says). Wrap, prettify JSON, order and four ways of merging duplicates change only the view; a line
  opens with its labels and fields, and **Filter for** and **Filter out** add the filter visibly to
  the query. The view reads the documents unchanged; under **Fields** you see and change which
  fields it reads ([Explore](../../guide/explore.md#logs)).
- Loki log queries load 1,000 lines unless you set another limit, at most 5,000.

## Checklist for Windows (manual)

- Explore with a Loki source: run `{app="..."}`, check that **Logs** opens with level words and the
  volume, open a line and use **Filter for**; the query shows `| label = "value"` and runs again.
