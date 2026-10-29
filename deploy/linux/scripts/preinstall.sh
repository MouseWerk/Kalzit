#!/bin/sh
# Before the files are unpacked (deb preinst, rpm %pre): the system account and group `kalzit`
# that the service runs as. Without a login shell and without a home directory of its own; the
# data directory is /var/lib/kalzit.
set -e

if ! getent group kalzit > /dev/null 2>&1; then
    groupadd --system kalzit
fi
if ! getent passwd kalzit > /dev/null 2>&1; then
    nologin=/usr/sbin/nologin
    [ -x "$nologin" ] || nologin=/sbin/nologin
    useradd --system --gid kalzit --home-dir /var/lib/kalzit --no-create-home \
        --shell "$nologin" --comment "Kalzit service" kalzit
fi
exit 0
