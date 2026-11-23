# Local CI

Kalzit's CI runs on the owner's Windows machine, not on GitHub's runners: the Windows leg in Git
Bash, the Linux leg in WSL (Ubuntu), both at the same time. Each run posts two commit statuses,
`local/windows` and `local/linux`, and `main` requires both. `.github/workflows/ci.yml` stays as
the reference these scripts mirror and runs only by hand.

## Use

```sh
tools/local-ci/run.sh 391            # PR 391 merged onto the current main, changed areas only
tools/local-ci/run.sh 391 --full     # every job
tools/local-ci/merge.sh 391          # squash-merge once that content passed
tools/local-ci/run.sh --ref origin/main --full   # release gate on the release commit
tools/local-ci/run.sh 391 388 386     # a batch: merged onto main in this order, one run
tools/local-ci/merge.sh 391 388 386   # merges the batch in the same order
tools/local-ci/gh-run.sh 391 388      # the same test on GitHub's runners (ci.yml by hand)
tools/local-ci/gh-run.sh --on 388 386 -- 391 390   # on GitHub, 391 and 390 on top of main + 388 + 386
```

**What a pass covers.** `run.sh` tests the pull requests merged onto `origin/main`, as the merge
queue did, and posts `local/windows` and `local/linux` to every head, naming the tested content
first: the tree of the merged result (`passed tree 6dedf534832d on main cae59d2e4 batch 391,388
in 70 min`). `merge.sh` computes the tree that merging the heads onto the current main would
make (git merge-tree, one after another) and merges only with a pass of exactly that tree on
every head; otherwise it runs the CI first, and a failure of that tree stops it. So a result
stays good while main moves in ways that leave the merged content the same, and never covers
anything else: a later push to a pull request, another main or another order make a new tree.
After each squash merge, `merge.sh` checks that the commit sits on the main it was checked
against and holds the predicted tree; before each merge after the first, main must be exactly
the commit the one before made. If GitHub refuses a merge partway, it says which pull requests
are merged and which are left.

**Batches.** As the merge queue built up to four pull requests at once, `run.sh PR PR...`
merges them onto main one after another and tests the result once: the build, databases, e2e
and image run once for all of them (at most 8). If a batch fails: for a conflict the status
names the pull request; for a failing test, which runs on the combined tree, run smaller
batches to find it.

**On GitHub's runners.** `gh-run.sh` makes the same merged commit without a checkout, pushes it
to a branch of its own (`local-ci/gh-...`, deleted afterwards), starts `ci.yml` there by hand
(every job, including arm64 packages and the MSI) and posts its result as the same statuses with
the same tree, plus the run's link. `merge.sh` takes it like a local pass. With `--on A... --`,
it tests ahead: the second list on top of main with the first list merged first, posting to the
second list only. Once the first list has merged, main plus the second list is exactly that
tree, so the second list merges without another run. Used overnight next to a local run.
On GitHub the pushed commit's own `ci.yml` runs, so `gh-run.sh` refuses a batch that changes
`.github/` or `tools/local-ci` (it would be judged by its own rules) unless
`GH_RUN_ALLOW_CI_CHANGES=1` says those changes were reviewed; run such a batch locally. A GitHub
run that is cancelled, times out (8 hours) or never finishes posts an error, not a failure, so
`merge.sh` runs the CI again instead of stopping. Merges are predicted, tested and checked as
squash merges, one pull request after another, the way GitHub makes them.

Options: `--full` runs every job regardless of the change, `--msi` adds the Windows installer
test (it installs and removes Kalzit as a service on this machine, so it is off by default),
`--no-status` posts nothing to GitHub, `--runner-from-pr` runs the pull request's own copy of
these scripts (see Trust).

`--ref` tests the commit as it is, not merged onto main; its statuses name its tree too
(`passed tree ... at <commit> as it is`).

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
for pull requests from the team and Dependabot, never for outside forks.

`merge.sh` merges only the head commits it checked, and only for content that passed. A status
still pending from a stopped run, or a pass of another tree, makes it run the CI first.

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
