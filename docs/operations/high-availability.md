# Several Kalzit servers: operator guide

Run two or more Kalzit servers behind a load balancer on one PostgreSQL database, so a server can
stop (a crash, a host update, a new Kalzit version) while the others keep answering. How it works
inside is in docs/ARCHITECTURE.md, "Several servers on one database"; the instance view's API in
docs/api/settings-dashboards.md, "Instances".

Kalzit makes its own servers redundant. PostgreSQL itself stays your job: a primary with a
standby (streaming replication with Patroni, a managed database, or your platform's failover)
behind one address that always points at the primary. Kalzit reconnects after a failover; the
requests that were running answer `503` once and can be sent again.

SQLite serves exactly one server. A second server started on the same SQLite database stops at
once with "another Kalzit server is already running on the SQLite database ..." (the first one
holds `kalzit.db.lock` next to the database file; the lock goes with its process, also after a
crash). To go from SQLite to several servers, move to PostgreSQL first; Kalzit has no copy tool
between the two yet.

## What every server needs

- **The same database URL** (`database.url` or `KALZIT_DATABASE_URL`), pointing at the primary.
  The database user needs `LISTEN`/`NOTIFY`, which every PostgreSQL user has.
- **The same secrets key** (`KALZIT_SECRETS_KEY`, or the same systemd credential). Data source
  passwords, AI provider keys, the ACME account and certificate and the known-device cookies are
  encrypted or signed with it. A server with another key cannot read them; it logs which stored
  secrets it cannot use. A key file in each data directory is per machine and does not work here.
- **Its own data directory.** Nothing in it is shared: logs, plugin packages as unpacked, update
  downloads and backups stay per server. Do not put the data directory on shared storage.
- **The same version**, apart from the minutes of a rolling update (below).
- Clocks set by NTP. Kalzit decides who leads and when jobs are due by the database's clock, so a
  wrong host clock does not break that; it does shift the times in logs and sign-in limits.

## Load balancer

- **Sticky sessions are not required.** Sessions, settings, rights and everything the UI changes
  live in the database; any server answers any request. Live updates (WebSocket) and AI answers
  (streamed) stay on the server they started on, as one connection does anyway.
  A few administration pages show the server that answered, not all of them: Updates (downloads,
  backups and history are per server), a plugin's process status and log, and the query cache's
  counters. Verwaltung, Instanzen (Administration, Instances) shows which server answered ("This
  server"). If you want these pages to stay on one server while you look, turn on cookie
  stickiness for the administration; nothing depends on it.
- **Health checks:** `GET /readyz` answers `200` while the server can reach the database and `503`
  when it cannot; use it for the load balancer's checks (every 5 s, out after 2 failures).
  `GET /healthz` only says that the process answers (liveness for container platforms).
- **Forwarded addresses:** list the load balancer in `security.trusted_proxies`, so sign-in limits
  and the audit log see the client's address, not the balancer's.
- **Timeouts:** allow long-lived connections for `/api/orgs/*/live` (WebSocket) and streamed AI
  answers, at least 10 minutes idle.
- **Stopping a server:** Kalzit stops accepting new connections at once and gives open requests 10
  s. Drain it at the balancer first (or let the failed `/readyz` take it out) for a stop nobody
  notices.

## The leader

One server leads. It runs what must run once for all servers: deleting audit events, Explore
history and AI chats past their retention, removing ended sessions, purging the data source trash,
refreshing the plugin catalog, the daily update check, and ordering and renewing the HTTPS
certificate. Every other job (session touches, live updates, queries, exports) runs on the server
that has the request.

The leader holds a lease in the database and renews it every 5 seconds; it lasts 15 seconds. A
server that stops cleanly hands the lease over at once, and the next one leads within 5 seconds.
After a crash or a network split another server takes over once 15 seconds have passed. Each
run-once job also claims its run in the database, so a change of leader never runs a job twice
within its interval. Verwaltung, Instanzen (Administration, Instances) shows the leader and since
when it leads.

## How changes reach the other servers

Settings, rights (and with them the query cache), data sources, plugins and
certificates changed on one server are announced through the database: a row in
`cluster_events` and a PostgreSQL `NOTIFY`. The other servers apply them within a second. When the
notification connection is down (a reconnect, a pooler that does not pass `LISTEN`), every server
reads the rows every second instead (every 5 seconds while notifications work, as a backstop).
What this guarantees:

- A change is in effect on the server that made it as soon as it answered.
- Another server applies it at the latest after its next read of the events: usually under a
  second, at most about 5 seconds, or a second without notifications.
- Settings are read again from the database every 30 seconds in any case; sessions, permissions,
  data sources, AI providers and grants are read from the database with every request, so a
  revoked session or permission is refused on every server at once.
- A server that could not read the events for close to an hour (they are kept for one) drops
  everything it keeps in memory and reads it again.
- The query cache keeps answers per server. A change of rights or of a data source ends the kept
  answers on every server; permissions are checked on every request before the cache, so an
  answer is never served to someone who may no longer see it.

Connection poolers: PgBouncer in transaction mode does not pass `LISTEN`; Kalzit then polls every
second, which works but adds a small query per second per server. Session mode, or a direct
connection for Kalzit, keeps notifications.

## What stays per server

- **Sign-in and request limits** are counted per server. With N servers behind a round-robin
  balancer, someone guessing passwords gets up to N times the failures per window before an
  account is held. Lower `security.login_max_failures` accordingly (for example 5 instead of 10
  with two servers), or keep stickiness by client address. The limits on AI calls and parallel
  queries are per server too.
- **Plugins** run as processes on every server. A package installed through one server is kept in
  the database; every other server unpacks it, with the same checks, and starts the plugin when
  the change reaches it. A plugin's log and status show the server that answered.
- **TLS certificate files** (`tls.cert_file`, `tls.key_file`) are read from each server's disk:
  deploy the same files to every server, or terminate TLS at the load balancer. Certificates
  Kalzit orders over ACME are shared through the database (encrypted with the secrets key): the
  leader orders and renews, every server serves the same certificate. HTTP-01 validations are
  answered by whichever server the certificate authority reaches. For TLS-ALPN-01 the load balancer
  must pass port 443 through as TCP (no TLS termination there); prefer HTTP-01 behind a balancer.
- **The binary** is not replaced by Kalzit itself while other servers use the database: "Install
  now" and planned updates are refused (Updates shows why), see below.

## Rolling updates

Update one server after the other with its package (deb, rpm, MSI or the container image):

1. Read the release notes. A release whose notes say "stop every server" changes the database in
   a way older versions cannot use; for those, stop all servers, update one, start it, then the
   others.
2. Back up the database (`pg_dump`). Kalzit cannot back up PostgreSQL itself.
3. Take the first server out of the balancer, update it (`apt install ./kalzit-<version>-linux-x64.deb`,
   `dnf install ...`, the MSI, or a new container), and wait until `/readyz` answers `200`. Its
   start runs the database migrations.
4. Put it back, then do the same with the next server.

While both versions run, the older servers keep working on the migrated database, but cannot be
started again: a server refuses a database a newer version migrated. Finish the update of all
servers promptly. Verwaltung, Instanzen lists each server's version and warns while they differ.

`kalzit update apply` (the command line, with that server stopped) works per server as well.

## Adding and removing servers

Start Kalzit with the same database URL and secrets key on another machine and add it to the
balancer; it registers itself. A server that stopped is listed as stopped for a day, then
removed. Nothing needs to be done to take a server away for good.

## Troubleshooting

| What you see | What to check |
|---|---|
| "another Kalzit server is already running on the SQLite database" | A second server on one SQLite file: stop it, or move to PostgreSQL |
| Instances shows "No heartbeat" for a server | The process hangs or cannot reach the database; its lease passes after 15 s and another server leads |
| "Changes arrive: By polling" | The notification connection is down or a pooler blocks `LISTEN`; changes still arrive within a second |
| A plugin runs on one server only | The log line "the plugin's package is not on this server" names why; install the plugin again |
| Data sources fail on one server with "not loaded" keys | That server has another secrets key |
