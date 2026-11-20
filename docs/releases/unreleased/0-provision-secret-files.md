## Fixed

- `kalzit provision`: a secret file (`fromFile`) must now be a regular file inside the set's folder, at most 64 KiB. Absolute paths, `..`, links that lead out of the folder, devices and system paths such as `/proc` are refused, and a secret that holds the value of one of Kalzit's own `KALZIT_*` variables is never sent. For a secret mounted elsewhere, name an environment variable instead.
- Reports: only the person who created a report and organization admins can change, resume, send or delete it, since it runs and mails with its creator's rights. Others who may write reports can still pause it; the list and the editor show only what each person may do.
