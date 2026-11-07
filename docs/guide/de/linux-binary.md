[English](../linux-binary.md) | Deutsch

# Linux ohne Paket

Die deb- und rpm-Pakete ([Installation](installation.md#debian-ubuntu-fedora-rhel-deb-und-rpm))
sind unter Linux der einfachste Weg. Auf einer Distribution ohne sie, oder wenn du das Programm an
anderer Stelle haben willst, installierst du das reine Binary von Hand als systemd-Dienst. Die
Schritte unten führen zum selben Ergebnis wie die Pakete: ein eigenes Systemkonto, die
Konfiguration in `/etc/kalzit`, die Daten in `/var/lib/kalzit`, der Secrets-Schlüssel im
Credential-Speicher des Systems und eine gehärtete Unit.

## 1. Herunterladen und prüfen

Jedes Release hat `kalzit-<version>-linux-x64` (x86-64) und `kalzit-<version>-linux-arm64`
(64-Bit-ARM); `uname -m` sagt dir, welches du brauchst (`x86_64` oder `aarch64`). Das Binary
braucht die glibc, gegen die es gebaut wurde: Debian 13, Ubuntu 24.04, Fedora 41, RHEL, Rocky und
AlmaLinux 10 oder neuer. Vergleiche seinen SHA-256 (`sha256sum kalzit-<version>-linux-x64`) mit dem
Eintrag im signierten Manifest des Releases, `kalzit-<version>-manifest.json`; `kalzit-sign verify`
prüft zusätzlich die Signatur des Manifests
([Anleitung zu Updates](../../operations/updates.md#what-kalzit-trusts)).

## 2. Konto und Ordner

```sh
sudo useradd --system --user-group --home-dir /var/lib/kalzit --no-create-home \
  --shell /usr/sbin/nologin --comment "Kalzit service" kalzit
sudo install -d -o kalzit -g kalzit -m 0700 /var/lib/kalzit
sudo install -d -o root -g kalzit -m 0750 /etc/kalzit
```

Wo das Binary liegt, entscheidet, wer es aktualisiert:

- **Updates durch dich** (wie bei den Paketen): Das Binary gehört root, und Kalzit kann es nicht
  ersetzen.

  ```sh
  sudo install -o root -g root -m 0755 kalzit-<version>-linux-x64 /usr/local/bin/kalzit
  ```

- **Updates durch Kalzit** (Verwaltung > Updates installiert selbstständig, mit automatischer
  Rückkehr, wenn die neue Version nicht gesund startet): Das Binary und sein Ordner gehören dem
  Systemkonto des Dienstes.

  ```sh
  sudo install -d -o kalzit -g kalzit -m 0755 /opt/kalzit
  sudo install -o kalzit -g kalzit -m 0755 kalzit-<version>-linux-x64 /opt/kalzit/kalzit
  ```

  Das Systemkonto des Dienstes kann dann das Programm ändern, das es ausführt; verwende dieses
  Konto nur für Kalzit.

## 3. Konfiguration

`/etc/kalzit/kalzit.toml`, gehört root und ist für den Dienst lesbar (`sudo chown root:kalzit
/etc/kalzit/kalzit.toml && sudo chmod 0640 /etc/kalzit/kalzit.toml`):

```toml
[server]
http_addr = "0.0.0.0:3000"
# public_url = "https://kalzit.example.com"

[paths]
data_dir = "/var/lib/kalzit"
```

Alle Einstellungen stehen in der [README](../../../README.md#configuration); HTTPS in
[HTTPS und Zertifikate](https.md), ein vorgeschalteter Proxy in [Reverse Proxy](reverse-proxy.md).
`sudo kalzit --config /etc/kalzit/kalzit.toml check-config` prüft die Datei, ohne den Server zu
starten.

## 4. Secrets-Schlüssel

Lege den Schlüssel im Credential-Speicher des Systems an, damit er weder im Datenordner noch in
einer Umgebungsvariablen steht:

```sh
sudo install -d -m 0700 /etc/credstore.encrypted
openssl rand -base64 32 | sudo systemd-creds encrypt --with-key=host --name=kalzit-secrets-key - \
  /etc/credstore.encrypted/kalzit-secrets-key
```

Er ist mit dem Credential-Schlüssel des Hosts verschlüsselt, `/var/lib/systemd/credential.secret`;
sichere beide zusammen mit deinen Daten ([Sichern und wiederherstellen](backup.md)). Ohne
`systemd-creds` schreibst du den base64-Schlüssel nach `/etc/credstore/kalzit-secrets-key`, mit
Modus 0600 und root als Eigentümer der Datei. Ohne beides legt Kalzit eine Schlüsseldatei
`secrets.key` im Datenordner an und warnt im Log.

## 5. Der Dienst

Schreibe `/etc/systemd/system/kalzit.service`. Das ist die Unit der Pakete
([deploy/linux/kalzit.service](../../../deploy/linux/kalzit.service)) mit geändertem Pfad zum
Binary:

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

- Bei Updates durch Kalzit verwendest du `ExecStart=/opt/kalzit/kalzit --config /etc/kalzit/kalzit.toml serve`
  und ergänzt `ReadWritePaths=/opt/kalzit`, damit der Dienst das neue Binary an seinen Platz legen
  darf.
- `ImportCredential=` braucht systemd 254 oder neuer. Bei einem älteren systemd verwendest du
  stattdessen `LoadCredentialEncrypted=kalzit-secrets-key:/etc/credstore.encrypted/kalzit-secrets-key`
  (oder `LoadCredential=` für einen Schlüssel in `/etc/credstore`).
- Die Härtung lässt übrig, was die Plugin-Sandbox braucht (User-, IPC- und Netzwerk-Namespaces,
  Landlock, seccomp). `sudo -u kalzit /usr/local/bin/kalzit sandbox-check` listet die Schutzmaßnahmen
  auf, die Plugins bekommen.
- **Ubuntu 23.10 und neuer** verweigern User-Namespaces für Programme ohne ein AppArmor-Profil, das
  sie erlaubt, und Plugins starten dann nicht. Lege wie das deb-Paket `/etc/apparmor.d/kalzit` an,
  mit dem Pfad deines Binarys, und lade es mit `sudo apparmor_parser -r /etc/apparmor.d/kalzit`:

  ```text
  abi <abi/4.0>,
  include <tunables/global>

  profile kalzit /usr/local/bin/kalzit flags=(unconfined) {
    userns,
    include if exists <local/kalzit>
  }
  ```

Danach:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now kalzit
sudo kalzit --config /etc/kalzit/kalzit.toml setup-code   # der einmalige Einrichtungscode
```

Öffne `http://<server>:3000` und mach mit [Erste Schritte](getting-started.md) weiter. Die Logs
stehen im Journal: `journalctl -u kalzit`.

## Updates

- **Updates durch dich:** Lade das neue Binary herunter, prüfe es, dann
  `sudo systemctl stop kalzit`, `sudo install -o root -g root -m 0755 kalzit-<new>-linux-x64
  /usr/local/bin/kalzit`, `sudo systemctl start kalzit`. Die neue Version migriert die Datenbank
  beim ersten Start; sichere vorher ([Sichern und wiederherstellen](backup.md)). Die Seite Updates
  kann auch ein Release für `kalzit update apply` herunterladen und prüfen
  ([Anleitung zu Updates](../../operations/updates.md#installing-from-the-command-line)); das
  behält das vorige Binary und kehrt zu ihm zurück, wenn das neue nicht gesund startet.
- **Updates durch Kalzit:** Verwaltung > Updates, **Jetzt installieren** oder eine geplante Zeit im
  Wartungsfenster ([Aktualisieren](upgrading.md)).

## Entfernen

```sh
sudo systemctl disable --now kalzit
sudo rm /etc/systemd/system/kalzit.service /usr/local/bin/kalzit   # oder /opt/kalzit
sudo systemctl daemon-reload
```

Der Datenordner, die Konfiguration und der Schlüssel bleiben, bis du sie löschst
(`/var/lib/kalzit`, `/etc/kalzit`, `/etc/credstore.encrypted/kalzit-secrets-key` und
`/etc/apparmor.d/kalzit`, falls du es angelegt hast); `sudo userdel kalzit` entfernt das Konto.
