#!/usr/bin/env bash
# Squash-merges pull requests whose local CI passed on the current main, and deletes their
# branches.
#
#   merge.sh PR            one pull request
#   merge.sh PR PR...      a batch, tested together by `run.sh PR PR...` in this order
#
# The statuses local/linux and local/windows must be green on every head and name what the run
# tested: the current main, and for a batch the batch and the fingerprint of exactly these heads
# (`passed on main <main> batch 391,388 run <fp> in N min`, see run.sh). If they name an older
# main, another batch or other heads, are still pending from a run that stopped, or have not run,
# the CI runs first (run.sh with the same arguments), as the merge queue tested on top of the
# latest main. A failure of this same run shape on the current main stops here.
#
# The merges name the head commits that were checked, so a push made in between is refused. A
# batch merges in its order: before each merge after the first, main must be exactly the commit
# the merge before it made, and after each merge the new commit's parent must be the main it was
# meant to land on, so nothing else lands between the pull requests that were tested together.
# GitHub enforces the two statuses as well (branch protection).

set -euo pipefail

REPO_SLUG=MouseWerk/Kalzit
[ $# -ge 1 ] || { echo "usage: merge.sh PR [PR...]" >&2; exit 2; }
prs=()
for n in "$@"; do
  case " ${prs[*]-} " in *" $n "*) echo "PR $n is named twice" >&2; exit 2 ;; esac
  prs+=("$n")
done
[ ${#prs[@]} -le 8 ] || { echo "at most 8 pull requests in a batch" >&2; exit 2; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

batch=""
if [ ${#prs[@]} -gt 1 ]; then batch="$(IFS=,; echo "${prs[*]}")"; fi

heads=()
main=""

# 0: all passed on the current main (as this batch with these heads); 1: run the CI (again);
# 2: this same run shape failed on the current main.
check() {
  git fetch --quiet origin main
  main="$(git rev-parse --short=9 origin/main)"
  heads=()
  local n
  for n in "${prs[@]}"; do
    heads+=("$(gh pr view "$n" --repo "$REPO_SLUG" --json headRefOid --jq .headRefOid)")
  done
  local base="on main $main"
  if [ -n "$batch" ]; then
    base="$base batch $batch run $(printf '%s ' "${heads[@]}" | sha1sum | cut -c1-7)"
  fi
  local verdict=0 i context line
  for i in "${!prs[@]}"; do
    for context in local/linux local/windows; do
      line="$(gh api "repos/$REPO_SLUG/commits/${heads[$i]}/status" \
        --jq ".statuses[] | select(.context == \"$context\") | \"\(.state) \(.description)\"" | head -1)"
      case "$line" in
        "success passed $base in "*) ;;
        "failure failed $base:"*) echo "PR ${prs[$i]} $context: $line"; verdict=2 ;;
        "") echo "PR ${prs[$i]} $context: no local run yet"; [ "$verdict" -eq 2 ] || verdict=1 ;;
        *) echo "PR ${prs[$i]} $context: $line (not: passed $base)"; [ "$verdict" -eq 2 ] || verdict=1 ;;
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
expected="$(git rev-parse origin/main)"
if [ "${expected:0:9}" != "$tested_main" ]; then
  echo "main moved while checking; run merge.sh ${prs[*]} again." >&2
  exit 1
fi

# Through the API, so a local branch or worktree of a PR stays untouched (remove it yourself).
# `sha` makes GitHub refuse a merge if the head moved after the check.
stop() {
  local i=$1 why=$2
  echo "$why" >&2
  if [ "$i" -gt 0 ]; then
    echo "Merged: ${prs[*]:0:$i}. Not merged: ${prs[*]:$i}; run merge.sh ${prs[*]:$i} for them (it runs the CI on the new main first)." >&2
  fi
  exit 1
}
for i in "${!prs[@]}"; do
  n=${prs[$i]}
  if [ "$i" -gt 0 ]; then
    git fetch --quiet origin main
    [ "$(git rev-parse origin/main)" = "$expected" ] || stop "$i" "main moved during the batch (expected ${expected:0:9})."
  fi
  title="$(gh pr view "$n" --repo "$REPO_SLUG" --json title --jq .title)"
  branch="$(gh pr view "$n" --repo "$REPO_SLUG" --json headRefName --jq .headRefName)"
  made="$(gh api -X PUT "repos/$REPO_SLUG/pulls/$n/merge" -f merge_method=squash \
    -f commit_title="$title (#$n)" -f sha="${heads[$i]}" --jq .sha)" \
    || stop "$i" "GitHub refused to merge PR $n."
  # The squash commit must sit directly on the main it was checked against.
  parent="$(gh api "repos/$REPO_SLUG/commits/$made" --jq '.parents[0].sha')"
  [ "$parent" = "$expected" ] \
    || stop "$((i + 1))" "PR $n landed on ${parent:0:9}, not on ${expected:0:9}: something else reached main in between. Check main."
  expected=$made
  gh api --silent -X DELETE "repos/$REPO_SLUG/git/refs/heads/$branch" || echo "deleting the branch $branch failed" >&2
  echo "PR $n merged as ${made:0:9} (head ${heads[$i]:0:9}); branch $branch deleted."
done
echo "Tested on main $tested_main${batch:+ as batch $batch}."
