## Improved

- `kalzit db copy` moves an installation from SQLite to PostgreSQL: with the server stopped, it
  copies everything into a new, empty PostgreSQL database, checks that the secrets key reads the
  stored secrets and compares the rows of every table (operator guide "Several Kalzit servers",
  "Moving from SQLite to PostgreSQL").

## Checklist for Windows (manual)

- Stop the Kalzit service, create an empty PostgreSQL database, set
  `$env:KALZIT_DB_COPY_TARGET` in an elevated PowerShell and run
  `kalzit db copy --config "$env:ProgramData\Kalzit\kalzit.toml"`: it lists every table with its
  rows and does not show the password. Point `database.url` at PostgreSQL, start the service and
  sign in: dashboards and data sources are there and a data source with a password still connects.
  Run the copy again: it refuses because the target is not empty.
