## Improved

- Public links: show a dashboard live to people without an account, with a required expiry, a
  window of time visitors may pick from, fixed variable values and a view count. The queries run
  with the creator's current rights; a link pauses while those rights, the creator's membership or
  the switch are missing, and revoking ends it for good. Off until a server admin turns it on; an
  organization can turn it off for itself. Visitors get only what each panel shows: its steps run
  on the server, and hidden queries and unused graph properties stay there. See
  [Sharing](../../guide/sharing.md).
- Snapshots: freeze a dashboard's panel results for one time range, internal for the organization
  or public by link, with a size limit and an expiry.
- New permission `dashboards:public` for public links and snapshots, given to admins and owners
  and available for custom roles. Changing a dashboard with live public links, or a library panel
  or saved analysis it shows, needs it too; only signed-in people publish, never API tokens.
