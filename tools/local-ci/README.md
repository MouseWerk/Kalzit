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
`--no-status` posts nothing to GitHub, `--runner-from-pr` runs the pull request's own copy of
these scripts (see Trust).

`--ref` tests the commit as it is, not merged onto main; its statuses say `passed at <commit>
as it is`, which `merge.sh` never takes for a pull request.

## Status page

`node tools/local-ci/status.mjs` serves the runs as a workflow graph on
http://127.0.0.1:39301/ (GitHub's run view, for the local CI): the merge step, both legs with
every job's status and time, the statuses, and the earlier runs. It reads the logs and reloads
every 3 seconds. In the desktop app it is the `local-ci-status` entry of `.claude/launch.json`.

## Trust

The leg scripts come from `origin/main` (copied to `C:/Users/klein/kz-ci/runner` for each run),
so a pull request cannot change how it is judged. A pull request that changes `tools/local-ci`
runs with main's scripts until it is reviewed; then `--runner-from-pr` runs its own (needed
too while main has no local CI yet). The code under test, its build scripts and tests, still
runs with this machine's rights, and in WSL as the user `ci`, who may use sudo: run the CI only
for pull requests from the
team and Dependabot, never for outside forks.

`merge.sh` merges only the head commit it checked, and only while main is the commit the run
used. A status still pending from a stopped run, or a pass on an older main, makes it run the
CI again first; a failure on the current main stops it.

## What runs

The areas come from `.github/scripts/changes.sh`, as for a pull request on GitHub; a change
under `.github/` or `tools/local-ci/` runs everything.

| Leg | Jobs |
|---|---|
| Linux (`linux.sh`) | changes test, server (fmt, clippy, tests), plugins, ui (with a DST zone), sdk, roadmap, devkit, devgen, audit, update rights, postgres, ldap, datasources, datasources-sql-kv, datasources-more, acme (pebble), e2e, packages (x64), docker, devgen proof |
| Windows (`windows.sh`) | server, plugins, ui, sdk, devkit, devgen, e2e, msi (only with `--msi`) |

Differences from `ci.yml`:

- Not covered: `packages (arm64)` (no arm64 machine; the release workflow still builds and
  checks arm64), the e2e job's TCP watch, the port-range widening (a one-time setup step here, see Setup),
  and the installer screenshots (`msi-screens.ps1`, informational in `ci.yml` too).
- `packages` serves the packaged server on port 39300 instead of 3000: WSL forwards its ports
  to Windows, where 3000 is the owner's demo. The package is purged even when the test fails.
- `devgen proof` runs only in a pull request's run without `--full`, as in `ci.yml` (pull requests only).
- No MongoDB restart loop in `datasources`: that worked around busy GitHub runners.

A job's failure does not stop the others. The services of the postgres, ldap, data source, e2e,
docker, packages and acme jobs listen on fixed localhost ports, and WSL forwards its ports to
Windows, so both legs share a lock around those jobs (`services.lock`).

## Folders

| What | Where |
|---|---|
| Windows checkout (a detached worktree), caches, logs | `C:/Users/klein/kz-ci` (`KALZIT_CI_HOME`) |
| Windows build | `C:/Users/klein/kz-target/ci-win` |
| Linux checkout, caches | `/home/ci/kz-ci` in WSL (the user `ci`) |
| Linux build | `/home/ci/kz-target/ci` in WSL |
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

Once, in an administrator PowerShell, the wider dynamic port range the e2e job on GitHub sets
(without it, a page load fails with `net::ERR_NO_BUFFER_SPACE` in some runs; it starts at
10000, clear of the ports below it, and stays after a restart):

```powershell
netsh int ipv4 set dynamicport tcp start=10000 num=55535
```

## Keeping it in step with ci.yml

A change to a job in `ci.yml` belongs in `linux.sh` or `windows.sh` as well, in the same pull
request.
