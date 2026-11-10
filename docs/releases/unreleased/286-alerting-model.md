## Improved

- Alerting groundwork: alert rules, contact points (mail and signed webhooks), silences and
  their history are stored per organization, with three new permissions: `alerts:read` (viewers
  and up), `alerts:write` (editors and up) and `alerts:contacts` (organization admins and up),
  also selectable in custom roles.
- Data sources can be opted in to alerting; only opted-in sources are queried by the
  organization's fixed alerting identity.
- Administration > Settings has an Alerting section: alerting on or off, the shortest interval,
  evaluation limits and how long the alerting history is kept. Organizations can only make them
  stricter.

## Checklist for Windows (manual)

- After the upgrade the server starts, Administration > Settings shows the Alerting section, and
  the role editor lists the three alerting permissions.
