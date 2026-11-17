## Improved

- Share dialog on every dashboard, behind the Share button: the address for people in the
  organization (with or without the time range and the variables, or for one panel), public links
  with expiry and time window, and snapshots for the organization or in public. Existing links and
  snapshots of the dashboard are listed there, with their expiry to change and a revoke that asks
  first. Where public sharing is not available, the dialog says why: the server's switch, the
  organization's, or the missing permission `dashboards:public`.
- Pages for visitors without an account: the shared dashboard without navigation, the time range
  to pick inside the link's window, the fixed variable values readable, and no query text, data
  source names or error texts of a source. A public snapshot shows its frozen range. Every address
  that does not work shows the same "This link is not available."
- Snapshots in the organization open inside the app, with who froze them, until when they stay and
  the way back to the live dashboard.
- Administration > Shares lists every public link and snapshot of the organization with its
  status and reason, expiry and views; Settings > My shares lists your own across your
  organizations. The sharing settings have sections of their own: Sharing (server) and Sharing in
  the organization.
- Saving a dashboard that has live public links without `dashboards:public` now names the links
  in the error.
