#!/usr/bin/env bash
# Shared helpers of the local CI legs (linux.sh in WSL, windows.sh in Git Bash). Sourced, not run.
#
# A leg runs jobs one after another. A job is a function; `job NAME AREA... -- FUNCTION` runs it
# when one of its areas is on (or always with the area `always`), logs it to $LOGS/<leg>-NAME.log
# and records the outcome. A failed step ends its job, never the leg: every other job still runs,
# as with `fail-fast: false` in ci.yml. The leg's result goes to $LOGS/<leg>.result: the first
# line is `success` or `failure`, the lines after it one job each with its time.
#
# Expects: LEG (linux|windows), LOGS (a folder both systems can write), AREAS (the key=value lines
# of .github/scripts/changes.sh), SRC (the checkout under test).

set -uo pipefail

: "${LEG:?}" "${LOGS:?}" "${AREAS:?}" "${SRC:?}"
mkdir -p "$LOGS"
RESULT_FILE="$LOGS/$LEG.result"
SUMMARY=()
FAILED=()

area_on() {
  local name=$1
  [ "$name" = always ] && return 0
  printf '%s\n' "$AREAS" | grep -qx "$name=true"
}

# UTC on both legs (they set TZ=UTC for the tests); the CI pane reads it as UTC.
stamp() { date -u +%H:%M:%S; }

# job NAME AREA... -- FUNCTION [ARGS...]
job() {
  local name=$1
  shift
  local wanted=false
  while [ $# -gt 0 ] && [ "$1" != -- ]; do
    area_on "$1" && wanted=true
    shift
  done
  shift
  local log="$LOGS/$LEG-$name.log"
  if [ "$wanted" != true ]; then
    SUMMARY+=("skipped  $name")
    return 0
  fi
  echo "[$(stamp)] $LEG: $name started"
  local start=$SECONDS
  (
    set -e
    cd "$SRC"
    "$@"
  ) > "$log" 2>&1
  local status=$?
  local took=$(( (SECONDS - start + 30) / 60 ))
  if [ "$status" -eq 0 ]; then
    SUMMARY+=("passed   $name (${took} min)")
    echo "[$(stamp)] $LEG: $name passed in ${took} min"
  else
    SUMMARY+=("FAILED   $name (${took} min, log $log)")
    FAILED+=("$name")
    echo "[$(stamp)] $LEG: $name FAILED in ${took} min; last lines of $log:"
    tail -n 30 "$log" | sed 's/^/    /'
  fi
}

finish() {
  {
    if [ ${#FAILED[@]} -eq 0 ]; then echo success; else echo "failure ${FAILED[*]}"; fi
    printf '%s\n' "${SUMMARY[@]}"
  } > "$RESULT_FILE"
  cat "$RESULT_FILE"
  [ ${#FAILED[@]} -eq 0 ]
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

# The env file the CI scripts write to (as $GITHUB_ENV), read back into this shell.
load_env_file() {
  local file=$1
  # -r, not -f: a process substitution (/dev/fd/N) is no regular file.
  [ -r "$file" ] || return 0
  while IFS= read -r line; do
    [ -n "$line" ] && export "${line?}"
  done < "$file"
}
