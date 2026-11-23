#!/usr/bin/env bash
# Squash-merges pull requests whose CI passed for exactly the content they would merge to, and
# deletes their branches.
#
#   merge.sh PR            one pull request
#   merge.sh PR PR...      a batch, merged in this order
#
# Exit codes: 0 merged; 3 a pull request does not merge cleanly; 4 the CI failed (or did not
# pass) for exactly this content; 1 anything else (main moved, GitHub refused, ...).
#
# It computes the tree that merging the heads onto the current main would make (git merge-tree,
# one pull request after another) and looks for a pass of exactly that tree on every head, from
# the local CI (run.sh) or a GitHub run (gh-run.sh): `passed tree <tree> ...`. So a result stays
# good when main moved in a way that leaves the merged content the same, for example a batch
# tested ahead on top of another that has merged since, and covers nothing else. Without such a
# pass, the local CI runs first (run.sh with the same arguments); a failure of that tree stops.
#
# The merges name the head commits that were checked, so a push made in between is refused.
# Before each merge after the first, main must be exactly the commit the merge before it made;
# after each merge, the squash commit must sit on the main it was checked against and hold the
# tree that was predicted for it. GitHub enforces the two statuses as well (branch protection).

set -euo pipefail

# The whole script is one function, called on the last line: bash reads all of it before it
# runs any of it, so an edit to this file during a run cannot change the running copy.
main() {

REPO_SLUG=MouseWerk/Kalzit
[ $# -ge 1 ] || { echo "usage: merge.sh PR [PR...]" >&2; exit 2; }
prs=()
for n in "$@"; do
  case " ${prs[*]-} " in *" $n "*) echo "PR $n is named twice" >&2; exit 2 ;; esac
  prs+=("$n")
done
[ ${#prs[@]} -le 8 ] || { echo "at most 8 pull requests in a batch" >&2; exit 2; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

heads=()
steps=()     # the predicted tree after each merge
main=""
tree=""

# Predicts the trees of merging the heads onto the current main, one after another. Returns 3
# when a pull request does not merge cleanly.
predict() {
  git fetch --quiet origin main
  main="$(git rev-parse origin/main)"
  heads=()
  steps=()
  local n cur="$main" step
  for n in "${prs[@]}"; do
    git fetch --quiet origin "+refs/pull/$n/head:refs/local-ci/pr-$n"
    heads+=("$(git rev-parse "refs/local-ci/pr-$n")")
  done
  local i
  for i in "${!prs[@]}"; do
    if ! step="$(git merge-tree --write-tree --no-messages "$cur" "${heads[$i]}")"; then
      echo "PR ${prs[$i]} does not merge cleanly onto main ${main:0:9}$([ "$i" -gt 0 ] && echo " after the PRs before it")." >&2
      return 3
    fi
    steps+=("$step")
    # One parent, as GitHub's squash commit has: the next merge then finds the same merge base.
    cur="$(git commit-tree "$step" -p "$cur" -m "predicted squash of PR ${prs[$i]}")"
  done
  tree=${steps[-1]}
}

# 0: every head has a pass of the predicted tree; 1: run the CI; 2: that tree failed.
check() {
  local verdict=0 i context line
  for i in "${!prs[@]}"; do
    for context in local/linux local/windows; do
      line="$(gh api "repos/$REPO_SLUG/commits/${heads[$i]}/status" \
        --jq ".statuses[] | select(.context == \"$context\") | \"\(.state) \(.description)\"" | head -1)"
      case "$line" in
        "success passed tree ${tree:0:12} "*) ;;
        "failure failed tree ${tree:0:12} "*) echo "PR ${prs[$i]} $context: $line"; verdict=2 ;;
        "") echo "PR ${prs[$i]} $context: no run yet"; [ "$verdict" -eq 2 ] || verdict=1 ;;
        *) echo "PR ${prs[$i]} $context: $line (not tree ${tree:0:12})"; [ "$verdict" -eq 2 ] || verdict=1 ;;
      esac
    done
  done
  return "$verdict"
}

predict || exit 3
verdict=0
check || verdict=$?
if [ "$verdict" -eq 2 ]; then
  echo "The CI failed for exactly this content; not merging." >&2
  exit 4
fi
if [ "$verdict" -eq 1 ] && [ "${MERGE_NO_LOCAL_RUN:-0}" = 1 ]; then
  # The night queue on GitHub: no local CI there; it tests and then merges only what passed.
  echo "No pass for tree ${tree:0:12}; not merging (MERGE_NO_LOCAL_RUN)." >&2
  exit 4
fi
if [ "$verdict" -eq 1 ]; then
  echo "No pass for tree ${tree:0:12} yet; running the local CI first."
  "$here/run.sh" "${prs[@]}" || true
  predict || exit 3
  verdict=0
  check || verdict=$?
  [ "$verdict" -eq 0 ] || { echo "The CI did not pass for this content; not merging." >&2; exit 4; }
fi

git fetch --quiet origin main
expected="$(git rev-parse origin/main)"
if [ "$expected" != "$main" ]; then
  echo "main moved while checking; run merge.sh ${prs[*]} again." >&2
  exit 1
fi

# Through the API, so a local branch or worktree of a PR stays untouched (remove it yourself).
# `sha` makes GitHub refuse a merge if the head moved after the check.
stop() {
  local i=$1 why=$2
  echo "$why" >&2
  if [ "$i" -gt 0 ]; then
    echo "Merged: ${prs[*]:0:$i}. Not merged: ${prs[*]:$i}; run merge.sh ${prs[*]:$i} for them." >&2
    echo "main now holds a tree that was tested only as part of the batch, not on its own: run the CI on main (run.sh --ref origin/main --full) before anything else merges." >&2
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
  # The squash commit must sit directly on the main it was checked against and hold the tree
  # that was predicted (and tested) for it.
  read -r parent made_tree < <(gh api "repos/$REPO_SLUG/commits/$made" --jq '"\(.parents[0].sha) \(.commit.tree.sha)"')
  [ "$parent" = "$expected" ] \
    || stop "$((i + 1))" "PR $n landed on ${parent:0:9}, not on ${expected:0:9}: something else reached main in between. Check main."
  [ "$made_tree" = "${steps[$i]}" ] \
    || stop "$((i + 1))" "PR $n merged to tree ${made_tree:0:12}, not the predicted ${steps[$i]:0:12}. Check main."
  expected=$made
  gh api --silent -X DELETE "repos/$REPO_SLUG/git/refs/heads/$branch" || echo "deleting the branch $branch failed" >&2
  echo "PR $n merged as ${made:0:9} (head ${heads[$i]:0:9}); branch $branch deleted."
done
echo "Merged tree ${tree:0:12}, tested as such."
}

main "$@"
