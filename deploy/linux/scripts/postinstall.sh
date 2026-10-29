#!/bin/sh
# After the files are in place (deb postinst `configure [old version]`, rpm %post with 1 for an
# installation and 2 for an update):
#
# - the data directory /var/lib/kalzit, owned by `kalzit` and closed to everyone else;
# - /etc/kalzit readable by the service, writable by root only;
# - on the first installation a secrets key in the system credential store, encrypted with
#   systemd-creds where it works (/etc/credstore.encrypted), otherwise readable by root only
#   (/etc/credstore); the service imports it (ImportCredential=). An existing installation keeps
#   the key it has;
# - systemd: deb enables and starts the service on the first installation, rpm follows the
#   system's preset (Fedora and RHEL leave new services off); every update restarts a running
#   service.
set -e

first_install=false
case "$1" in
    configure) [ -z "$2" ] && first_install=true ;;
    1) first_install=true ;;
esac
packager=deb
case "$1" in
    1 | 2) packager=rpm ;;
esac

install -d -o kalzit -g kalzit -m 0700 /var/lib/kalzit
chown root:kalzit /etc/kalzit /etc/kalzit/kalzit.toml
chmod 0750 /etc/kalzit
chmod 0640 /etc/kalzit/kalzit.toml

# A new secrets key only for a data directory that has never held secrets: a key file or a
# database there means data encrypted with another key already.
key_name=kalzit-secrets-key
if [ ! -e "/etc/credstore.encrypted/$key_name" ] && [ ! -e "/etc/credstore/$key_name" ] \
    && [ ! -e /var/lib/kalzit/secrets.key ] && [ ! -e /var/lib/kalzit/kalzit.db ]; then
    install -d -o root -g root -m 0700 /etc/credstore.encrypted /etc/credstore
    umask 077
    stored=false
    if command -v systemd-creds > /dev/null 2>&1; then
        # The host key, not a TPM: a moved disk or a restored backup on other hardware still
        # decrypts it (with /var/lib/systemd/credential.secret).
        if head -c 32 /dev/urandom | base64 \
            | systemd-creds encrypt --with-key=host --name="$key_name" - "/etc/credstore.encrypted/$key_name" \
                > /dev/null 2>&1; then
            stored=true
        else
            rm -f "/etc/credstore.encrypted/$key_name"
        fi
    fi
    if [ "$stored" = false ]; then
        head -c 32 /dev/urandom | base64 > "/etc/credstore/$key_name"
        chmod 0600 "/etc/credstore/$key_name"
    fi
fi

if [ -d /run/systemd/system ]; then
    systemctl daemon-reload > /dev/null 2>&1 || true
    if [ "$first_install" = true ]; then
        if [ "$packager" = deb ]; then
            systemctl enable --now kalzit.service > /dev/null 2>&1 \
                || echo "kalzit: the service did not start; see: journalctl -u kalzit" >&2
        else
            systemctl preset kalzit.service > /dev/null 2>&1 || true
        fi
    else
        systemctl try-restart kalzit.service > /dev/null 2>&1 || true
    fi
fi

if [ "$first_install" = true ]; then
    cat <<'EOF'
Kalzit is installed. Configuration: /etc/kalzit/kalzit.toml, data: /var/lib/kalzit.
Start it (if it is not running yet):  sudo systemctl enable --now kalzit
Then open http://<this server>:3000 and enter the setup code:
    sudo kalzit setup-code
EOF
fi
exit 0
