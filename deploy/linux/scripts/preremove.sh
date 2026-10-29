#!/bin/sh
# Before the files are removed (deb prerm `remove`, rpm %preun with 0): stops and disables the
# service. An update (deb `upgrade`, rpm 1) leaves it running; the new package restarts it.
set -e

case "$1" in
    remove | 0)
        if [ -d /run/systemd/system ]; then
            systemctl disable --now kalzit.service > /dev/null 2>&1 || true
        fi
        ;;
esac
exit 0
