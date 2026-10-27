# Design blueprint

The binding look of the Kalzit web app. Every UI change matches these boards: layout, density,
spacing, component shapes and wording. Colours map onto the existing design tokens; the hex values
in the boards are reference values, not new tokens. The rules in `CLAUDE.md` still win where they
are stricter (no accent borders or left bars for selected states, i18n catalogs, tokens).

Each board is a static HTML page at 1440 px width. Open it in a browser; the `support.js` reference
belongs to the design tool and is not needed to view the page. `canvas.json` holds the board order,
titles and heights.

| Board | Screen |
| --- | --- |
| `Main.dc.html` | Dashboard view: sidebar, top bar, toolbar with filters, panel grid, right rail |
| `DashboardEdit.dc.html` | Edit mode with the Add menu |
| `DashboardEditSelected.dc.html` | Edit mode with the outline and the panel inspector |
| `PanelEditor.dc.html` | Full-page panel editor with queries, colours and thresholds |
| `Start.dc.html` | Start page |
| `Explore.dc.html` | Explore with documents, schema and analysis steps |
| `Settings.dc.html` | Server settings with live preview and undo |
| `Updates.dc.html` | Online and offline updates, backups and history |
| `DataSources.dc.html` | Data source list with team access drawer |
| `DataSourceNew.dc.html` | Add and configure a data source, advanced options per type |
| `DataChat.dc.html` | "Fragen", a planned data chat; not scheduled yet |
| `SavedAnalyses.dc.html` | Saved analyses: save dialog and saved state in Explore, the list under Explore, the panel editor's "From saved analysis", and the conflict on save |
| `Access.dc.html` | Sign in and first-run setup on the calm backdrop: every state of both, 360 px layouts, light and dark, notes on motion and accessibility |

The boards contain sample data only.
