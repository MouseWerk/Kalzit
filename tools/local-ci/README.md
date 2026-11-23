# Local CI

Kalzit's CI runs on the owner's Windows machine, not on GitHub's runners: the Windows leg in Git
Bash, the Linux leg in WSL (Ubuntu), both at the same time. Each run posts two commit statuses,
`local/windows` and `local/linux`, and `main` requires both. `.github/workflows/ci.yml` stays as
the reference these scripts mirror and runs only by hand.

## Use

```sh
tools/local-ci/run.sh 391            # PR 391 merged onto the current main, changed areas only
tools/local-ci/run.sh 391 --full     # every job
tools/local-ci/merge.sh 391          # squash-merge once both statuses passed on the current main
tools/local-ci/run.sh --ref origin/main --full   # release gate on the release commit
```

`run.sh PR` tests the pull request merged onto `origin/main`, as the merge queue did, and posts
the statuses to the PR's head commit. Their description names the main commit the run used
(`passed on main 1a2b3c4d5 in 23 min`). `merge.sh` merges only when both statuses passed on the
main that is current now; if main has moved, it runs `run.sh` again first. A PR that does not
merge cleanly onto main fails at once with `conflicts with main`.

Options: `--full` runs every job regardless of the change, `--msi` adds the Windows installer
test (it installs and removes Kalzit as a service on this machine, so it is off by default),
`--no-status` posts nothing to GitHub.

## What runs

The areas come from `.github/scripts/changes.sh`, as for a pull request on GitHub; a change
under `.github/` or `tools/local-ci/` runs everything.

| Leg | Jobs |
|---|---|
| Linux (`linux.sh`) | changes test, server (fmt, clippy, tests), plugins, ui (with a DST zone), sdk, roadmap, devkit, devgen, audit, update rights, postgres, ldap, datasources, datasources-sql-kv, datasources-more, acme (pebble), e2e, packages (x64), docker, devgen proof |
| Windows (`windows.sh`) | server, plugins, ui, sdk, devkit, devgen, e2e, msi (only with `--msi`) |

Not covered locally: `packages (arm64)` (no arm64 machine; the release workflow still builds and
checks arm64), and the e2e job's Windows port-range widening and TCP watch (system settings).

A job's failure does not stop the others. The services of the postgres, ldap, data source, e2e,
docker, packages and acme jobs listen on fixed localhost ports, and WSL forwards its ports to
Windows, so both legs share a lock around those jobs (`services.lock`).

## Folders

| What | Where |
|---|---|
| Windows checkout (a detached worktree), caches, logs | `C:/Users/klein/kz-ci` (`KALZIT_CI_HOME`) |
| Windows build | `C:/Users/klein/kz-target/ci-win` |
| Linux checkout, caches | `/root/kz-ci` in WSL |
| Linux build | `/root/kz-target/ci` in WSL |
| Logs of a run | `C:/Users/klein/kz-ci/logs/<time>-<pr>-<commit>/`: `<leg>.out`, `<leg>-<job>.log`, `<leg>.result`, `areas.txt` |

The build folders stay between runs, so a run builds only what changed. One run at a time; a
second waits for the first (`run.lock`).

## Setup

Once, and again after a toolchain change:

```sh
wsl.exe -d Ubuntu -u root -- bash tools/local-ci/setup-wsl.sh   # from Git Bash: prefix MSYS_NO_PATHCONV=1
wsl.exe --terminate Ubuntu
```

On Windows: Git for Windows, Rust stable, Node 26, Go, PowerShell 7 and the GitHub CLI (signed
in, with the right to post commit statuses).

## Keeping it in step with ci.yml

A change to a job in `ci.yml` belongs in `linux.sh` or `windows.sh` as well, in the same pull
request.
