## Improved

- Verwaltung > Plugins: the installed plugins can be searched by name, id or publisher and
  filtered by kind (data sources, panels) and status, each with its count. The strip says how many
  data sources run out of how many and what the problems are ("1 crashed, 1 not loaded"), and the
  trust tab shows how many keys are trusted.
- "Plugin log" next to "Install from file" opens the server audit log filtered to plugin events.
- A plugin's page has a "Permissions" tab with its network targets, secrets, files, the limits of
  its process (memory, processes, connections) and its sandbox.
- A data source plugin's page shows its last health check and how its data sources answered in
  the last 24 hours: queries, errors and the 95th percentile response time.
- The question before removing a plugin says that its log and temporary folder are deleted too.

## Fixed

- Long plugin ids wrap after a dot instead of in the middle of a word, check boxes on the plugin
  pages look like everywhere else, and "Take back" in the trusted keys stays on one line.

## Checklist for Windows (manual)

- On a Windows server with a running data source plugin, open its page: "Last check" shows a time
  of at most 30 seconds ago, and the "Permissions" tab shows the memory and process limits of the
  job object.
