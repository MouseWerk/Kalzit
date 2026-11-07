[English](../installation.md) | Deutsch

# Installation

Kalzit ist ein einziges Programm, `kalzit`, mit eingebauter Weboberfläche. Unter Linux installierst
du das deb- oder rpm-Paket, das es als systemd-Dienst ausführt; unter Windows installierst du es mit
dem MSI-Paket als Dienst ([Windows](#windows)); oder du startest es als Container-Image
([Docker](#docker)); oder du baust das Programm aus dem Quellcode und startest es direkt oder als
Dienst (siehe die [README](../../../README.md#quick-start) und „Running as a service“ in
[ARCHITECTURE](../../ARCHITECTURE.md#running-as-a-service)). Nach der Installation geht es mit
[Erste Schritte](getting-started.md) weiter. HTTPS, mit deinem eigenen Zertifikat oder einem von
Let's Encrypt, beschreibt [HTTPS und Zertifikate](https.md).

## Debian, Ubuntu, Fedora, RHEL (deb und rpm)

Jedes Release enthält die Pakete für x86-64 (`kalzit-<version>-linux-x64.deb`,
`kalzit-<version>-linux-x64.rpm`) und für 64-Bit-ARM wie AWS Graviton, Ampere oder einen Raspberry
Pi 4 oder 5 mit 64-Bit-System (`kalzit-<version>-linux-arm64.deb`,
`kalzit-<version>-linux-arm64.rpm`); `uname -m` sagt, welches ein Computer braucht (`x86_64` oder
`aarch64`). Die reinen Programmdateien `kalzit-<version>-linux-x64` und
`kalzit-<version>-linux-arm64` liegen ebenfalls im Release. Die Pakete brauchen die glibc, gegen die
das Release-Programm gebaut wurde (das Paket nennt sie und lehnt ein älteres System ab): Debian 13,
Ubuntu 24.04, Fedora 41, RHEL, Rocky und AlmaLinux 10 oder neuer. Alle stehen mit Größe, SHA-256
und Signatur im signierten Manifest des Release (`kalzit-<version>-manifest.json`), neben den
Programmdateien.

### Installieren

Lade das Paket für deinen Prozessor von den
[Releases](https://github.com/MouseWerk/Kalzit/releases) herunter, dann (auf ARM `arm64` statt
`x64`):

```sh
# Debian, Ubuntu
sudo apt install ./kalzit-0.5.0-linux-x64.deb
# Fedora, RHEL, Rocky, Alma
sudo dnf install ./kalzit-0.5.0-linux-x64.rpm
sudo systemctl enable --now kalzit
```

Das deb-Paket startet den Dienst sofort; das rpm-Paket folgt der Voreinstellung des Systems, die
neue Dienste unter Fedora und RHEL ausgeschaltet lässt, daher startest du ihn mit
`systemctl enable --now kalzit`. Öffne `http://<server>:3000` und gib den Einrichtungscode ein, den
`sudo kalzit setup-code` ausgibt (`/var/lib/kalzit` gehört dem Benutzer `kalzit` mit Modus 0700,
Lesen braucht also root: `sudo cat /var/lib/kalzit/setup-token.txt` geht ebenso;
[Erste Schritte](getting-started.md)).

Um einen Download mit dem signierten Manifest abzugleichen, vergleiche seine SHA-256 mit dem
Eintrag unter `installers` im Manifest (`sha256sum kalzit-0.5.0-linux-x64.deb`);
`kalzit-sign verify --public-key <key> --manifest kalzit-0.5.0-manifest.json --signature
kalzit-0.5.0-manifest.json.sig --installer kalzit-0.5.0-linux-x64.deb` prüft auch die Signatur
des Manifests ([Updates](../../operations/updates.md)).

### Was das Paket installiert

| Pfad | Was es ist |
|---|---|
| `/usr/bin/kalzit` | Das Programm |
| `/usr/lib/systemd/system/kalzit.service` | Der Dienst; ändere ihn mit `sudo systemctl edit kalzit` |
| `/etc/kalzit/kalzit.toml` | Die Konfiguration: root darf sie schreiben, der Dienst nur lesen (`root:kalzit`, `0640`). Deine Änderungen bleiben bei Updates erhalten |
| `/var/lib/kalzit` | Der Datenordner (Datenbank, ACME-Zertifikate, Plugins), gehört `kalzit`, Modus `0700` |
| `/etc/credstore.encrypted/kalzit-secrets-key` | Der Secrets-Schlüssel, verschlüsselt mit `systemd-creds` (wo das nicht geht: `/etc/credstore/kalzit-secrets-key`, nur für root lesbar) |

Der Dienst läuft als Systemkonto `kalzit` (ohne Anmeldung, ohne Shell), das das Paket anlegt. Ein
vorhandenes Konto namens `kalzit` wird nur verwendet, wenn es ein Systemkonto ohne Anmelde-Shell
ist und seine Gruppe `kalzit` keine weiteren Mitglieder hat; sonst bricht die Installation mit
einer Meldung ab, damit Kalzits Daten nie dem Konto einer Person gehören.
Die Unit ist gehärtet: Das Dateisystem ist bis auf den Datenordner schreibgeschützt
(`ProtectSystem=strict`, `ReadWritePaths=/var/lib/kalzit`), keine neuen Privilegien, kein Zugriff
auf Home-Verzeichnisse, Geräte, Kernel-Einstellungen oder andere Prozesse, dazu ein
Systemaufruf-Filter. Sie behält, was die Plugin-Sandbox braucht (User-, IPC- und
Netzwerk-Namespaces, Landlock, seccomp); `sudo -u kalzit kalzit sandbox-check` listet die
Schutzmaßnahmen, die Plugins auf diesem System bekommen, und die Tests der Pakete prüfen, dass die
Unit keine davon wegnimmt. Ubuntu 23.10 und neuer verweigern User-Namespaces für Programme ohne ein
AppArmor-Profil, das sie erlaubt; das deb-Paket installiert daher `/etc/apparmor.d/kalzit`, das sie
für `/usr/bin/kalzit` erlaubt und sonst nichts einschränkt, und lädt es, wenn AppArmor aktiv ist
(`apt purge` löscht es). Der Dienst darf Ports unter 1024 belegen (`CAP_NET_BIND_SERVICE`), daher
funktionieren HTTPS auf 443 und HTTP auf 80 ohne root; Plugins bekommen diese Fähigkeit nie.

### Konfiguration und Secrets-Schlüssel

Bearbeite `/etc/kalzit/kalzit.toml` und starte neu: `sudo systemctl restart kalzit`. Die
Einstellungen beschreibt die [README](../../../README.md#configuration). Die Logs stehen im
Journal: `journalctl -u kalzit`.

Die erste Installation legt den Secrets-Schlüssel im Credential-Speicher des Systems an, und der
Dienst importiert ihn (`ImportCredential=`), sodass der Schlüssel weder im Datenordner noch in
einer Umgebungsvariable liegt. Er ist mit dem Credential-Schlüssel des Hosts verschlüsselt
(`/var/lib/systemd/credential.secret`), nicht mit einem TPM, daher funktioniert ein
wiederhergestelltes Backup auf anderer Hardware, wenn diese Datei mit wiederhergestellt wird.
Sichere den Schlüssel und diese Datei zusammen mit deinen Daten: Ohne den Schlüssel lassen sich die
gespeicherten Passwörter der Datenquellen nicht entschlüsseln. Ein Datenordner, der schon eine
Datenbank oder eine Schlüsseldatei enthält, behält seinen Schlüssel; das Paket ersetzt nie einen.

Um deinen eigenen Schlüssel zu verwenden, schreibe ihn vor dem ersten Start:
`openssl rand -base64 32 | sudo systemd-creds encrypt --name=kalzit-secrets-key -
/etc/credstore.encrypted/kalzit-secrets-key`. `kalzit secrets rotate` ändert ihn später (der
Dienst gestoppt, der neue Schlüssel in `KALZIT_SECRETS_NEW_KEY`, danach die Credential-Datei
ersetzt).

### Updates

Bei einer Installation aus einem Paket gehört `/usr/bin/kalzit` dem Paketmanager: **Verwaltung** >
**Updates** zeigt ein neues Release mit seinen Hinweisen und dem Befehl, der es installiert, und
weder die Weboberfläche noch `kalzit update apply` ersetzt das Programm. Lade das neue Paket für
denselben Prozessor herunter und installiere es wie das erste:

```sh
sudo apt install ./kalzit-0.5.1-linux-x64.deb   # or: sudo dnf install ./kalzit-0.5.1-linux-x64.rpm
```

Das Paket startet einen laufenden Dienst neu; die neue Version migriert die Datenbank bei ihrem
ersten Start. Sichere vorher `/var/lib/kalzit` (das Paket tut es nicht); zu Backups und PostgreSQL
siehe die [Anleitung zu Updates](../../operations/updates.md).

### Entfernen

`sudo apt remove kalzit` oder `sudo dnf remove kalzit` stoppt den Dienst, schaltet ihn ab und
entfernt das Programm. Datenordner, Konfiguration und Secrets-Schlüssel bleiben, sodass eine
spätere Installation alles wiederfindet. `sudo apt purge kalzit` löscht zusätzlich
`/var/lib/kalzit`, `/etc/kalzit` und den Secrets-Schlüssel; rpm kennt kein purge, dort löschst du
sie von Hand:

```sh
sudo rm -rf /var/lib/kalzit /etc/kalzit
sudo rm -f /etc/credstore.encrypted/kalzit-secrets-key /etc/credstore/kalzit-secrets-key
```

Das Konto `kalzit` bleibt in beiden Fällen (`sudo userdel kalzit` entfernt es).

## Docker

Das Image `ghcr.io/mousewerk/kalzit` ist für Linux auf amd64 und arm64 gebaut. Unter Windows und
macOS läuft es in Docker Desktop (unter Windows mit dem WSL2-Backend, das das Linux-Image
ausführt).

| Tag | Was es ist |
|---|---|
| `0.2.0` | Genau dieses Release |
| `0.2` | Das neueste Release von 0.2 |
| `latest` | Das neueste stabile Release (Vorabversionen wie `0.3.0-rc.1` haben nur ihr eigenes Tag) |

Lege für Server, auf die du dich verlässt, eine Version fest (`0.2.0` oder `0.2`), damit ein Update
dann passiert, wenn du es entscheidest.

### Starten

```sh
docker run -d --name kalzit --restart unless-stopped \
  -p 3000:3000 \
  -v kalzit-data:/var/lib/kalzit \
  ghcr.io/mousewerk/kalzit:0.2
```

Kalzit lauscht im Container auf Port 3000; veröffentliche ihn auf einem beliebigen Port des Hosts
(`-p 8080:3000`). Öffne `http://localhost:3000` (oder den gewählten Port des Hosts).

### Erster Start

Beim ersten Start schreibt Kalzit einen einmaligen **Einrichtungscode** in den Datenordner, und
das Log sagt, wo er liegt. Das Image hat keine Shell, gib ihn daher mit Kalzit selbst aus:

```sh
docker exec kalzit kalzit setup-code
```

Gib den Code auf der Einrichtungsseite ein; er wird in einem eigenen Schritt geprüft, bevor du das
Eigentümer-Konto anlegst und die Organisation benennst, wie in
[Erste Schritte](getting-started.md#einrichtung) beschrieben. Sobald der Eigentümer existiert, ist
der Code verbraucht. Jeder Neustart davor erzeugt einen neuen Code, und die Seite unterscheidet
einen alten Code von einem falschen. Um den Code selbst zu wählen (für automatisierte
Installationen), setze `KALZIT_SETUP_TOKEN` auf mindestens 16 Buchstaben oder Ziffern; die
Einrichtungsseite verweist dann auf diese Variable.

Bevor sich jemand anmeldet, nennt die Einrichtungsseite nur die Standardpfade (`/var/lib/kalzit`
unter Linux und im Image, `C:\ProgramData\Kalzit\data` unter Windows) und den Docker-Befehl, nie
die Pfade, die dieser Server tatsächlich verwendet.

### Daten und das Volume

Alles, was Kalzit aufbewahrt, liegt in `/var/lib/kalzit`, einem Volume: die SQLite-Datenbank, der
Einrichtungscode, die Ersatz-Schlüsseldatei, der Update-Zustand und die Beispieldatenbank
(`samples/`, geschrieben, wenn jemand die Beispieldaten hinzufügt). Lege es in ein benanntes Volume
(`kalzit-data` oben); ein neues benanntes Volume übernimmt den richtigen Eigentümer und Modus aus
dem Image.

- Der Container läuft als fester Benutzer und feste Gruppe **65532:65532**, nicht als root.
  Laufzeitumgebungen, die Container mit einer beliebigen Benutzer-ID starten (OpenShift, rootless
  Podman mit User-Namespaces), brauchen ein Volume, das diesem Benutzer gehört, mit Modus 0700:
  gib dem Pod eine `fsGroup` oder übertrage das Volume mit `chown` an den Benutzer, als der er
  läuft.
- Kalzit lehnt einen Datenordner ab, den andere lesen dürfen: Ein Bind-Mount muss 65532 gehören
  und Modus 0700 haben, zum Beispiel `sudo install -d -o 65532 -g 65532 -m 0700 /srv/kalzit`,
  dann `-v /srv/kalzit:/var/lib/kalzit`.
- Verwende unter Docker Desktop für Windows und macOS ein benanntes Volume. Ein Ordner des Windows-
  oder macOS-Hosts trägt keine Linux-Eigentümer und -Modi, und Kalzit lehnt eine Datenbank auf
  einem Netzwerk- oder gemeinsam genutzten Dateisystem ab.
- Sichere das Volume wie unter [Sichern und wiederherstellen](backup.md) beschrieben, zusammen mit
  dem Secrets-Schlüssel (unten).

### Konfiguration

Einstellungen kommen aus Umgebungsvariablen `KALZIT_<SECTION>_<KEY>`, aus einer `kalzit.toml` oder
aus beidem (die Variablen gewinnen). Binde die Datei schreibgeschützt unter
`/etc/kalzit/kalzit.toml` ein:

```sh
docker run -d --name kalzit -p 3000:3000 \
  -v kalzit-data:/var/lib/kalzit \
  -v "$PWD/kalzit.toml:/etc/kalzit/kalzit.toml:ro" \
  -e KALZIT_SERVER_PUBLIC_URL=https://kalzit.example.com \
  -e KALZIT_LOG_FORMAT=json \
  ghcr.io/mousewerk/kalzit:0.2
```

Das Image setzt keine eigene Konfiguration: Es gelten die Standardwerte (`server.http_addr`
`0.0.0.0:3000`, Datenordner `/var/lib/kalzit`). Hinter einem Reverse Proxy setzt du
`server.public_url` auf die Adresse, die die Benutzer öffnen, und trägst das Netz des Proxys in
`security.trusted_proxies` ein. Alle Einstellungen stehen in der
[README](../../../README.md#configuration). Eine Umgebungsvariable, die gesetzt, aber leer ist,
hebt den Wert aus der Datei auf; lass also die weg, die du nicht verwendest.

### Secrets-Schlüssel

Kalzit verschlüsselt Passwörter und Tokens von Datenquellen mit einem Schlüssel. In einem Container
kommt er, in dieser Reihenfolge, aus:

1. der Umgebungsvariable `KALZIT_SECRETS_KEY` (Base64 von 32 Bytes);
2. einem **Docker Secret** namens `kalzit-secrets-key`, eingebunden unter
   `/run/secrets/kalzit-secrets-key` (das Image liest `/run/secrets` wie systemd-Credentials):
   32 Bytes oder deren Base64. Das ist die bessere Wahl: Ein Secret taucht nicht in
   `docker inspect` auf;
3. sonst einer Schlüsseldatei `secrets.key` im Volume, mit einer Warnung im Log.

Erzeuge einen Schlüssel mit `openssl rand -base64 32`. Der Schlüssel ist nie Teil des Images.
Bewahre eine Kopie bei deinen Backups auf: Ohne ihn lassen sich die gespeicherten Geheimnisse der
Datenquellen nicht entschlüsseln. Unter Linux muss die Secret-Datei im Container für Benutzer 65532
lesbar sein (Compose bindet sie so ein, wie sie auf dem Host ist):
`sudo chown 65532 secrets/kalzit-secrets-key && sudo chmod 0400 secrets/kalzit-secrets-key`.

**Den Schlüssel ändern.** Ein Docker Secret ist im Container schreibgeschützt, daher kann Kalzit
es nicht selbst ersetzen; `kalzit secrets rotate` verschlüsselt die gespeicherten Geheimnisse mit
einem neuen Schlüssel, den du ihm gibst, und du tauschst die Datei danach aus. Mit Compose (füge
jedem `docker compose` ein `-f` mit der Datei hinzu, mit der du gestartet hast, zum Beispiel
`-f compose.postgres.yaml`):

```sh
openssl rand -base64 32 > secrets/kalzit-secrets-key.new
docker compose stop kalzit
docker compose run --rm -e KALZIT_SECRETS_NEW_KEY="$(cat secrets/kalzit-secrets-key.new)" \
  kalzit secrets rotate
mv secrets/kalzit-secrets-key secrets/kalzit-secrets-key.old
mv secrets/kalzit-secrets-key.new secrets/kalzit-secrets-key   # same owner and mode as before
docker compose up -d kalzit
```

Behalte den alten Schlüssel, solange du Backups von vor der Änderung aufbewahrst; sie brauchen ihn.

### Datenbank-URL

Mit PostgreSQL als Kalzits eigener Datenbank enthält die URL das Datenbankpasswort. Statt
`KALZIT_DATABASE_URL`, das `docker inspect` anzeigt, gibst du Kalzit die URL in einer Datei, in
dieser Reihenfolge:

1. `KALZIT_DATABASE_URL`, wenn es gesetzt und nicht leer ist;
2. die Datei, die `KALZIT_DATABASE_URL_FILE` nennt;
3. ein **Docker Secret** namens `kalzit-database-url` (`/run/secrets/kalzit-database-url`);
4. `database.url` in `kalzit.toml`.

Die Datei enthält eine Zeile, `postgres://kalzit:<password>@postgres:5432/kalzit`. Zeichen mit
einer Bedeutung in einer URL werden im Passwort prozentkodiert (`/` als `%2F`, `@` als `%40`, `+`
als `%2B`); ein Passwort aus `openssl rand -hex 24` braucht keine. Das Log zeigt die URL mit `***`
statt des Passworts, und SQLite-Datenquellen dürfen die Datei nicht lesen. Wie der Schlüssel muss
die Datei für Benutzer 65532 lesbar sein.

### Compose

[deploy/docker](../../../deploy/docker) enthält zwei Compose-Dateien und eine `example.env`:

| Datei | Kalzits eigene Datenbank |
|---|---|
| `compose.sqlite.yaml` | SQLite im benannten Volume `kalzit-data` |
| `compose.postgres.yaml` | PostgreSQL 17 in einem eigenen Dienst mit Health-Check; Kalzit startet, sobald die Datenbank gesund ist |

```sh
cd deploy/docker
cp example.env .env               # image, version and port
mkdir -p secrets
openssl rand -base64 32 > secrets/kalzit-secrets-key
password=$(openssl rand -hex 24)  # PostgreSQL only
printf '%s' "$password" > secrets/postgres-password
printf 'postgres://kalzit:%s@postgres:5432/kalzit\n' "$password" > secrets/kalzit-database-url
sudo chown 65532 secrets/kalzit-secrets-key secrets/kalzit-database-url   # Linux
sudo chmod 0400 secrets/kalzit-secrets-key secrets/kalzit-database-url
docker compose -f compose.postgres.yaml up -d
docker compose -f compose.postgres.yaml exec kalzit kalzit setup-code
```

Beide Dateien verwenden das Docker Secret `kalzit-secrets-key`. Mit PostgreSQL steht das
Datenbankpasswort in keiner Umgebungsvariable: PostgreSQL liest es aus dem Secret
`postgres-password` (`POSTGRES_PASSWORD_FILE`), Kalzit liest die ganze URL aus dem Secret
`kalzit-database-url`. `.env` und `secrets/` werden nicht eingecheckt. Kalzit kann PostgreSQL nicht
für dich sichern: Verwende `pg_dump` und sichere den Schlüssel mit.

### Health-Check und Stoppen

Der Health-Check des Images führt `kalzit healthcheck` aus, das `/readyz` am einfachen
HTTP-Listener im Container abfragt und besteht, wenn die Datenbank antwortet. `docker ps` zeigt den
Container wenige Sekunden nach dem Start als `healthy`. Es ist eine Bereitschaftsprüfung: Solange
Kalzits eigene Datenbank nicht erreichbar ist, wird der Container `unhealthy`, und ein
Orchestrator, der ungesunde Container neu startet, startet Kalzit neu. Wenn du einfaches HTTP
abschaltest (`server.http_addr = ""`), schlägt der Health-Check fehl; lass HTTP an (mit
`server.redirect_http_to_https` bleiben `/healthz` und `/readyz` über HTTP erreichbar) oder ersetze
den Health-Check in deiner Compose-Datei.

`docker stop` sendet SIGTERM: Kalzit nimmt keine Anfragen mehr an, gibt offenen 10 Sekunden und
schließt die Datenbank sauber. Dockers Standard von 10 Sekunden, bevor es den Prozess beendet, ist
knapp; die Compose-Dateien erlauben 30 (`stop_grace_period`), und `docker stop --time 30` tut
dasselbe.

### Updates

Der eingebaute Updater ersetzt das Programm in einem Container nicht: **Verwaltung** >
**Updates** zeigt, dass ein Release verfügbar ist, und sagt, dass du stattdessen das Image
aktualisieren sollst. Sichere das Volume (und die PostgreSQL-Datenbank), hole dann die neue
Version und erstelle den Container neu:

```sh
docker pull ghcr.io/mousewerk/kalzit:0.2
docker rm -f kalzit
docker run -d --name kalzit ...   # the same command as before
```

Mit Compose: `docker compose pull && docker compose up -d`. Die neue Version migriert die
Datenbank bei ihrem ersten Start. Um zurückzugehen, starte das Tag der vorherigen Version mit dem
Backup, das du vor dem Update gemacht hast.

### Die Signatur des Images prüfen

Ab 0.6.0 ist jedes veröffentlichte Image vom Release-Workflow mit
[Sigstore cosign](https://docs.sigstore.dev) signiert, ohne eigenen Schlüssel: Die Signatur nennt
den Workflow und das Tag, für das er lief, und ist im öffentlichen Transparenz-Log von Sigstore
verzeichnet. Der Release-Workflow signiert mit cosign 3.0.6; zum Prüfen brauchst du cosign 3.0
oder neuer. Prüfe es, bevor du eine neue Version startest:

```sh
cosign verify ghcr.io/mousewerk/kalzit:0.6.0 \
  --certificate-identity https://github.com/MouseWerk/Kalzit/.github/workflows/release.yml@refs/tags/v0.6.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Es gibt den signierten Digest aus; lege diesen Digest fest (`ghcr.io/mousewerk/kalzit@sha256:...`),
wo du genau das geprüfte Image willst. Ein anderes Image oder eines, das anderswo gebaut wurde,
besteht die Prüfung nicht.

Die beweglichen Tags `latest` und `<major>.<minor>` (`0.6`) zeigen auf das Image eines Release, und
dieses Image wurde für sein eigenes Versions-Tag signiert. Prüfe sie mit der Identität des Release,
auf das sie zeigen: `cosign verify ghcr.io/mousewerk/kalzit:0.6 --certificate-identity
https://github.com/MouseWerk/Kalzit/.github/workflows/release.yml@refs/tags/v0.6.1 ...`, wenn `0.6`
gerade 0.6.1 ist. Mit der Identität einer anderen Version schlägt die Prüfung fehl, was zeigt,
welches Release ein bewegliches Tag enthält.

### Das Image bauen

Aus einem Checkout des Repositorys:

```sh
docker build -t kalzit .
docker buildx build --platform linux/amd64,linux/arm64 -t kalzit .
```

Der Build kompiliert die Weboberfläche und den Server; der Server wird für die andere Architektur
cross-kompiliert, daher braucht ein Multi-Architektur-Build keine Emulation. Build-Argumente:
`CARGO_BUILD_JOBS` begrenzt die parallelen Kompilierjobs, `KALZIT_BUILD_COMMIT` und
`KALZIT_BUILD_DATE` setzen, was **Einstellungen** > **Über Kalzit** anzeigt (der Build hat keinen
Git-Verlauf).

## Windows

Unter Windows läuft Kalzit als Windows-Dienst **Kalzit** unter einem eigenen virtuellen Konto,
`NT SERVICE\Kalzit`. Das MSI-Paket richtet alles ein; `kalzit service install` tut dasselbe ohne
es.

### Mit dem MSI-Paket installieren

1. Lade `kalzit-<version>-windows-x64.msi` von den
   [Releases](https://github.com/MouseWerk/Kalzit/releases) herunter. Seine SHA-256 steht in
   `kalzit-<version>-manifest.json` desselben Release, das mit Kalzits Release-Schlüssel signiert
   ist: `Get-FileHash kalzit-<version>-windows-x64.msi` muss denselben Wert zeigen.
2. Führe es aus (es fragt nach Administratorrechten). Der Assistent zeigt die Lizenz (die AGPL,
   die du nicht akzeptieren musst) und fragt nach:

   | Seite | Einstellung | Standard |
   |---|---|---|
   | Programmordner | wohin `kalzit.exe` kommt | `C:\Program Files\Kalzit` |
   | Servereinstellungen | HTTP-Port | `3000` |
   | | Datenordner | `%ProgramData%\Kalzit\data` |
   | | HTTPS: aus, ein selbstsigniertes Zertifikat für diesen Computer oder ein vorhandenes Zertifikat (PEM-Dateien) | aus |
   | | HTTPS-Port, Zertifikatsdatei und Schlüsseldatei | `3443` |
   | | Port(s) in der Windows Defender Firewall öffnen | nicht angehakt |

   Der Assistent ist auf Deutsch, wenn Windows Deutsch anzeigt, sonst auf Englisch; um auf
   beliebigem Windows Deutsch zu wählen, starte ihn mit
   `msiexec /i kalzit-<version>-windows-x64.msi TRANSFORMS=:1031`.

3. Die letzte Seite einer Erstinstallation hat **Einrichtung im Browser öffnen**, standardmäßig
   angehakt: **Fertig stellen** öffnet `http://localhost:3000/setup` (oder den gewählten Port)
   oder `https://localhost:3443/setup` (oder den gewählten HTTPS-Port), wenn du HTTPS gewählt hast.
   Der Einrichtungscode ist nicht Teil dieses Links: Die Abschlussseite läuft ohne
   Administratorrechte und kann ihn nicht lesen.
   Der Code steht in `setup-token.txt` im Datenordner, den nur Administratoren öffnen können; ein
   normal gestarteter Editor oder Explorer wird abgewiesen (Windows meldet, dass du keine Rechte
   zum Öffnen der Datei hast). Öffne PowerShell mit **Als Administrator ausführen** und gib einen
   dieser Befehle ein (die Einrichtungsseite zeigt beide mit einer Kopieren-Schaltfläche):

   ```powershell
   Get-Content "C:\ProgramData\Kalzit\data\setup-token.txt"
   & "C:\Program Files\Kalzit\kalzit.exe" setup-code
   ```

   `kalzit setup-code` liest den Datenordner aus `kalzit.toml`, funktioniert also auch mit einem
   eigenen Datenordner; mit `--url` gibt es die Adresse der Einrichtungsseite mit dem Code in ihrem
   Fragment aus (`#code=...`), das den Code ausfüllt, wenn du sie auf diesem Computer öffnest, und
   nie den Server erreicht. Der Link zeigt auf die eigene Adresse des Listeners (`localhost`, außer
   Kalzit ist an eine IP gebunden) oder auf `server.public_url`; über HTTPS warnt der Browser, außer
   das Zertifikat nennt diesen Host. Der Browser-Verlauf kann die `#code=`-Adresse behalten, bis die
   Einrichtung abgeschlossen ist; danach ist der Code wertlos. Weiter geht es mit
   [Erste Schritte](getting-started.md#einrichtung).

Was das Paket einrichtet:

- `kalzit.exe` im Programmordner. Nur Administratoren und SYSTEM dürfen den Ordner ändern (mit
  `SELFUPDATE=1` auch das Konto des Dienstes); alle dürfen das Programm ausführen. Der Ordner wird
  nicht zum `PATH` hinzugefügt: Rufe `kalzit.exe` mit seinem vollständigen Pfad auf. Die eigenen
  Schritte des Installers laufen aus einer Kopie des Programms im Paket, nie aus der installierten
  Datei.
- Der Dienst `Kalzit` (automatischer Start, Konto `NT SERVICE\Kalzit`) mit einem einzigen
  Privileg, `SeChangeNotifyPrivilege`: kein Impersonieren, sodass ein kompromittierter Dienst sich
  nicht zu SYSTEM machen kann. Nach einem Fehler startet der Dienststeuerungs-Manager ihn erneut
  (nach 2 s, 5 s, dann alle 30 s).
- `%ProgramData%\Kalzit\kalzit.toml` mit deinen Einstellungen. Alle dürfen sie lesen, nur
  Administratoren ändern.
- Der Datenordner, mit Zugriff nur für Administratoren und das Konto des Dienstes. Er enthält die
  Datenbank, den Einrichtungscode, den Schlüssel für gespeicherte Passwörter (`secrets.key.dpapi`,
  mit DPAPI für diesen Computer geschützt), das Log und, mit einem selbstsignierten Zertifikat,
  `tls\`.
- Mit „Vorhandenes Zertifikat“ darf das Konto des Dienstes die beiden Dateien dort lesen, wo sie
  liegen. Ein erneuertes Zertifikat, das darüber gespeichert wird, wirkt innerhalb einer Minute,
  ohne Neustart. Beide müssen Dateien sein, die nur Administratoren ändern dürfen, der Schlüssel
  zudem eine, die nur sie lesen dürfen, in Ordnern, die andere nicht umbenennen können (ein
  Schlüssel unter `C:\` oder einer, den Users lesen dürfen, wird abgelehnt); sonst schränke sie ein
  oder kopiere sie in einen Ordner, den nur Administratoren öffnen können.
- Mit angehakter Firewall eine eingehende Regel namens `Kalzit` für den Port oder die Ports.

Ein selbstsigniertes Zertifikat (`<data folder>\tls\self-signed.crt.pem`) lässt Browser warnen,
bis du ihm auf jedem Computer vertraust, der Kalzit öffnet; für mehr als einen Test verwende ein
Zertifikat deiner eigenen Zertifizierungsstelle oder einer öffentlichen.

Wenn `%ProgramData%\Kalzit\kalzit.toml` schon existiert (eine frühere Installation), behält das
Paket sie und überspringt die Seite mit den Einstellungen.

Der Installer übernimmt nichts, was jemand anderes vorbereitet haben könnte, da der Dienst es
ausführen, wiederherstellen oder ausliefern würde. Die Installation bricht ab, und die Meldung im
Log des Installers und im Ereignisprotokoll sagt was, wenn:

- `%ProgramData%\Kalzit` existiert, aber andere als Administratoren es ändern dürfen, oder
  `kalzit.toml` nicht von einem Administrator geschrieben wurde;
- der Datenordner existiert, aber jemand anderem eine Datei oder ein Ordner darin gehört oder
  jemand anderes sie öffnen darf, oder er einen Link oder eine Junction enthält;
- der Datenordner ein Laufwerksstamm oder ein Systemordner ist (Windows, Program Files,
  `%ProgramData%` selbst, `C:\Users`) oder im Programmordner liegt;
- ein Ordner oberhalb des Datenordners, des Programmordners oder des Zertifikats anderen erlaubt,
  seinen Inhalt umzubenennen oder zu entfernen (Ordner, die direkt unter `C:\` angelegt wurden,
  sind so, `C:\Program Files` und `%ProgramData%` nicht);
- der Programmordner etwas anderes als Kalzits Dateien enthält oder andere ihn ändern dürfen.

Schiebe einen solchen Ordner beiseite (oder korrigiere seine Zugriffsliste) und installiere erneut.

### Mit winget installieren

Stabile Releases gibt es auch in winget, als `MouseWerk.Kalzit`. In einer PowerShell mit
Administratorrechten:

```powershell
winget install MouseWerk.Kalzit
winget install MouseWerk.Kalzit --override "/qn PORT=8080 FIREWALL=1"
winget upgrade MouseWerk.Kalzit
```

winget lädt dasselbe MSI-Paket aus dem GitHub-Release, prüft seine SHA-256 und installiert es
still mit den Standardwerten; `--override` übergibt stattdessen die Eigenschaften einer stillen
Installation (unten). Ein neues Release kann ein paar Tage brauchen, bis es in winget erscheint.

### Stille Installation

Jede Einstellung ist eine MSI-Eigenschaft:

```powershell
msiexec /i kalzit-0.5.0-windows-x64.msi /qn /l*v kalzit-install.log PORT=8080 FIREWALL=1
msiexec /i kalzit-0.5.0-windows-x64.msi /qn HTTPS=certificate HTTPSPORT=443 `
  CERTFILE="C:\certs\kalzit.pem" KEYFILE="C:\certs\kalzit.key" DATADIR="D:\Kalzit"
```

| Eigenschaft | Bedeutung | Standard |
|---|---|---|
| `INSTALLFOLDER` | Programmordner | `C:\Program Files\Kalzit` |
| `PORT` | HTTP-Port | `3000` |
| `DATADIR` | Datenordner (absoluter Pfad) | `%ProgramData%\Kalzit\data` |
| `HTTPS` | `off`, `self-signed` oder `certificate` | `off` |
| `HTTPSPORT` | HTTPS-Port | `3443` |
| `CERTFILE`, `KEYFILE` | Zertifikatskette und privater Schlüssel (PEM) für `HTTPS=certificate` | |
| `FIREWALL` | `1` öffnet den Port oder die Ports in der Windows Defender Firewall | nicht gesetzt |
| `SELFUPDATE` | `0`: Der Programmordner bleibt nur für Administratoren, und Updates kommen mit einem neuen MSI-Paket; `1`: Das Konto des Dienstes darf `kalzit.exe` ersetzen, sodass der eingebaute Updater selbst installiert (siehe den Hinweis unten) | `0` |
| `REMOVEDATA` | beim Deinstallieren: `1` entfernt auch den Datenordner und `kalzit.toml` | nicht gesetzt |

**`SELFUPDATE=1` und sein Risiko.** Damit darf das Konto des Dienstes `kalzit.exe` und was daneben
liegt ändern. Sollte der Dienst je übernommen werden, könnte der Angreifer Code ändern, den später
ein Administrator mit vollen Rechten ausführt, und so selbst Administrator werden. Kalzit lädt DLLs
nur aus System32, und der Installer führt nie die installierte Datei aus, aber ein Administrator,
der diese `kalzit.exe` mit erhöhten Rechten startet (für `kalzit update`, `kalzit setup-code`,
`kalzit service`), führt aus, was das Konto des Dienstes dort hinterlassen hat. Mit
`SELFUPDATE=1` führe das installierte Programm nicht mit erhöhten Rechten aus: Lies den
Einrichtungscode aus `setup-token.txt`, und verwende für die Arbeit auf der Kommandozeile eine aus
dem Release heruntergeladene `kalzit.exe`. Mit `SELFUPDATE=0` (dem Standard) ist das Ausführen mit
erhöhten Rechten sicher.

Mit einer vorhandenen `kalzit.toml` werden `PORT`, `DATADIR` und die HTTPS-Eigenschaften nicht
verwendet. Werte dürfen kein Anführungszeichen (`"`) enthalten. Die Einstellungen werden bei der
Erstinstallation und bei Upgrades gelesen, nie bei einer Reparatur. Wenn etwas schiefgeht, sagen
das Log (`/l*v`) und das Windows-Ereignisprotokoll (Ereignisanzeige, Windows-Protokolle, Anwendung,
Quelle `Kalzit`), was.

### Ohne das MSI-Paket

`kalzit service` richtet denselben Dienst für eine `kalzit.exe` ein, die du selbst kopiert hast.
Kopiere sie allein in einen eigenen Ordner, den nur Administratoren ändern können, etwa
`C:\Program Files\Kalzit` (Kalzit lehnt einen Ordner ab, den andere ändern dürfen oder in dem
andere Dateien liegen, da der Dienst ausführt, was darin ist), dann in einer Eingabeaufforderung
mit Administratorrechten:

```powershell
& "C:\Program Files\Kalzit\kalzit.exe" service install --port 3000 --open-firewall
```

| Befehl | Was er tut |
|---|---|
| `kalzit service install` | legt den Dienst für diese `kalzit.exe` an, registriert die Ereignisprotokoll-Quelle `Kalzit`, schreibt `kalzit.toml` (falls sie nicht existiert), sichert den Datenordner ab und startet den Dienst. Optionen wie die Eigenschaften oben: `--port`, `--data-dir`, `--https` (`off`, `self-signed` oder `certificate`), `--https-port`, `--cert-file`, `--key-file`, `--open-firewall`, `--self-update 1` (standardmäßig aus, siehe den Hinweis zu `SELFUPDATE`); `--no-start` richtet ein, ohne zu starten; `--config` verwendet eine andere Konfigurationsdatei als `%ProgramData%\Kalzit\kalzit.toml` |
| `kalzit service uninstall` | stoppt und entfernt den Dienst, seine Ereignisprotokoll-Quelle und die Firewall-Regel; die Daten und `kalzit.toml` bleiben. `--remove-data` entfernt sie auch |
| `kalzit service run` | was der Dienststeuerungs-Manager startet; in einer Konsole verwende `kalzit serve` |

Mische die beiden Wege nicht: Deinstalliere eine MSI-Installation unter Einstellungen, Apps, und
ein `kalzit service install` mit `kalzit service uninstall`.

### Den Dienst betreiben

- Starte, stoppe und starte ihn neu in der App „Dienste“ oder in einer PowerShell mit
  Administratorrechten mit `Start-Service Kalzit`, `Stop-Service Kalzit` und
  `Restart-Service Kalzit`. Beim Stoppen werden offene Anfragen beendet (bis zu 10 Sekunden) und
  die Datenbank sauber geschlossen.
- Das Log ist `<data folder>\logs\kalzit.log` (alle 10 MB eine neue Datei, drei ältere bleiben).
- Seine Fehler sind auch im Windows-Ereignisprotokoll vermerkt (Ereignisanzeige,
  Windows-Protokolle, Anwendung, Quelle `Kalzit`), wo Überwachungswerkzeuge, die das
  Ereignisprotokoll beobachten, sie finden. Jeder lokale Benutzer kann das Anwendungsprotokoll
  lesen, und es wird oft an andere Systeme weitergeleitet, während `kalzit.log` nur für
  Administratoren und den Dienst lesbar ist. Ein Eintrag dort ist daher ein kurzer, fester
  Hinweis: die Stufe, wo in Kalzit es passiert ist, und der Ordner von `kalzit.log`, etwa
  `Error in kalzit::server. See kalzit.log in C:\ProgramData\Kalzit\data\logs for the details.`
  Der Fehlertext selbst, mit Adressen, Pfaden, Abfragen, Benutzer-IDs oder dem Grund einer
  Ablehnung, bleibt in `kalzit.log`; Abstürze (Panics) werden genauso protokolliert. Eine
  `kalzit.toml`, die sich nicht laden lässt, wird nur mit Zeile und Spalte gemeldet, nie mit der
  Zeile selbst (sie kann ein Passwort oder eine Datenbank-URL enthalten); `kalzit check-config`
  als Administrator zeigt dir den ganzen Fehler. Lässt sich `kalzit.log` nicht schreiben, sagt
  das ein Eintrag mit Pfad und Grund, die Meldungen des Starts folgen mit ihrem Text (damit du
  einen fehlgeschlagenen Start untersuchen kannst), und sobald Kalzit Anfragen bedient, nur noch
  die kurzen Hinweise. Höchstens 10 Einträge pro Minute kommen von derselben Stelle; der nächste nach
  einer Pause sagt, wie viele ausgelassen wurden. `log.event_log` in `kalzit.toml` (oder
  `KALZIT_LOG_EVENT_LOG`) wählt, was dort landet: `"errors"` (der Standard), `"warnings"` (auch
  Warnungen) oder `"off"`.
- Das MSI-Paket und `kalzit service install` registrieren die Ereignisquelle `Kalzit`; das
  Deinstallieren entfernt sie, bereits geschriebene Einträge bleiben. Die Quelle verwendet die
  Meldungsdatei von .NET Framework 4, die jedes Desktop- und Server-Windows hat, aber nicht Nano
  Server: Dort zeigt die Ereignisanzeige die Einträge mit dem Hinweis, dass die Beschreibung nicht
  gefunden wird, gefolgt vom Text.
- Um eine Einstellung zu ändern, bearbeite `%ProgramData%\Kalzit\kalzit.toml` als Administrator und
  starte den Dienst neu. Alle Einstellungen stehen in der
  [README](../../../README.md#configuration). Alle am Computer dürfen die Datei lesen, schreibe also
  keine Geheimnisse hinein: Gib eine PostgreSQL-URL mit Passwort in einer Datei an, die
  `KALZIT_DATABASE_URL_FILE` nennt und die nur Administratoren und der Dienst lesen dürfen. Kalzit
  warnt in seinem Log und unter Einstellungen, Über Kalzit (für Server-Admins), wenn
  `database.url` in der Datei ein Passwort enthält.
- Der Schlüssel für gespeicherte Passwörter ist `secrets.key.dpapi` im Datenordner, den nur dieser
  Computer entschlüsseln kann: Sichere den Datenordner als Ganzes
  ([Sichern und wiederherstellen](backup.md)), und gib nach dem Wiederherstellen auf einem anderen
  Computer die Passwörter der Datenquellen erneut ein.

### Updates

- **Ein neueres MSI-Paket** (der Standardweg) installiert über das vorherige: Der Dienst stoppt,
  das Programm wird ersetzt, der Dienst startet wieder; `kalzit.toml` und die Daten bleiben. Die
  neue Version migriert die Datenbank bei ihrem ersten Start, ohne das Backup und die automatische
  Rückkehr des Updaters, sichere also vorher den Datenordner
  ([Sichern und wiederherstellen](backup.md)). Ein älteres Paket als das installierte wird
  abgelehnt. Die Seite Updates (Verwaltung > Updates) sagt dir, wenn ein Release erschienen ist;
  sie kann es auch für `kalzit update apply` aus einer Eingabeaufforderung mit Administratorrechten
  herunterladen und prüfen (`Stop-Service Kalzit`,
  `& "C:\Program Files\Kalzit\kalzit.exe" update apply`, `Start-Service Kalzit`).
- **Der eingebaute Updater installiert selbst** nur mit `SELFUPDATE=1` (siehe den Hinweis zu
  seinem Risiko oben): Er stoppt den Dienst geordnet, sichert die Datenbank, legt die neue
  `kalzit.exe` an ihren Platz, und der Dienststeuerungs-Manager startet sie wieder. Meldet die neue
  Version sich nicht als gesund, kehrt Kalzit mit dem Backup zur vorherigen zurück
  ([Anleitung zu Updates](../../operations/updates.md)). Einstellungen, Apps zeigt weiter die
  Version, die das MSI-Paket installiert hat; die Seite Updates zeigt die, die läuft.

### Deinstallieren

- Einstellungen, Apps, Kalzit, **Deinstallieren** entfernt das Programm, den Dienst und die
  Firewall-Regel. Der Datenordner und `kalzit.toml` bleiben, sodass eine spätere Installation alles
  wiederfindet.
- Um auch die Daten zu entfernen, führe das MSI-Paket erneut aus, wähle **Entfernen** und hake
  „Auch Datenordner und Konfiguration löschen (endgültig)“ an, oder führe
  `msiexec /x kalzit-<version>-windows-x64.msi REMOVEDATA=1` aus. Das lässt sich nicht rückgängig
  machen. Ein Datenordner, der andere Dateien als Kalzits enthält (oder ein Laufwerksstamm), hinter
  einem Link oder einer Junction liegt oder in einem Ordner liegt, den andere ändern dürfen, bleibt
  stehen.

### Signierte Pakete

Release-Pakete werden mit der Code-Signatur des Projekts signiert (Microsoft Artifact Signing oder
ein Code-Signing-Zertifikat), wenn sie für das Release eingerichtet ist; Windows nennt dann vor der
Installation den Herausgeber. Unsignierte Pakete sagen das in den Release Notes, und Windows
SmartScreen kann warnen („Der Computer wurde durch Windows geschützt“): Vergleiche die SHA-256 wie
oben mit dem signierten Manifest, wähle dann „Weitere Informationen“ und „Trotzdem ausführen“.
