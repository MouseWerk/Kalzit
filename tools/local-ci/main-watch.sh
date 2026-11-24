#!/usr/bin/env bash
# The full suite on main, after the merges: pull requests merge on the fast gate (run.sh without
# --full), and this script runs everything else on main (every e2e test, the engine checks also
# in Firefox and WebKit, PostgreSQL, LDAP, ACME, the data source containers, packages, docker and
# the generators' proof) once a merge batch has landed, or within the hour when main changed.
#
#   main-watch.sh            keeps watching: checks main every 5 minutes, runs the full suite when
#                            merge.sh reported a batch (KALZIT_CI_HOME/main-watch.trigger) or the
#                            last full run on main is an hour old and main changed since
#   main-watch.sh --once     one check now, and a full run if main changed since the last one;
#                            exits 1 when that run failed
#
#   --every MIN    the longest wait between two full runs while main changes (default 60)
#   --poll MIN     how often it looks at main (default 5)
#   --msi          adds the Windows installer test, which installs and removes Kalzit as a
#                  service (with a firewall rule and %ProgramData%\Kalzit) on this machine; off
#                  by default, as for every run (docs/process.md)
#   --no-revert    bisects but opens no revert pull request
#   --good COMMIT  the last main commit known to pass the full suite (a bisect starts there);
#                  afterwards every passing full run on main sets it
#
# The run posts local/linux and local/windows to the main commit (run.sh --ref <main> --full).
# When it fails:
#   - A job that failed and then passed on its diagnostic rerun is an intermittent failure: no
#     bisect, no revert (a bisect cannot follow it). It is in the flaky log and the summary and
#     needs a root-cause fix, like any failing test.
#   - An open revert pull request of this script for the same failed jobs: nothing new until it
#     has merged or closed.
#   - Otherwise it runs the failed tests alone on the head: if they pass there (they needed the
#     tests around them, or the pattern misses a title), the bisect runs the whole jobs. Then it
#     runs them on the last main commit whose full suite passed. If they fail there too, the
#     merges are not the cause: it reports and reverts nothing.
#   - Otherwise it bisects the commits since then (each squash commit is one pull request) with
#     only the failed jobs, narrowed to the failed tests where the logs name them (Rust tests,
#     Playwright titles), and opens a pull request that reverts the first failing one, authored
#     as the owner, from a branch fix/revert-<pr>: never a second one for the same pull request
#     (open or merged), never one that changes nothing. It never pushes to main: the revert goes
#     through review and merge.sh's fast gate like any other pull request. A failing test is a
#     bug to fix in the code; the revert takes the merge back, never a test.
#
# It shares run.lock with every other run: a full run on main waits for a running gate, and a
# gate waits for a running full run. The release gate stays one full local run on the release
# commit (run.sh --ref origin/main --full). State and log: KALZIT_CI_HOME/main-watch/.

set -euo pipefail

main() {

REPO_SLUG=MouseWerk/Kalzit
CI_HOME=${KALZIT_CI_HOME:-C:/Users/klein/kz-ci}
OWNER_NAME="Maurice Kleindienst"
OWNER_EMAIL="kleindiema@gmail.com"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tab=$'\t'

once=false
every=60
poll=5
msi=()
revert=true
good_seed=""
while [ $# -gt 0 ]; do
  case "$1" in
    --once) once=true ;;
    --every) every=${2:?--every needs minutes}; shift ;;
    --poll) poll=${2:?--poll needs minutes}; shift ;;
    --msi) msi=(--msi) ;;
    --no-revert) revert=false ;;
    --good) good_seed=${2:?--good needs a commit}; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
cd "$(git -C "$here" rev-parse --show-toplevel)"

state="$CI_HOME/main-watch"
mkdir -p "$state"
# The last main commit with a passing full suite, where a bisect starts; set by every passing
# full run, or by hand with --good (for example the commit of the last release gate).
if [ -n "$good_seed" ]; then git rev-parse "$good_seed^{commit}" > "$state/last-good"; fi
log="$state/main-watch.log"
trigger="$CI_HOME/main-watch.trigger"
say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$log"; }
get() { cat "$state/$1" 2> /dev/null || true; }
put() { echo "$2" > "$state/$1"; }

# The newest log folder of a run of COMMIT as it is (run.sh --ref), or nothing.
run_logs() {
  local dir
  for dir in "$CI_HOME/logs/"*"-ref-${1:0:9}"; do [ -d "$dir" ] && printf '%s\n' "$dir"; done | sort | tail -1
}

# The failed jobs of a run (both legs), one list separated by commas.
failed_jobs() {
  local dir=$1
  { head -1 "$dir/windows.result" 2> /dev/null; head -1 "$dir/linux.result" 2> /dev/null; } \
    | sed -n 's/^failure //p' | tr ' ' '\n' | sed '/^$/d' | sort -u | paste -sd, -
}

# Did every failed job pass its diagnostic rerun? Then the failure is intermittent.
intermittent() {
  local dir=$1 jobs=$2 job
  for job in ${jobs//,/ }; do
    if ! cat "$dir"/*.reruns 2> /dev/null | grep -qF "/$job${tab}failed, then passed on rerun${tab}"; then return 1; fi
    if cat "$dir"/*.reruns 2> /dev/null | grep -qF "/$job${tab}failed again on rerun${tab}"; then return 1; fi
  done
  return 0
}

# The failed tests the logs name (one per line), for a bisect narrowed to them.
failed_tests() {
  cat "$1"/*.reruns 2> /dev/null | cut -f3 | grep -v '^(job ' | sort -u || true
}

# 0 when the jobs (narrowed to TESTS, a file, when it has lines) pass on COMMIT, 1 when not.
jobs_pass() {
  local commit=$1 jobs=$2 tests=$3
  say "bisect: $jobs on ${commit:0:9}"
  "$here/run.sh" --ref "$commit" --full --only "$jobs" --tests "$tests" --no-rerun "${msi[@]}" > /dev/null 2>&1
}

# The open revert pull request of an earlier failure with the same jobs, if any.
open_revert_for() {
  local jobs=$1 recorded url
  recorded="$(get open-revert)"
  [ -n "$recorded" ] || return 1
  [ "${recorded%%"$tab"*}" = "$jobs" ] || return 1
  url="${recorded#*"$tab"}"
  [ "$(gh pr view "$url" --repo "$REPO_SLUG" --json state --jq .state 2> /dev/null)" = OPEN ] || return 1
  printf '%s\n' "$url"
}

# Opens the revert pull request for CULPRIT (a squash commit on main). TESTS: the failed tests the
# full run named; RUN: the name of the full run's log folder (the bisect makes newer ones).
open_revert() {
  local culprit=$1 head=$2 jobs=$3 tests=$4 run=$5
  local subject number title tree commit branch body earlier url
  subject="$(git log -1 --format=%s "$culprit")"
  number="$(printf '%s' "$subject" | sed -n 's/.*(#\([0-9][0-9]*\))$/\1/p')"
  title="$(printf '%s' "$subject" | sed 's/ (#[0-9][0-9]*)$//')"
  branch="fix/revert-${number:-${culprit:0:9}}"
  # One revert per pull request: an open or merged one (its branch is deleted after the merge)
  # ends here, and so does a branch left over without a pull request.
  earlier="$(gh pr list --repo "$REPO_SLUG" --state all --head "$branch" \
    --json number,state --jq '.[] | select(.state != "CLOSED") | "#\(.number) \(.state)"' | head -1)"
  if [ -n "$earlier" ]; then
    say "a revert of ${culprit:0:9} exists already ($earlier); no second one"
    return 0
  fi
  if git ls-remote --exit-code --heads origin "$branch" > /dev/null 2>&1; then
    say "a branch $branch exists already; no second revert"
    return 0
  fi
  git fetch --quiet origin main
  # The revert as a three-way merge onto the current main, without a checkout.
  if ! tree="$(git merge-tree --write-tree --no-messages --merge-base="$culprit" origin/main "$culprit^")"; then
    say "reverting ${culprit:0:9} conflicts with main; revert it by hand"
    return 1
  fi
  if [ "$tree" = "$(git rev-parse 'origin/main^{tree}')" ]; then
    say "reverting ${culprit:0:9} changes nothing on main (reverted already?); no pull request"
    return 0
  fi
  # No local paths in the public text: the run is named by its folder's name only.
  body="Reverts ${culprit} (${subject})."$'\n\n'"The full suite failed on main ${head:0:9} in: ${jobs}. The same jobs pass on the last main commit with a passing full suite; bisecting the merges since then found this commit as the first that fails them, and the commit before it passes."
  if [ -s "$tests" ]; then
    body="$body"$'\n\n'"Failed tests:"$'\n'"$(sed 's/^/- /' "$tests")"
  fi
  body="$body"$'\n\n'"Local CI run: ${run}."
  commit="$(GIT_AUTHOR_NAME="$OWNER_NAME" GIT_AUTHOR_EMAIL="$OWNER_EMAIL" \
    GIT_COMMITTER_NAME="$OWNER_NAME" GIT_COMMITTER_EMAIL="$OWNER_EMAIL" \
    git commit-tree "$tree" -p origin/main -m "Revert \"$title\"" -m "$body")"
  git push --quiet origin "$commit:refs/heads/$branch"
  url="$(gh pr create --repo "$REPO_SLUG" --base main --head "$branch" --title "Revert \"$title\"" \
    --body "$body"$'\n\n'"This pull request goes through review and the fast gate (merge.sh) like any other. The change comes back in a new pull request with the fix.")"
  say "revert pull request for ${culprit:0:9}: $url"
  put open-revert "$jobs$tab$url"
}

handle_failure() {
  local head=$1 dir jobs good open tests
  dir="$(run_logs "$head")"
  if [ -z "$dir" ]; then
    say "the full suite on ${head:0:9} failed before it wrote a log folder; nothing to bisect"
    return 0
  fi
  jobs="$(failed_jobs "$dir")"
  if [ -z "$jobs" ]; then
    say "the full suite on ${head:0:9} failed without a failed job (a leg itself); see $dir"
    return 0
  fi
  if intermittent "$dir" "$jobs"; then
    say "full suite on ${head:0:9}: $jobs failed, then passed on rerun; an intermittent failure: no bisect, no revert. Find and fix the cause (flaky log, $dir)."
    return 0
  fi
  if open="$(open_revert_for "$jobs")"; then
    say "full suite on ${head:0:9}: $jobs failed; the revert $open for these jobs is still open; no new bisect"
    return 0
  fi
  good="$(get last-good)"
  if [ -z "$good" ] || ! git merge-base --is-ancestor "$good" "$head"; then
    say "full suite on ${head:0:9} failed in $jobs; no earlier passing full run on main to bisect from ($dir)"
    return 0
  fi
  local named="$state/failed-tests.txt"
  failed_tests "$dir" > "$named"
  tests="$state/bisect-tests.txt"
  cp "$named" "$tests"
  # The narrowed set must fail on the head too. It can pass there (the failure needed state from
  # tests around it, or the pattern misses the title): then the bisect runs the whole jobs.
  if [ -s "$tests" ] && jobs_pass "$head" "$jobs" "$tests"; then
    say "full suite on ${head:0:9}: the failed tests alone pass there; bisecting the whole jobs ($jobs)"
    : > "$tests"
  fi
  # The jobs must pass where the bisect starts, or the merges since then are not the cause.
  if ! jobs_pass "$good" "$jobs" "$tests"; then
    say "full suite on ${head:0:9}: $jobs fail on the last good commit ${good:0:9} too; not caused by the merges since, no revert ($dir)"
    return 0
  fi
  local commits=()
  mapfile -t commits < <(git rev-list --first-parent --reverse "$good..$head")
  local lo=-1 hi=$(( ${#commits[@]} - 1 )) mid
  # commits[hi] fails (the head); lo is the last known pass (-1: the last good commit).
  while [ $((hi - lo)) -gt 1 ]; do
    mid=$(( (lo + hi) / 2 ))
    if jobs_pass "${commits[$mid]}" "$jobs" "$tests"; then lo=$mid; else hi=$mid; fi
  done
  local culprit=${commits[$hi]}
  say "full suite on ${head:0:9}: $jobs fail from ${culprit:0:9} on ($(git log -1 --format=%s "$culprit"))"
  if [ "$revert" = true ]; then open_revert "$culprit" "$head" "$jobs" "$named" "$(basename "$dir")" || true; fi
}

# 0 when nothing was due or the full run passed, 1 when it failed.
check() {
  # The trigger goes before the fetch: a batch that lands after it leaves a new trigger, a batch
  # that landed before it is in the fetch.
  local triggered=false
  if [ -e "$trigger" ]; then
    triggered=true
    rm -f "$trigger"
  fi
  git fetch --quiet origin main
  local head last last_time now
  head="$(git rev-parse origin/main)"
  last="$(get last-tested)"
  last_time="$(get last-time)"
  now="$(date +%s)"
  [ "$head" != "$last" ] || return 0
  if [ "$once" != true ] && [ "$triggered" != true ] && [ -n "$last_time" ] \
      && [ $((now - last_time)) -lt $((every * 60)) ]; then
    return 0
  fi
  say "full suite on main ${head:0:9}"
  put last-time "$now"
  local status=0
  "$here/run.sh" --ref "$head" --full "${msi[@]}" || status=$?
  # Only a finished run counts as tested; a stopped one runs again at the next check.
  put last-tested "$head"
  if [ "$status" -eq 0 ]; then
    put last-good "$head"
    say "full suite on main ${head:0:9}: passed"
    return 0
  fi
  say "full suite on main ${head:0:9}: FAILED"
  handle_failure "$head" || say "handling the failure stopped; see the log above"
  return 1
}

if [ "$once" = true ]; then
  check
  exit
fi
while :; do
  check || true
  sleep $((poll * 60))
done
}

main "$@"
