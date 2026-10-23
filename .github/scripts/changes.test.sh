#!/usr/bin/env bash
# Tests changes.sh: which flags a set of changed paths turns on.
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/changes.sh"
failures=0

# expect "<paths, one per line>" "<server> <ui> <e2e> <audit> <workflows> <docs_only>"
expect() {
  local paths=$1 want=$2 got
  got=$(printf '%s' "$paths" | "$script" | cut -d= -f2 | tr '\n' ' ')
  got=${got% }
  if [ "$got" != "$want" ]; then
    echo "FAIL: $(printf '%s' "$paths" | tr '\n' ',') gave '$got', expected '$want'"
    failures=$((failures + 1))
  fi
}

#      paths                                              server ui e2e audit workflows docs_only
expect $'docs/ARCHITECTURE.md'                             "false false false false false true"
expect $'README.md\ndocs/screenshots/start.png'            "false false false false false true"
expect $'LICENSE'                                          "false false false false false true"
expect $'server/src/main.rs'                               "true false true true false false"
expect $'Cargo.lock'                                       "true false true true false false"
expect $'rustfmt.toml\ndocs/PLAN.md'                       "true false true true false false"
expect $'ui/src/app.tsx'                                   "false true true false false false"
expect $'ui/e2e/viewer.spec.ts'                            "false true true false false false"
expect $'ui/package-lock.json'                             "false true true true false false"
expect $'ui/src/api/generated/shapes.ts'                   "true true true true false false"
expect $'docs/api/datasources.md'                          "true true true true false false"
expect $'docs/glossary.md'                                 "false true true false false false"
expect $'.github/workflows/ci.yml'                         "true true true true true false"
expect $'.github/dependabot.yml\ndocs/PLAN.md'             "true true true true true false"
expect $'.gitattributes'                                   "true true true true false false"
expect $'docs/PLAN.md\r\nserver/src/lib.rs\r\n'            "true false true true false false"
expect ''                                                  "true true true true false false"

if [ "$failures" -gt 0 ]; then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
