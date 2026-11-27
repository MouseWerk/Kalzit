English | [Deutsch](de/export.md)

# Export

Export a panel or an Explore result as a file, with the [analysis steps](calculated-fields.md)
applied, or save a panel as a picture. API: [export](../api/datasources.md#export). The audit log
has its own export, see [Audit log](administration.md#audit-log).

The file keeps the shape of the result: a table stays a table, documents stay documents and a
graph stays a graph. Kalzit never turns one into another on its own; for a table of documents or
of a graph, add the step that makes one first (see "Tables from documents and graphs" below).

## How

- **Panel:** the **Export...** entry in the panel's menu, or **Export...** in the
  panel editor.
- **Explore:** **Export...** next to the result.

The dialog asks for the **Result** when there are several (each named with its shape: table,
documents or graph), the **Format** that result can have, and for CSV the **Numbers in the CSV
file**. The file holds the result after all active steps; times in CSV and Excel files are in UTC. A panel exports its **saved** version: save the
dashboard first to export your changes (the dialog says so).

Exporting needs the `data:export` permission. Editors, admins and owners have it, viewers do not.
Exporting a panel needs only that you may see its dashboard: the file holds the panel's saved
queries, so you do not need the right to query its data sources. Exporting from Explore or from a
panel you are editing runs your own queries and needs the right to query every data source in it.
Every export is recorded in the [audit log](administration.md#audit-log) with the format, time
range, the size (rows, documents, or nodes and edges) and the panel or data sources, never the
data.

## Formats

| Format | Details |
|---|---|
| CSV, for Excel and other spreadsheets | UTF-8 with a byte order mark so Excel reads umlauts correctly, CRLF line ends. **German** uses a semicolon and a decimal comma; **English** a comma and a decimal point. Times are ISO 8601 in UTC. Text that starts with `=`, `+`, `-` or `@` gets a leading `'` so a spreadsheet never runs it as a formula. |
| Excel workbook (.xlsx) | One sheet with a bold, frozen header row and typed cells: numbers, true/false and times are cells of their type. Very large whole numbers and times before 1900 are text; text is cut at Excel's cell limit of 32,767 characters. |
| JSON | The result as the frame, with its fields and types. |

### Documents

| Format | Details |
|---|---|
| NDJSON, one document per line | Each document on its own line, with its fields in the order the database stored them and its values unchanged. Tools such as `jq` and MongoDB's `mongoimport` read it. |
| JSON | The documents with their field list (schema) and the notes of the result, such as that it was cut off at the row limit. |

### Graphs

| Format | Details |
|---|---|
| GraphML, for Gephi, yEd and Cytoscape | Nodes with their labels (`:Person:Customer`) and properties, edges with their type and properties. Each property gets a type that fits all its values (true/false, whole number, decimal number or text); lists and objects are written as JSON text. Paths are not part of GraphML: their nodes and edges are. |
| JSON | Nodes, edges and paths as the query answered them, with the graph's labels and edge types. |
| CSV: nodes, CSV: edges | The two lists of the graph as CSV files, written like a table. Nodes: `id`, `labels` (`:Person:Customer`), then one column per property. Edges: `id`, `type`, `source`, `target`, then one column per property. The property columns are in name order and the same in every row; a node without the property leaves the cell empty. Lists and objects are written as JSON text. |

In a graph panel the formats are in the panel's own **Export** menu, in three groups: **Image**,
**Graph** (GraphML, JSON) and **Tables** (the two CSV files). The data formats export **Everything
loaded** or only the **Visible nodes** (those you have not hidden or closed in a group), with the
edges between them. GraphML also records where the nodes are, as drawn, so Gephi and yEd open the graph
as you see it; nodes inside a cluster have no position. Nodes you loaded with the explorer are not part of a file: the server makes it from
the panel's query.

### Tables from documents and graphs

- Documents: add the projection step ("Documents as a table") and choose the fields; the export
  then offers CSV, Excel and JSON for the table.
- Graphs: add a graph step that makes a table, such as counting labels or the degree of each
  node; the export then offers the table formats for it.

## Panel as an image

**Save image (PNG)** in a panel's menu saves what the panel shows as a PNG picture: its title,
the chart, table, graph or text, and its legend, in the theme you see, sharp enough for documents
and slides (at least twice the screen's pixels). The picture is drawn in your browser from the
screen, so it holds exactly what you see, without a request to the server, and it is not
recorded in the audit log. It is offered with export, to members who may export data. Menus
and tooltips that are open are not part of the picture; a table shows the rows that are in view.
Panels of a panel plugin draw in a frame of their own that the browser does not let Kalzit read:
their area stays empty in the picture. Images on a panel (in a text panel, for example) are part
of it when they come from your Kalzit server; images from other sites are left out.

### Graph as an image

The **Export** menu of a graph panel saves what the panel shows as **PNG**, **SVG** or **PDF**.
The dialog asks for the **Scope** (the visible part, the whole graph or only the selection), the
**Background** (as shown, light or transparent), whether to include the **legend** and the title,
data source and time range, and for a PDF the **Page** (the size of the drawing or A4 landscape).
The picture is made in your browser from the drawing, with no request to the server and no entry in
the audit log, so everyone who may see the panel can save it.

- **PNG** is a picture at least twice as sharp as the screen, as before.
- **SVG** is vector: shapes stay shapes and every label stays text you can select and search. The
  file holds no scripts and no links to other files; the panel's label font is embedded (some
  editors ignore embedded fonts and show their own).
- **PDF** is one page of vector paths with the text in Helvetica, a font every PDF reader has, so
  the file stays small (a few kilobytes for a graph of a few hundred nodes) and nothing is embedded.
  Helvetica covers Western European text; a label in another script (Cyrillic, Greek, Chinese) is
  put in as a small image of itself. No library is used for it: a PDF library would have added
  300 to 500 kB of script to the app.

Without the right `data:export` the menu offers only the three pictures and says that GraphML, JSON
and CSV need that right.

## Limits

- A server makes at most three export files at once; more answers "busy" and can be tried again.
- A file is at most 256 MiB; Excel files have at most 1,048,575 rows and 16,384 columns. Files
  are made on the server's disk first and then sent, so large exports do not fill its memory. You
  can have one export at a time. A download that breaks off midway (for example when the
  connection drops, or your browser stops reading for a minute) is not saved: export again.
- Export is also bounded by the query time limit and the steps' limits (see
  [Calculated fields and statistics](calculated-fields.md#limits)).
- One export holds one result. With several queries, choose which one in the dialog.
