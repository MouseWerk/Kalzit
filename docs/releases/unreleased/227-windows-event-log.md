## Improved

- On Windows, the service's errors are also noted in the Windows event log (Application, source
  "Kalzit"), where monitoring tools can pick them up, as a short note that points to kalzit.log
  for the details; `log.event_log` adds warnings or turns it off. `kalzit service install`
  registers the source and `uninstall` removes it. Stable releases can be installed and
  upgraded with `winget install MouseWerk.Kalzit`.

## Checklist for Windows (manual)

- Install Kalzit with `kalzit service install`, set `log.event_log = "warnings"` in kalzit.toml,
  restart the service, stop a data source's database and open a dashboard on it: Event Viewer,
  Windows Logs, Application shows entries from source "Kalzit" that name the level, the place
  in Kalzit and the folder of kalzit.log, without the error text, and no "description cannot be
  found" note; reloading the dashboard many times adds at most 10 entries per minute. After
  `kalzit service uninstall`, the source "Kalzit" is gone from
  `HKLM\SYSTEM\CurrentControlSet\Services\EventLog\Application`.
