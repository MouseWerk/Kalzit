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
#   run.sh PR PR... [options]
#       a batch, as the merge queue built up to four at once: the pull requests merged onto main
#       one after another in this order and tested together in one run. Each head gets the
#       statuses, naming the batch (`passed on main <main> batch 391,388 in N min`); merge.sh
#       then merges exactly these, in this order (merge.sh 391 388).
#   run.sh --ref REF [--full] [--msi] [--no-status]
#       tests REF as it is (for example `--ref origin/main --full` as the release gate) and posts
#       the statuses to that commit.
#
#   --msi        also the Windows installer test, which installs and removes Kalzit as a service
#                on this machine
#   --no-status  posts nothing to GitHub
#   --runner-from-pr
#                runs the leg scripts (tools/local-ci) of the pull request instead of main's; for
#                a reviewed pull request that changes them, or while main has none yet
#
# Trust: the leg scripts come from origin/main, so a pull request cannot change how it is judged,
# but its code (build scripts, tests) runs with this machine's rights, and in WSL as a user with sudo. Run it
# only for pull requests from the team and Dependabot, never for outside forks.
#
# Folders: KALZIT_CI_HOME (default C:/Users/klein/kz-ci) holds the Windows checkout, the caches
# and the logs (logs/<run>/); the Windows build goes to C:/Users/klein/kz-target/ci-win, the Linux
# checkout and build to ~ci/kz-ci and ~ci/kz-target/ci inside WSL (the user `ci`). One run at a time: a second
# run waits for the first.

set -euo pipefail

# The whole script is one function, called on the last line: bash reads all of it before it
# runs any of it, so an edit to this file during a run cannot change the running copy.
main() {

REPO_SLUG=MouseWerk/Kalzit
DISTRO=${KALZIT_CI_DISTRO:-Ubuntu}
CI_HOME=${KALZIT_CI_HOME:-C:/Users/klein/kz-ci}
WIN_TARGET=${KALZIT_CI_WIN_TARGET:-C:/Users/klein/kz-target/ci-win}

pr=""
prs=()
ref=""
full=false
msi=0
post=true
runner_from_pr=false
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref=${2:?--ref needs a value}; shift ;;
    --full) full=true ;;
    --msi) msi=1 ;;
    --no-status) post=false ;;
    --runner-from-pr) runner_from_pr=true ;;
    [0-9]*) prs+=("$1"); pr=${prs[0]} ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -z "$pr" ] && [ -z "$ref" ]; then
  echo "usage: run.sh PR [PR...] [--full] [--msi] [--no-status] | run.sh --ref REF [--full] [--msi] [--no-status]" >&2
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
echo "${pr:+PR ${prs[*]}}${ref:+$ref} since $(date '+%H:%M:%S')" > "$run_lock/owner"
windows_pid=""
linux_pid=""
# A run that dies or is stopped takes its legs with it, so none keeps the services lock.
cleanup() {
  for pid in $windows_pid $linux_pid; do kill "$pid" 2> /dev/null || true; done
  rm -rf "$run_lock"
}
trap cleanup EXIT

git -C "$repo" fetch --quiet origin main
main="$(git -C "$repo" rev-parse origin/main)"
heads=()
if [ -n "$pr" ]; then
  for n in "${prs[@]}"; do
    git -C "$repo" fetch --quiet origin "+refs/pull/$n/head:refs/local-ci/pr-$n"
    heads+=("$(git -C "$repo" rev-parse "refs/local-ci/pr-$n")")
  done
  head=${heads[0]}
  batch="$(IFS=,; echo "${prs[*]}")"
  label="pr$(IFS=+; echo "${prs[*]}")-${head:0:9}"
else
  git -C "$repo" fetch --quiet origin
  head="$(git -C "$repo" rev-parse "$ref^{commit}")"
  heads=("$head")
  batch=""
  label="ref-${head:0:9}"
fi
run_id="$(date +%Y%m%d-%H%M%S)-$label"
logs="$CI_HOME/logs/$run_id"
mkdir -p "$logs"

# Posts to every head of the run (one, or each pull request of a batch).
status() {
  local state=$1 context=$2 description=$3 one
  [ "$post" = true ] || return 0
  for one in "${heads[@]}"; do
    gh api --silent -X POST "repos/$REPO_SLUG/statuses/$one" -f state="$state" -f context="$context" \
      -f description="${description:0:140}" || echo "posting the status $context to ${one:0:9} failed" >&2
  done
}

# The Windows checkout: a detached worktree of the repository, reused between runs.
src="$CI_HOME/src"
if [ ! -e "$src/.git" ]; then
  git -C "$repo" worktree add --detach "$src" "$main" > /dev/null
fi
git -C "$src" checkout --quiet -f --detach "$main"
git -C "$src" clean -ffdxq
if [ -n "$pr" ]; then
  for i in "${!prs[@]}"; do
    if ! git -C "$src" -c user.name="Local CI" -c user.email="local-ci@invalid" \
        merge --quiet --no-ff --no-edit -m "Local CI: PR ${prs[$i]} onto main" "${heads[$i]}" >> "$logs/merge.log" 2>&1; then
      git -C "$src" merge --abort || true
      if [ "${#prs[@]}" -gt 1 ]; then
        echo "PR ${prs[$i]} does not merge onto main ${main:0:9} together with the PRs before it in the batch." >&2
        status failure local/linux "PR ${prs[$i]} conflicts in batch $batch on main ${main:0:9}"
        status failure local/windows "PR ${prs[$i]} conflicts in batch $batch on main ${main:0:9}"
      else
        echo "PR $pr does not merge cleanly onto main ${main:0:9}; merge main into it first." >&2
        status failure local/linux "conflicts with main ${main:0:9}"
        status failure local/windows "conflicts with main ${main:0:9}"
      fi
      exit 1
    fi
  done
else
  git -C "$src" checkout --quiet -f --detach "$head"
fi
tested="$(git -C "$src" rev-parse HEAD)"
git -C "$repo" update-ref refs/local-ci/tested "$tested"

# Everything runs for --full, for --ref, and when the change detection itself fails.
everything() { (cd "$src" && .github/scripts/changes.sh < /dev/null 2> /dev/null); }
if [ "$full" != true ] && [ -n "$pr" ]; then
  areas="$(cd "$src" && .github/scripts/changes.sh "$main" "$tested" 2> "$logs/changed-files.txt")" \
    || { echo "the change detection failed; everything runs" >&2; areas="$(everything)"; }
else
  # The generators' proof (about 12 minutes) only for a pull request's run, as in ci.yml, where
  # it runs on pull requests alone; --full and --ref leave it out.
  areas="$(everything | sed 's/^devgen_proof=true$/devgen_proof=false/')"
fi

# The leg scripts: main's, unless --runner-from-pr. A copy outside the checkout under test.
runner="$CI_HOME/runner"
rm -rf "$runner"
mkdir -p "$runner"
runner_commit=$main
if [ "$runner_from_pr" = true ]; then
  runner_commit=$tested
elif ! git -C "$repo" cat-file -e "$main:tools/local-ci/run.sh" 2> /dev/null; then
  echo "main has no tools/local-ci yet; review the pull request's scripts and pass --runner-from-pr" >&2
  exit 2
fi
git -C "$repo" archive "$runner_commit" tools/local-ci | tar -x -C "$runner" --strip-components=2
if [ "$runner_from_pr" != true ] && [ -n "$(git -C "$repo" diff --name-only "$main" "$tested" -- tools/local-ci)" ]; then
  echo "Note: this pull request changes tools/local-ci; the run uses main's scripts (--runner-from-pr after review)."
fi
printf '%s\n' "$areas" > "$logs/areas.txt"
echo "Run $run_id: testing ${tested:0:9} (${pr:+PR ${prs[*]}, }main ${main:0:9})"
echo "Areas: $(printf '%s\n' "$areas" | grep '=true' | cut -d= -f1 | tr '\n' ' ')"
echo "Logs: $logs"

# The descriptions name what the run tested; merge.sh accepts only "passed on main <current>".
if [ "${#prs[@]}" -gt 1 ]; then base="on main ${main:0:9} batch $batch"
elif [ -n "$pr" ]; then base="on main ${main:0:9}"
else base="at ${head:0:9} as it is"; fi
status pending local/linux "running $base"
status pending local/windows "running $base"

start=$SECONDS
lock="$CI_HOME/services.lock"
rm -rf "$lock"

(
  LOGS="$logs" AREAS="$areas" SRC="$src" CARGO_TARGET_DIR="$WIN_TARGET" \
    KALZIT_CI_CACHE="$CI_HOME/cache" KALZIT_CI_LOCK="$lock" KALZIT_CI_MSI="$msi" \
    bash "$runner/windows.sh"
) > "$logs/windows.out" 2>&1 &
windows_pid=$!

wsl_repo="$(to_wsl "$repo")"
wsl_logs="$(to_wsl "$logs")"
wsl_lock="$(to_wsl "$lock")"
(
  # MSYS_NO_PATHCONV: Git Bash would turn the /mnt/... arguments into Windows paths.
  MSYS_NO_PATHCONV=1 wsl.exe -d "$DISTRO" -u ci -- bash "$(to_wsl "$runner")/wsl-leg.sh"     "$wsl_repo" "$wsl_logs" "$wsl_lock" "$(to_wsl "$runner")"
) > "$logs/linux.out" 2>&1 &
linux_pid=$!

# Progress of both legs on this console.
tail -q -n +1 -F "$logs/windows.out" "$logs/linux.out" 2> /dev/null | grep --line-buffered -E '^\[' &
tail_pid=$!

windows_ok=true
linux_ok=true
wait "$windows_pid" || windows_ok=false
wait "$linux_pid" || linux_ok=false
windows_pid=""
linux_pid=""
kill "$tail_pid" 2> /dev/null || true
rm -rf "$lock"

took=$(( (SECONDS - start + 30) / 60 ))
report() {
  local leg=$1 ok=$2
  local result="$logs/$leg.result"
  if [ "$ok" = true ] && [ "$(head -1 "$result" 2> /dev/null)" = success ]; then
    status success "local/$leg" "passed $base in $took min"
    return 0
  fi
  local failed
  failed="$(head -1 "$result" 2> /dev/null | sed -n 's/^failure //p')"
  status failure "local/$leg" "failed: ${failed:-the leg itself, see $leg.out} $base"
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
}

main "$@"
