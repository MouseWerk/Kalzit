[English](../backup.md) | Deutsch

# Sichern und wiederherstellen

Was du sichern solltest, wie du eine konsistente Kopie anlegst, während Kalzit läuft, und wie du
sie wiederherstellst, für SQLite und PostgreSQL als Kalzits eigene Datenbank, unter Linux, Windows
und im Container. Übe die Wiederherstellung einmal (die [Übung](#wiederherstellung-üben) am Ende),
bevor du dich darauf verlässt.

Kalzit hat keinen eigenen Sicherungsplan (geplant für M7): Führe die Schritte unten aus deinem
üblichen Sicherungswerkzeug oder einem Timer aus. Das eingebaute Update sichert die SQLite-Datenbank
vor jedem Update, das es selbst installiert (nicht vor einem Upgrade per Paket, MSI oder Image),
und **Verwaltung** > **Updates** hat **Jetzt sichern**; diese Kopien bleiben auf derselben
Festplatte und sind für den Weg zurück nach einem Update gedacht, nicht als deine einzige Sicherung
([Anleitung zu Updates](../../operations/updates.md#backups)).

## Was du sichern solltest

| Was | Wo | Warum |
|---|---|---|
| Die Datenbank | SQLite: `kalzit.db` im Datenordner (während des Betriebs mit `kalzit.db-wal` und `kalzit.db-shm`). PostgreSQL: die Datenbank in `database.url` | Alles, was du in Kalzit angelegt hast: Organisationen, Personen, Dashboards, Datenquellen, Einstellungen, das Audit-Log; Passwörter und Tokens der Datenquellen verschlüsselt |
| Der Secrets-Schlüssel | `KALZIT_SECRETS_KEY`, die systemd credential `kalzit-secrets-key` (deb und rpm legen sie in `/etc/credstore.encrypted/` oder `/etc/credstore/` ab), das Docker-Secret `kalzit-secrets-key` oder eine Schlüsseldatei im Datenordner (`secrets.key` unter Linux, `secrets.key.dpapi` unter Windows) | Ohne ihn lassen sich die gespeicherten Passwörter, Tokens, Schlüssel der KI-Anbieter, das Passwort des Mailservers und die ACME-Dateien nicht entschlüsseln |
| `acme/` im Datenordner | `account-<hash>.enc` und `certificate.enc` | Das ACME-Konto und das Zertifikat, das Kalzit bestellt hat, verschlüsselt mit dem Secrets-Schlüssel. Bei mehreren Servern auf PostgreSQL liegt das Zertifikat auch in der Datenbank |
| `plugins/` im Datenordner | Die installierten Plugin-Pakete, entpackt | Die Datenbank führt die Plugins auf; bei SQLite gibt es die Pakete nur hier. Bei mehreren Servern auf PostgreSQL liegen sie auch in der Datenbank |
| `kalzit.toml` | `/etc/kalzit/kalzit.toml` (Pakete), `%ProgramData%\Kalzit\kalzit.toml` (Windows) oder die Datei, mit der du Kalzit startest | Adressen, HTTPS, Proxys, die Datenbank-URL |
| Zertifikatsdateien | `tls.cert_file` und `tls.key_file`, falls du eigene verwendest | HTTPS |

Den Rest des Datenordners kannst du ebenfalls sichern, für eine Wiederherstellung ist er aber nicht
nötig: `updates/` (Downloads, aufbewahrte Versionen und die Update-Sicherungen), `logs/` (Windows),
`tls/` (das selbst signierte Zertifikat des Windows-Installers, wird neu erzeugt, wenn es fehlt)
und `samples/` (die Beispieldatenbank, wird neu geschrieben, wenn jemand die Beispieldaten
hinzufügt). Stelle `kalzit-node-id` nicht auf einer anderen Maschine wieder her, die gleichzeitig
mit dem Original läuft (siehe [Mehrere Server](#mehrere-server)).

**Der Secrets-Schlüssel gehört zur Sicherung.** Bewahre eine Kopie getrennt von der
Datenbanksicherung auf, zum Beispiel in deinem Passwortmanager, und behalte alte Schlüssel so lange,
wie du Sicherungen aufbewahrst, die mit ihnen angelegt wurden (`kalzit secrets rotate` wechselt den
Schlüssel; siehe die [README](../../../README.md#configuration)).

- Unter Linux mit den Paketen ist der Schlüssel in `/etc/credstore.encrypted/` mit dem
  Credential-Schlüssel des Hosts verschlüsselt, `/var/lib/systemd/credential.secret`: Sichere diese
  Datei mit, sonst kann eine Wiederherstellung auf anderer Hardware den Schlüssel nicht lesen.
- Unter Windows lässt sich `secrets.key.dpapi` nur auf demselben Computer entschlüsseln. Auf einen
  anderen Computer kopiert, verweigert Kalzit damit den Start. Wenn du auf anderer Hardware
  wiederherstellst, lass diese Datei weg: Kalzit erzeugt dann einen neuen Schlüssel, alle
  gespeicherten Passwörter, Tokens und Schlüssel müssen neu eingegeben werden, und ACME bestellt ein
  neues Zertifikat. Um ohne das auf anderer Hardware wiederherzustellen, betreibe Kalzit von Anfang
  an mit `KALZIT_SECRETS_KEY` und bewahre diesen Schlüssel auf.

## SQLite

### Während Kalzit läuft

Kopiere bei einem laufenden Server nie nur `kalzit.db`: Was noch in `kalzit.db-wal` steht, ginge
verloren. Lege stattdessen mit der SQLite-Shell eine konsistente Kopie an, als das Konto, unter dem
Kalzit läuft, oder als root:

```sh
# Linux (Pakete): eine konsistente Datei, sicher während Kalzit läuft
sudo -u kalzit sqlite3 /var/lib/kalzit/kalzit.db "VACUUM INTO '/var/lib/kalzit/backup-$(date +%F).db'"
sudo tar -C /var/lib/kalzit -czf /srv/backup/kalzit-$(date +%F).tar.gz \
  backup-$(date +%F).db acme plugins
sudo rm /var/lib/kalzit/backup-$(date +%F).db
sudo cp /etc/kalzit/kalzit.toml /srv/backup/
```

`.backup <file>` in der `sqlite3`-Shell funktioniert ebenso. Unter Windows führst du `sqlite3.exe`
genauso aus einer Eingabeaufforderung mit Administratorrechten aus, mit der Datenbank unter
`%ProgramData%\Kalzit\data\kalzit.db`, und kopierst `acme` und `plugins` daneben. **Jetzt sichern**
auf der Seite Updates legt dieselbe Art Kopie (`VACUUM INTO`) in `updates/backups` an und bietet sie
zum Download an; der Download steht im Audit-Log.

### Bei gestopptem Kalzit

Stoppe den Dienst (`sudo systemctl stop kalzit`, `Stop-Service Kalzit`, `docker stop --time 30
kalzit`), kopiere den ganzen Datenordner und starte ihn wieder. Nach einem sauberen Stopp sind
`kalzit.db-wal` und `kalzit.db-shm` meist verschwunden; wenn sie noch da sind, kopiere sie zusammen
mit `kalzit.db`.

Bei einem Container kopierst du das Volume, während der Container gestoppt ist:

```sh
docker stop --time 30 kalzit
docker run --rm -v kalzit-data:/data:ro -v "$PWD":/backup alpine \
  tar -C /data -czf /backup/kalzit-data.tar.gz .
docker start kalzit
```

Compose stellt den Namen das Projekt voran (standardmäßig den Namen des Ordners): Das Volume heißt
dann zum Beispiel `kalzit_kalzit-data` und der Container `kalzit-kalzit-1`; `docker volume ls` und
`docker compose ps` zeigen sie.

### Wiederherstellen

1. Installiere dieselbe Kalzit-Version, mit der die Sicherung angelegt wurde (eine neuere Version
   migriert die Datenbank beim ersten Start; eine ältere kann eine Datenbank, die eine neuere
   migriert hat, nicht öffnen).
2. Stoppe Kalzit.
3. Lege die Dateien in den Datenordner: die Datenbank als `kalzit.db` (entferne übrig gebliebene
   `kalzit.db-wal` und `kalzit.db-shm`), `acme/` und `plugins/`.
   - **Kopieren, nicht verschieben.** Eine kopierte Datei übernimmt die privaten Rechte des
     Datenordners; eine verschobene behält ihre alten, und Kalzit verweigert damit den Start. Unter
     Windows behalten Werkzeuge, die Rechte mitkopieren (`robocopy /COPYALL` oder `/SEC`,
     `xcopy /O`), auch fremde Einträge: Kopiere einfach, oder führe danach `icacls <file> /reset`
     aus.
   - Unter Linux müssen die Dateien dem Konto gehören, unter dem Kalzit läuft
     (`sudo chown -R kalzit:kalzit /var/lib/kalzit`), und der Ordner muss für andere geschlossen
     bleiben (`chmod 700`).
   - In einem Container stellst du in das Volume des gestoppten Containers wieder her und gibst die
     Dateien dem Benutzer des Images:

     ```sh
     docker stop kalzit
     docker run --rm -v kalzit-data:/data -v "$PWD":/backup alpine        sh -c 'rm -rf /data/* && tar -C /data -xzf /backup/kalzit-data.tar.gz && chown -R 65532:65532 /data && chmod 700 /data'
     docker start kalzit
     ```
4. Lege `kalzit.toml` und den Secrets-Schlüssel zurück, mit denen die Sicherung angelegt wurde
   (unter Windows auf einem anderen Computer ohne `secrets.key.dpapi`, siehe oben).
5. Starte Kalzit und prüfe das Log: Eine Warnung, dass gespeicherte Secrets Schlüssel verwenden, die
   nicht geladen sind, bedeutet, dass der Schlüssel nicht der ist, mit dem die Sicherung angelegt
   wurde.

## PostgreSQL

Kalzit kann eine PostgreSQL-Datenbank nicht selbst sichern. Verwende die Werkzeuge von PostgreSQL,
während Kalzit läuft:

```sh
pg_dump --format=custom --file=kalzit-$(date +%F).dump "postgres://kalzit@db.internal/kalzit"
```

Sichere außerdem `acme/` und `plugins/` aus dem Datenordner und `kalzit.toml` jedes Servers sowie
den Secrets-Schlüssel, den sich alle Server teilen.

Zum Wiederherstellen stoppst du alle Kalzit-Server, stellst in eine leere Datenbank wieder her und
startest einen Server, danach die anderen:

```sh
createdb -O kalzit kalzit
pg_restore --no-owner --role=kalzit --dbname="postgres://kalzit@db.internal/kalzit" kalzit-2026-11-04.dump
```

Die Regel zur Version ist dieselbe wie bei SQLite: Starte die Version, mit der der Dump angelegt
wurde, oder eine neuere. Point-in-Time-Recovery, Replikate und Failover (Patroni, eine verwaltete
Datenbank) sind Aufgabe von PostgreSQL; Kalzit verbindet sich nach einem Failover wieder.

## Mehrere Server

Bei mehreren Kalzit-Servern auf einer PostgreSQL-Datenbank
([Anleitung für den Betrieb](../../operations/high-availability.md)) teilen sich alle die Datenbank
und den Secrets-Schlüssel; der Datenordner gehört jedem Server allein. Sichere die Datenbank einmal
und `kalzit.toml` jedes Servers. Um einen Server neu aufzubauen, starte Kalzit mit einem leeren
Datenordner, derselben Datenbank-URL und demselben Schlüssel: Er trägt sich selbst ein und entpackt
die Plugins aus der Datenbank. Kopiere keinen Datenordner, um einen weiteren Server einzurichten;
seine `kalzit-node-id` würde aus zwei Servern einen machen.

## Wiederherstellung üben

Probiere die Wiederherstellung einmal auf einer zweiten Maschine oder einer virtuellen Maschine aus,
und nach jeder Änderung daran, wie du sicherst:

1. Installiere dort die Kalzit-Version der Sicherung, ohne sie zu starten (mit den Paketen stoppst
   du den Dienst direkt nach der Installation).
2. Stelle die Datenbank (oder den Dump), `acme/`, `plugins/`, `kalzit.toml` und den
   Secrets-Schlüssel wie oben wieder her. Ändere `server.public_url` und die Adressen in
   `kalzit.toml`, wenn die Testmaschine einen anderen Namen hat, und halte sie von deinen
   produktiven Datenquellen fern, wenn ein Testlauf sie nicht abfragen soll.
3. Starte Kalzit und prüfe:
   - Du kannst dich anmelden, und Dashboards, Ordner und Auswertungen sind da;
   - **Verbindung testen** bei einer Datenquelle mit Passwort gelingt (der Schlüssel stimmt);
   - Verwaltung > Plugins führt die Plugins als laufend auf;
   - das Audit-Log endet zum Zeitpunkt der Sicherung;
   - mit ACME zeigt die Zertifikatskarte das Zertifikat der Sicherung.
4. Notiere, wie lange die Wiederherstellung gedauert hat, und entferne dann die Testinstallation.
