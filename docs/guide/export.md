# Export

Export a panel or an Explore result as a file, with the [analysis steps](calculated-fields.md) applied.
API: [export](../api/datasources.md#export).

## How

- **Panel:** the **Export...** entry in the panel's menu, or **Export...** in the
  panel editor.
- **Explore:** **Export...** next to the result.

The dialog asks for the **Format**, and for CSV the **Numbers in the CSV file**. The file holds the
result after all active steps; times are in UTC. A panel exports its **saved** version: save the
dashboard first to export your changes (the dialog says so).

Exporting needs the `data:export` permission. Editors, admins and owners have it, viewers do not.
Every export is recorded in the [audit log](administration.md#audit-log) with the format, time
range, number of rows and the panel or data sources, never the data.

## Formats

| Format | Details |
|---|---|
| CSV, for Excel and other spreadsheets | UTF-8 with a byte order mark so Excel reads umlauts correctly, CRLF line ends. **German** uses a semicolon and a decimal comma; **English** a comma and a decimal point. Times are ISO 8601 in UTC. Text that starts with `=`, `+`, `-` or `@` gets a leading `'` so a spreadsheet never runs it as a formula. |
| Excel workbook (.xlsx) | One sheet with a bold, frozen header row and typed cells: numbers, true/false and times are cells of their type. Very large whole numbers and times before 1900 are text; text is cut at Excel's cell limit of 32,767 characters. |
| JSON | The result as the frame, with its fields and types. |

## Limits

- A server makes at most three export files at once; more answers "busy" and can be tried again.
- A file is at most 256 MiB; Excel files have at most 1,048,575 rows and 16,384 columns. Files
  are sent while they are made, so large exports do not fill the server's memory. A download that
  breaks off midway (for example when the connection drops) is incomplete: export again.
- Export is also bounded by the query time limit and the steps' limits (see
  [Calculated fields and statistics](calculated-fields.md#limits)).
- A table result exports directly. For documents, add the projection step first ("Documents as a
  table"); graphs have no export format yet.
