#!/usr/bin/env bash
# Smoke test of the Linux packages (package-smoke.sh DIST_DIR, on an Ubuntu runner with sudo
# and Docker; DIST_DIR holds one kalzit-*-linux-x64.deb and one .rpm):
#
# 1. the deb on the runner itself, under its real systemd: the service starts as `kalzit` with
#    the hardened unit, answers /readyz, uses the secrets key from the credential store (no key
#    file in the data directory), prints the setup code; the plugin sandbox inside the unit has
#    every layer it has for the same account outside of it (`kalzit sandbox-check`); a
#    reinstall restarts it; `apt remove` keeps data, configuration and key, `apt purge` deletes
#    them;
# 2. the deb in a Debian container and the rpm in a Fedora container, each with systemd as
#    process 1 when the container can run it (otherwise the binary as `kalzit`): installs,
#    becomes ready, and removing keeps the data.
#
# Port 3000 on loopback (the packaged default); everything it installs is removed again.
set -euo pipefail

dist=$(cd "${1:?usage: package-smoke.sh DIST_DIR}" && pwd)
deb=$(ls "$dist"/kalzit-*-linux-x64.deb)
rpm=$(ls "$dist"/kalzit-*-linux-x64.rpm)

fail() {
  echo "::error::$1"
  exit 1
}

# Waits until `$1 curl ...` (a command prefix, empty on the host) gets 200 from /readyz.
wait_ready() {
  local prefix=$1 what=$2
  for _ in $(seq 1 90); do
    if $prefix curl -fsS -o /dev/null http://127.0.0.1:3000/readyz 2> /dev/null; then
      echo "$what is ready"
      return 0
    fi
    sleep 2
  done
  return 1
}

echo "::group::deb on the runner with systemd"
sudo apt-get install -y "$deb"
systemctl is-enabled kalzit || fail "the deb did not enable the service"
if ! wait_ready "" "the service"; then
  sudo journalctl -u kalzit --no-pager | tail -n 80
  fail "the service did not become ready"
fi
pid=$(systemctl show -p MainPID --value kalzit)
[ "$(ps -o user= -p "$pid" | tr -d ' ')" = kalzit ] || fail "the service does not run as kalzit"
[ "$(cat /usr/lib/kalzit/package)" = deb ] || fail "the package marker is missing"
sudo test -e /etc/credstore.encrypted/kalzit-secrets-key -o -e /etc/credstore/kalzit-secrets-key \
  || fail "no secrets key in the credential store"
sudo test ! -e /var/lib/kalzit/secrets.key || fail "the service fell back to a key file in the data directory"
[ "$(sudo stat -c '%U %a' /var/lib/kalzit)" = "kalzit 700" ] || fail "the data directory is not private to kalzit"
[ "$(sudo stat -c "%U:%G %a" /etc/kalzit/kalzit.toml)" = "root:kalzit 640" ] || fail "kalzit.toml has the wrong owner or mode"
code=$(sudo kalzit setup-code)
[ -n "$code" ] || fail "no setup code"
systemctl show -p NoNewPrivileges -p ProtectSystem kalzit
if [ -d /sys/kernel/security/apparmor ]; then
  sudo grep -q '^kalzit ' /sys/kernel/security/apparmor/profiles || fail "the AppArmor profile is not loaded"
fi

# The sandbox inside the unit (a one-shot copy of it running the check) against the same
# account outside of any unit.
outside=$(sudo -u kalzit /usr/bin/kalzit --config /etc/kalzit/kalzit.toml sandbox-check)
echo "outside the unit:"
echo "$outside"
sed -e 's#^ExecStart=.*#ExecStart=/usr/bin/kalzit --config /etc/kalzit/kalzit.toml sandbox-check#' \
  -e 's#^Type=.*#Type=oneshot#' -e '/^Restart/d' -e '/^\[Install\]/,$d' \
  /usr/lib/systemd/system/kalzit.service | sudo tee /etc/systemd/system/kalzit-sandbox-check.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl start kalzit-sandbox-check.service || {
  sudo journalctl -u kalzit-sandbox-check --no-pager | tail -n 40
  fail "the sandbox check did not run inside the unit"
}
report=$(sudo journalctl -u kalzit-sandbox-check -o cat --no-pager)
inside=$(echo "$report" | grep '^sandbox layers in force:' | tail -n1)
echo "inside the unit:"
echo "$report" | grep -E '^(sandbox layers|capabilities|test program)' | tail -n4
[ "$inside" = "$(echo "$outside" | grep '^sandbox layers in force:')" ] \
  || fail "the unit's hardening takes sandbox layers away from plugins"
# Every layer, the namespaces included: the runner's Ubuntu restricts user namespaces through
# AppArmor, which the deb's profile lifts for /usr/bin/kalzit.
for layer in no_new_privs seccomp landlock user_namespace ipc_namespace network_namespace; do
  echo "$inside" | grep -qw "$layer" || fail "plugins run without $layer inside the unit"
done
# The service holds CAP_NET_BIND_SERVICE as an ambient capability; a plugin gets none.
service_ambient=$(sudo awk '/^CapAmb:/ { print $2 }' "/proc/$pid/status")
[ "$service_ambient" != 0000000000000000 ] || fail "the service has no ambient capability to test with"
echo "$report" | grep -q '^capabilities ambient 0000000000000000 bounding 0000000000000000 ' \
  || fail "a plugin inherits capabilities inside the unit"
sudo rm /etc/systemd/system/kalzit-sandbox-check.service
sudo systemctl daemon-reload

# A reinstall (the path of an update) restarts the service and keeps the data.
before=$(systemctl show -p MainPID --value kalzit)
sudo apt-get install -y --reinstall "$deb"
wait_ready "" "the service after the reinstall" || fail "the service did not come back after the reinstall"
[ "$(systemctl show -p MainPID --value kalzit)" != "$before" ] || fail "the reinstall did not restart the service"
sudo test -e /var/lib/kalzit/kalzit.db || fail "the reinstall lost the database"

sudo apt-get remove -y kalzit
! systemctl is-active --quiet kalzit || fail "the service still runs after apt remove"
sudo test -e /var/lib/kalzit/kalzit.db || fail "apt remove deleted the data"
sudo test -e /etc/kalzit/kalzit.toml || fail "apt remove deleted the configuration"
sudo apt-get purge -y kalzit
sudo test ! -e /var/lib/kalzit || fail "apt purge kept the data"
sudo test ! -e /etc/kalzit || fail "apt purge kept the configuration"
test ! -e /etc/apparmor.d/kalzit || fail "apt purge kept the AppArmor profile"
if [ -d /sys/kernel/security/apparmor ]; then
  ! sudo grep -q '^kalzit ' /sys/kernel/security/apparmor/profiles || fail "the AppArmor profile stayed loaded"
fi
sudo test ! -e /etc/credstore.encrypted/kalzit-secrets-key -a ! -e /etc/credstore/kalzit-secrets-key \
  || fail "apt purge kept the secrets key"
echo "::endgroup::"

# One distribution in a container: $1 name, $2 image, $3 command that installs systemd and curl,
# $4 install command, $5 remove command, $6 package file.
container() {
  local name=$1 image=$2 prepare=$3 install=$4 remove=$5 file=$6
  echo "::group::$(basename "$file") in $image"
  docker run -d --name "$name" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    --tmpfs /run --tmpfs /run/lock -v "$dist:/dist:ro" "$image" \
    sh -c "$prepare && exec /sbin/init" > /dev/null
  local systemd=false state
  for _ in $(seq 1 120); do
    state=$(docker exec "$name" systemctl is-system-running 2> /dev/null || true)
    case "$state" in
      running | degraded) systemd=true; break ;;
    esac
    [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || break
    sleep 2
  done
  if [ "$systemd" = false ]; then
    # No systemd as process 1 here: the same image with a plain process 1.
    docker logs "$name" 2>&1 | tail -n 20 || true
    docker rm -f "$name" > /dev/null
    docker run -d --name "$name" -v "$dist:/dist:ro" "$image" sh -c "$prepare && touch /prepared && exec sleep infinity" \
      > /dev/null
    for _ in $(seq 1 120); do
      docker exec "$name" test -e /prepared 2> /dev/null && break
      sleep 2
    done
  fi
  # A person's account named kalzit (a login shell, a user id) is never taken over.
  docker exec "$name" useradd -m -s /bin/sh kalzit
  if docker exec "$name" sh -c "$install /dist/$(basename "$file")" > /tmp/refused.log 2>&1; then
    fail "the package in $image took over a login account named kalzit"
  fi
  grep -q "is not a system account\|login shell" /tmp/refused.log || { cat /tmp/refused.log; fail "no clear refusal in $image"; }
  docker exec "$name" userdel -r kalzit
  docker exec "$name" sh -c "getent group kalzit > /dev/null && groupdel kalzit || true"
  docker exec "$name" sh -c "$install /dist/$(basename "$file")"
  if [ "$systemd" = true ]; then
    docker exec "$name" systemctl enable --now kalzit
    wait_ready "docker exec $name" "kalzit in $image (systemd)" || {
      docker exec "$name" journalctl -u kalzit --no-pager | tail -n 60
      fail "kalzit did not become ready in $image"
    }
  else
    echo "::notice::systemd does not run in the $image container; starting the binary as kalzit"
    docker exec -d -u kalzit "$name" /usr/bin/kalzit --config /etc/kalzit/kalzit.toml serve
    wait_ready "docker exec $name" "kalzit in $image (as kalzit)" || fail "kalzit did not become ready in $image"
    docker exec "$name" pkill -u kalzit -x kalzit || true
  fi
  docker exec "$name" sh -c "$remove"
  docker exec "$name" test -e /var/lib/kalzit || fail "removing the package in $image deleted the data"
  docker exec "$name" test ! -e /usr/bin/kalzit || fail "removing the package in $image kept the binary"
  docker rm -f "$name" > /dev/null
  echo "::endgroup::"
}

trap 'docker rm -f kalzit-debian kalzit-fedora > /dev/null 2>&1 || true' EXIT
container kalzit-debian debian:13 \
  "apt-get update -qq && apt-get install -y -qq systemd systemd-sysv curl procps > /dev/null" \
  "apt-get install -y" "apt-get remove -y kalzit" "$deb"
container kalzit-fedora fedora:43 \
  "dnf -y -q install systemd curl procps-ng > /dev/null" \
  "dnf -y install" "dnf -y remove kalzit" "$rpm"
echo "the packages install, run and remove cleanly"
