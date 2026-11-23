#!/usr/bin/env bash
# Squash-merges a pull request whose local CI passed on the current main, and deletes its branch.
#
#   merge.sh PR
#
# Both statuses, local/linux and local/windows, must be green on the PR's head commit and name
# the main commit they ran on. If they ran on an older main, are still pending from a run that
# stopped, or have not run, the CI runs first (run.sh PR), as the merge queue tested each pull
# request on top of the latest main. A failure on the current main stops here. The merge names
# the head commit that was checked, so a push made in between is refused, and main is checked
# once more right before it. GitHub enforces the two statuses as well (branch protection).

set -euo pipefail

REPO_SLUG=MouseWerk/Kalzit
pr=${1:?usage: merge.sh PR}
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

head=""
main=""

# 0: both passed on the current main; 1: run the CI (again); 2: failed on the current main.
check() {
  git fetch --quiet origin main
  main="$(git rev-parse --short=9 origin/main)"
  head="$(gh pr view "$pr" --repo "$REPO_SLUG" --json headRefOid --jq .headRefOid)"
  local verdict=0
  for context in local/linux local/windows; do
    local line
    line="$(gh api "repos/$REPO_SLUG/commits/$head/status" \
      --jq ".statuses[] | select(.context == \"$context\") | \"\(.state) \(.description)\"" | head -1)"
    case "$line" in
      "success passed on main $main "*) ;;
      "failure "*"on main $main") echo "$context: $line"; verdict=2 ;;
      "") echo "$context: no local run yet"; [ "$verdict" -eq 2 ] || verdict=1 ;;
      *) echo "$context: $line (not a pass on main $main)"; [ "$verdict" -eq 2 ] || verdict=1 ;;
    esac
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
  "$here/run.sh" "$pr" || true
  verdict=0
  check || verdict=$?
  [ "$verdict" -eq 0 ] || { echo "The local CI did not pass; not merging." >&2; exit 1; }
fi

tested_head=$head
tested_main=$main
git fetch --quiet origin main
if [ "$(git rev-parse --short=9 origin/main)" != "$tested_main" ]; then
  echo "main moved while checking; run merge.sh $pr again." >&2
  exit 1
fi

# Through the API, so a local branch or worktree of the PR stays untouched (remove it yourself).
# `sha` makes GitHub refuse the merge if the head moved after the check.
title="$(gh pr view "$pr" --repo "$REPO_SLUG" --json title --jq .title)"
branch="$(gh pr view "$pr" --repo "$REPO_SLUG" --json headRefName --jq .headRefName)"
gh api --silent -X PUT "repos/$REPO_SLUG/pulls/$pr/merge" -f merge_method=squash \
  -f commit_title="$title (#$pr)" -f sha="$tested_head"
gh api --silent -X DELETE "repos/$REPO_SLUG/git/refs/heads/$branch" || echo "deleting the branch $branch failed" >&2
echo "PR $pr merged (${tested_head:0:9}, tested on main $tested_main); branch $branch deleted."
