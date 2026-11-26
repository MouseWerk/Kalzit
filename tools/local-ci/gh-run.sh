#!/usr/bin/env bash
# Runs the full CI of pull requests on GitHub's runners instead of this machine, for example
# overnight next to a local run: the pull requests are merged onto the current main (one after
# another as squash commits, as run.sh and GitHub do), that commit is pushed to a branch of its
# own, ci.yml is started there by hand (workflow_dispatch: every job, Windows and Linux, arm64
# packages and the MSI included), and its result is posted to every head as the statuses
# local/linux and local/windows with the tested tree, as run.sh posts them:
#
#   passed tree <tree> on main <main> [batch 391,388] in N min, GitHub run <id>
#
# merge.sh takes such a pass like a local one, for exactly that tree.
#
#   gh-run.sh PR [PR...]          tests on the current main
#   gh-run.sh --on PR... -- PR... tests the second list on top of main with the first list merged
#                                 first (as the merge queue tested ahead); the statuses go to the
#                                 heads of the second list only, for the tree main + first + second
#   gh-run.sh --gate ...          the fast gate instead of the full suite (ci.yml with
#                                 suite=gate), posted as `passed gate tree ...` like run.sh's gate;
#                                 enough for merge.sh, as a local gate is
#
# It waits for the run (at most 8 hours) and deletes the branch afterwards. No checkout is
# touched: the merges are made with git merge-tree in the repository's object store.
#
# On GitHub the pushed commit's own ci.yml runs, so a batch that changes .github/ or
# tools/local-ci would be judged by its own rules: it is refused (run it locally) unless
# GH_RUN_ALLOW_CI_CHANGES=1 says those changes were reviewed. A run that is cancelled, times out
# or does not finish posts `error` (no result; merge.sh runs the CI again), not `failure`.

set -euo pipefail

# The whole script is one function, called on the last line: bash reads all of it before it
# runs any of it, so an edit to this file during a run cannot change the running copy.
main() {

REPO_SLUG=MouseWerk/Kalzit
CI_HOME=${KALZIT_CI_HOME:-C:/Users/klein/kz-ci}

suite=full
if [ "${1:-}" = --gate ]; then
  suite=gate
  shift
fi
ahead=()
prs=()
if [ "${1:-}" = --on ]; then
  shift
  while [ $# -gt 0 ] && [ "$1" != -- ]; do ahead+=("$1"); shift; done
  [ "${1:-}" = -- ] || { echo "usage: gh-run.sh --on PR... -- PR..." >&2; exit 2; }
  shift
fi
prs=("$@")
[ ${#prs[@]} -ge 1 ] || { echo "usage: gh-run.sh [--on PR... --] PR [PR...]" >&2; exit 2; }
all=("${ahead[@]}" "${prs[@]}")
[ ${#all[@]} -le 8 ] || { echo "at most 8 pull requests in a batch" >&2; exit 2; }

git fetch --quiet origin main
main="$(git rev-parse origin/main)"
heads=()
cur=$main
for n in "${all[@]}"; do
  git fetch --quiet origin "+refs/pull/$n/head:refs/local-ci/pr-$n"
  h="$(git rev-parse "refs/local-ci/pr-$n")"
  heads+=("$h")
  step="$(git merge-tree --write-tree --no-messages "$cur" "$h")" \
    || { echo "PR $n does not merge cleanly onto main ${main:0:9} with the PRs before it." >&2; exit 1; }
  # One parent, as GitHub's squash commit has (see merge.sh).
  cur="$(git commit-tree "$step" -p "$cur" -m "GitHub CI: PR $n onto main")"
done
tree="$(git rev-parse "$cur^{tree}")"
# The workflow that runs is the pushed commit's own ci.yml: a batch that changes it, or the
# scripts it calls, would be judged by its own rules. Such a batch runs locally (run.sh uses
# main's scripts), unless GH_RUN_ALLOW_CI_CHANGES=1 says those changes were reviewed.
ci_changes="$(git diff --name-only "$main" "$cur" -- .github tools/local-ci)"
if [ "${GH_RUN_ALLOW_CI_CHANGES:-0}" != 1 ] && [ -n "$ci_changes" ]; then
  echo "This batch changes .github/ or tools/local-ci, so ci.yml on GitHub would judge it by its own rules:" >&2
  printf '%s\n' "$ci_changes" | sed 's/^/  /' >&2
  echo "Run it locally, or set GH_RUN_ALLOW_CI_CHANGES=1 after reviewing those changes." >&2
  exit 2
fi
# The heads that get the statuses: the second list (all of them without --on).
targets=("${heads[@]:${#ahead[@]}}")

base="tree ${tree:0:12} on main ${main:0:9}"
[ "$suite" = gate ] && base="gate $base"
if [ ${#all[@]} -gt 1 ]; then base="$base batch $(IFS=,; echo "${all[*]}")"; fi

label="$(IFS=+; echo "${all[*]}")"
branch="local-ci/gh-$label-$(date +%H%M%S)"
logs="$CI_HOME/logs/$(date +%Y%m%d-%H%M%S)-gh-pr$label-${heads[0]:0:9}"
mkdir -p "$logs"

status() {
  local state=$1 description=$2 one context
  for one in "${targets[@]}"; do
    for context in local/linux local/windows; do
      gh api --silent -X POST "repos/$REPO_SLUG/statuses/$one" -f state="$state" -f context="$context" \
        -f description="${description:0:140}" -f target_url="$url" \
        || echo "posting the status $context to ${one:0:9} failed" >&2
    done
  done
}

git push --quiet origin "$cur:refs/heads/$branch"
trap 'git push --quiet origin --delete "$branch" 2> /dev/null || true' EXIT
gh workflow run ci.yml --repo "$REPO_SLUG" --ref "$branch" -f suite="$suite" > /dev/null
run=""
for _ in $(seq 1 30); do
  sleep 5
  # The run of exactly the pushed commit, not an older one on a branch of the same name; a failed
  # call is tried again.
  run="$(gh run list --repo "$REPO_SLUG" --workflow ci.yml --branch "$branch" --event workflow_dispatch \
    --json databaseId,headSha --jq "[.[] | select(.headSha == \"$cur\")][0].databaseId // empty" || true)"
  [ -n "$run" ] && break
done
[ -n "$run" ] || { echo "the GitHub run did not start" >&2; exit 1; }
url="https://github.com/$REPO_SLUG/actions/runs/$run"
echo "GitHub run $run for ${all[*]} (tree ${tree:0:12} on main ${main:0:9}): $url" | tee "$logs/github.txt"
status pending "running $base, GitHub run $run"

start=$SECONDS
# At most eight hours; a run that has not finished by then counts as no result. A failed status
# call counts as not finished yet.
state=unknown
conclusion=none
while [ $((SECONDS - start)) -lt 28800 ]; do
  sleep 60
  line="$(gh run view "$run" --repo "$REPO_SLUG" --json status,conclusion \
    --jq '"\(.status) \(.conclusion // "none")"' 2> /dev/null || true)"
  read -r state conclusion <<< "${line:-unknown none}" || true
  [ "$state" = completed ] && break
done
took=$(( (SECONDS - start + 30) / 60 ))
if [ "$conclusion" = success ]; then
  status success "passed $base in $took min, GitHub run $run"
  echo "PASSED in $took min: $url" | tee -a "$logs/github.txt"
  exit 0
fi
# A run that was cancelled, timed out or never finished says nothing about the code: an error,
# which merge.sh treats as no result (it runs the CI again), not as a failure of this tree.
if [ "$state" != completed ] || [ "$conclusion" = cancelled ] || [ "$conclusion" = timed_out ] \
    || [ "$conclusion" = startup_failure ]; then
  status error "no result for $base: GitHub run $run ($state, $conclusion)"
  echo "NO RESULT ($state, $conclusion) after $took min; $url" | tee -a "$logs/github.txt"
  exit 1
fi
failed="$(gh run view "$run" --repo "$REPO_SLUG" --json jobs \
  --jq '[.jobs[] | select(.conclusion == "failure") | .name] | join(", ")' 2> /dev/null || true)"
status failure "failed $base: GitHub run $run ${failed:-$conclusion}"
echo "FAILED ($conclusion) after $took min: ${failed:-}; $url" | tee -a "$logs/github.txt"
exit 1
}

main "$@"
