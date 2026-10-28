#!/usr/bin/env bash
# Decides which CI areas a change touches and prints the flags as key=value lines for
# $GITHUB_OUTPUT:
#
#   server     Rust code (the server, the release crate, the plugin API, SDK, tool and examples),
#              manifests, toolchain and lint settings
#   ui         the UI, including the e2e tests in ui/e2e
#   e2e        server or ui
#   audit      server, or the UI's dependency manifests
#   workflows  anything under .github/ (then every other flag is true as well)
#   docs_only  only documentation changed (docs/, Markdown files, LICENSE)
#   docker     the container image: server or ui, the Dockerfile, .dockerignore or deploy/
#
# changes.sh BASE HEAD   compares two commits (renames count as a deletion and an addition, so
#                        the old path counts too)
# changes.sh             reads NUL-separated paths, relative to the repository root, on stdin
#
# A path that fits no known area turns every flag on, so a new top-level file or folder runs
# the full check until this script learns about it. No paths at all also runs everything.
# The changed paths are listed on stderr.
set -euo pipefail

server=false
ui=false
audit=false
workflows=false
docs=false
image=false
unknown=false
count=0

classify() {
  local path=$1
  case "$path" in
    .github/*)
      workflows=true ;;
    # The UI's conformance test runs server/src/analysis/conformance.json, which the Rust
    # engine there must also pass.
    server/src/analysis/*)
      server=true
      ui=true ;;
    server/* | release/* | plugin-api/* | plugin-sdk/* | plugin-tool/* | examples/* | Cargo.toml | Cargo.lock | rust-toolchain | rust-toolchain.toml | clippy.toml \
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
    Dockerfile | .dockerignore | deploy/*)
      image=true ;;
    docs/* | *.md | LICENSE)
      docs=true ;;
    *)
      unknown=true ;;
  esac
}

paths() {
  if [ $# -eq 2 ]; then
    git diff --no-renames --name-only -z "$1" "$2"
  else
    cat
  fi
}

while IFS= read -r -d '' path; do
  [ -n "$path" ] || continue
  count=$((count + 1))
  echo "  $path" >&2
  classify "$path"
done < <(paths "$@")
# A failed git diff must not look like "no changes"; wait reports the substitution's status.
wait $! || exit 1

if [ "$workflows" = true ] || [ "$unknown" = true ] || [ "$count" -eq 0 ]; then
  server=true
  ui=true
fi
[ "$server" = true ] && audit=true
e2e=false
if [ "$server" = true ] || [ "$ui" = true ]; then e2e=true; fi
docker=false
if [ "$e2e" = true ] || [ "$image" = true ]; then docker=true; fi
docs_only=false
if [ "$docs" = true ] && [ "$server" = false ] && [ "$ui" = false ] && [ "$audit" = false ] \
  && [ "$image" = false ]; then
  docs_only=true
fi

echo "server=$server"
echo "ui=$ui"
echo "e2e=$e2e"
echo "audit=$audit"
echo "workflows=$workflows"
echo "docs_only=$docs_only"
echo "docker=$docker"
