#!/bin/sh
# After the files are removed (deb postrm, rpm %postun). Removing the package never touches the
# data: /var/lib/kalzit, /etc/kalzit and the secrets key stay, so a reinstallation finds
# everything again. Only `apt purge kalzit` deletes them; rpm has no purge, there they are
# deleted by hand (docs/guide/installation.md, "Remove"). The `kalzit` account stays, as files
# may still belong to it.
set -e

if [ -d /run/systemd/system ]; then
    systemctl daemon-reload > /dev/null 2>&1 || true
fi

if [ "$1" = purge ]; then
    rm -rf /var/lib/kalzit /etc/kalzit
    rm -f /etc/credstore.encrypted/kalzit-secrets-key /etc/credstore/kalzit-secrets-key
fi
exit 0
