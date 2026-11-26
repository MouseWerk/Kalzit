# Local CI

Kalzit's CI runs on the owner's Windows machine, not on GitHub's runners: the Windows leg in Git
Bash, the Linux leg in WSL (Ubuntu), both at the same time. Each run posts two commit statuses,
`local/windows` and `local/linux`, and `main` requires both. `.github/workflows/ci.yml` stays as
the reference these scripts mirror and runs only by hand.

## Two stages

| Stage | When | What | Time |
|---|---|---|---|
| Fast gate | Before every merge: `run.sh <pr>`, and `merge.sh` when no pass exists | fmt, clippy, the unit tests and the integration tests of the core flows, the UI checks (Biome, lint, types, i18n, Vitest), the production UI build with the bundle budget, sdk/devkit/devgen/roadmap when touched, the security audit (cargo audit, npm audit) when `Cargo.lock` or a `package-lock.json` changed, and the smoke e2e set (30 tests tagged `@smoke`) in Chromium, on Linux and Windows | 30 to 35 minutes when the server crate changed (measured 2026-11-24: 32 minutes; the test build of the server crate takes most of it), less for UI-only changes (no server job) |
| Full suite | On `main` after the merges (`main-watch.sh`), and as the release gate (`run.sh --ref origin/main --full`) | Everything: all Rust tests, every e2e test in Chromium plus the engine checks (the query editor under the CSP) in Firefox and WebKit, as `playwright.config.ts` assigns them (in parallel shards, with one merged report), PostgreSQL, LDAP, ACME, the data source containers, plugins, audit, packages, docker and the generators' proof; the MSI only with `--msi` | 70 to 160 minutes |

**Merge policy** (owner decision 2026-11-24): a pass of the fast gate is enough to merge. The
full suite runs on `main` after each merge batch, or within the hour when `main` changed. When it
fails, it posts the failure to that `main` commit and runs the failed jobs on the last main commit
whose full suite passed: if they fail there too, the merges are not the cause and nothing is
reverted. Otherwise it bisects the merges since then with only the failed jobs (narrowed to the
failed tests where the logs name them) and opens a pull request that reverts the first failing
merge: one per merge, never one that changes nothing, none while an open revert covers the same
jobs. That revert goes through review and the fast gate like any other pull request; `main` takes
no direct or force push. A failing test is a bug: the revert takes the merge back, never a test,
and the change returns in a new pull request with the fix. The release gate stays one full local
run on the release commit (`run.sh --ref origin/main --full`).

## Use

```sh
tools/local-ci/run.sh 391            # fast gate: PR 391 merged onto the current main, changed areas
tools/local-ci/run.sh 391 --full     # full suite on the same content
tools/local-ci/merge.sh 391          # squash-merge once that content passed the gate (or the full suite)
tools/local-ci/run.sh 391 388 386    # a batch: merged onto main in this order, one run
tools/local-ci/merge.sh 391 388 386  # merges the batch in the same order
tools/local-ci/main-watch.sh         # the full suite on main after merges (keeps watching)
tools/local-ci/main-watch.sh --once  # one full run on main now, if main changed since the last one
tools/local-ci/run.sh --ref origin/main --full   # release gate on the release commit (--msi adds the installer)
tools/local-ci/gh-run.sh 391 388     # the full suite on GitHub's runners (ci.yml by hand)
tools/local-ci/gh-run.sh --gate 391  # the fast gate on GitHub's runners
tools/local-ci/gh-run.sh --on 388 386 -- 391 390   # on GitHub, 391 and 390 on top of main + 388 + 386
```

**What a pass covers.** `run.sh` tests the pull requests merged onto `origin/main`, as the merge
queue did, and posts `local/windows` and `local/linux` to every head, naming the tested content
first: the tree of the merged result (`passed gate tree 6dedf534832d on main cae59d2e4 batch
391,388 in 30 min` for the gate, `passed tree ...` for the full suite). `merge.sh` computes the
tree that merging the heads onto the current main would make (git merge-tree, one after another)
and merges only with a pass of exactly that tree on every head, from the gate or the full suite;
otherwise it runs the gate first, and a failure of that tree stops it. So a result stays good
while main moves in ways that leave the merged content the same, and never covers anything else:
a later push to a pull request, another main or another order make a new tree. After each squash
merge, `merge.sh` checks that the commit sits on the main it was checked against and holds the
predicted tree; before each merge after the first, main must be exactly the commit the one before
made. If GitHub refuses a merge partway, it says which pull requests are merged and which are
left. A failure of exactly that tree, in either stage and on either leg, stops it even under a
later pass: a second run does not turn a failure into a pass. The one exception is a leg that
died without a failed job (`failed ... : the leg itself`, for example WSL gone or a full disk):
that gets one rerun, whose statuses say `rerun after a failed leg`; a second such failure, or any
failed job, stops it. After a merged batch (also one that
stopped partway) it leaves `main-watch.trigger` for `main-watch.sh`.

**Batches.** As the merge queue built up to four pull requests at once, `run.sh PR PR...`
merges them onto main one after another and tests the result once: the build, databases, e2e
and image run once for all of them (at most 8). If a batch fails: for a conflict the status
names the pull request; for a failing test, which runs on the combined tree, run smaller
batches to find it.

**On GitHub's runners.** `gh-run.sh` makes the same merged commit without a checkout, pushes it
to a branch of its own (`local-ci/gh-...`, deleted afterwards), starts `ci.yml` there by hand
(the full suite, including arm64 packages and the MSI; with `--gate` the fast gate, input
`suite=gate`) and posts its result as the same statuses with the same tree, plus the run's link.
`merge.sh` takes it like a local pass. With `--on A... --`, it tests ahead: the second list on top
of main with the first list merged first, posting to the second list only. Once the first list
has merged, main plus the second list is exactly that tree, so the second list merges without
another run.

Options of `run.sh`: `--full` runs the full suite (every job regardless of the change), `--msi`
adds the Windows installer test (it installs and removes Kalzit as a service, with a firewall rule
and `%ProgramData%\Kalzit`, on this machine, which also hosts the demo, so it is off unless asked
for, also in `main-watch.sh`), `--no-status` posts nothing to GitHub, `--only JOBS` runs only
these jobs and posts nothing (for bisecting), `--tests FILE` narrows them to the named tests,
`--no-rerun` leaves out the
diagnostic rerun, `--runner-from-pr` runs the pull request's own copy of these scripts (see
Trust).

`--ref` tests the commit as it is, not merged onto main; its statuses name its tree too
(`passed tree ... at <commit> as it is`).

## Failures and reruns

"Flake" is not a root cause. A failed job runs once more, only to diagnose; the job and the
status stay failed whatever the second run says, and nothing is retried into a pass. Playwright
keeps `retries: 0`. A rerun repeats only the failed tests where it can (Playwright
`--last-failed`; the whole job otherwise). The run's `summary.txt` and
`C:/Users/klein/kz-ci/flaky.log` (one line per test) record the outcome:

```
2026-11-24T21:03:11Z run 20261124-210002-pr412-1a2b3c4d5 linux/e2e (6dedf534832d): failed, then passed on rerun: [chromium] › flows.spec.ts:8:1 › a time range ...
```

The summary lists every test that failed, then passed on rerun more than twice in 7 days: it
needs a root-cause fix. No test is ever skipped, quarantined, loosened or deleted to get green.
`main-watch.sh` does not bisect or revert for an intermittent failure (every failed job passed on
its rerun), since a bisect cannot follow it; that failure is reported for a fix instead.

## Build once, test many

- **One build per leg and kind.** The UI job makes the production build (with the strict license
  lists) once per leg run, and every later build embeds it. The e2e binaries (`cargo build
  --profile e2e -p kalzit -p kalzit-test-plugin`) are built once per leg run (markers per leg run,
  not per job; the old variable lived in each job's subshell, so `packages` built again). The
  packages and the MSI build `-p kalzit --bin kalzit`, and `update rights` and `acme` their test
  with `-p kalzit`, as `ci.yml` and `release.yml` do, so they test the package's own features.
- **Line tables only** in the debug and test builds (`CARGO_PROFILE_DEV_DEBUG`); backtraces keep
  files and lines, and `KALZIT_CI_DEBUGINFO=2` brings the full debug info back.
- **One job at a time within a leg.** Vitest next to the leg's own cargo build missed its timing
  budgets (five UI tests failed in the first measurement), so the jobs stay sequential; the two
  legs run at the same time, as before.
- **sccache** caches the compiler output when it is installed: `KALZIT_CI_CACHE/sccache`
  (`C:/Users/klein/kz-ci/cache/sccache` on Windows, `/home/ci/kz-ci/cache/sccache` in WSL),
  40 GB by default (`KALZIT_CI_SCCACHE_SIZE`). Without it the builds run as before;
  `KALZIT_CI_SCCACHE=0` turns it off. Each leg uses a server of its own, on port 4227 (Windows)
  and 4228 (WSL, which forwards localhost to Windows; `KALZIT_CI_SCCACHE_PORT`), so a server of
  other builds is never stopped or redirected; it
  stays up between runs and ends when idle. Its statistics per run: `<leg>-sccache.txt` in the
  run's logs.
- **cargo nextest** runs the Rust test binaries at once (cargo test runs them one after another),
  8 threads (`KALZIT_CI_TEST_THREADS`), and doc tests with `cargo test --doc` in the full suite.
  Without nextest, or with `KALZIT_CI_NEXTEST=0`, cargo test runs. Both go on after a failure, so
  the log names every failed test. The jobs with services (postgres, ldap, data sources) keep
  cargo test with their filters.
- **Playwright shards.** The full suite runs the e2e tests in `KALZIT_CI_E2E_SHARDS` parallel
  shards (default 2), each with a server and run folder of its own and
  `KALZIT_CI_E2E_WORKERS` workers (default 2), then the timing budgets alone, then merges the
  shards' blob reports into one HTML report (`ui/e2e/.output/report`, copied to the logs on a
  failure). The smoke set runs as one run with `KALZIT_CI_E2E_SMOKE_WORKERS` workers (default 4).
- The memory limits stay: `CARGO_BUILD_JOBS=5` per leg (`KALZIT_CI_JOBS`), no incremental
  builds, Vitest with 4 workers; more jobs per leg ran Windows out of memory (os error 1455).

## Status page

`node tools/local-ci/status.mjs` serves the runs as a workflow graph on
http://127.0.0.1:39301/ (GitHub's run view, for the local CI): the merge step, both legs with
every job's status and time, the stage (fast gate or full suite), the statuses, and the earlier
runs. It reads the logs and reloads every 3 seconds. In the desktop app it is the
`local-ci-status` entry of `.claude/launch.json`.

## Trust

The leg scripts come from `origin/main` (copied to `C:/Users/klein/kz-ci/runner` for each run),
so a pull request cannot change how it is judged. A pull request that changes `tools/local-ci`
runs with main's scripts until it is reviewed; then `--runner-from-pr` runs its own (needed
too while main has no local CI yet). The code under test, its build scripts and tests, still
runs with this machine's rights, and in WSL as the user `ci`, who may use sudo: run the CI only
for pull requests from the team and Dependabot, never for outside forks.

`merge.sh` merges only the head commits it checked, and only for content that passed. A status
still pending from a stopped run, or a pass of another tree, makes it run the gate first.
`main-watch.sh` pushes only `fix/revert-<pr>` branches, authored as the owner, and opens their
pull requests (whose text names no local paths); it never merges them. Its full runs hold
`run.lock` like every local run, so no other build or test runs on this machine meanwhile.

## What runs

The areas come from `.github/scripts/changes.sh`, as for a pull request on GitHub; a change
under `.github/` or `tools/local-ci/` runs everything (of the stage).

| Leg | Fast gate | Full suite adds |
|---|---|---|
| Linux (`linux.sh`) | changes test, server (fmt, clippy, unit and core integration tests), ui (with a DST zone), sdk, roadmap, devkit, devgen, audit (when a lock file changed), e2e (smoke, Chromium), visual (the visual comparison, when the UI changed; the pictures of a failed run in `linux-visual-diffs/`) | all Rust tests, plugins, audit, update rights, postgres, ldap, datasources, datasources-sql-kv, datasources-more, acme (pebble), e2e (all in Chromium, the engine checks in Firefox and WebKit, sharded), visual, packages (x64), docker, devgen proof |
| Windows (`windows.sh`) | server, ui, sdk, devkit, devgen, e2e (smoke, Chromium) | all Rust tests, plugins, e2e (as on Linux), msi (with `--msi`) |

The gate's integration tests are `GATE_RUST_TESTS` in `common.sh` (and the same list in
`ci.yml`): access, alerting (rules, delivery, routing), analyses, api, dashboard features,
Explore history, provisioning, reports, service accounts, settings and dashboards, sharing,
shell, team spaces, two-factor sign-in. The smoke e2e set is every test tagged `@smoke`
(`npx playwright test -c e2e/playwright.config.ts --list --grep @smoke`): setup, sign-in (also
with two factors) and sign-out, dashboards (view, time range, create, edit, save, conflict),
the panel editor, Explore (SQL, a CSV file, MongoDB, Neo4j, saved analyses), data sources,
alerting (rules, viewer, policies), sharing (public link, snapshot), reports, provisioning,
members and teams, the Verwaltung pages and CORS, and the viewer's limits.

Differences from `ci.yml`:

- Not covered: `packages (arm64)` (no arm64 machine; the release workflow still builds and
  checks arm64), the e2e job's TCP watch, the port-range widening (a one-time setup step here, see Setup),
  and the installer screenshots (`msi-screens.ps1`, informational in `ci.yml` too).
- `packages` serves the packaged server on port 39300 instead of 3000: WSL forwards its ports
  to Windows, where 3000 is the owner's demo. The package is purged even when the test fails.
- `devgen proof` runs in the local full suite; in `ci.yml` only for pull requests.
- The UI job builds with the strict license lists (cargo is there), so e2e reuses that build.
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
| Compiler cache | `C:/Users/klein/kz-ci/cache/sccache`, `/home/ci/kz-ci/cache/sccache` |
| Logs of a run | `C:/Users/klein/kz-ci/logs/<time>-<pr>-<commit>/`: `<leg>.out`, `<leg>-<job>.log`, `<leg>-<job>-rerun.log`, `<leg>.result`, `<leg>.reruns`, `summary.txt`, `areas.txt`, `stage.txt` |
| Flaky log | `C:/Users/klein/kz-ci/flaky.log` |
| main-watch state and log | `C:/Users/klein/kz-ci/main-watch/` (`last-good`, `last-tested`, `main-watch.log`) |

The build folders stay between runs, so a run builds only what changed. One run at a time; a
second waits for the first (`run.lock`), and so does `main-watch.sh`.

## Setup

Once, and again after a toolchain change:

```sh
wsl.exe -d Ubuntu -u root -- bash tools/local-ci/setup-wsl.sh   # from Git Bash: prefix MSYS_NO_PATHCONV=1
wsl.exe --terminate Ubuntu
```

It installs sccache and cargo-nextest for the user `ci` too.

On Windows: Git for Windows, Rust stable, Node 26, Go, PowerShell 7 and the GitHub CLI (signed
in, with the right to post commit statuses and open pull requests). For sccache and
cargo-nextest, in Git Bash:

```sh
cargo install --locked sccache cargo-nextest
mkdir -p C:/Users/klein/kz-ci/cache/sccache
```

(or the prebuilt releases on their GitHub pages, into `%USERPROFILE%\.cargo\bin`). The Windows
leg finds both there; without them it builds and tests as before.

Once, in an administrator PowerShell, the wider dynamic port range the e2e job on GitHub sets
(without it, a page load fails with `net::ERR_NO_BUFFER_SPACE` in some runs; it starts at
10000, clear of the ports below it, and stays after a restart):

```powershell
netsh int ipv4 set dynamicport tcp start=10000 num=55535
```

`main-watch.sh` runs in its own Git Bash window (or as a scheduled task) from the main
checkout. Seed it once with the last full pass on main: `main-watch.sh --good <commit>`.

## Keeping it in step with ci.yml

A change to a job in `ci.yml` belongs in `linux.sh` or `windows.sh` as well, in the same pull
request; a change to the gate's test list in `common.sh` belongs in `ci.yml`'s server job too.
