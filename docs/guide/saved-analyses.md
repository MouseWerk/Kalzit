# Saved analyses

A saved analysis (Auswertung) is an Explore query kept under a name: its data source and query,
the analysis steps and the chosen visualization. Analyses live in folders and team spaces like
dashboards and follow the same rights; dashboard panels can show one and stay linked to it. API:
[saved analyses](../api/analyses.md).

## Saving in Explore

**Save** (Speichern, Ctrl+S) next to **Run query** opens **Save analysis** for a query that is not
saved yet:

- **Name**, required.
- **Location** (Ablage): the top level of the organization, one of its folders, or a folder of a
  team space. The line below says who will see the analysis, and that only people who may query
  the data source can change the query.
- **Description**, optional.
- **What is saved**: the data source, the queries, the number of steps and the visualization.
- **Keep the time range** (Zeitraum mitspeichern) is off by default: the analysis then opens with
  whatever range is set at the time, and a dashboard panel uses the dashboard's range. Turned on,
  the range in use is stored with it.

Once saved, Explore shows the analysis's place and name above the toolbar, "Saved ... by you"
next to the buttons and a neutral **Changed** (Geändert) mark as soon as the query, the steps, the
visualization or a kept range differ from the saved version. **Save** then saves a new version.
The menu beside it offers:

| Entry | What it does |
|---|---|
| Save as... (Ctrl+Shift+S) | A copy under a new name and location; Explore goes on with the copy |
| Rename and describe | Name and description only; unsaved changes to the query stay unsaved |
| Move... | Another location, with the same visibility line as the save dialog |
| Versions and history | Every save; compare one with the current version or restore it as a new one |
| Discard changes | Loads the saved version again, after asking |

Without the right to save the analysis, **Save** becomes **Save as**.

## Opening

**Open** (Öffnen, Ctrl+O) in Explore lists the saved analyses, newest change first; type to filter,
Up and Down to move, Enter to open. Opening loads the query, the steps and the visualization into
Explore and runs them. Analyses also appear in the command palette (Ctrl+K) by name.

## The list

**Saved** (Gespeichert) sits under **Explore** in the sidebar. It shows the folders and team spaces
on the left, a search, filters for **Data source** and **Created by** (everyone or you) and the
sort (**Last changed** or **Name A to Z**). Each row shows the name and location, the data source,
who created it (**Created by**, Erstellt von: **You** for your own, **Unknown** once the account
was removed), the dashboards that use it (**Used in**) and when and by whom it was last changed.
J and K move between rows, Enter opens.

![The list of saved analyses with their data source, creator, use in dashboards and last change](../screenshots/analyses.png)

**Open** and the name open the analysis in Explore when you may query its data source. Without
that right (viewers, or a source not shared with you) they open it **to view and run**: the page
shows its title, description, location, data source and time range (the kept one, or pick
another), runs the stored queries as saved and draws the result with its steps and
visualization; **Run again** runs it once more, **Versions and history** lists its saves. Only
people who may query the source see **Edit in Explore**. Viewers find the list as **Analyses**
in the sidebar, since they have no Explore.

![A saved analysis opened by a viewer to view and run: description, location, time range and result](../screenshots/analysis-view.png)

The row menu offers **Open in Explore** (or **View and run**), **Add to dashboard...** (as a linked panel), **Duplicate**,
**Move...**, **Copy link**, **Versions** and **Move to trash**. An analysis that dashboards still
show cannot go to the trash; the dialog lists those dashboards. The **Trash** link under the
folders lists trashed analyses to restore or delete for good (deleting for good needs the admin
level on the analysis).

## In a dashboard panel

A new panel in the panel editor asks how it begins: **New query**, **From saved analysis** or
**From another panel** (a copy of a panel of the same dashboard).

**From saved analysis** lists the analyses (**All**, **Team of this dashboard**, **Mine**) with a
live preview over the dashboard's time range. Analyses visible to one team only cannot be used in
a dashboard, and analyses whose data source you may not query are listed but cannot be picked.
Choose how it is used:

- **Linked** (default): the panel runs the analysis's current queries and steps, so a saved change
  of the analysis shows in every dashboard that links it. The panel keeps its own title and
  visualization. Its queries are read-only in the panel: **Edit in Explore** opens the analysis,
  **Unlink** turns the panel's queries into a copy of its own, **Remove** clears them.
- **As a copy**: the queries and steps are copied into the panel and edited there from then on.

Viewers of the dashboard see the result only; they need no access to the analysis itself.

## Conflicts

Explore checks the open analysis for newer versions every 30 seconds. When someone else saved
one, a notice names who and when, the version you work on and the current one, with **View
differences** and **Load the new version**. Saving over a newer version is never silent: the
dialog **A newer version exists** shows both sides' changes and offers **Save as a copy**,
**Load version N** (after asking, when you have unsaved changes) and **Overwrite anyway**, which
needs only the right to save; the overwritten version stays in the history.
