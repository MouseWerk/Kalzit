# Kalzit devkit

Tools for working on Kalzit: throwaway servers with demo data, screenshots across locales,
themes and widths, visual diffs, UI defect checks, CI log triage and the merge queue. One code
base, two front ends: an MCP server over stdio (registered for Claude Code in the repository's
`.mcp.json`) and a CLI with the same tools as subcommands.

The devkit is for development only. It is not part of the product binary, the packages or the
container image, and it holds no secrets: every password and key it needs is generated per
instance and kept in that instance's run folder.

## Setup

```
cd tools/devkit
npm ci
npm run build                 # dist/server.js (MCP) and dist/cli.js (CLI)
npx playwright install chromium   # once; shared with ui/ when the versions match
node dist/cli.js --help
```

Node 26 or newer. The instance tools need `cargo` and the UI's dependencies (`ui/node_modules`,
installed on first use), the graph option needs Docker, the CI tools need an authenticated `gh`.
Claude Code asks once to approve the `kalzit-devkit` server from `.mcp.json`; run `npm run build`
first.

## Where outputs go

Everything lands below `tools/devkit/.out/` (gitignored), or below `KALZIT_DEVKIT_OUT`:

| Folder                 | Content                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `instances/inst-<id>/` | run folder: copied binary, data directory, fixtures, `server.log`, `instance.json`, `credentials.json` (0600) |
| `build/`               | build logs of the UI and server builds                                                                        |
| `captures/<time>/`     | screenshots and `manifest.json`                                                                               |
| `diffs/<time>/`        | diff images, `report.html`, `report.md`, `report.json`                                                        |
| `checks/<time>/`       | `findings.json`, `findings.md`                                                                                |
| `ci/<time>/`           | fetched job logs and `failures.json`                                                                          |
| `tests/<time>/`        | logs of `affected_tests --run`                                                                                |
| `e2e-runs/`            | `KALZIT_E2E_RUN_DIR` of Playwright runs started by the devkit (one folder per run)                            |

## Tools

In the CLI, tool names take dashes or underscores, options are `--kebab-case`, lists are
comma-separated or repeated, booleans take `--flag` or `--no-flag`. Results are JSON on stdout,
progress goes to stderr.

### instance_start, instance_stop, instance_list

Builds the server once with the `e2e` profile (or reuses `$CARGO_TARGET_DIR/e2e/kalzit`, or the
binary in `--binary` / `KALZIT_DEVKIT_BINARY`), copies it into a fresh run folder, starts it on a
random free port (never 3000) and seeds the README demo organization (Maria Keller and her
colleagues, the sales SQLite source, "Sales by region", the panel gallery and three more
dashboards). The fixture data lies around the README screenshot moment, and the screenshot tools
fix the page clock to it, so captures repeat; `--no-fixed-clock` puts the data around now.
- `--graph` starts a Neo4j container with a unique name and a random port, seeds it with
  `ui/e2e/fixtures/graph-shop.cypher`, and adds it as a source with a "Shop graph" dashboard.
- `--ai` starts the fake OpenAI-compatible provider (the mock of `ui/e2e/ai.spec.ts`), connects
  it as a server provider, turns AI on and opens the sources to AI, for Explore's AI buttons and
  Fragen.

The result names the URL, the owner's email and `credentialsFile`; the passwords are only in
`credentials.json` in the run folder (the Neo4j password reaches Docker through the environment,
never a command line). `--show-credentials` (MCP: `showCredentials`) adds them to the result.
On Linux the run folder and its files are private by mode (0700/0600); on Windows modes mean
nothing, so the run folder gets an ACL without inherited entries and full control for the current
user only. The server's build goes through `CARGO_BUILD_JOBS=2` unless set.

`--binary` and `KALZIT_DEVKIT_BINARY` name a file that is copied into the run folder and
executed: only point them at a Kalzit build you trust.

Stopping ends only the PIDs and containers the instance started (a PID is only ended when its
command line still names the run folder; containers by id), then removes the run folder. An
instance stops when the process that started it ends (the MCP server, or the CLI on Ctrl+C),
unless started `--detached`. Instances whose owner is gone are cleaned up by the next
`instance_start` or `instance_list`.

```
node dist/cli.js instance-start --graph --ai          # runs until Ctrl+C
node dist/cli.js instance-start --detached            # returns; stop it later
node dist/cli.js instance-list
node dist/cli.js instance-stop <id>                   # or: instance-stop all
```

### capture_screens

Screenshots a running instance (the newest, or `--instance <id>`) with Playwright: every main
screen, or `--screens` by name or path, for each locale, theme and width (default en and de,
light and dark, 1440 and 1024 px, 900 px high). Files are named
`<screen>--<locale>-<theme>-<width>.png`; the manifest lists each with its path or error.
Locale and theme are set as preferences of the seeded owner, so run one capture or check per
instance at a time.

Screens: `sign-in`, `home`, `dashboards`, `dashboard`, `dashboard-gallery`, `dashboard-history`,
`dashboard-trash`, `explore`, `saved-analyses`, `data-sources`, `data-source-kinds`,
`data-source`, `members`, `teams`, `roles`, `audit-log`, `usage`, `users`, `organizations`,
`updates`, `organization-settings`, `server-settings`, `ai-settings`, `account`, and with
`--graph` also `graph-dashboard` and `graph-source`.

`--scenes` runs the existing shots scripts through the e2e harness instead (each starts its own
isolated server with the same binary and writes into the capture folder): `readme`, `sign-in`,
`two-factor`, `access` (ui/e2e/screenshots) and `gallery` (ui/e2e/gallery).

```
node dist/cli.js capture-screens --out .out/captures/before
node dist/cli.js capture-screens --screens dashboard,explore,/admin/teams --locales de --themes dark --widths 1440
node dist/cli.js capture-screens --scenes readme
```

### visual_diff

Compares two capture folders file by file: a diff image per changed screen, the share of changed
pixels, and `report.html` / `report.md` listing changed, added and removed screens.
`--threshold` (0 to 1, default 0.1) is the per-pixel color distance that still counts as equal;
anti-aliased pixels never count. `--min-score` (default 0.0005) is the share of changed pixels
below which a screen counts as unchanged.

```
# instance from main: capture-screens --out .out/captures/before
# instance from the branch (instance-start --rebuild): capture-screens --out .out/captures/after
node dist/cli.js visual-diff .out/captures/before .out/captures/after
```

### ui_check

The defect-finding half of the UI fixer. On a running instance, per screen and variant (default
en, light, 1440 and 1024 px): axe violations (the e2e rule sets; serious and critical unless
`--impacts` says otherwise), elements sticking out horizontally (the rule of
`ui/e2e/support/overflow.ts`), text cut off by a box that hides overflow without an ellipsis, and
console errors and uncaught exceptions. Each finding names the screen, variant and a selector.

```
node dist/cli.js ui-check
node dist/cli.js ui-check --screens members,teams --locales en,de --themes light,dark --widths 1024
node dist/cli.js ui-check --checks overflow,clipped --widths 1024,800
```

### ci_status, ci_failures

`ci_status` summarises the checks of a PR (`<pr>`), a run (`--run`) or a commit (`--sha`): counts,
overall pending/green/red, failing and pending checks. `ci_failures` fetches the log of every
failed job through the REST API, falling back to `gh run view --job --log` and the run's
`--log-failed` when the log is "not found", saves it, extracts failing tests (cargo, vitest,
Playwright) and assertion lines, and classifies each job:
- `infra`: a service container could not bind its port or did not start, the runner went away
  or ran out of disk, an action could not be downloaded, a job failed without a failed step, or
  network and download errors without failing tests
- `code`: failing tests, compiler, type or lint errors
- `cancelled`, or `unknown` when nothing in the log is recognised (the failed steps are listed),
  when the job hit its time limit (a hang in the code looks the same as a slow runner), or when a
  reset connection or 5xx shows up in a step that runs the product itself (smoke, health, Docker,
  package and installer steps), where it can be a crash

```
node dist/cli.js ci-status 181
node dist/cli.js ci-failures 181
node dist/cli.js ci-failures --run 18934123456
```

### merge_pr

Merges a PR through the merge queue: stops on conflicts (DIRTY), waits until every check on the
head finished, reruns the failed jobs once when every failure is a runner fault (never cancelled
or timed-out jobs, and never when a failing check is no Actions job),
enqueues the PR (GraphQL `enqueuePullRequest` with the expected head), and waits until it is
merged. When the merge group fails for runner reasons it enqueues once more; real failures stop
it with the classified failures. Deletes the head branch after the merge (`--no-delete-branch`
keeps it). Exits non-zero unless merged. It can take a long time: from an agent, run the CLI in
the background rather than the MCP tool.

```
node dist/cli.js merge-pr 181
node dist/cli.js merge-pr 181 --timeout-minutes 120 --poll-seconds 20
```

### affected_tests

Maps a diff (default: the branch against `origin/main` plus uncommitted and untracked files;
`--base`, or `--paths` to map given paths) to targeted test commands:
- Rust: a changed `server/tests/<name>.rs` runs that file; a changed module runs its unit tests
  (`--lib -- <module::path>`) and the integration tests named after it (`server/src/ai/...` gives
  `--test ai --test ai_calls --test ai_chat`); migrations, test helpers and other crates run their
  whole package, `Cargo.toml`/`Cargo.lock` the workspace.
- UI: the vitest files that are, import or sit next to a changed file; i18n catalogs run the i18n
  tests; styles run the layout and accessibility specs; a feature folder runs the Playwright spec
  named after it; e2e support files run the specs that import them.
- `.github/scripts/changes*` runs `changes.test.sh`, `tools/devkit/` the devkit's tests.

`--run` runs them with the load limits (`CARGO_BUILD_JOBS=2`, `vitest --maxWorkers=2`,
Playwright `--workers=2` on Chromium with its own `KALZIT_E2E_RUN_DIR`) and reports each exit code
with the log's tail. Commands run without a shell (vitest and Playwright as `node <package
script>`), only tracked files with plain names (`[A-Za-z0-9_./-]`) become arguments, other paths
are listed as uncovered, and `--base` has to be a revision git knows.

```
node dist/cli.js affected-tests
node dist/cli.js affected-tests --paths server/src/scim/mod.rs,ui/src/features/admin/TeamsPage.tsx
node dist/cli.js affected-tests --run
```

## Development

```
npm run check        # Biome: format, lint, imports
npm run typecheck
npm test             # unit tests: log classification, diff scoring, test mapping, ports, CLI
npm run test:smoke   # local only: builds or reuses the server, starts and stops an instance
```

The smoke test needs cargo (or `KALZIT_DEVKIT_BINARY`) and is not run in CI: the CI job checks
format, lint, types, unit tests and the build on Linux and Windows.
