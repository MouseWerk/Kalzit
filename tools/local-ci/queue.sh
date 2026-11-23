#!/usr/bin/env bash
# The local side of the queue: while this machine is on, it works the pull requests labelled
# `queue` with the same rules as the night queue on GitHub (.github/workflows/night-queue.yml),
# so both can run side by side without testing the same pull request twice.
#
#   queue.sh           batches until the queue is empty (or everything left is being tested)
#   queue.sh --once    one batch
#
# Each round takes up to four queued pull requests (oldest first; one alone when it carries
# `queue-single`) that neither side is testing (`queue-running`), marks them `queue-running`,
# and runs merge.sh on them: it merges content that already passed (locally or on GitHub) and
# runs the local CI first otherwise. A failed batch puts its pull requests on `queue-single`; a
# pull request that fails alone gets `queue-failed` and leaves the queue, as does one that
# conflicts with main (`queue-conflict`).

set -euo pipefail

main() {
REPO_SLUG=MouseWerk/Kalzit
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
once=false
[ "${1:-}" = --once ] && once=true

while :; do
  queued="$(gh pr list --repo "$REPO_SLUG" --state open --label queue --limit 100 \
    --json number,isDraft,labels \
    --jq '[.[] | select(.isDraft | not) | select([.labels[].name] | index("queue-running") | not)] | sort_by(.number)')"
  single="$(jq -r '[.[] | select([.labels[].name] | index("queue-single"))][0].number // empty' <<< "$queued")"
  if [ -n "$single" ]; then
    read -ra prs <<< "$single"
  else
    read -ra prs <<< "$(jq -r '.[:4][].number' <<< "$queued" | tr '\n' ' ')"
  fi
  if [ ${#prs[@]} -eq 0 ]; then
    echo "Nothing queued that is free to test."
    return 0
  fi
  echo "[$(date '+%H:%M')] queue: PR ${prs[*]}"
  for n in "${prs[@]}"; do gh pr edit "$n" --repo "$REPO_SLUG" --add-label queue-running > /dev/null; done
  status=0
  bash "$here/merge.sh" "${prs[@]}" || status=$?
  for n in "${prs[@]}"; do gh pr edit "$n" --repo "$REPO_SLUG" --remove-label queue-running > /dev/null 2>&1 || true; done
  case "$status" in
    0) echo "merged PR ${prs[*]}" ;;
    3)
      # A conflict: take the batch apart, so the ones that merge go on without the one that does not.
      if [ ${#prs[@]} -gt 1 ]; then
        for n in "${prs[@]}"; do gh pr edit "$n" --repo "$REPO_SLUG" --add-label queue-single > /dev/null || true; done
      else
        gh pr edit "${prs[0]}" --repo "$REPO_SLUG" --remove-label queue --remove-label queue-single --add-label queue-conflict > /dev/null || true
        gh pr comment "${prs[0]}" --repo "$REPO_SLUG" --body "Local queue: this pull request does not merge cleanly onto main. Merge main into it and add the label \`queue\` again." > /dev/null || true
      fi
      ;;
    4)
      if [ ${#prs[@]} -gt 1 ]; then
        for n in "${prs[@]}"; do gh pr edit "$n" --repo "$REPO_SLUG" --add-label queue-single > /dev/null || true; done
      else
        gh pr edit "${prs[0]}" --repo "$REPO_SLUG" --remove-label queue --remove-label queue-single --add-label queue-failed > /dev/null || true
        gh pr comment "${prs[0]}" --repo "$REPO_SLUG" --body "Local queue: the CI failed for this pull request on main (logs in C:/Users/klein/kz-ci/logs). It left the queue; fix it and add the label \`queue\` again." > /dev/null || true
      fi
      ;;
    *) echo "PR ${prs[*]}: not merged (exit $status); they stay queued." ;;
  esac
  [ "$once" = true ] && return 0
done
}

main "$@"
