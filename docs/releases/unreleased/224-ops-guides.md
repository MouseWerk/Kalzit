## Improved

- New guides for running Kalzit: backup and restore (SQLite and PostgreSQL, the secrets key, the
  ACME and plugin folders, a restore drill), upgrading per installation type, Kalzit behind nginx,
  Caddy, Traefik or IIS (with WebSocket), and the plain binary on Linux as a hardened systemd
  service. Help links in the app open the guide of the installed version instead of the newest.

## Fixed

- German texts use one word for one thing: Anmerkungen, Schwellenwerte, Bibliothekspanel,
  Abfrage-Cache, Datenform and "Person" for people; the start page setting no longer reads
  "Startseite: Startseite" but offers "Start".

## Checklist for Windows (manual)

- With Kalzit installed by the MSI, choose Help > Documentation in the top bar and open a page
  from the in-app help before signing in: both open the GitHub pages of the installed version
  (`/tree/v<version>/docs` and `/blob/v<version>/docs/guide/...`), not `main`.
