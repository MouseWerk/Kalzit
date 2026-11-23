#!/usr/bin/env bash
# Squash-merges pull requests whose local CI passed on the current main, and deletes their
# branches.
#
#   merge.sh PR            one pull request
#   merge.sh PR PR...      a batch, tested together by `run.sh PR PR...` in this order
#
# The statuses local/linux and local/windows must be green on every head and name the main
# commit they ran on (and, for a batch, the batch: `passed on main <main> batch 391,388`). If
# they ran on an older main or another batch, are still pending from a run that stopped, or have
# not run, the CI runs first (run.sh with the same arguments), as the merge queue tested on top
# of the latest main. A failure on the current main stops here.
#
# The merges name the head commits that were checked, so a push made in between is refused. A
# batch merges in its order: before each merge after the first, main must be exactly the commit
# the merge before it made, so nothing else lands between the pull requests that were tested
# together. GitHub enforces the two statuses as well (branch protection).

set -euo pipefail

REPO_SLUG=MouseWerk/Kalzit
[ $# -ge 1 ] || { echo "usage: merge.sh PR [PR...]" >&2; exit 2; }
prs=("$@")
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

batch=""
if [ ${#prs[@]} -gt 1 ]; then batch="$(IFS=,; echo "${prs[*]}")"; fi

heads=()
main=""

# 0: all passed on the current main (as this batch); 1: run the CI (again); 2: failed on it.
check() {
  git fetch --quiet origin main
  main="$(git rev-parse --short=9 origin/main)"
  local want="passed on main $main"
  [ -z "$batch" ] || want="$want batch $batch"
  heads=()
  local verdict=0 n head context line
  for n in "${prs[@]}"; do
    head="$(gh pr view "$n" --repo "$REPO_SLUG" --json headRefOid --jq .headRefOid)"
    heads+=("$head")
    for context in local/linux local/windows; do
      line="$(gh api "repos/$REPO_SLUG/commits/$head/status" \
        --jq ".statuses[] | select(.context == \"$context\") | \"\(.state) \(.description)\"" | head -1)"
      # A failure counts only for the same run shape: this batch, or this PR alone.
      case "$line" in
        "success $want in "*) ;;
        "failure "*"on main $main${batch:+ batch $batch}") echo "PR $n $context: $line"; verdict=2 ;;
        "") echo "PR $n $context: no local run yet"; [ "$verdict" -eq 2 ] || verdict=1 ;;
        *) echo "PR $n $context: $line (not: $want)"; [ "$verdict" -eq 2 ] || verdict=1 ;;
      esac
    done
  done
  return "$verdict"
}

verdict=0
check || verdict=$?
if [ "$verdict" -eq 2 ]; then
  echo "The local CI failed on the current main; not merging." >&2
  exit 1
fi
if [ "$verdict" -eq 1 ]; then
  echo "Running the local CI on the current main first."
  "$here/run.sh" "${prs[@]}" || true
  verdict=0
  check || verdict=$?
  [ "$verdict" -eq 0 ] || { echo "The local CI did not pass; not merging." >&2; exit 1; }
fi

tested_main=$main
git fetch --quiet origin main
if [ "$(git rev-parse --short=9 origin/main)" != "$tested_main" ]; then
  echo "main moved while checking; run merge.sh ${prs[*]} again." >&2
  exit 1
fi

# Through the API, so a local branch or worktree of a PR stays untouched (remove it yourself).
# `sha` makes GitHub refuse a merge if the head moved after the check.
expected="$(git rev-parse origin/main)"
for i in "${!prs[@]}"; do
  n=${prs[$i]}
  if [ "$i" -gt 0 ]; then
    git fetch --quiet origin main
    if [ "$(git rev-parse origin/main)" != "$expected" ]; then
      echo "main moved during the batch (expected ${expected:0:9}); PR ${prs[*]:$i} not merged." >&2
      exit 1
    fi
  fi
  title="$(gh pr view "$n" --repo "$REPO_SLUG" --json title --jq .title)"
  branch="$(gh pr view "$n" --repo "$REPO_SLUG" --json headRefName --jq .headRefName)"
  expected="$(gh api -X PUT "repos/$REPO_SLUG/pulls/$n/merge" -f merge_method=squash \
    -f commit_title="$title (#$n)" -f sha="${heads[$i]}" --jq .sha)"
  gh api --silent -X DELETE "repos/$REPO_SLUG/git/refs/heads/$branch" || echo "deleting the branch $branch failed" >&2
  echo "PR $n merged as ${expected:0:9} (head ${heads[$i]:0:9}); branch $branch deleted."
done
echo "Tested on main $tested_main${batch:+ as batch $batch}."
