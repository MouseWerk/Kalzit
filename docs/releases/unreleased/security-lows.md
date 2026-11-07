## Fixed

- A shared Explore link no longer runs its query on opening: the query goes into the editor with
  a note to check it, and runs when you choose Run. Opening a link while a saved analysis is open
  leaves that analysis alone; saving the link's query makes a new one.
- The data source list names who last changed a source only for people who may change it or read
  the audit log; everyone else sees when it changed.
- On Windows, a kalzit.toml that does not load is reported in the event log with its line and
  column only, never the line itself, which may hold a password; `kalzit check-config` shows the
  full error.
- Crashes (panics) are now written to the log, and on Windows noted in the event log.

## Checklist for Windows (manual)

- With Kalzit running as a service, stop a data source's database and open a dashboard on it:
  the entry from source "Kalzit" in Event Viewer (Windows Logs, Application) reads like
  "Error in kalzit::... See kalzit.log in C:\ProgramData\Kalzit\data\logs for the details." and
  contains no host name, path or query; kalzit.log has the full error.
- Put `password = "geheim` (without the closing quote) under `[smtp]` in kalzit.toml and restart
  the service: the event log entry names the line and column but not "geheim"; `kalzit
  check-config` in an elevated PowerShell shows the full error. Restore the file afterwards.
