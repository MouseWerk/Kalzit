## Fixed

- `kalzit provision`: a secret file (`fromFile`) is read only from the set's folder, or from folders you name with `--secret-dir` (such as `/run/secrets`; also `KALZIT_PROVISION_SECRET_DIRS`). It must be a regular file with one name, at most 64 KiB. `..`, links that lead out of those folders, devices and system paths such as `/proc` are refused, and a secret that holds the value of one of Kalzit's own `KALZIT_*` variables is never sent.
- Reports: only the person who created a report and organization admins can change, resume, send or delete it, since it runs and mails with its creator's rights. Others who may write reports can still pause it; the list, the editor and the runs page show only what each person may do.
