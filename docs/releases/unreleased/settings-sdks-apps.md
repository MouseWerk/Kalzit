## Improved

- CORS: administrators can let pages of chosen origins call Kalzit's API from the browser (exact origins, or all subdomains of a domain); off by default, with or without the session cookie, lockable in `kalzit.toml`.
- Self-registration: people with an address of an allowed domain can create an account themselves. The address is confirmed by mail, an admin approves each account by default, new accounts join a chosen organization as viewer or editor, and starts are limited per address, email and day.
- Scheduled backups: Kalzit backs up its database, `acme/`, `plugins/` and `kalzit.toml` on a schedule into an allowed folder or an S3-compatible bucket, encrypted with the secrets key, keeps the newest 14 and lists every run. `kalzit backup restore` puts a backup back.
- App plugins: plugins can bring pages of their own, which read dashboards and saved analyses with your rights and keep their own data. Organization admins can block an app or allow it only from a role up.
- SDKs for TypeScript (Node and browsers) and Go: typed clients for service account tokens, dashboards, data sources, queries in their native shapes and alerts.

## Checklist for Windows (manual)

- Save a local backup target below an allowed folder, run a backup through the API and check that the file appears there.
- Stop the service, run `kalzit.exe backup restore <file> --yes` from an elevated prompt, start the service and sign in.
