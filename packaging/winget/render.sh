#!/usr/bin/env bash
# Fills in the winget manifest templates of this folder for one release and writes them in the
# layout of the winget-pkgs repository: <out>/manifests/m/MouseWerk/Kalzit/<version>/.
# The release workflow (job `publish`) runs it with the published MSI; submitting the result to
# microsoft/winget-pkgs is a manual step (docs/operations/winget.md).
#
#   render.sh <version> <msi-url> <msi-sha256> <release-date YYYY-MM-DD> <out-dir>
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: $0 <version> <msi-url> <msi-sha256> <release-date> <out-dir>" >&2
  exit 2
fi
version="$1" url="$2" sha="$3" date="$4" out="$5"

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a stable version: $version" >&2; exit 1; }
[[ "$url" =~ ^https://[A-Za-z0-9./_~-]+\.msi$ ]] || { echo "not an https address of an MSI: $url" >&2; exit 1; }
[[ "$sha" =~ ^[0-9A-Fa-f]{64}$ ]] || { echo "not a SHA-256: $sha" >&2; exit 1; }
[[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "not a date: $date" >&2; exit 1; }

here="$(cd "$(dirname "$0")" && pwd)"
dir="$out/manifests/m/MouseWerk/Kalzit/$version"
mkdir -p "$dir"
notes="https://github.com/MouseWerk/Kalzit/releases/tag/v$version"
for name in MouseWerk.Kalzit.yaml MouseWerk.Kalzit.installer.yaml MouseWerk.Kalzit.locale.en-US.yaml; do
  # winget-pkgs keeps hashes in upper case; the values were checked above, so none holds a `|`.
  sed -e "s|{{VERSION}}|$version|g" \
    -e "s|{{MSI_URL}}|$url|g" \
    -e "s|{{MSI_SHA256}}|${sha^^}|g" \
    -e "s|{{RELEASE_DATE}}|$date|g" \
    -e "s|{{RELEASE_NOTES_URL}}|$notes|g" \
    -e '/^# Template;/d' \
    "$here/$name" > "$dir/$name"
  if grep -q '{{' "$dir/$name"; then
    echo "$dir/$name still has a placeholder" >&2
    exit 1
  fi
done
echo "$dir"
