#!/usr/bin/env bash
# Tests browser-deps.sh without root, apt or network: a fake install command that stalls or
# fails on chosen attempts, fake dpkg tools, and apt's folders in a temporary directory.
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/browser-deps.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

fail() {
  echo "FAIL: $*"
  failures=$((failures + 1))
}

# A fresh apt folder like the runner's, fake tools on PATH, and an install command whose
# behaviour per attempt is given as words: "stall" (outlives the attempt), "fail" or "ok".
setup() {
  local case=$1
  shift
  dir="$work/$case"
  mkdir -p "$dir/etc/apt.conf.d" "$dir/etc/sources.list.d" "$dir/archives" "$dir/bin"
  printf 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\n' \
    > "$dir/etc/apt-mirrors.txt"
  printf 'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: resolute\n' \
    > "$dir/etc/sources.list.d/ubuntu.sources"
  printf '%s\n' "$@" > "$dir/plan"
  : > "$dir/calls"
  cat > "$dir/bin/fake-install" << 'EOF'
#!/usr/bin/env bash
dir=$(dirname "$(dirname "$0")")
echo install >> "$dir/calls"
n=$(grep -c install "$dir/calls")
case "$(sed -n "${n}p" "$dir/plan")" in
  stall) sleep 30 ;;
  slow) sleep 4; exit 0 ;;
  fail) exit 1 ;;
  ok) for p in "$dir"/downloads/*.deb; do [ -f "$p" ] && cp "$p" "$dir/archives/"; done; exit 0 ;;
esac
EOF
  cat > "$dir/bin/dpkg" << 'EOF'
#!/usr/bin/env bash
echo "dpkg $*" >> "$(dirname "$(dirname "$0")")/calls"
EOF
  # A fake package is a text file "name architecture version"; `installed` lists what is
  # installed in the same form, one line per package and architecture, as dpkg-query prints it.
  cat > "$dir/bin/dpkg-deb" << 'EOF'
#!/usr/bin/env bash
case "$3" in
  Package) cut -d' ' -f1 "$2" ;;
  Architecture) cut -d' ' -f2 "$2" ;;
  Version) cut -d' ' -f3 "$2" ;;
esac
EOF
  cat > "$dir/bin/dpkg-query" << 'EOF'
#!/usr/bin/env bash
cat "$(dirname "$(dirname "$0")")/installed"
EOF
  : > "$dir/installed"
  chmod +x "$dir"/bin/*
}

run() {
  status=0
  PATH="$dir/bin:$PATH" DEPS_SUDO="" DEPS_APT_ETC="$dir/etc" DEPS_APT_ARCHIVES="$dir/archives" \
    DEPS_ATTEMPT_SECONDS="${limits-2}" DEPS_CACHE="${cache:-}" "$script" fake-install > "$dir/out" 2>&1 || status=$?
}

count() {
  grep -c -x -F "$1" "$dir/calls" || true
}

# 1. The first attempt stalls past its limit: the second runs after dpkg recovery, on the main
#    archive, and succeeds.
setup stall-then-ok stall ok
started=$SECONDS
run
[ "$status" -eq 0 ] || fail "stall then ok: exit $status, $(cat "$dir/out")"
[ "$(count install)" -eq 2 ] || fail "stall then ok: $(count install) attempts, expected 2"
[ "$(count 'dpkg --configure -a')" -eq 1 ] || fail "stall then ok: dpkg recovery ran $(count 'dpkg --configure -a') times"
grep -q 'azure' "$dir/etc/apt-mirrors.txt" && fail "stall then ok: the mirror list still names the Azure mirror"
grep -q -x -F 'http://archive.ubuntu.com/ubuntu/	priority:1' "$dir/etc/apt-mirrors.txt" ||
  fail "stall then ok: mirror list is $(cat "$dir/etc/apt-mirrors.txt")"
grep -q 'Acquire::Retries "3";' "$dir/etc/apt.conf.d/80-kalzit-ci" || fail "stall then ok: apt retries not configured"
[ $((SECONDS - started)) -lt 25 ] || fail "stall then ok: the stalled attempt was not stopped"

# 2. Every attempt fails: three attempts, recovery before the second and third, exit 1.
setup all-fail fail fail fail
run
[ "$status" -eq 1 ] || fail "all fail: exit $status"
[ "$(count install)" -eq 3 ] || fail "all fail: $(count install) attempts, expected 3"
[ "$(count 'dpkg --configure -a')" -eq 2 ] || fail "all fail: dpkg recovery ran $(count 'dpkg --configure -a') times"
grep -q 'failed 3 times' "$dir/out" || fail "all fail: no final message"

# 3. No source names the Azure mirror: the switch says so and the retry goes on.
setup no-mirror fail ok
printf 'https://archive.ubuntu.com/ubuntu/\tpriority:1\n' > "$dir/etc/apt-mirrors.txt"
run
[ "$status" -eq 0 ] || fail "no mirror: exit $status"
grep -q 'no apt source or mirror list names azure.archive.ubuntu.com' "$dir/out" || fail "no mirror: not logged"

# 4. A first attempt that succeeds changes nothing.
setup first-ok ok
run
[ "$status" -eq 0 ] || fail "first ok: exit $status"
[ "$(count install)" -eq 1 ] || fail "first ok: $(count install) attempts"
[ "$(count 'dpkg --configure -a')" -eq 0 ] || fail "first ok: dpkg recovery ran"
grep -q 'azure' "$dir/etc/apt-mirrors.txt" || fail "first ok: the mirror list was changed"

# 5. Limits per attempt: a short first one stops the slow install, the longer later ones let it
#    finish.
setup per-attempt slow slow
limits="1 10"
run
unset limits
[ "$status" -eq 0 ] || fail "per attempt: exit $status, $(cat "$dir/out")"
[ "$(count install)" -eq 2 ] || fail "per attempt: $(count install) attempts, expected 2"

# 6. An empty or blank limit means the default (180 s), not an error: the slow install finishes.
for blank in "" "  "; do
  setup "blank-limit-${#blank}" slow
  limits=$blank
  run
  unset limits
  [ "$status" -eq 0 ] || fail "limit '$blank': exit $status, $(cat "$dir/out")"
  [ "$(count install)" -eq 1 ] || fail "limit '$blank': $(count install) attempts, expected 1"
done

# 7. The package cache: cached packages reach apt first, and afterwards the cache holds exactly
#    what is installed, by version and architecture: the outdated cached one goes, the new
#    download stays, and of a multiarch package only the installed architecture's version stays.
setup cache ok
cache="$dir/cache"
mkdir -p "$cache" "$dir/downloads"
echo "libold amd64 1.0" > "$cache/libold_1.0_amd64.deb"
echo "libkept all 2.0" > "$cache/libkept_2.0_all.deb"
echo "libnew amd64 3.0" > "$dir/downloads/libnew_3.0_amd64.deb"
echo "libmulti amd64 4.0" > "$dir/downloads/libmulti_4.0_amd64.deb"
echo "libmulti i386 4.0" > "$dir/downloads/libmulti_4.0_i386.deb"
echo "libmulti i386 3.9" > "$dir/downloads/libmulti_3.9_i386.deb"
echo "libnew i386 3.0" > "$dir/downloads/libnew_3.0_i386.deb"
printf '%s\n' "libold amd64 1.1" "libkept all 2.0" "libnew amd64 3.0" "libmulti amd64 4.0" "libmulti i386 4.0" \
  > "$dir/installed"
run
unset cache
[ "$status" -eq 0 ] || fail "cache: exit $status, $(cat "$dir/out")"
[ -f "$dir/archives/libkept_2.0_all.deb" ] || fail "cache: cached packages were not handed to apt"
kept=$(cd "$dir/cache" && ls | tr '\n' ' ')
[ "$kept" = "libkept_2.0_all.deb libmulti_4.0_amd64.deb libmulti_4.0_i386.deb libnew_3.0_amd64.deb " ] ||
  fail "cache: kept $kept"

# 8. A cache that cannot be written does not fail an install that succeeded.
setup cache-broken ok
echo "not a folder" > "$dir/file"
cache="$dir/file/cache"
run
unset cache
[ "$status" -eq 0 ] || fail "broken cache: exit $status, $(cat "$dir/out")"
grep -q '::warning::could not keep the downloaded packages' "$dir/out" || fail "broken cache: no warning"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "browser-deps.sh: all checks passed"
