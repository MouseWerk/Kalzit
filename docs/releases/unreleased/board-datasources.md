## Improved

- The data source list follows its board: each source shows where it connects, its team and who
  else it is shared with, its status from the last connection test with the query latency of the
  last 24 hours, how many dashboards use it and when it was last used, and when and by whom it was
  last changed. Opening the list no longer needs a connection test to show a status.
- Filter the list by team, and sort it by last used or last changed.
- Each row has a menu: open in Explore, test the connection, edit, share, duplicate, move to the
  trash.
- Select several sources to test, share with a team, export (settings without secrets) or move
  them to the trash together; Undo brings them back.
- The side panel has two new tabs: "Usage" lists the dashboards using the source with its queries
  and errors of the last day, "History" what happened to it and who did it. Under "Access" each
  team's level is changed in place and applies at once, with Undo.

## Checklist for Windows (manual)

- Under Datenquellen, select two sources, choose "In den Papierkorb", then "Rückgängig" in the
  message: both are back in the list. Open a source's side panel, change a team's level under
  "Zugriff" and undo it; check "Nutzung" and "Verlauf".
