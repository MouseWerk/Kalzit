## Improved

- `kalzit db copy` moves an installation from SQLite to PostgreSQL: with the server stopped, it
  copies everything into a new, empty PostgreSQL database, decrypts every stored secret with the
  secrets key to make sure the server on PostgreSQL can read them, and compares the rows of every
  table (operator guide "Several Kalzit servers", "Moving from SQLite to PostgreSQL").

## Checklist for Windows (manual)

- Stop the Kalzit service and create an empty PostgreSQL database. In an elevated PowerShell 7,
  type the password at the hidden prompt of `$env:PGPASSWORD = Read-Host -MaskInput 'PostgreSQL
  password'`, set `$env:KALZIT_DB_COPY_TARGET = 'postgres://kalzit@<host>/kalzit'` (no password
  in it) and run `kalzit db copy --config "$env:ProgramData\Kalzit\kalzit.toml"`: it lists every
  table with its rows and shows no password. Point `database.url` at PostgreSQL, start the
  service and sign in: dashboards and data sources are there and a data source with a password
  still connects. Run the copy again: it refuses because the target is not empty.
