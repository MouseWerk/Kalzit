English | [Deutsch](de/linux-binary.md)

# Linux without a package

The deb and rpm packages ([Installation](installation.md#debian-ubuntu-fedora-rhel-deb-and-rpm))
are the easiest way on Linux. On a distribution without them, or when you want the binary
somewhere else, install the plain binary as a systemd service by hand. The steps below give the
same result as the packages: its own system account, the configuration in `/etc/kalzit`, the data
in `/var/lib/kalzit`, the secrets key in the system credential store and a hardened unit.

## 1. Download and check

Every release has `kalzit-<version>-linux-x64` (x86-64) and `kalzit-<version>-linux-arm64`
(64-bit ARM); `uname -m` says which one (`x86_64` or `aarch64`). The binary needs the glibc it was
built against: Debian 13, Ubuntu 24.04, Fedora 41, RHEL, Rocky and AlmaLinux 10 or newer. Compare
its SHA-256 (`sha256sum kalzit-<version>-linux-x64`) with the entry in the release's signed
manifest `kalzit-<version>-manifest.json`; `kalzit-sign verify` checks the manifest's signature
too ([updates guide](../operations/updates.md#what-kalzit-trusts)).

## 2. Account and folders

```sh
sudo useradd --system --user-group --home-dir /var/lib/kalzit --no-create-home \
  --shell /usr/sbin/nologin --comment "Kalzit service" kalzit
sudo install -d -o kalzit -g kalzit -m 0700 /var/lib/kalzit
sudo install -d -o root -g kalzit -m 0750 /etc/kalzit
```

Where the binary goes decides who updates it:

- **Updates by you** (like the packages): the binary belongs to root and Kalzit cannot replace it.

  ```sh
  sudo install -o root -g root -m 0755 kalzit-<version>-linux-x64 /usr/local/bin/kalzit
  ```

- **Updates by Kalzit** (Administration > Updates installs on its own, with an automatic return
  when the new version does not start healthy): the binary and its folder belong to the service
  account.

  ```sh
  sudo install -d -o kalzit -g kalzit -m 0755 /opt/kalzit
  sudo install -o kalzit -g kalzit -m 0755 kalzit-<version>-linux-x64 /opt/kalzit/kalzit
  ```

  The service account can then change the program it runs; keep that account for Kalzit alone.

## 3. Configuration

`/etc/kalzit/kalzit.toml`, owned by root and readable by the service (`sudo chown root:kalzit
/etc/kalzit/kalzit.toml && sudo chmod 0640 /etc/kalzit/kalzit.toml`):

```toml
[server]
http_addr = "0.0.0.0:3000"
# public_url = "https://kalzit.example.com"

[paths]
data_dir = "/var/lib/kalzit"
```

All settings are in the [README](../../README.md#configuration); HTTPS in
[HTTPS and certificates](https.md), a proxy in front in [Reverse proxy](reverse-proxy.md).
`sudo kalzit --config /etc/kalzit/kalzit.toml check-config` checks the file without starting the
server.

## 4. Secrets key

Create the key in the system credential store, so it is neither in the data folder nor in an
environment variable:

```sh
sudo install -d -m 0700 /etc/credstore.encrypted
openssl rand -base64 32 | sudo systemd-creds encrypt --with-key=host --name=kalzit-secrets-key - \
  /etc/credstore.encrypted/kalzit-secrets-key
```

It is encrypted with the host's credential key, `/var/lib/systemd/credential.secret`; back up both
with your data ([Backup and restore](backup.md)). Without `systemd-creds`, write the base64 key to
`/etc/credstore/kalzit-secrets-key` with mode 0600, owned by root. Without either, Kalzit keeps a
key file `secrets.key` in the data folder and warns in its log.

## 5. The service

Write `/etc/systemd/system/kalzit.service`. This is the packages' unit
([deploy/linux/kalzit.service](../../deploy/linux/kalzit.service)) with the binary's path changed:

```ini
[Unit]
Description=Kalzit, a self-hosted platform to visualize and analyze data
Wants=network-online.target
After=network-online.target

[Service]
Type=exec
User=kalzit
Group=kalzit
ExecStart=/usr/local/bin/kalzit --config /etc/kalzit/kalzit.toml serve
WorkingDirectory=/
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
UMask=0077
LimitNOFILE=65536

ImportCredential=kalzit-secrets-key
ImportCredential=kalzit-database-url

AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/kalzit
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
RemoveIPC=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
RestrictNamespaces=~cgroup mnt pid uts
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=landlock_create_ruleset landlock_add_rule landlock_restrict_self setsid
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
```

- With updates by Kalzit, use `ExecStart=/opt/kalzit/kalzit --config /etc/kalzit/kalzit.toml serve`
  and add `ReadWritePaths=/opt/kalzit`, so the service may put the new binary in place.
- `ImportCredential=` needs systemd 254 or newer. On an older systemd, use
  `LoadCredentialEncrypted=kalzit-secrets-key:/etc/credstore.encrypted/kalzit-secrets-key`
  instead (or `LoadCredential=` for a key in `/etc/credstore`).
- The hardening keeps what the plugin sandbox needs (user, IPC and network namespaces, Landlock,
  seccomp). `sudo -u kalzit /usr/local/bin/kalzit sandbox-check` lists the protections plugins get.
- **Ubuntu 23.10 and later** refuse user namespaces to programs without an AppArmor profile that
  allows them, and plugins then do not start. Add `/etc/apparmor.d/kalzit` like the deb does,
  with your binary's path, and load it with `sudo apparmor_parser -r /etc/apparmor.d/kalzit`:

  ```text
  abi <abi/4.0>,
  include <tunables/global>

  profile kalzit /usr/local/bin/kalzit flags=(unconfined) {
    userns,
    include if exists <local/kalzit>
  }
  ```

Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now kalzit
sudo kalzit --config /etc/kalzit/kalzit.toml setup-code   # the one-time setup code
```

Open `http://<server>:3000` and continue with [Getting started](getting-started.md). Logs are in
the journal: `journalctl -u kalzit`.

## Updates

- **Updates by you:** download the new binary, check it, then
  `sudo systemctl stop kalzit`, `sudo install -o root -g root -m 0755 kalzit-<new>-linux-x64
  /usr/local/bin/kalzit`, `sudo systemctl start kalzit`. The new version migrates the database on
  its first start; back up first ([Backup and restore](backup.md)). The Updates page can also
  download and verify a release for `kalzit update apply`
  ([updates guide](../operations/updates.md#installing-from-the-command-line)), which keeps the
  previous binary and returns to it when the new one does not start healthy.
- **Updates by Kalzit:** Administration > Updates, **Install now** or a planned time in the
  maintenance window ([Upgrading](upgrading.md)).

## Remove

```sh
sudo systemctl disable --now kalzit
sudo rm /etc/systemd/system/kalzit.service /usr/local/bin/kalzit   # or /opt/kalzit
sudo systemctl daemon-reload
```

The data folder, the configuration and the key stay until you delete them
(`/var/lib/kalzit`, `/etc/kalzit`, `/etc/credstore.encrypted/kalzit-secrets-key`, and
`/etc/apparmor.d/kalzit` if you added it); `sudo userdel kalzit` removes the account.
