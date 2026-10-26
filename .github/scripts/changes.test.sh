#!/usr/bin/env bash
# Tests changes.sh: which flags a set of changed paths turns on, from a path list and from the
# diff between two commits of a scratch repository (deletions and renames).
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/changes.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

flags() {
  cut -d= -f2 | tr '\n' ' ' | sed 's/ $//'
}

check() {
  local label=$1 got=$2 want=$3
  if [ "$got" != "$want" ]; then
    echo "FAIL: $label gave '$got', expected '$want'"
    failures=$((failures + 1))
  fi
}

# expect "<want>" path... ; want is "<server> <ui> <e2e> <audit> <workflows> <docs_only> <docker>"
expect() {
  local want=$1 got
  shift
  got=$( (for p in "$@"; do printf '%s\0' "$p"; done) | "$script" 2> /dev/null | flags)
  check "$*" "$got" "$want"
}

#      server ui e2e audit workflows docs_only docker   paths
expect "false false false false false true false"         docs/ARCHITECTURE.md
expect "false false false false false true false"         README.md docs/screenshots/start.png
expect "false false false false false true false"         LICENSE
expect "false false false false false true false"         "docs/a file with spaces.md"
expect "true false true true false false true"            server/src/main.rs
expect "true false true true false false true"            server/migrations/sqlite/0001_init.sql
expect "true false true true false false true"            Cargo.lock
expect "true false true true false false true"            release/src/main.rs
expect "true false true true false false true"            rust-toolchain
expect "true false true true false false true"            rust-toolchain.toml
expect "true false true true false false true"            .cargo/config.toml
expect "true false true true false false true"            rustfmt.toml docs/PLAN.md
expect "true true true true false false true"             server/src/analysis/conformance.json
expect "true true true true false false true"             server/src/analysis/engine.rs
expect "false true true false false false true"           ui/src/app.tsx
expect "false true true false false false true"           ui/e2e/viewer.spec.ts
expect "false true true true false false true"            ui/package.json
expect "false true true true false false true"            ui/package-lock.json
expect "true true true true false false true"             ui/src/api/generated/shapes.ts
expect "true true true true false false true"             docs/api/datasources.md
expect "false true true false false false true"           docs/glossary.md
expect "true true true true false false true"             docs/glossary.md server/src/lib.rs
expect "true true true true true false true"              .github/workflows/ci.yml
expect "true true true true true false true"              .github/dependabot.yml docs/PLAN.md
expect "false false false false false false true"         Dockerfile
expect "false false false false false false true"         .dockerignore
expect "false false false false false false true"         deploy/docker/compose.sqlite.yaml
expect "false false false false false false true"         deploy/docker/example.env docs/guide/installation.md
expect "true true true true false false true"             .gitattributes
expect "true true true true false false true"

# From commits: a deletion and a move out of server/ into docs/ both count as server changes.
repo="$work/repo"
git init -q "$repo"
git -C "$repo" config user.name test
git -C "$repo" config user.email test@example.invalid
git -C "$repo" config core.autocrlf false
git -C "$repo" commit -q --allow-empty -m base
mkdir -p "$repo/server/src" "$repo/docs"
printf 'fn main() {}\n' > "$repo/server/src/main.rs"
printf 'notes\n' > "$repo/server/src/notes.txt"
printf 'plan\n' > "$repo/docs/PLAN.md"
git -C "$repo" add -A
git -C "$repo" commit -q -m files
git -C "$repo" rm -q server/src/main.rs
git -C "$repo" commit -q -m deletion
git -C "$repo" mv server/src/notes.txt docs/notes.txt
git -C "$repo" commit -q -m rename
printf 'more\n' >> "$repo/docs/PLAN.md"
git -C "$repo" commit -q -am docs

run() { (cd "$repo" && "$script" "$@" 2> /dev/null | flags); }
check "deletion" "$(run HEAD~3 HEAD~2)" "true false true true false false true"
check "rename" "$(run HEAD~2 HEAD~1)" "true false true true false false true"
check "docs commit" "$(run HEAD~1 HEAD)" "false false false false false true false"
if (cd "$repo" && "$script" HEAD~1 no-such-commit > /dev/null 2>&1); then
  echo "FAIL: a failing git diff did not fail the script"
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
