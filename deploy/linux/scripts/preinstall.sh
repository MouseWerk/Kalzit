#!/bin/sh
# Before the files are unpacked (deb preinst, rpm %pre): the system account and group `kalzit`
# that the service runs as. Without a login shell and without a home directory of its own; the
# data directory is /var/lib/kalzit.
#
# An existing `kalzit` account is used only when it looks like one this package made: a system
# account (an id below the first user id) without a login shell, and a group `kalzit` without
# other members. Anything else might be a person's account or a group others share, which would
# then own the data directory and the secrets; the installation stops and says so.
set -e

refuse() {
    echo "kalzit: $1" >&2
    echo "kalzit: the service needs its own system account; rename or remove the existing one, then install again" >&2
    exit 1
}

first_user_id=$(awk '$1 == "UID_MIN" { print $2 }' /etc/login.defs 2> /dev/null || true)
[ -n "$first_user_id" ] || first_user_id=1000

if getent group kalzit > /dev/null 2>&1; then
    members=$(getent group kalzit | cut -d: -f4)
    [ -z "$members" ] || refuse "the existing group kalzit has members ($members)"
else
    groupadd --system kalzit
fi

if getent passwd kalzit > /dev/null 2>&1; then
    uid=$(getent passwd kalzit | cut -d: -f3)
    shell=$(getent passwd kalzit | cut -d: -f7)
    [ "$uid" -lt "$first_user_id" ] || refuse "the existing account kalzit is not a system account (id $uid)"
    case "$shell" in
        */nologin | */false) ;;
        *) refuse "the existing account kalzit has the login shell $shell" ;;
    esac
else
    nologin=/usr/sbin/nologin
    [ -x "$nologin" ] || nologin=/sbin/nologin
    useradd --system --gid kalzit --home-dir /var/lib/kalzit --no-create-home \
        --shell "$nologin" --comment "Kalzit service" kalzit
fi
exit 0
