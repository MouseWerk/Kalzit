## Fixed

- Snapshots can no longer fill the server's disk: an organization keeps at most 500 snapshots
  taking 1 GB together (both adjustable under Verwaltung > Teilen), one person makes at most
  10 snapshots a minute, and an internal snapshot made without an expiry now stays 7 days instead
  of 30. A refusal says what to do: revoke snapshots nobody needs, or wait a moment.
- Visitors of public links no longer use up the query slots of the person who made the link:
  their panels run in slots of their own per organization, and a visitor gets "busy, try again
  in a moment" at once instead of waiting when those are full. One link's visitors can run only
  so many different time ranges a minute.
- Opening a public link or snapshot no longer writes to the database on every page load: views
  are counted in memory and written every few seconds.
- The snapshot list no longer shows a snapshot's title to someone who may not read its dashboard,
  since the title is the dashboard's by default.
