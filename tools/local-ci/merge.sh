#!/usr/bin/env bash
# Squash-merges a pull request whose local CI passed on the current main, and deletes its branch.
#
#   merge.sh PR
#
# Both statuses, local/linux and local/windows, must be green on the PR's head commit and name
# the main commit they ran on; if main has moved since, the run is repeated first (run.sh PR),
# as the merge queue tested each pull request on top of the latest main. GitHub enforces the two
# statuses as well (branch protection of main).

set -euo pipefail

REPO_SLUG=MouseWerk/Kalzit
pr=${1:?usage: merge.sh PR}
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

check() {
  git fetch --quiet origin main
  local main head
  main="$(git rev-parse --short=9 origin/main)"
  head="$(gh pr view "$pr" --repo "$REPO_SLUG" --json headRefOid --jq .headRefOid)"
  local ok=true
  for context in local/linux local/windows; do
    local line
    line="$(gh api "repos/$REPO_SLUG/commits/$head/status" \
      --jq ".statuses[] | select(.context == \"$context\") | \"\(.state) \(.description)\"" | head -1)"
    case "$line" in
      "success passed on main $main"*) ;;
      success*) echo "$context passed on an older main: $line"; ok=false ;;
      "") echo "$context: no local run yet"; ok=false ;;
      *) echo "$context: $line"; return 2 ;;
    esac
  done
  [ "$ok" = true ]
}

status=0
check || status=$?
if [ "$status" -eq 2 ]; then
  echo "The local CI failed; not merging." >&2
  exit 1
fi
if [ "$status" -ne 0 ]; then
  echo "Running the local CI on the current main first."
  "$here/run.sh" "$pr"
  check
fi
# Through the API, so a local branch or worktree of the PR stays untouched (remove it yourself).
# The squash commit's subject is the PR title with its number, as before.
title="$(gh pr view "$pr" --repo "$REPO_SLUG" --json title --jq .title)"
branch="$(gh pr view "$pr" --repo "$REPO_SLUG" --json headRefName --jq .headRefName)"
gh api --silent -X PUT "repos/$REPO_SLUG/pulls/$pr/merge" -f merge_method=squash \
  -f commit_title="$title (#$pr)" -f sha="$(gh pr view "$pr" --repo "$REPO_SLUG" --json headRefOid --jq .headRefOid)"
gh api --silent -X DELETE "repos/$REPO_SLUG/git/refs/heads/$branch" || echo "deleting the branch $branch failed" >&2
echo "PR $pr merged; branch $branch deleted."
