#!/usr/bin/env bash
# Starts the Linux leg inside WSL (called by run.sh as the user `ci`): brings the Linux checkout to the
# commit under test, fetched from the Windows repository as refs/local-ci/tested, and runs
# linux.sh there. A file of its own, since wsl.exe mangles the quotes of an inline script.
#
#   wsl-leg.sh REPO LOGS LOCK RUNNER    (all four as /mnt/... paths; RUNNER holds linux.sh)

set -euo pipefail
# WSL starts in the caller's Windows folder, which may be a worktree whose .git file points to
# a Windows path that git in WSL cannot follow.
cd /
REPO=$1
export LOGS=$2 KALZIT_CI_LOCK=$3
RUNNER=$4

src=$HOME/kz-ci/src
if [ ! -d "$src/.git" ]; then
  mkdir -p "$src"
  git -C "$src" init --quiet
fi
git config --global --get-all safe.directory | grep -qxF "$REPO" \
  || git config --global --add safe.directory "$REPO"
git -C "$src" fetch --quiet --no-tags "$REPO" "+refs/local-ci/tested:refs/local-ci/tested"
git -C "$src" checkout --quiet -f --detach refs/local-ci/tested
git -C "$src" clean -ffdxq

AREAS="$(cat "$LOGS/areas.txt")"
export AREAS SRC="$src" CARGO_TARGET_DIR=$HOME/kz-target/ci KALZIT_CI_CACHE=$HOME/kz-ci/cache
exec bash "$RUNNER/linux.sh"
