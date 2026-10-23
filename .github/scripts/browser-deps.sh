#!/usr/bin/env bash
# Installs the system packages the Playwright browsers need on the Linux CI runner: the command
# given as arguments (Playwright's `install-deps`), with retries.
#
# The runner's package mirror sometimes slows to a few kB/s without failing, so each attempt
# gets DEPS_ATTEMPT_SECONDS (default 180; a list such as "20 180" sets it per attempt, the last
# one repeating), run as root so `timeout` can stop apt and the downloads it started.
# Before a further attempt, dpkg finishes what a stopped attempt left half unpacked, and the
# runner's own mirror is replaced by the main Ubuntu archive. Its sources name the mirror through
# `mirror+file:` and the list in `apt-mirrors.txt`, so that list is changed too.
#
# DEPS_CACHE, when set, is a folder of downloaded packages kept between runs (actions/cache): its
# packages are handed to apt first, and after a successful install it holds exactly the packages
# installed now, so it does not grow with every runner image.
#
# Settings for the test (browser-deps.test.sh): DEPS_ATTEMPTS, DEPS_ATTEMPT_SECONDS, DEPS_APT_ETC,
# DEPS_APT_ARCHIVES, and DEPS_SUDO (empty runs everything as the current user).
set -euo pipefail

attempts=${DEPS_ATTEMPTS:-3}
seconds=${DEPS_ATTEMPT_SECONDS:-180}
apt_etc=${DEPS_APT_ETC:-/etc/apt}
archives=${DEPS_APT_ARCHIVES:-/var/cache/apt/archives}
sudo=${DEPS_SUDO-sudo}
cache=${DEPS_CACHE:-}
slow_mirror=azure.archive.ubuntu.com
main_archive=archive.ubuntu.com

if [ "$#" -eq 0 ]; then
  echo "usage: browser-deps.sh <install command...>" >&2
  exit 2
fi

as_root() {
  if [ -n "$sudo" ]; then
    "$sudo" "$@"
  else
    "$@"
  fi
}

configure_apt() {
  if [ -d "$apt_etc/apt.conf.d" ]; then
    printf '%s\n' 'Acquire::Retries "3";' 'Acquire::http::Timeout "30";' 'Acquire::https::Timeout "30";' \
      'APT::Keep-Downloaded-Packages "true";' | as_root tee "$apt_etc/apt.conf.d/80-kalzit-ci" > /dev/null
  fi
}

switch_mirror() {
  local switched=0 list
  for list in "$apt_etc/apt-mirrors.txt" "$apt_etc/sources.list" "$apt_etc"/sources.list.d/*; do
    if [ -f "$list" ] && grep -q -F "://$slow_mirror/" "$list"; then
      as_root sed -i "s#://$slow_mirror/#://$main_archive/#g" "$list"
      echo "switched $list from $slow_mirror to $main_archive"
      switched=1
    fi
  done
  if [ "$switched" -eq 0 ]; then
    echo "::notice::no apt source or mirror list names $slow_mirror; retrying with the configured ones"
    echo "no apt source or mirror list names $slow_mirror"
  fi
}

restore_cache() {
  local count
  if [ -z "$cache" ] || [ ! -d "$cache" ]; then
    return
  fi
  count=$(find "$cache" -maxdepth 1 -name '*.deb' | wc -l) || return 1
  if [ "$count" -gt 0 ]; then
    as_root cp "$cache"/*.deb "$archives/" || return 1
  fi
  echo "handed $count cached packages to apt"
}

# Keeps the downloaded packages that are installed now, in that version and architecture: one
# package can be installed for several architectures (multiarch), each a line of its own.
# Called only where a failure is reported and ignored, so every step returns on an error.
save_cache() {
  local deb entry installed kept=0
  if [ -z "$cache" ]; then
    return 0
  fi
  installed=$(dpkg-query -W -f='${Package} ${Architecture} ${Version}\n') || return 1
  mkdir -p "$cache" || return 1
  find "$cache" -maxdepth 1 -name '*.deb' -delete || return 1
  for deb in "$archives"/*.deb; do
    [ -f "$deb" ] || continue
    entry="$(dpkg-deb -f "$deb" Package) $(dpkg-deb -f "$deb" Architecture) $(dpkg-deb -f "$deb" Version)" ||
      return 1
    if grep -q -x -F -- "$entry" <<< "$installed"; then
      cp "$deb" "$cache/" || return 1
      kept=$((kept + 1))
    fi
  done
  echo "kept $kept downloaded packages for the next run"
}

# One limit for every attempt, or one per attempt ("20 180"): the last one repeats. Empty or
# blank means the default.
read -r -a limits <<< "$seconds"
if [ "${#limits[@]}" -eq 0 ]; then
  limits=(180)
fi

configure_apt
restore_cache || echo "::warning::could not hand the cached packages to apt; downloading them all"
for attempt in $(seq 1 "$attempts"); do
  if [ "$attempt" -gt 1 ]; then
    echo "::warning::installing the browser system packages failed or stalled (attempt $((attempt - 1)) of $attempts)"
    echo "attempt $attempt of $attempts"
    as_root dpkg --configure -a || true
  fi
  if [ "$attempt" -eq 2 ]; then
    switch_mirror
  fi
  limit=${limits[$((attempt - 1))]:-${limits[-1]}}
  if as_root env "PATH=$PATH" timeout --kill-after=15 "$limit" "$@"; then
    # The packages are installed; a cache that cannot be written only costs the next run time.
    save_cache || echo "::warning::could not keep the downloaded packages for the next run"
    exit 0
  fi
done
echo "installing the browser system packages failed $attempts times" >&2
exit 1
