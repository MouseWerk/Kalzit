## Fixed

- A shared Explore link no longer runs its query on opening: the query goes into the editor with
  a note to check it, and runs when you choose Run.
- The data source list names who last changed a source only for people who may change it or read
  the audit log; everyone else sees when it changed.

## Checklist for Windows (manual)

- With Kalzit running as a service, stop a data source's database and open a dashboard on it:
  the entry from source "Kalzit" in Event Viewer (Windows Logs, Application) reads like
  "Error in kalzit::... See kalzit.log in C:\ProgramData\Kalzit\data\logs for the details." and
  contains no host name, path or query; kalzit.log has the full error.
