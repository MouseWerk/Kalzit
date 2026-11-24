#!/usr/bin/env bash
# The full suite on main, after the merges: pull requests merge on the fast gate (run.sh without
# --full), and this script runs everything else on main (every e2e test in every browser,
# PostgreSQL, LDAP, ACME, the data source containers, packages, docker, the generators' proof
# and the MSI) once a merge batch has landed, or within the hour when main changed.
#
#   main-watch.sh            keeps watching: checks main every 5 minutes, runs the full suite when
#                            merge.sh reported a batch (KALZIT_CI_HOME/main-watch.trigger) or the
#                            last full run on main is an hour old and main changed since
#   main-watch.sh --once     one check now, and a full run if main changed since the last one
#
#   --every MIN    the longest wait between two full runs while main changes (default 60)
#   --poll MIN     how often it looks at main (default 5)
#   --no-msi       leaves out the Windows installer test
#   --no-revert    bisects but opens no revert pull request
#   --good COMMIT  the last main commit known to pass the full suite (a bisect starts there);
#                  afterwards every passing full run on main sets it
#
# The run posts local/linux and local/windows to the main commit (run.sh --ref <main> --full).
# When it fails:
#   - A job that failed and then passed on its diagnostic rerun is an intermittent failure: no
#     bisect, no revert (a bisect cannot follow it). It is in the flaky log and the summary and
#     needs a root-cause fix, like any failing test.
#   - Otherwise it bisects the commits since the last main commit whose full suite passed (each
#     squash commit is one pull request) with only the failed jobs, and opens a pull request that
#     reverts the first failing one, authored as the owner, from a branch fix/revert-<pr>. It
#     never pushes to main: the revert goes through review and merge.sh's fast gate like any
#     other pull request. A failing test is a bug to fix in the code; the revert takes the merge
#     back, never a test.
#
# It shares run.lock with every other run: a full run on main waits for a running gate, and a
# gate waits for a running full run. The release gate stays one full run on the release commit
# (run.sh --ref origin/main --full). State and log: KALZIT_CI_HOME/main-watch/.

set -euo pipefail

main() {

REPO_SLUG=MouseWerk/Kalzit
CI_HOME=${KALZIT_CI_HOME:-C:/Users/klein/kz-ci}
OWNER_NAME="Maurice Kleindienst"
OWNER_EMAIL="kleindiema@gmail.com"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

once=false
every=60
poll=5
msi=(--msi)
revert=true
while [ $# -gt 0 ]; do
  case "$1" in
    --once) once=true ;;
    --every) every=${2:?--every needs minutes}; shift ;;
    --poll) poll=${2:?--poll needs minutes}; shift ;;
    --no-msi) msi=() ;;
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
if [ -n "${good_seed:-}" ]; then echo "$(git rev-parse "$good_seed^{commit}")" > "$state/last-good"; fi
log="$state/main-watch.log"
trigger="$CI_HOME/main-watch.trigger"
say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$log"; }
get() { cat "$state/$1" 2> /dev/null || true; }
put() { echo "$2" > "$state/$1"; }

# The newest log folder of a full run of COMMIT.
run_logs() { ls -d "$CI_HOME/logs/"*"-ref-${1:0:9}" 2> /dev/null | sort | tail -1; }

# The failed jobs of a run (both legs), one list.
failed_jobs() {
  local dir=$1
  { head -1 "$dir/windows.result" 2> /dev/null; head -1 "$dir/linux.result" 2> /dev/null; } \
    | sed -n 's/^failure //p' | tr ' ' '\n' | sed '/^$/d' | sort -u | paste -sd, -
}

# Did every failed job pass its diagnostic rerun? Then the failure is intermittent.
intermittent() {
  local dir=$1 jobs=$2 job tab=$'\t'
  for job in ${jobs//,/ }; do
    if ! cat "$dir"/*.reruns 2> /dev/null | grep -qF "/$job${tab}failed, then passed on rerun${tab}"; then return 1; fi
    if cat "$dir"/*.reruns 2> /dev/null | grep -qF "/$job${tab}failed again on rerun${tab}"; then return 1; fi
  done
  return 0
}

# 0 when the jobs pass on COMMIT, 1 when they fail.
jobs_pass() {
  local commit=$1 jobs=$2
  say "bisect: $jobs on ${commit:0:9}"
  "$here/run.sh" --ref "$commit" --full --only "$jobs" --no-rerun "${msi[@]}" > /dev/null 2>&1
}

# Opens the revert pull request for CULPRIT (a squash commit on main).
open_revert() {
  local culprit=$1 head=$2 jobs=$3 dir=$4
  local subject number title tree commit branch body
  subject="$(git log -1 --format=%s "$culprit")"
  number="$(printf '%s' "$subject" | sed -n 's/.*(#\([0-9][0-9]*\))$/\1/p')"
  title="$(printf '%s' "$subject" | sed 's/ (#[0-9][0-9]*)$//')"
  branch="fix/revert-${number:-${culprit:0:9}}"
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
  body="Reverts ${culprit} (${subject})."$'\n\n'"The full suite failed on main ${head:0:9} in: ${jobs}. Bisecting the merges since the last passing full run found this commit as the first that fails them; the commit before it passes."$'\n\n'"Failed tests:"$'\n'"$(cat "$dir"/*.reruns 2> /dev/null | cut -f3 | sort -u | sed 's/^/- /')"$'\n\n'"Logs: ${dir}"
  commit="$(GIT_AUTHOR_NAME="$OWNER_NAME" GIT_AUTHOR_EMAIL="$OWNER_EMAIL" \
    GIT_COMMITTER_NAME="$OWNER_NAME" GIT_COMMITTER_EMAIL="$OWNER_EMAIL" \
    git commit-tree "$tree" -p origin/main -m "Revert \"$title\"" -m "$body")"
  git push --quiet origin "$commit:refs/heads/$branch"
  gh pr create --repo "$REPO_SLUG" --base main --head "$branch" --title "Revert \"$title\"" \
    --body "$body"$'\n\n'"This pull request goes through review and the fast gate (merge.sh) like any other. The change comes back in a new pull request with the fix." \
    | tee -a "$log"
}

handle_failure() {
  local head=$1 dir jobs good
  dir="$(run_logs "$head")"
  jobs="$(failed_jobs "$dir")"
  if [ -z "$jobs" ]; then
    say "the full suite on ${head:0:9} failed without a failed job (a leg itself); see $dir"
    return 0
  fi
  if intermittent "$dir" "$jobs"; then
    say "full suite on ${head:0:9}: $jobs failed, then passed on rerun; an intermittent failure: no bisect, no revert. Find and fix the cause (flaky log, $dir)."
    return 0
  fi
  good="$(get last-good)"
  if [ -z "$good" ] || ! git merge-base --is-ancestor "$good" "$head"; then
    say "full suite on ${head:0:9} failed in $jobs; no earlier passing full run on main to bisect from ($dir)"
    return 0
  fi
  local commits=()
  mapfile -t commits < <(git rev-list --first-parent --reverse "$good..$head")
  local lo=-1 hi=$(( ${#commits[@]} - 1 )) mid
  # commits[hi] fails (the head); lo is the last known pass (-1: the last good commit).
  while [ $((hi - lo)) -gt 1 ]; do
    mid=$(( (lo + hi) / 2 ))
    if jobs_pass "${commits[$mid]}" "$jobs"; then lo=$mid; else hi=$mid; fi
  done
  local culprit=${commits[$hi]}
  say "full suite on ${head:0:9}: $jobs fail from ${culprit:0:9} on ($(git log -1 --format=%s "$culprit"))"
  if [ "$revert" = true ]; then open_revert "$culprit" "$head" "$jobs" "$dir" || true; fi
}

check() {
  git fetch --quiet origin main
  local head last last_time now
  head="$(git rev-parse origin/main)"
  last="$(get last-tested)"
  last_time="$(get last-time)"
  now="$(date +%s)"
  [ "$head" != "$last" ] || return 0
  if [ "$once" != true ] && [ ! -e "$trigger" ] && [ -n "$last_time" ] && [ $((now - last_time)) -lt $((every * 60)) ]; then
    return 0
  fi
  rm -f "$trigger"
  say "full suite on main ${head:0:9}"
  put last-tested "$head"
  put last-time "$now"
  if "$here/run.sh" --ref "$head" --full "${msi[@]}"; then
    put last-good "$head"
    say "full suite on main ${head:0:9}: passed"
  else
    say "full suite on main ${head:0:9}: FAILED"
    handle_failure "$head"
  fi
}

if [ "$once" = true ]; then
  check
  exit 0
fi
while :; do
  check || say "the check failed; trying again at the next poll"
  sleep $((poll * 60))
done
}

main "$@"
