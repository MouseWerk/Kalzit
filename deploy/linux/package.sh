#!/usr/bin/env bash
# Builds the deb and rpm of Kalzit from a built Linux binary, x64 or arm64
# (deploy/linux/nfpm.yaml):
#
#   deploy/linux/package.sh VERSION BINARY OUT_DIR
#
# writes OUT_DIR/kalzit-VERSION-linux-ARCH.deb and OUT_DIR/kalzit-VERSION-linux-ARCH.rpm, where
# ARCH (x64 or arm64) is read from the binary's ELF header. Needs nfpm and objdump. The packages
# require the glibc version the binary was linked against, read from its symbol versions, so a
# system with an older glibc refuses the package instead of failing at the start.
set -euo pipefail

version=${1:?usage: package.sh VERSION BINARY OUT_DIR}
binary=${2:?usage: package.sh VERSION BINARY OUT_DIR}
out=${3:?usage: package.sh VERSION BINARY OUT_DIR}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

command -v nfpm > /dev/null || { echo "package.sh: nfpm is not installed" >&2; exit 1; }

# e_machine, the little-endian 16-bit field at offset 18 of the ELF header: 62 is x86-64, 183 is
# AArch64. The release name uses x64 and arm64, nfpm the Go names amd64 and arm64 (it writes
# x86_64 and aarch64 into the rpm).
machine=$(od -An -t u2 -j 18 -N 2 "$binary" | tr -d ' ')
case "$machine" in
  62) arch=x64; nfpm_arch=amd64 ;;
  183) arch=arm64; nfpm_arch=arm64 ;;
  *) echo "package.sh: $binary is not an x86-64 or AArch64 ELF binary (machine $machine)" >&2; exit 1 ;;
esac

glibc=$(objdump -T "$binary" | grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' | sed 's/^GLIBC_//' | sort -uV | tail -n1)
[ -n "$glibc" ] || { echo "package.sh: no glibc symbol versions in $binary" >&2; exit 1; }
echo "package.sh: $binary is linux-$arch and needs glibc $glibc"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
install -m 0755 "$binary" "$work/kalzit"
echo deb > "$work/package-deb"
echo rpm > "$work/package-rpm"
sed -e "s|@VERSION@|$version|g" -e "s|@ARCH@|$nfpm_arch|g" -e "s|@GLIBC@|$glibc|g" -e "s|@WORK@|$work|g" \
    -e "s|@ROOT@|$root|g" "$root/deploy/linux/nfpm.yaml" > "$work/nfpm.yaml"

mkdir -p "$out"
nfpm package --config "$work/nfpm.yaml" --packager deb --target "$out/kalzit-$version-linux-$arch.deb"
nfpm package --config "$work/nfpm.yaml" --packager rpm --target "$out/kalzit-$version-linux-$arch.rpm"
