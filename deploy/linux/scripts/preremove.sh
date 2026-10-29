#!/bin/sh
# Before the files are removed (deb prerm `remove`, rpm %preun with 0): stops and disables the
# service and unloads its AppArmor profile (deb). An update (deb `upgrade`, rpm 1) leaves both;
# the new package restarts the service and reloads the profile.
set -e

case "$1" in
    remove | 0)
        if [ -d /run/systemd/system ]; then
            systemctl disable --now kalzit.service > /dev/null 2>&1 || true
        fi
        if [ -f /etc/apparmor.d/kalzit ] && command -v apparmor_parser > /dev/null 2>&1 \
            && [ -d /sys/kernel/security/apparmor ]; then
            apparmor_parser -R /etc/apparmor.d/kalzit > /dev/null 2>&1 || true
        fi
        ;;
esac
exit 0
