#!/usr/bin/env bash
# Decides which CI areas a change touches. Reads the changed paths (one per line, relative to
# the repository root) on stdin and prints the flags as key=value lines for $GITHUB_OUTPUT:
#
#   server     Rust code, manifests, toolchain and lint settings
#   ui         the UI, including the e2e tests in ui/e2e
#   e2e        server or ui
#   audit      server, or the UI's dependency manifests
#   workflows  anything under .github/ (then every other flag is true as well)
#   docs_only  only documentation changed (docs/, Markdown files, LICENSE)
#
# A path that fits no known area turns every flag on, so a new top-level file or folder runs
# the full check until this script learns about it. No input at all also runs everything.
set -euo pipefail

server=false
ui=false
audit=false
workflows=false
docs=false
unknown=false
count=0

while IFS= read -r path || [ -n "$path" ]; do
  path=${path%$'\r'}
  [ -n "$path" ] || continue
  count=$((count + 1))
  case "$path" in
    .github/*)
      workflows=true ;;
    server/* | Cargo.toml | Cargo.lock | rust-toolchain | rust-toolchain.toml | clippy.toml \
      | .clippy.toml | rustfmt.toml | .rustfmt.toml | .cargo/*)
      server=true ;;
    # The server's tests compare the generated TypeScript types with the Rust shapes.
    ui/src/api/generated/*)
      server=true
      ui=true ;;
    ui/package.json | ui/package-lock.json)
      ui=true
      audit=true ;;
    ui/*)
      ui=true ;;
    # Server and UI tests check the reason codes in docs/api/datasources.md, the UI's i18n test
    # reads the glossary.
    docs/api/*)
      server=true
      ui=true ;;
    docs/glossary.md)
      ui=true ;;
    docs/* | *.md | LICENSE)
      docs=true ;;
    *)
      unknown=true ;;
  esac
done

if [ "$workflows" = true ] || [ "$unknown" = true ] || [ "$count" -eq 0 ]; then
  server=true
  ui=true
fi
[ "$server" = true ] && audit=true
e2e=false
if [ "$server" = true ] || [ "$ui" = true ]; then e2e=true; fi
docs_only=false
if [ "$docs" = true ] && [ "$server" = false ] && [ "$ui" = false ] && [ "$audit" = false ]; then
  docs_only=true
fi

echo "server=$server"
echo "ui=$ui"
echo "e2e=$e2e"
echo "audit=$audit"
echo "workflows=$workflows"
echo "docs_only=$docs_only"
