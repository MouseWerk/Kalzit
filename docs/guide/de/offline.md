[English](../offline.md) | Deutsch

# Offline- und Air-Gap-Betrieb

Kalzit arbeitet vollständig in einem Netz ohne Internetzugang. Nichts außerhalb deines Netzes ist
nötig: Jedes externe System ist optional oder wird von einer Administration eingerichtet, und wenn
eines fehlt, startet Kalzit trotzdem und jede Seite öffnet sich. Die betroffene Funktion zeigt
einen eigenen Fehler, mehr nicht.

## Was offline funktioniert

- **Start und die ganze Oberfläche.** Die Seite, ihre Schriften, Symbole und Lizenztexte sind im
  Kalzit-Programm enthalten. Die Seite lädt nichts von anderen Websites, und die Content Security
  Policy des Servers erlaubt nur die eigene Adresse (dazu `data:` und `blob:` für Bilder und
  Worker). Tests im Repository halten das ein.
- **Anmeldung mit lokalen Konten**, Organisationen, Teams, Rollen, Audit-Log und Einstellungen.
- **Dashboards, Explore, gespeicherte Analysen, Export und die mitgelieferte Hilfe**, auf
  Datenquellen in deinem Netz, auch auf demselben Rechner.
- **Kalzits eigene Datenbank**, SQLite oder ein PostgreSQL-Server von dir. Ein PostgreSQL-Host, der
  mit Namen angegeben ist, wird nach dem Start im Hintergrund aufgelöst; ein nicht erreichbarer
  Namensserver verzögert den Start nie, und solange der Name unbekannt ist, verweigert Kalzit den
  Port der eigenen Datenbank als Ziel einer Datenquelle. Diese Verweigerung gilt für jedes Ziel
  mit diesem Port (standardmäßig 5432), solange der Name der Datenbank nicht aufgelöst werden kann,
  nicht nur für die Datenbank selbst; sie endet, sobald eine Auflösung gelingt. Eine fehlgeschlagene
  Auflösung kostet die Prüfung, die sie auslöst, bis zu 2 Sekunden und wird 30 Sekunden lang nicht
  wiederholt; der Server meldet einmal im Log, dass der Port aus diesem Grund verweigert wird.
- **Alarmregeln und ihre Zustände**, Stummschaltungen und der Richtlinienbaum.
- **Plugins aus einer Datei** und Updates per Offline-Paket (unten).

## Was nach außen greift, und wann

Jedes davon ist aus oder wird erst nach Einrichtung durch eine Administration genutzt:

| Funktion | Was kontaktiert wird | Standard |
|---|---|---|
| Datenquellen | Die Datenbank oder der Dienst, den du einträgst, wo auch immer er läuft | Nur die Quellen, die du anlegst |
| KI | Der Anbieter, den du verbindest (OpenAI-kompatibel, Anthropic oder ein lokales Modell wie Ollama in deinem Netz) | Aus; ein lokaler Anbieter braucht kein Internet |
| Mail (Einladungen, Passwort-Links, Berichte) | Der SMTP-Server, den du einträgst | Aus bis zur Einrichtung |
| Kontaktpunkte für Alarme: Webhooks, Slack, Microsoft Teams | Die Adressen, die du im Kontaktpunkt einträgst | Keine, bis du einen anlegst |
| Anmeldeanbieter: OpenID Connect, SAML, LDAP | Der Identitätsanbieter oder das Verzeichnis, das du einträgst | Aus; lokale Konten funktionieren |
| Automatische Zertifikate (ACME, Let's Encrypt) | Die Zertifizierungsstelle, die du einträgst | Aus; nutze eigene Zertifikatsdateien |
| Plugin-Katalog | Die Katalogadresse, die du einträgst | Aus, keine Adresse voreingestellt; Installation aus einer Datei geht immer |
| Update-Prüfung und Download | `api.github.com` und GitHubs Dateiserver | Prüfung nur auf Anforderung; „Automatisch prüfen“ ist aus |
| Kartenbilder | Die Kartenbild-Quelle, die du unter Verwaltung > Karte einträgst; der Kalzit-Server holt die Bilder, nie der Browser | Aus; Karten zeichnen ihre Orte auf Umrissen, die Kalzit mitbringt |

Einen Proxy für diese ausgehenden Anfragen stellst du unter Verwaltung, Einstellungen, Netzwerk,
HTTPS und Proxy ein ([Verwaltung](administration.md#ausgehender-proxy)). Hosts in deinem eigenen
Netz kannst du dort eintragen, damit sie direkt erreicht werden.

Zwei Dinge gehören nicht zum Produkt selbst. Die Hilfe- und Dokumentationslinks in der Oberfläche
zeigen derzeit auf GitHub und öffnen sich nur mit Internet; das eingebaute Handbuch ersetzt diese
Links. Die Seite „Über Kalzit“ verlinkt Repository, Website und Sicherheitsrichtlinie als externe
Links; der Lizenztext öffnet sich aus Kalzit selbst.

## Offline aktualisieren

1. Lade auf einem Rechner mit Internet `kalzit-<version>-<platform>-<arch>.kalzit-update` vom
   [GitHub-Release](https://github.com/MouseWerk/Kalzit/releases) herunter (`windows-x64`,
   `linux-x64` oder `linux-arm64`).
2. Bring die Datei in dein Netz und melde dich als Serveradministration an.
3. Öffne Verwaltung, Updates, **Offline-Update**, ziehe das Paket dorthin oder wähle die Datei.
4. Kalzit prüft die Signatur gegen die eingebauten öffentlichen Schlüssel, dass das Paket zu dieser
   Plattform passt und seine Version neuer ist. Danach zeigt es, dass das Paket geprüft ist.
5. Installiere es sofort oder im Wartungsfenster. Vorher wird eine Sicherung angelegt.

Der Upload braucht im Datenordner Platz für die doppelte Größe des Pakets. Die drei einzelnen
Dateien (Manifest, Signatur, Programm) lassen sich stattdessen über die API hochladen; siehe den
[Update-Leitfaden](../../operations/updates.md#offline-installations) und
[docs/api/updates.md](../../api/updates.md). Auch ein Plugin aus einer Datei zu installieren
braucht kein Internet.
