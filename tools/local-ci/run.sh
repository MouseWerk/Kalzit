#!/usr/bin/env bash
# Runs the CI of a pull request (or of any commit) on this Windows machine: the Windows leg in
# Git Bash and the Linux leg in WSL (Ubuntu), at the same time. It replaces the GitHub Actions
# runs of .github/workflows/ci.yml, which now run only by hand. See tools/local-ci/README.md.
#
#   run.sh PR [--full] [--msi] [--no-status]
#       tests the pull request merged onto the current origin/main, the way the merge queue did,
#       and posts the commit statuses local/linux and local/windows to its head commit; main
#       requires both. Without --full only the areas the change touches run
#       (.github/scripts/changes.sh).
#   run.sh --ref REF [--full] [--msi] [--no-status]
#       tests REF as it is (for example `--ref origin/main --full` as the release gate) and posts
#       the statuses to that commit.
#
#   --msi        also the Windows installer test, which installs and removes Kalzit as a service
#                on this machine
#   --no-status  posts nothing to GitHub
#
# Folders: KALZIT_CI_HOME (default C:/Users/klein/kz-ci) holds the Windows checkout, the caches
# and the logs (logs/<run>/); the Windows build goes to C:/Users/klein/kz-target/ci-win, the Linux
# checkout and build to /root/kz-ci and /root/kz-target/ci inside WSL. One run at a time: a second
# run waits for the first.

set -euo pipefail

REPO_SLUG=MouseWerk/Kalzit
DISTRO=${KALZIT_CI_DISTRO:-Ubuntu}
CI_HOME=${KALZIT_CI_HOME:-C:/Users/klein/kz-ci}
WIN_TARGET=${KALZIT_CI_WIN_TARGET:-C:/Users/klein/kz-target/ci-win}

pr=""
ref=""
full=false
msi=0
post=true
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref=${2:?--ref needs a value}; shift ;;
    --full) full=true ;;
    --msi) msi=1 ;;
    --no-status) post=false ;;
    [0-9]*) pr=$1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -z "$pr" ] && [ -z "$ref" ]; then
  echo "usage: run.sh PR [--full] [--msi] [--no-status] | run.sh --ref REF [--full] [--msi] [--no-status]" >&2
  exit 2
fi

# E:/GITHUB/Kalzit -> /mnt/e/GITHUB/Kalzit
to_wsl() {
  local path
  path="$(cygpath -m "$1")"
  local drive=${path:0:1}
  echo "/mnt/${drive,,}${path:2}"
}

repo="$(cd "$(git rev-parse --git-common-dir)/.." && pwd -W)"
mkdir -p "$CI_HOME"

# One run at a time.
run_lock="$CI_HOME/run.lock"
until mkdir "$run_lock" 2> /dev/null; do
  echo "another local CI run is active ($(cat "$run_lock/owner" 2> /dev/null || echo unknown)); waiting"
  sleep 30
done
echo "${pr:+PR $pr}${ref:+$ref} since $(date '+%H:%M:%S')" > "$run_lock/owner"
trap 'rm -rf "$run_lock"' EXIT

git -C "$repo" fetch --quiet origin main
main="$(git -C "$repo" rev-parse origin/main)"
if [ -n "$pr" ]; then
  git -C "$repo" fetch --quiet origin "+refs/pull/$pr/head:refs/local-ci/pr-$pr"
  head="$(git -C "$repo" rev-parse "refs/local-ci/pr-$pr")"
  label="pr$pr-${head:0:9}"
else
  git -C "$repo" fetch --quiet origin
  head="$(git -C "$repo" rev-parse "$ref^{commit}")"
  label="ref-${head:0:9}"
fi
run_id="$(date +%Y%m%d-%H%M%S)-$label"
logs="$CI_HOME/logs/$run_id"
mkdir -p "$logs"

status() {
  local state=$1 context=$2 description=$3
  [ "$post" = true ] || return 0
  gh api --silent -X POST "repos/$REPO_SLUG/statuses/$head" -f state="$state" -f context="$context" \
    -f description="${description:0:140}" || echo "posting the status $context failed" >&2
}

# The Windows checkout: a detached worktree of the repository, reused between runs.
src="$CI_HOME/src"
if [ ! -e "$src/.git" ]; then
  git -C "$repo" worktree add --detach "$src" "$main" > /dev/null
fi
git -C "$src" checkout --quiet -f --detach "$main"
git -C "$src" clean -ffdxq
if [ -n "$pr" ]; then
  if ! git -C "$src" -c user.name="Local CI" -c user.email="local-ci@invalid" \
      merge --quiet --no-ff --no-edit -m "Local CI: PR $pr onto main" "$head" > "$logs/merge.log" 2>&1; then
    git -C "$src" merge --abort || true
    echo "PR $pr does not merge cleanly onto main ${main:0:9}; merge main into it first." >&2
    status failure local/linux "conflicts with main ${main:0:9}"
    status failure local/windows "conflicts with main ${main:0:9}"
    exit 1
  fi
else
  git -C "$src" checkout --quiet -f --detach "$head"
fi
tested="$(git -C "$src" rev-parse HEAD)"
git -C "$repo" update-ref refs/local-ci/tested "$tested"

if [ "$full" = true ]; then
  areas="$(cd "$src" && .github/scripts/changes.sh < /dev/null 2> /dev/null)"
elif [ -n "$pr" ]; then
  areas="$(cd "$src" && .github/scripts/changes.sh "$main" "$tested" 2> "$logs/changed-files.txt")"
else
  areas="$(cd "$src" && .github/scripts/changes.sh < /dev/null 2> /dev/null)"
fi
printf '%s\n' "$areas" > "$logs/areas.txt"
echo "Run $run_id: testing ${tested:0:9} (head ${head:0:9}, main ${main:0:9})"
echo "Areas: $(printf '%s\n' "$areas" | grep '=true' | cut -d= -f1 | tr '\n' ' ')"
echo "Logs: $logs"

status pending local/linux "running on main ${main:0:9}"
status pending local/windows "running on main ${main:0:9}"

start=$SECONDS
lock="$CI_HOME/services.lock"
rm -rf "$lock"

(
  LOGS="$logs" AREAS="$areas" SRC="$src" CARGO_TARGET_DIR="$WIN_TARGET" \
    KALZIT_CI_CACHE="$CI_HOME/cache" KALZIT_CI_LOCK="$lock" KALZIT_CI_MSI="$msi" \
    bash "$src/tools/local-ci/windows.sh"
) > "$logs/windows.out" 2>&1 &
windows_pid=$!

wsl_repo="$(to_wsl "$repo")"
wsl_logs="$(to_wsl "$logs")"
wsl_lock="$(to_wsl "$lock")"
(
  # shellcheck disable=SC2016
  # MSYS_NO_PATHCONV: Git Bash would turn the /mnt/... arguments into Windows paths.
  MSYS_NO_PATHCONV=1 wsl.exe -d "$DISTRO" -u root -- env LOGS="$wsl_logs" REPO="$wsl_repo" KALZIT_CI_LOCK="$wsl_lock" bash -lc '
    set -euo pipefail
    src=/root/kz-ci/src
    if [ ! -d "$src/.git" ]; then mkdir -p "$src"; git -C "$src" init --quiet; fi
    git config --global --add safe.directory "$REPO" 2> /dev/null || true
    git -C "$src" fetch --quiet "$REPO" "+refs/local-ci/tested:refs/local-ci/tested"
    git -C "$src" checkout --quiet -f --detach refs/local-ci/tested
    git -C "$src" clean -ffdxq
    export AREAS="$(cat "$LOGS/areas.txt")" SRC="$src" CARGO_TARGET_DIR=/root/kz-target/ci \
      KALZIT_CI_CACHE=/root/kz-ci/cache
    bash "$src/tools/local-ci/linux.sh"
  '
) > "$logs/linux.out" 2>&1 &
linux_pid=$!

# Progress of both legs on this console.
tail -q -n +1 -F "$logs/windows.out" "$logs/linux.out" 2> /dev/null | grep --line-buffered -E '^\[' &
tail_pid=$!

windows_ok=true
linux_ok=true
wait "$windows_pid" || windows_ok=false
wait "$linux_pid" || linux_ok=false
kill "$tail_pid" 2> /dev/null || true
rm -rf "$lock"

took=$(( (SECONDS - start + 30) / 60 ))
report() {
  local leg=$1 ok=$2
  local result="$logs/$leg.result"
  if [ "$ok" = true ] && [ "$(head -1 "$result" 2> /dev/null)" = success ]; then
    status success "local/$leg" "passed on main ${main:0:9} in $took min"
    return 0
  fi
  local failed
  failed="$(head -1 "$result" 2> /dev/null | sed -n 's/^failure //p')"
  status failure "local/$leg" "failed: ${failed:-the leg itself, see $leg.out} on main ${main:0:9}"
  return 1
}
overall=0
report windows "$windows_ok" || overall=1
report linux "$linux_ok" || overall=1

echo
echo "== Windows"; cat "$logs/windows.result" 2> /dev/null || tail -n 20 "$logs/windows.out"
echo "== Linux"; cat "$logs/linux.result" 2> /dev/null || tail -n 20 "$logs/linux.out"
echo
if [ "$overall" -eq 0 ]; then
  echo "PASSED in $took min (${tested:0:9}); logs in $logs"
else
  echo "FAILED after $took min (${tested:0:9}); logs in $logs"
fi
exit "$overall"
