English | [Deutsch](de/sharing.md)

# Sharing

Show a dashboard to people without an account: a **public link** shows it live, a **snapshot**
freezes its panels as they are now. API: [sharing](../api/sharing.md). To share a dashboard with
people of your organization, grant them access or copy its address; they sign in and need read
rights as usual (see [Dashboards](dashboards.md)).

The screens for this follow in a later release; until then the functions are available through
the API.

## Turning it on

Public sharing is off until a server admin turns it on: **Settings > Sharing**, *Public links and
snapshots* (`sharing.public_enabled`). An organization can turn it off for itself again
(`sharing.org_public_enabled` under **Settings > Sharing in the organization**). The server's
section also sets the longest expiry (default 365 days) and the largest snapshot (default 10 MB).
Changes apply at once: with sharing off, every public link and public snapshot stops answering and
starts again when it is turned back on.

Sharing starts at a dashboard's **Share** button. [**Administration > Shares**](app:/admin/shares) lists every public
link and snapshot of the organization for its admins, with the status and the reason when one is
suspended; **Settings > My shares** lists your own.

Creating public links and public snapshots needs the permission `dashboards:public`. Admins and
owners have it; it can be added to custom roles.

## Public links

A public link shows the dashboard with its current data. Whoever has the link sees the dashboard
and may pick a time range within the window you set (by default the last 7 days); the variables
stay at the values you chose. Visitors cannot run their own queries, see query texts, data source
names, annotations or links to other dashboards and pages.

- A link always expires (by default after 30 days, at most after the longest expiry the server
  allows). You can change the expiry later.
- The panels' queries run with **your** rights at the moment someone opens the link. If you lose
  the permission, the right to read the dashboard or to query one of its data sources, or leave
  the organization, the link is **suspended**; it works again when that changes back, until it
  expires. It is also suspended while the dashboard is in the trash or public sharing is off.
- Visitors of a link that does not work see only "not available", never why.
- **Revoke** ends a link for good. Revoked and expired links stay in the list for 30 days.
- Each link counts its page loads. Nothing else about visitors is kept: no address, no browser.

## Snapshots

A snapshot stores the results of every panel for one time range and the chosen variable values
in Kalzit's database, in their own shape (table, documents or graph). Opening it never asks a
data source again.

- An **internal** snapshot is seen by members of your organization who may read the dashboard.
  Making one needs the right to share the dashboard (`dashboards:share`).
- A **public** snapshot has a link like a public link, needs `dashboards:public` and stops in the
  same cases.
- A snapshot may be at most as large as the server allows (default 10 MB) and always expires.
- An organization keeps at most 500 snapshots taking 1 GB together (both set by the server
  administrators), and one person makes at most 10 snapshots a minute (per server, when Kalzit
  runs on several). Revoked snapshots do not count: revoking deletes what they stored at once.
  Expired ones count until they are deleted 30 days later, so revoke the ones nobody needs to
  make room.
- When many people open public links of your organization at the same time, a panel may wait a
  moment for its turn; the page tries again by itself and says so if the server stays busy.

## Managing

Organization admins see every public link and snapshot of the organization with its status
(active, suspended and why, expired, revoked) and can change its expiry or revoke it. Everyone
else sees and manages their own. Creating, changing the expiry and revoking are recorded in the
[audit log](administration.md#audit-log).
