#!/usr/bin/env bash
# Tests changes.sh: which flags a set of changed paths turns on, from a path list and from the
# diff between two commits of a scratch repository (deletions and renames).
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/changes.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

flags() {
  # The devgen flags have checks of their own (expect_flag), so the columns below stay as they are.
  grep -v '^devgen' | cut -d= -f2 | tr '\n' ' ' | sed 's/ $//'
}

# expect_flag <flag> "<true|false>" path...
expect_flag() {
  local flag=$1 want=$2 got
  shift 2
  got=$( (for p in "$@"; do printf '%s\0' "$p"; done) | "$script" 2> /dev/null | sed -n "s/^$flag=//p")
  check "$flag: $*" "$got" "$want"
}

check() {
  local label=$1 got=$2 want=$3
  if [ "$got" != "$want" ]; then
    echo "FAIL: $label gave '$got', expected '$want'"
    failures=$((failures + 1))
  fi
}

# expect "<want>" path... ; want is "<server> <ui> <e2e> <audit> <workflows> <docs_only> <docker> <installer>"
expect() {
  local want=$1 got
  shift
  got=$( (for p in "$@"; do printf '%s\0' "$p"; done) | "$script" 2> /dev/null | flags)
  check "$*" "$got" "$want"
}

#      server ui e2e audit workflows docs_only docker installer   paths
expect "false false false false false true false false"   docs/ARCHITECTURE.md
expect "false false false false false true false false"   README.md docs/screenshots/start.png
expect "false false false false false true false false"   LICENSE
expect "false false false false false true false false"   "docs/a file with spaces.md"
expect "true false true true false false true true"       server/src/main.rs
expect "true false true true false false true true"       server/migrations/sqlite/0001_init.sql
expect "true false true true false false true true"       Cargo.lock
expect "true false true true false false true true"       release/src/main.rs
expect "true false true true false false true true"       plugin-api/src/panel.rs
expect "true false true true false false true true"       plugin-sdk/src/lib.rs
expect "true false true true false false true true"       plugin-tool/src/main.rs
expect "true false true true false false true true"       examples/plugins/panel-kpi/panel.js
expect "true false true true false false true true"       rust-toolchain
expect "true false true true false false true true"       rust-toolchain.toml
expect "true false true true false false true true"       .cargo/config.toml
expect "true false true true false false true true"       rustfmt.toml docs/PLAN.md
expect "true true true true false false true true"        server/src/analysis/conformance.json
expect "true true true true false false true true"        server/src/analysis/engine.rs
expect "false true true false false false true false"     ui/src/app.tsx
expect "false true true false false false true false"     ui/e2e/viewer.spec.ts
expect "false true true true false false true false"      ui/package.json
expect "false true true true false false true false"      ui/package-lock.json
expect "true true true true false false true true"        ui/src/api/generated/shapes.ts
expect "true true true true false false true true"        docs/api/datasources.md
expect "false true true false false false true false"     docs/glossary.md
expect "true true true true false false true true"        docs/glossary.md server/src/lib.rs
expect "true true true true true false true true"         .github/workflows/ci.yml
expect "true true true true true false true true"         .github/dependabot.yml docs/PLAN.md
expect "false false false false false false true false"   Dockerfile
expect "false false false false false false false true"   packaging/windows/Kalzit.wxs
expect "false false false false false false false true"   packaging/windows/build.ps1 docs/guide/installation.md
expect "false false false false false false true false"   .dockerignore
expect "false false false false false false true false"   deploy/docker/compose.sqlite.yaml
expect "false false false false false false true false"   deploy/docker/example.env docs/guide/installation.md
expect "true true true true false false true true"        .gitattributes
expect "true true true true false false true true"
# The developer generators run their own job only; the product checks stay off.
expect "false false false false false false false false"  tools/devgen/src/cli.ts
expect "false false false false false false false false"  .mcp.json
expect "false false false false false false false false"  tools/devgen/README.md docs/PLAN.md

expect_flag devgen true   tools/devgen/src/cli.ts
expect_flag devgen true   .mcp.json
expect_flag devgen true   .github/workflows/ci.yml
expect_flag devgen true
expect_flag devgen false  server/src/main.rs ui/src/app.tsx docs/PLAN.md

# The scaffolds' proof: only for what they write into or read from, and for their own code.
expect_flag devgen_proof true   server/src/routes/usage.rs
expect_flag devgen_proof true   server/src/settings.rs
expect_flag devgen_proof true   ui/src/i18n/de/admin.json
expect_flag devgen_proof true   ui/src/features/settings/sections.ts
expect_flag devgen_proof true   tools/devgen/src/lib/routeScaffold.ts
expect_flag devgen_proof true   .github/workflows/ci.yml
expect_flag devgen_proof false  tools/devgen/README.md tools/devgen/test/rules.test.ts .mcp.json
expect_flag devgen_proof false  server/src/main.rs ui/src/app.tsx

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
check "deletion" "$(run HEAD~3 HEAD~2)" "true false true true false false true true"
check "rename" "$(run HEAD~2 HEAD~1)" "true false true true false false true true"
check "docs commit" "$(run HEAD~1 HEAD)" "false false false false false true false false"
if (cd "$repo" && "$script" HEAD~1 no-such-commit > /dev/null 2>&1); then
  echo "FAIL: a failing git diff did not fail the script"
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
