#!/usr/bin/env bash
# Builds the deb and rpm of Kalzit from a built Linux x64 binary (deploy/linux/nfpm.yaml):
#
#   deploy/linux/package.sh VERSION BINARY OUT_DIR
#
# writes OUT_DIR/kalzit-VERSION-linux-x64.deb and OUT_DIR/kalzit-VERSION-linux-x64.rpm. Needs
# nfpm and objdump. The packages require the glibc version the binary was linked against,
# read from its symbol versions, so a system with an older glibc refuses the package instead of
# failing at the start.
set -euo pipefail

version=${1:?usage: package.sh VERSION BINARY OUT_DIR}
binary=${2:?usage: package.sh VERSION BINARY OUT_DIR}
out=${3:?usage: package.sh VERSION BINARY OUT_DIR}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

command -v nfpm > /dev/null || { echo "package.sh: nfpm is not installed" >&2; exit 1; }
glibc=$(objdump -T "$binary" | grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' | sed 's/^GLIBC_//' | sort -uV | tail -n1)
[ -n "$glibc" ] || { echo "package.sh: no glibc symbol versions in $binary" >&2; exit 1; }
echo "package.sh: $binary needs glibc $glibc"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
install -m 0755 "$binary" "$work/kalzit"
echo deb > "$work/package-deb"
echo rpm > "$work/package-rpm"
sed -e "s|@VERSION@|$version|g" -e "s|@GLIBC@|$glibc|g" -e "s|@WORK@|$work|g" -e "s|@ROOT@|$root|g" \
    "$root/deploy/linux/nfpm.yaml" > "$work/nfpm.yaml"

mkdir -p "$out"
nfpm package --config "$work/nfpm.yaml" --packager deb --target "$out/kalzit-$version-linux-x64.deb"
nfpm package --config "$work/nfpm.yaml" --packager rpm --target "$out/kalzit-$version-linux-x64.rpm"
