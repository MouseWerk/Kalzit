## Improved

- People who sign in through an OpenID Connect provider and set up their first second factor now
  sign in at the provider again first ("Sign in at ..."); the provider asks for the sign-in even if
  the browser is still signed in there.
- Three wrong passwords in a row in one session are recorded in the audit log once ("Password
  entered wrongly several times in a session"), and the person gets a mail about it when the
  server can send mail.
- Settings > Storage and retention: "Data source trash (days)" sets how long deleted data sources
  stay in the trash (default 30). The trash shows the date each source is deleted for good.
- The plugin folder can live outside the data folder (`paths.plugins_dir` in `kalzit.toml` or
  `KALZIT_PATHS_PLUGINS_DIR`); an existing folder moves there at the next start, and Settings >
  Storage and retention shows the folder in use.

## Checklist for Windows (manual)

- Set `plugins_dir` under `[paths]` in `kalzit.toml` to a folder on the same drive, restart the
  service, and check that the installed plugins moved there and still run.
