[English](../upgrading.md) | Deutsch

# Aktualisieren

Wie du einen Kalzit-Server auf ein neues Release bringst, je nachdem, wie er installiert wurde. Die
Einzelheiten des eingebauten Updaters (Signaturen, der Probestart, die Rückkehr zu einer früheren
Version, Offline-Pakete) stehen im [Update-Leitfaden](../../operations/updates.md); mehrere Server
auf einer Datenbank werden nacheinander aktualisiert
([Betriebsleitfaden](../../operations/high-availability.md#rolling-updates)).

## Vor jedem Update

1. **Lies die Release Notes** jeder Version zwischen deiner und der neuen
   ([docs/releases](../../releases)). Ein Release, dessen Notes „stop every server“ sagen, darf
   nicht neben einer älteren Version auf derselben Datenbank laufen.
2. **Sichere** die Datenbank, den Secrets-Schlüssel und den Datenordner
   ([Sichern und wiederherstellen](backup.md)). Der eingebaute Updater sichert eine
   SQLite-Datenbank selbst; die Pakete, das MSI und ein neues Container-Image tun das nicht, und
   PostgreSQL sichert Kalzit nie.
3. **Wähle eine ruhige Zeit.** Kalzit startet neu, was alle kurz unterbricht; Verwaltung > Updates
   zeigt, wie viele Personen in den letzten 30 Minuten aktiv waren.

Die neue Version migriert die Datenbank bei ihrem ersten Start. Ein Release kann eine
Mindestversion nennen, von der aus aktualisiert werden darf; auf einem älteren Server lehnt der
Updater ein solches Release ab. Eine ältere Version kann keine Datenbank öffnen, die eine neuere
migriert hat: Zurück geht es nur mit der vorher angelegten Sicherung oder mit der eigenen Rückkehr
des Updaters (unten).

## Nach Installationsart

| Installiert mit | Aktualisieren mit |
|---|---|
| deb- oder rpm-Paket | Dem neuen Paket für denselben Prozessor: `sudo apt install ./kalzit-<version>-linux-x64.deb` oder `sudo dnf install ./kalzit-<version>-linux-x64.rpm` (`arm64` auf ARM). Das Paket startet den Dienst neu. Verwaltung > Updates zeigt den Befehl, installiert aber nie selbst ([Installation](installation.md#updates)) |
| MSI unter Windows | Dem neuen MSI über dem installierten; Einstellungen und Daten bleiben, und der Dienst startet wieder. Mit `SELFUPDATE=1` kann Verwaltung > Updates selbst installieren ([Installation](installation.md#updates-2)) |
| Container-Image | Den neuen Tag ziehen und den Container neu erstellen (`docker compose pull && docker compose up -d`); der Updater ersetzt nie das Programm eines Containers ([Installation](installation.md#updates-1)) |
| Einfache Binärdatei unter Linux | Stoppen, Binärdatei ersetzen, starten; oder Verwaltung > Updates installieren lassen, wenn die Binärdatei dem Konto gehört, unter dem der Dienst läuft ([Linux ohne Paket](linux-binary.md#updates)) |
| Aus dem Quellcode gebaut | Den neuen Tag bauen und die Binärdatei bei gestopptem Dienst ersetzen |

## Mit dem eingebauten Updater

Wo Kalzit sein eigenes Programm ersetzen darf (eine einfache Binärdatei, die dem Konto gehört, unter
dem der Dienst läuft, oder der Windows-Dienst mit `SELFUPDATE=1`), unter **Verwaltung** > **Updates**:

1. **Jetzt suchen**, dann **Herunterladen**: Das Release wird gegen den Release-Schlüssel von
   Kalzit geprüft, bevor irgendetwas anderes passiert.
2. **Jetzt installieren**, oder für das Wartungsfenster planen.
3. Kalzit sichert eine SQLite-Datenbank, behält die laufende Version, startet die neue und wartet,
   bis sie sich als gesund meldet (standardmäßig 60 Sekunden). Tut sie das nicht, kehrt Kalzit von
   selbst zur vorherigen Version und zur Sicherung zurück; der Verlauf sagt, warum.

Der Verlauf bietet für die behaltenen Versionen **Zu dieser Version zurückkehren** an
([Rückkehr zu einer früheren Version](../../operations/updates.md#returning-to-an-earlier-version)).
Server ohne Internetzugang bekommen dasselbe signierte Release als Offline-Paket
([Offline-Installationen](../../operations/updates.md#offline-installations)).

## Nach dem Update

- Verwaltung > Updates (und bei mehreren Servern Verwaltung > Instanzen) zeigt die neue Version.
- Öffne ein Dashboard und führe in Explore eine Abfrage aus; prüfe, ob Plugins noch laufen
  (Einstellungen > Plugins).
- Arbeite die „Checklist for Windows (manual)“ der Release Notes durch, soweit sie dich betrifft.
