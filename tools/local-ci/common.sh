#!/usr/bin/env bash
# Shared helpers of the local CI legs (linux.sh in WSL, windows.sh in Git Bash). Sourced, not run.
#
# A job is a function; `job NAME AREA... -- FUNCTION` runs it when one of its areas is on (or
# always with the area `always`), logs it to $LOGS/<leg>-NAME.log and records the outcome. Jobs
# run one after another: Vitest's and Playwright's timing checks next to a cargo build of the
# same leg missed their budgets. A failed step ends its job, never the leg: every other job still runs, as with `fail-fast: false` in ci.yml. The leg's
# result goes to $LOGS/<leg>.result: the first line is `success` or `failure`, the lines after it
# one job each with its time.
#
# Stages (KALZIT_CI_STAGE): `gate`, the fast check before a merge, and `full`, everything (after
# the merges on main, and as the release gate). The legs pick their jobs and test sets by it.
#
# A failed job runs once more, only to diagnose (KALZIT_CI_RERUN=0 turns that off): the job stays
# failed whatever the second run says. A pass on the second run is written to $LOGS/<leg>.reruns
# ("failed, then passed on rerun: <test>") for run.sh's summary and the flaky log, so the test
# gets a root-cause fix. Nothing turns a failure into a pass.
#
# Expects: LEG (linux|windows), LOGS (a folder both systems can write), AREAS (the key=value lines
# of .github/scripts/changes.sh), SRC (the checkout under test). Optional: KALZIT_CI_STAGE,
# KALZIT_CI_ONLY (job names separated by spaces or commas: only these run; for bisecting).

set -uo pipefail

: "${LEG:?}" "${LOGS:?}" "${AREAS:?}" "${SRC:?}"
# The debug and test builds with line tables only instead of full debug info (backtraces keep
# their files and lines): the server crate's test build took 16 minutes of a 24-minute gate job,
# much of it debug info and linking. KALZIT_CI_DEBUGINFO=2 brings the full info back.
export CARGO_PROFILE_DEV_DEBUG=${KALZIT_CI_DEBUGINFO:-line-tables-only}
mkdir -p "$LOGS"
RESULT_FILE="$LOGS/$LEG.result"
RERUNS_FILE="$LOGS/$LEG.reruns"
STAGE=${KALZIT_CI_STAGE:-full}
case "$STAGE" in gate | full) ;; *) echo "unknown stage $STAGE" >&2; exit 2 ;; esac
ONLY=" $(printf '%s' "${KALZIT_CI_ONLY:-}" | tr ',' ' ') "
# Outcomes and markers of this leg's run (a job runs in a subshell, so no variables).
STATE_DIR="$(mktemp -d)"
JOB_ORDER=()
: > "$RERUNS_FILE"

area_on() {
  local name=$1
  [ "$name" = always ] && return 0
  printf '%s\n' "$AREAS" | grep -qx "$name=true"
}

# UTC on both legs (they set TZ=UTC for the tests); the CI pane reads it as UTC.
stamp() { date -u +%H:%M:%S; }

# A path the Windows programs (node, the .exe tools) can open; unchanged on Linux.
native() { if command -v cygpath > /dev/null; then cygpath -w "$1"; else printf '%s\n' "$1"; fi; }

# The failed tests named in a job's log: cargo test, cargo nextest, Playwright and Vitest.
failed_tests() {
  [ -f "$1" ] || return 0
  # Without the colour codes Vitest writes even into a file.
  sed 's/\x1b\[[0-9;]*m//g' "$1" | awk '
    /^ *Running (unittests|tests\/|benches\/)/ { bin = ($2 == "unittests") ? $3 : $2; next }
    /^test .* \.\.\. FAILED$/ { t = $0; sub(/^test /, "", t); sub(/ \.\.\. FAILED$/, "", t); print (bin != "" ? bin ": " : "") t; next }
    /^ *(FAIL|TIMEOUT|SIGSEGV|SIGABRT|SIGKILL) +\[/ { t = $0; sub(/^[^]]*\] +/, "", t); print t; next }
    /^ +[0-9]+\) \[[a-z]+\] / { t = $0; sub(/^ +[0-9]+\) /, "", t); sub(/ ─.*$/, "", t); print t; next }
    /^ *FAIL +[^ []/ { t = $0; sub(/^ *FAIL +/, "", t); print t; next }
  ' | awk '!seen[$0]++' | head -n 30
}

# Runs FUNCTION [ARGS...] in the checkout with its output in LOG; returns its status.
run_attempt() {
  local log=$1
  shift
  (
    set -e
    cd "$SRC"
    "$@"
  ) > "$log" 2>&1
}

_job() {
  local name=$1
  shift
  local wanted=false
  while [ $# -gt 0 ] && [ "$1" != -- ]; do
    area_on "$1" && wanted=true
    shift
  done
  shift
  local outcome="$STATE_DIR/job-$name"
  local log="$LOGS/$LEG-$name.log"
  if [ "$wanted" != true ]; then
    echo "skipped  $name" > "$outcome"
    return 0
  fi
  if [ "$ONLY" != "  " ] && [[ "$ONLY" != *" $name "* ]]; then
    echo "skipped  $name (not selected)" > "$outcome"
    return 0
  fi
  echo "[$(stamp)] $LEG: $name started"
  local start=$SECONDS
  run_attempt "$log" "$@"
  local status=$?
  local took=$(( (SECONDS - start + 30) / 60 ))
  if [ "$status" -eq 0 ]; then
    echo "passed   $name (${took} min)" > "$outcome"
    echo "[$(stamp)] $LEG: $name passed in ${took} min"
    return 0
  fi
  echo "[$(stamp)] $LEG: $name FAILED in ${took} min; last lines of $log:"
  tail -n 30 "$log" | sed 's/^/    /'
  local tests
  tests="$(failed_tests "$log")"
  [ -n "$tests" ] || tests="(job $name, no test named in its log)"
  if [ "${KALZIT_CI_RERUN:-1}" != 1 ]; then
    echo "FAILED   $name (${took} min, log $log)" > "$outcome"
    return 0
  fi
  # Once more, only to see whether the failure repeats. The job stays failed either way.
  local rerun_log="$LOGS/$LEG-$name-rerun.log" again=$SECONDS
  echo "[$(stamp)] $LEG: $name rerun to diagnose (the job stays failed)"
  KALZIT_CI_RERUN_PASS=1 run_attempt "$rerun_log" "$@"
  local rerun_status=$?
  local rerun_took=$(( (SECONDS - again + 30) / 60 ))
  local what
  if [ "$rerun_status" -eq 0 ]; then
    what="failed, then passed on rerun"
  else
    what="failed again on rerun"
  fi
  echo "[$(stamp)] $LEG: $name $what (${rerun_took} min, log $rerun_log)"
  echo "FAILED   $name (${took} min, $what; log $log)" > "$outcome"
  local test
  while IFS= read -r test; do
    printf '%s/%s\t%s\t%s\n' "$LEG" "$name" "$what" "$test" >> "$RERUNS_FILE"
  done <<< "$tests"
}

# job NAME AREA... -- FUNCTION [ARGS...]
job() {
  JOB_ORDER+=("$1")
  _job "$@"
}

# A job that is not part of this stage, shown as skipped with the reason.
skip_job() {
  JOB_ORDER+=("$1")
  echo "skipped  $1 ($2)" > "$STATE_DIR/job-$1"
}

finish() {
  local name line failed=()
  local lines=()
  for name in "${JOB_ORDER[@]}"; do
    line="$(cat "$STATE_DIR/job-$name" 2> /dev/null || echo "FAILED   $name (no outcome recorded)")"
    lines+=("$line")
    case "$line" in FAILED*) failed+=("$name") ;; esac
  done
  {
    if [ ${#failed[@]} -eq 0 ]; then echo success; else echo "failure ${failed[*]}"; fi
    printf '%s\n' "${lines[@]}"
  } > "$RESULT_FILE"
  cat "$RESULT_FILE"
  sccache_report
  rm -rf "$STATE_DIR"
  [ ${#failed[@]} -eq 0 ]
}

# A marker for work done once per leg run (the UI's install and build, the e2e binaries), so the
# jobs after it reuse it instead of building again.
done_once() { [ -e "$STATE_DIR/once-$1" ]; }
mark_once() { : > "$STATE_DIR/once-$1"; }

# sccache as the compiler cache of every cargo build, when it is installed; without it the builds
# run as before. Its folder: KALZIT_CI_CACHE/sccache (C:/Users/klein/kz-ci/cache/sccache on
# Windows, /home/ci/kz-ci/cache/sccache in WSL). KALZIT_CI_SCCACHE=0 turns it off.
sccache_start() {
  [ "${KALZIT_CI_SCCACHE:-1}" = 1 ] || { echo "sccache: off (KALZIT_CI_SCCACHE=0)"; return 0; }
  if ! command -v sccache > /dev/null; then
    echo "sccache: not installed; building without a compiler cache"
    return 0
  fi
  # A server of the CI's own (its port, its folder), so a server the owner's builds use is never
  # stopped or pointed at another folder.
  export SCCACHE_DIR="$KALZIT_CI_CACHE/sccache" SCCACHE_CACHE_SIZE=${KALZIT_CI_SCCACHE_SIZE:-40G} \
    SCCACHE_SERVER_PORT=${KALZIT_CI_SCCACHE_PORT:-4227}
  mkdir -p "$SCCACHE_DIR"
  if sccache --start-server > /dev/null 2>&1 || sccache --show-stats > /dev/null 2>&1; then
    export RUSTC_WRAPPER=sccache
    SCCACHE_STARTED=true
    echo "sccache: on ($SCCACHE_DIR)"
  else
    echo "sccache: the server did not start; building without a compiler cache"
  fi
}
# The statistics into the run's logs; the CI's server stays up for the next run and ends on its
# own when idle (sccache's idle timeout).
sccache_report() {
  [ "${SCCACHE_STARTED:-false}" = true ] || return 0
  sccache --show-stats > "$LOGS/$LEG-sccache.txt" 2>&1 || true
}

# cargo nextest runs every test binary at once (cargo test runs them one after another); doc
# tests stay with cargo test. Without nextest, or with KALZIT_CI_NEXTEST=0, cargo test runs
# everything. Both go on after a failing binary, so the log names every failed test.
#   rust_tests [cargo test target options, for example --lib --test api]
rust_tests() {
  if [ "${KALZIT_CI_NEXTEST:-1}" = 1 ] && cargo nextest --version > /dev/null 2>&1; then
    cargo nextest run --locked --no-fail-fast --test-threads "${KALZIT_CI_TEST_THREADS:-8}" "$@"
    if [ $# -eq 0 ]; then cargo test --locked --no-fail-fast --doc; fi
  else
    cargo test --locked --no-fail-fast "$@"
  fi
}

# The fast gate's Rust tests: the unit tests of every crate and the integration tests of the
# core flows (accounts and access, dashboards, Explore, analyses, alerting, sharing, reports,
# provisioning). The full suite runs all of them. Kept short on purpose: every integration test
# is a binary of its own that links the whole server.
GATE_RUST_TESTS=(access alerting alerting_delivery alerting_routing analyses api dashboard_features
  explore_history provisioning reports service_accounts settings_dashboards sharing shell team_spaces
  two_factor)

# A bisect (main-watch.sh, run.sh --tests) narrows the server and e2e jobs to the failed tests,
# one per line in KALZIT_CI_TESTS_FILE as failed_tests names them.
bisect_lines() { [ -s "${KALZIT_CI_TESTS_FILE:-}" ] && tr -d '\r' < "$KALZIT_CI_TESTS_FILE"; return 0; }
# The Rust test names (the last word of "tests/api.rs: a::b" or "kalzit::api a::b").
bisect_rust_names() { bisect_lines | grep -v ' › ' | grep -v '\.test\.tsx\? > ' | awk '{ print $NF }'; return 0; }
# One --grep pattern for the Playwright titles, with the setup every run needs; empty: no titles.
bisect_titles() {
  local titles
  titles="$(bisect_lines | grep ' › ' | sed 's/^.* › //' | sed 's/[][\\.^$*+?(){}|/]/\\&/g' | paste -sd'|' -)"
  [ -z "$titles" ] || printf '%s|first-run\\.setup\n' "$titles"
}

# fmt, clippy and the tests (ci.yml, job `server`); in the gate the tests above.
server() {
  cargo fmt --all --check
  cargo clippy --locked --all-targets -- -D warnings
  local names=()
  mapfile -t names < <(bisect_rust_names)
  if [ ${#names[@]} -gt 0 ]; then
    rust_tests -- "${names[@]}"
  elif [ "$STAGE" = gate ]; then
    local args=(--lib --bins) name
    for name in "${GATE_RUST_TESTS[@]}"; do args+=(--test "$name"); done
    rust_tests "${args[@]}"
  else
    rust_tests
  fi
}

# The UI's install, once per leg run.
ui_install() {
  done_once ui-install && return 0
  (cd "$SRC/ui" && npm ci --no-audit --no-fund)
  mark_once ui-install
}

# The UI checks (ci.yml, job `ui`). The build is the strict one (license lists with cargo, which
# both legs have), so the e2e binary embeds this build instead of making another.
ui() {
  ui_install
  cd ui
  npm run format:check
  npm run lint
  npm run check
  npm run typecheck
  npm test -- "$TEST_WORKERS"
  if [ "$LEG" = linux ]; then TZ=America/New_York npm test -- "$TEST_WORKERS"; fi
  npm run build
  mark_once ui-build
  npm run budget
}

# The e2e binaries (server with the embedded UI, the test plugin), built once per leg run and
# used by e2e, packages, msi and the like. Reuses the UI job's build when it ran.
e2e_build() {
  done_once e2e-build && return 0
  ui_install
  done_once ui-build || (cd "$SRC/ui" && npm run build)
  mark_once ui-build
  (cd "$SRC" && cargo build --profile e2e --locked -p kalzit -p kalzit-test-plugin)
  mark_once e2e-build
}

# The server alone (`-p kalzit --bin kalzit`, the package's own features), as ci.yml and
# release.yml build it for the packages and the MSI; with the UI build of this leg run. It
# replaces the e2e build's binary, so a later e2e_build builds again.
package_build() {
  ui_install
  done_once ui-build || (cd "$SRC/ui" && npm run build)
  mark_once ui-build
  (cd "$SRC" && cargo build --profile e2e --locked -p kalzit --bin kalzit)
  rm -f "$STATE_DIR/once-e2e-build"
}

# The Playwright run of the e2e job, once the services are up and their variables loaded.
#   gate: the smoke set (@smoke) in Chromium, one run.
#   full: every test in every browser, in KALZIT_CI_E2E_SHARDS parallel shards (default 2; each
#         with a server of its own), then the timing budgets alone, then one merged report.
# On the diagnostic rerun only the tests that failed run again (--last-failed), or everything
# when no test failed (for example the server did not start).
#   last_failed OUTPUT   prints --last-failed when OUTPUT's last run names failed tests
last_failed() {
  local file="$1/results/.last-run.json"
  [ "${KALZIT_CI_RERUN_PASS:-0}" = 1 ] && [ -f "$file" ] && ! grep -q '"failedTests": \[\]' "$file" \
    && echo --last-failed
  return 0
}
e2e_playwright() {
  local binary=$1 plugin=$2
  local base="$KALZIT_CI_CACHE/e2e-run" out="$SRC/ui/e2e/.output"
  export KALZIT_E2E_BINARY KALZIT_E2E_PLUGIN_BINARY KALZIT_E2E_WORKERS
  KALZIT_E2E_BINARY="$(native "$binary")"
  KALZIT_E2E_PLUGIN_BINARY="$(native "$plugin")"
  KALZIT_E2E_WORKERS=${KALZIT_CI_E2E_WORKERS:-2}
  local rerun=false status=0
  [ "${KALZIT_CI_RERUN_PASS:-0}" = 1 ] && rerun=true
  if [ "$STAGE" = gate ]; then
    [ "$rerun" = true ] || rm -rf "$base"
    # shellcheck disable=SC2046 # last_failed prints one word or none
    (cd "$SRC/ui" && KALZIT_E2E_BROWSERS=chromium KALZIT_E2E_RUN_DIR="$(native "$base")" \
      KALZIT_E2E_WORKERS=${KALZIT_CI_E2E_SMOKE_WORKERS:-4} \
      npx playwright test -c e2e/playwright.config.ts --project chromium --grep @smoke \
      $(last_failed "$out")) || status=$?
  else
    local shards=${KALZIT_CI_E2E_SHARDS:-2} i pids=() shard_status
    # A bisect narrowed to the failed titles (run.sh --tests); a shard may then have none.
    local narrow=() titles
    titles="$(bisect_titles)"
    [ -z "$titles" ] || narrow=(--grep "$titles" --pass-with-no-tests)
    [ "$rerun" = true ] || rm -rf "$base" "$out"
    mkdir -p "$out/blobs"
    for i in $(seq 1 "$shards"); do
      # A rerun repeats only the shards that failed.
      if [ "$rerun" = true ] && [ "$(cat "$out/shard-$i.status" 2> /dev/null)" = 0 ]; then continue; fi
      (
        cd "$SRC/ui" || exit 1
        code=0
        # shellcheck disable=SC2046
        KALZIT_E2E_OUTPUT="$(native "$out/shard-$i")" KALZIT_E2E_RUN_DIR="$(native "$base/shard-$i")" \
          KALZIT_E2E_BLOB=1 PLAYWRIGHT_BLOB_OUTPUT_FILE="$(native "$out/blobs/shard-$i.zip")" \
          npx playwright test -c e2e/playwright.config.ts --project chromium --project firefox \
          --project webkit --shard "$i/$shards" "${narrow[@]}" $(last_failed "$out/shard-$i") \
          > "$out/shard-$i.log" 2>&1 || code=$?
        echo "$code" > "$out/shard-$i.status"
      ) &
      pids+=("$!")
    done
    for i in "${pids[@]}"; do wait "$i" || true; done
    for i in $(seq 1 "$shards"); do
      echo "== shard $i of $shards"
      cat "$out/shard-$i.log" 2> /dev/null || true
      shard_status="$(cat "$out/shard-$i.status" 2> /dev/null || echo 1)"
      [ "$shard_status" = 0 ] || status=1
    done
    # The timing budgets last and alone, as in one run (project `budget`), with a fresh owner.
    # A failure here still merges the reports and keeps the artefacts below.
    if [ "$rerun" != true ] || [ "$(cat "$out/budget.status" 2> /dev/null)" != 0 ]; then
      echo "== timing budgets"
      shard_status=0
      # shellcheck disable=SC2046
      (cd "$SRC/ui" && KALZIT_E2E_OUTPUT="$(native "$out/budget")" KALZIT_E2E_RUN_DIR="$(native "$base/budget")" \
        KALZIT_E2E_BLOB=1 PLAYWRIGHT_BLOB_OUTPUT_FILE="$(native "$out/blobs/budget.zip")" \
        npx playwright test -c e2e/playwright.config.ts --project setup --project budget --no-deps \
        --workers 1 "${narrow[@]}" $(last_failed "$out/budget")) || shard_status=$?
      echo "$shard_status" > "$out/budget.status"
      [ "$shard_status" = 0 ] || status=1
    fi
    (cd "$SRC/ui" && PLAYWRIGHT_HTML_OUTPUT_DIR="$(native "$out/report")" PLAYWRIGHT_HTML_OPEN=never \
      npx playwright merge-reports --reporter html "$(native "$out/blobs")") > /dev/null 2>&1 \
      || echo "merging the shards' reports failed"
  fi
  if [ "$status" -ne 0 ] && [ -d "$out" ]; then
    local keep="$LOGS/$LEG-e2e-output"
    [ "$rerun" = true ] && keep="$keep-rerun"
    rm -rf "$keep"
    cp -r "$out" "$keep" || true
  fi
  return "$status"
}

# The services of the datasources, postgres, ldap and e2e jobs listen on fixed localhost ports,
# and WSL forwards the ports of its containers to Windows. Both legs therefore take this lock
# (a folder on the Windows drive, which both see) around every job with services.
LOCK_DIR=${KALZIT_CI_LOCK:-}
services_lock() {
  [ -n "$LOCK_DIR" ] || return 0
  local waited=0
  until mkdir "$LOCK_DIR" 2> /dev/null; do
    if [ $((waited % 60)) -eq 0 ]; then echo "[$(stamp)] waiting for the services lock ($LOCK_DIR)"; fi
    sleep 5
    waited=$((waited + 5))
    # A lock older than two hours belongs to a run that died.
    if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +120 2> /dev/null)" ]; then
      echo "removing a stale services lock"
      rmdir "$LOCK_DIR" 2> /dev/null || true
    fi
  done
  echo "$LEG $$" > "$LOCK_DIR/owner" 2> /dev/null || true
}
services_unlock() {
  [ -n "$LOCK_DIR" ] || return 0
  rm -f "$LOCK_DIR/owner"
  rmdir "$LOCK_DIR" 2> /dev/null || true
}

# The example plugins, built, packaged, signed with a throwaway key and verified (ci.yml, job
# `plugins`). PLATFORM (linux-x64, windows-x64) and EXE ("" or .exe) are set by the leg.
plugins() {
  cargo build --release --locked -p kalzit-csv-http -p kalzit-plugin-tool -p kalzit-release
  local tool="$T/release/kalzit-plugin$EXE"
  local work
  work="$(mktemp -d)"
  # On Windows a path the .exe tools can open too (C:/... instead of Git Bash's /tmp/...).
  if command -v cygpath > /dev/null; then work="$(cygpath -m "$work")"; fi
  local key="$work/throwaway-plugin-key" dist="$work/dist"
  mkdir -p "$dist"
  local public
  public="$("$tool" keygen --out "$key" | tr -d '\r' | sed -n 's/^public key: //p')"
  test -n "$public"
  "$tool" package --manifest examples/plugins/csv-http/kalzit-plugin.toml \
    --file "bin/$PLATFORM/kalzit-csv-http$EXE=$T/release/kalzit-csv-http$EXE" \
    --file README.md=examples/plugins/csv-http/README.md \
    --platform "$PLATFORM" --unsigned \
    --out "$dist/csv-http.zip" --manifest-out "$dist/csv-http.toml"
  "$tool" package --manifest examples/plugins/panel-kpi/kalzit-plugin.toml \
    --file panel.js=examples/plugins/panel-kpi/panel.js \
    --file README.md=examples/plugins/panel-kpi/README.md \
    --unsigned --out "$dist/panel-kpi.zip" --manifest-out "$dist/panel-kpi.toml"
  "$tool" package --manifest examples/plugins/app-kpi-board/kalzit-plugin.toml \
    --file board.js=examples/plugins/app-kpi-board/board.js \
    --file README.md=examples/plugins/app-kpi-board/README.md \
    --unsigned --out "$dist/app-kpi-board.zip" --manifest-out "$dist/app-kpi-board.toml"
  KALZIT_PLUGIN_SIGNING_KEY="$(cat "$key")" "$T/release/kalzit-sign$EXE" sign-plugin-manifest \
    --manifest "$dist/csv-http.toml" --manifest "$dist/panel-kpi.toml" --manifest "$dist/app-kpi-board.toml"
  rm -f "$key"
  for name in csv-http panel-kpi app-kpi-board; do
    "$tool" attach-signature --package "$dist/$name.zip" --signature "$dist/$name.toml.sig" \
      --public-key "$public"
    "$tool" verify --package "$dist/$name.zip" --public-key "$public"
  done
  rm -rf "$work"
}

# The SDKs (ci.yml, job `sdk`): TypeScript and Go.
sdk() {
  (cd sdk/typescript && npm ci --no-audit --no-fund && npm run check && npm run typecheck && npm test -- "$TEST_WORKERS" \
    && npm run build)
  cd sdk/go
  test -z "$(gofmt -l .)" || { gofmt -l .; exit 1; }
  go vet ./...
  go test ./...
}

devkit() {
  cd tools/devkit
  npm ci --no-audit --no-fund
  npm run check
  npm run typecheck
  npm test -- "$TEST_WORKERS"
  npm run build
}

devgen() {
  cd tools/devgen
  npm ci --no-audit --no-fund
  npm run check
  npm run typecheck
  npm test -- "$TEST_WORKERS"
}

# The env file the CI scripts write to (as $GITHUB_ENV), read back into this shell.
load_env_file() {
  local file=$1
  # -r, not -f: a process substitution (/dev/fd/N) is no regular file.
  [ -r "$file" ] || return 0
  while IFS= read -r line; do
    [ -n "$line" ] && export "${line?}"
  done < "$file"
}
