#!/usr/bin/env bash
# Runs the CI of a pull request (or of any commit) on this Windows machine: the Windows leg in
# Git Bash and the Linux leg in WSL (Ubuntu), at the same time. It replaces the GitHub Actions
# runs of .github/workflows/ci.yml, which now run only by hand. See tools/local-ci/README.md.
#
#   run.sh PR [--full] [--msi] [--no-status]
#       tests the pull request merged onto the current origin/main, the way the merge queue did,
#       and posts the commit statuses local/linux and local/windows to its head commit; main
#       requires both. Without --full it runs the fast gate (about 30 minutes) for the areas the
#       change touches (.github/scripts/changes.sh): fmt, clippy, the unit tests and the core
#       integration tests, the UI checks and build, and the smoke e2e set (@smoke) in Chromium.
#       That is enough to merge (`passed gate tree ...`); the full suite runs on main after the
#       merges (main-watch.sh). --full runs the full suite: every job and every test.
#   run.sh PR PR... [options]
#       a batch, as the merge queue built up to four at once: the pull requests merged onto main
#       one after another in this order and tested together in one run. Each head gets the
#       statuses, naming the batch (`passed gate tree <tree> on main <main> batch 391,388 in N
#       min`); merge.sh then merges exactly these, in this order (merge.sh 391 388).
#   run.sh --ref REF [--full] [--msi] [--no-status]
#       tests REF as it is (for example `--ref origin/main --full` as the release gate) and posts
#       the statuses to that commit.
#
#   --msi        also the Windows installer test, which installs and removes Kalzit as a service
#                on this machine
#   --no-status  posts nothing to GitHub
#   --only JOBS  runs only these jobs (names separated by commas, for example e2e,postgres), for
#                bisecting a failure; posts nothing
#   --tests FILE with --only: narrows the server and e2e jobs to these tests (one per line, as
#                the run summary names them: Rust test names, Playwright titles)
#   --no-rerun   no diagnostic rerun of a failed job
#   --runner-from-pr
#                runs the leg scripts (tools/local-ci) of the pull request instead of main's; for
#                a reviewed pull request that changes them, or while main has none yet
#
# A failed job runs once more, only to diagnose: the status stays failure. When the second run
# passes, the run's summary and KALZIT_CI_HOME/flaky.log record "failed, then passed on rerun:
# <test>", so the test gets a root-cause fix; the summary lists the tests that needed that more
# than twice in 7 days.
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
only=""
tests_file=""
rerun=1
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref=${2:?--ref needs a value}; shift ;;
    --full) full=true ;;
    --msi) msi=1 ;;
    --no-status) post=false ;;
    --only) only=${2:?--only needs job names}; post=false; shift ;;
    --tests) tests_file=${2:?--tests needs a file}; shift ;;
    --no-rerun) rerun=0 ;;
    --runner-from-pr) runner_from_pr=true ;;
    [0-9]*)
      case " ${prs[*]-} " in *" $1 "*) echo "PR $1 is named twice" >&2; exit 2 ;; esac
      prs+=("$1"); pr=${prs[0]} ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -z "$pr" ] && [ -z "$ref" ]; then
  echo "usage: run.sh PR [PR...] [--full] [--msi] [--no-status] [--only JOBS] [--no-rerun] | run.sh --ref REF [same options]" >&2
  exit 2
fi
stage=gate
[ "$full" = true ] && stage=full
if [ -n "$tests_file" ] && [ -z "$only" ]; then
  echo "--tests narrows the jobs of --only; name them too" >&2
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
  if [ "${#prs[@]}" -gt 8 ]; then echo "at most 8 pull requests in a batch" >&2; exit 2; fi
  label="pr$(IFS=+; echo "${prs[*]}")-${head:0:9}"
else
  git -C "$repo" fetch --quiet origin
  head="$(git -C "$repo" rev-parse "$ref^{commit}")"
  heads=("$head")
  batch=""
  label="ref-${head:0:9}"
fi
# What the run tests, for the texts of a conflict found while merging (no tree yet).
if [ "${#prs[@]}" -gt 1 ]; then base="on main ${main:0:9} batch $batch"
elif [ -n "$pr" ]; then base="on main ${main:0:9}"
else base="at ${head:0:9} as it is"; fi
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
        status failure local/linux "failed $base: PR ${prs[$i]} conflicts with the ones before it"
        status failure local/windows "failed $base: PR ${prs[$i]} conflicts with the ones before it"
      else
        echo "PR $pr does not merge cleanly onto main ${main:0:9}; merge main into it first." >&2
        status failure local/linux "failed $base: conflicts with main"
        status failure local/windows "failed $base: conflicts with main"
      fi
      exit 1
    fi
  done
else
  git -C "$src" checkout --quiet -f --detach "$head"
fi
tested="$(git -C "$src" rev-parse HEAD)"
# The statuses name the tested content first: the tree of the merged result. merge.sh computes
# the tree a merge would make now and takes a pass only for exactly that tree, so a result stays
# good while main moves in ways that leave the merged content the same (for example, a batch
# tested ahead on top of another that has merged since), and never covers anything else.
#   passed [gate ]tree <tree> on main <main> [batch 391,388] in N min
#   failed [gate ]tree <tree> on main <main> [batch 391,388]: <jobs>
# "gate" marks the fast gate; without it, the full suite.
tree="$(git -C "$src" rev-parse "HEAD^{tree}")"
if [ "$stage" = gate ]; then base="gate tree ${tree:0:12} $base"; else base="tree ${tree:0:12} $base"; fi
git -C "$repo" update-ref refs/local-ci/tested "$tested"

# The gate of a pull request runs the areas it changes; everything runs for --full, for --ref,
# and when the change detection itself fails. The generators' proof belongs to the full suite.
everything() { (cd "$src" && .github/scripts/changes.sh < /dev/null 2> /dev/null); }
if [ "$full" != true ] && [ -n "$pr" ]; then
  areas="$(cd "$src" && .github/scripts/changes.sh "$main" "$tested" 2> "$logs/changed-files.txt")" \
    || { echo "the change detection failed; everything runs" >&2; areas="$(everything)"; }
else
  areas="$(everything)"
fi
# The security audit (cargo audit, npm audit) joins the gate when a lock file changes, so a
# dependency update (Dependabot) never merges unaudited; without a pull request it always runs.
lockfiles=true
if [ -n "$pr" ] && ! git -C "$src" diff --name-only "$main" "$tested" \
    | grep -qE '(^|/)(Cargo\.lock|package-lock\.json)$'; then
  lockfiles=false
fi
areas="$areas"$'\n'"lockfiles=$lockfiles"

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
echo "$stage" > "$logs/stage.txt"
printf '%s\n' "$only" > "$logs/only.txt"
# The tests a bisect narrows to (common.sh, bisect_tests); empty: every test of the jobs.
if [ -n "$tests_file" ]; then cp "$tests_file" "$logs/tests.txt"; else : > "$logs/tests.txt"; fi
echo "$rerun" > "$logs/rerun.txt"
echo "Run $run_id: the $([ "$stage" = gate ] && echo "fast gate" || echo "full suite") of ${tested:0:9} (${pr:+PR ${prs[*]}, }main ${main:0:9})${only:+, only $only}"
echo "Areas: $(printf '%s\n' "$areas" | grep '=true' | cut -d= -f1 | tr '\n' ' ')"
echo "Logs: $logs"

status pending local/linux "running $base"
status pending local/windows "running $base"

start=$SECONDS
lock="$CI_HOME/services.lock"
rm -rf "$lock"

(
  LOGS="$logs" AREAS="$areas" SRC="$src" CARGO_TARGET_DIR="$WIN_TARGET" \
    KALZIT_CI_CACHE="$CI_HOME/cache" KALZIT_CI_LOCK="$lock" KALZIT_CI_MSI="$msi" \
    KALZIT_CI_STAGE="$stage" KALZIT_CI_ONLY="$only" KALZIT_CI_RERUN="$rerun" \
    KALZIT_CI_TESTS_FILE="$logs/tests.txt" \
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
  # What was tested first, so a cut at 140 characters loses job names, never the batch.
  status failure "local/$leg" "failed $base: ${failed:-the leg itself, see $leg.out}"
  return 1
}
overall=0
report windows "$windows_ok" || overall=1
report linux "$linux_ok" || overall=1

# The diagnostic reruns: into the flaky log (one line per test), and the tests that needed a
# rerun to pass more than twice in 7 days into the summary. Neither changes a status.
flaky_log="$CI_HOME/flaky.log"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
reruns="$(cat "$logs/windows.reruns" "$logs/linux.reruns" 2> /dev/null | tr -d '\r' || true)"
if [ -n "$reruns" ]; then
  printf '%s\n' "$reruns" | while IFS=$'\t' read -r where what test; do
    printf '%s run %s %s (%s): %s: %s\n' "$now" "$run_id" "$where" "${tree:0:12}" "$what" "$test"
  done >> "$flaky_log"
fi
since="$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)"
repeated="$(awk -v since="$since" '$1 >= since && index($0, ": failed, then passed on rerun: ") {
    sub(/^.*: failed, then passed on rerun: /, ""); count[$0]++ }
  END { for (t in count) if (count[t] > 2) printf "  %s (%d times)\n", t, count[t] }' "$flaky_log" 2> /dev/null || true)"

{
  echo "== Windows"; cat "$logs/windows.result" 2> /dev/null || tail -n 20 "$logs/windows.out"
  echo "== Linux"; cat "$logs/linux.result" 2> /dev/null || tail -n 20 "$logs/linux.out"
  if [ -n "$reruns" ]; then
    echo
    echo "== Diagnostic reruns (the jobs stay failed; find and fix the cause)"
    printf '%s\n' "$reruns" | awk -F'\t' '{ printf "  %s: %s: %s\n", $1, $2, $3 }'
  fi
  if [ -n "$repeated" ]; then
    echo
    echo "== Failed, then passed on rerun, more than twice in 7 days ($flaky_log): needs a root-cause fix"
    printf '%s\n' "$repeated"
  fi
  echo
  if [ "$overall" -eq 0 ]; then
    echo "PASSED ($stage) in $took min (${tested:0:9}); logs in $logs"
  else
    echo "FAILED ($stage) after $took min (${tested:0:9}); logs in $logs"
  fi
} > "$logs/summary.txt"
echo
cat "$logs/summary.txt"
exit "$overall"
}

main "$@"
