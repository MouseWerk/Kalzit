[English](../reports.md) | Deutsch

# Berichte

Ein Bericht schickt ein Dashboard nach Zeitplan per Mail: alle Panels oder einige davon, als
PDF-Datei, als CSV-Dateien oder beides. Kalzit zeichnet die PDF selbst, auf dem Server, ohne
Browser und ohne externen Dienst; sie sieht dem Dashboard ähnlich, ist ihm aber nicht gleich.

## In der Oberfläche

**Berichte** in der Hauptnavigation, nach Alerting, listet die Berichte der Organisation: was
jeder sendet, seinen Zeitplan, Format und Empfänger, den nächsten und den letzten Lauf und die
Person, mit deren Rechten er läuft. Filtere nach „Meine“ und „Mit Problemen“ (ausgesetzt oder
letzter Lauf fehlgeschlagen) oder suche nach Bericht und Dashboard. Ausgesetzte und pausierte
Berichte sind gedämpft und sagen das in Worten; ein ausgesetzter nennt seinen Grund unter der
Liste. Das Zeilenmenü bearbeitet, pausiert, sendet jetzt, dupliziert und löscht. Der Eintrag
erscheint mit `reports:read`, solange Berichte für den Server und die Organisation an sind.

- **Neuer Bericht** öffnet den Editor: Name, Dashboard und Panels, Zeitraum und Variablen,
  Zeitplan mit seiner Zeitzone (die nächsten Läufe erscheinen, während du wählst), Empfänger,
  Format und Sprache. Die Zusammenfassung rechts folgt dem Formular. Vor **Speichern** gilt
  nichts; was fehlt oder abgelehnt wird, steht an seinem Feld, ein abgelehnter Empfänger bei der
  Person, die er nennt.
- **Bericht anlegen…** im Menü eines Dashboards öffnet denselben Editor für dieses Dashboard, mit
  dem dort gewählten Zeitraum und den Werten der Variablen. Das Menü führt auch zu den Berichten,
  die das Dashboard schon hat.
- **Empfänger** fügst du über Name oder Adresse hinzu: Mitglieder der Organisation und Adressen
  außerhalb, wo die Organisation sie erlaubt. Dafür liest Kalzit die Mitgliederliste, was
  `users:read` braucht.
- **Vorschau** zeichnet den Entwurf als PDF mit demselben Renderer wie ein Lauf, mit den Daten von
  jetzt und deinen eigenen Rechten, und sendet nichts. Lade sie herunter oder öffne sie in einem
  neuen Tab; ihre Größe steht neben der größten erlaubten Mail.
- **Jetzt senden** bei einem gespeicherten Bericht fragt vorher nach: Der Bericht geht an alle
  Empfänger, nicht nur an dich. Es wird ohne Mailserver oder bei ausgeschalteten Berichten nicht
  angeboten.
- **Läufe** neben den Details eines Berichts listet jeden Lauf mit seinem Auslöser, seiner Dauer,
  der Zahl der Empfänger, die ihn bekommen haben, der Größe der Dateien und dem Ergebnis mit
  Grund. Läufe, die noch unterwegs sind, aktualisieren sich selbst.
- **Duplizieren** legt eine Kopie an, die mit deinen Rechten läuft; so übernimmst du einen
  Bericht, dessen Ersteller ein Recht verloren hat oder gegangen ist.

Ohne Mailserver sagen die Seiten das, mit dem Weg zu Einstellungen > E-Mail für Server-Admins. Die
Einstellungen stehen unter Verwaltung > Berichte (Server) und im Abschnitt Berichte der
Organisation. Die API (`/api/orgs/{orgId}/reports`) steht weiter unten.

## Was ein Bericht enthält

- **Dashboard und Panels.** Alle Panels in der Reihenfolge des Dashboards oder die Panels, die du
  wählst. Ein Panel, das später aus dem Dashboard entfernt wird, zeigt in der PDF einen Hinweis.
- **Zeitraum.** Der des Dashboards oder ein eigener des Berichts: `now-7d` bis `now`, gerundete
  Zeiträume wie `now-1d/d` bis `now-1d/d` (gestern, Mitternacht bis Mitternacht) oder `now-1M/M`
  bis `now-1M/M` (letzter Monat) oder feste Daten. Tage, Wochen, Monate und Jahre zählen nach dem
  Kalender der Zeitzone des Berichts; Wochen beginnen am Montag. Geschäftsjahre und Quartale gibt
  es in Berichten nicht.
- **Variablen.** Feste Werte für die Variablen des Dashboards. Variablen, die du offen lässt,
  nehmen den mit dem Dashboard gespeicherten Wert.
- **Zeitplan.** Täglich, wöchentlich (an gewählten Tagen) oder monatlich (an einem Tag; in
  kürzeren Monaten am letzten Tag) zu einer Uhrzeit oder ein Cron-Ausdruck mit fünf Feldern
  (Minute, Stunde, Tag des Monats, Monat, Wochentag). Ein Bericht läuft höchstens alle 15 Minuten.
- **Zeitzone.** Wann der Zeitplan läuft und wie Zeiten im Bericht stehen. Ein Bericht um 08:00
  läuft im Sommer und im Winter um 08:00. Eine Zeit, die es beim Vorstellen der Uhren nicht gibt,
  läuft, wenn die Lücke endet (02:30 wird 03:00); eine Zeit, die beim Zurückstellen zweimal
  vorkommt, läuft einmal.
- **Format.** PDF, CSV oder beides. CSV-Dateien brauchen das Recht, Daten zu exportieren
  (`data:export`): Der Ersteller braucht es, und nur Empfänger, die es haben, bekommen die
  CSV-Dateien. Alle anderen und jede Adresse außerhalb der Organisation bekommen nur die PDF; der
  Verlauf der Läufe zählt sie.
- **Sprache.** Deutsch oder Englisch, für die PDF und die Mail.
- **Empfänger.** Mitglieder der Organisation und Adressen außerhalb, wo die Organisation sie
  erlaubt (unten). Standardmäßig höchstens 20 je Bericht.

## So sehen die Dateien aus

Die PDF ist A4 quer: ein Deckblatt mit dem Dashboard, dem Zeitraum, den Werten der Variablen und
dem Zeitpunkt der Erstellung, danach eine Karte je Panel. Jedes Ergebnis behält seine Datenform:

| Ergebnis | In der PDF |
|---|---|
| Tabellenergebnis (frame) in einem Zeitreihen-Panel | Linien über die Zeit, bis zu 8 Serien, mit Legende |
| ... in einem Balken-Panel | Balken je Kategorie, bis zu 24 Kategorien |
| ... in einem Stat-, Gauge- oder Balken-Gauge-Panel | Der Wert mit dem Reducer und der Einheit des Panels |
| ... in einem Tabellen-Panel | Die ersten 25 Zeilen, so viele Spalten, wie passen |
| Dokumente | Die ersten Dokumente als eingerückter Baum, bis zu 40 Zeilen, in der eigenen Feldreihenfolge |
| Graph | Ein statisches Layout mit bis zu 150 Knoten und 2.000 Beziehungen, nach Label gefärbt |
| Trace | Ein Wasserfall mit bis zu 40 Spans in Baumreihenfolge: Dienst und Operation, Start und Dauer im Trace, Fehler in Rot |
| Text-Panel | Sein Text |

Was fehlt (weitere Zeilen, Serien, Dokumente oder Knoten), steht unter dem Panel. Ein Panel-Typ,
den die PDF noch nicht zeichnet (Kreisdiagramm, Heatmap, Histogramm, Zustandsverlauf,
Statusverlauf, Plugin-Panels), zeigt einen Hinweis und seine Werte als Tabelle. Ein Panel, dessen
Ergebnis nicht zu seinem Typ passt (ein Dokumentergebnis in einem Zeitreihen-Panel), zeigt einen
Platzhalter mit dem Grund; Kalzit macht aus Dokumenten oder Graphen nie von selbst eine Tabelle.

CSV-Dateien enthalten nur Tabellenergebnisse, eine Datei je Ergebnis, geschrieben wie ein Export
(Semikolons und Dezimalkommas auf Deutsch, Kommas und Punkte auf Englisch). Mehrere Dateien kommen
als eine Zip-Datei. Ein Dokument-, Graph- oder Trace-Panel steht nur dann in den CSV-Dateien, wenn
es einen Schritt hat, der eine Tabelle daraus macht („In Tabelle“, ein Graph-Schritt mit
Tabellenergebnis oder „Span-Tabelle“ (`spanTable`) bei Traces); sonst nennt die Mail es als
ausgelassen.

## Läufe und Rechte

- Ein Bericht läuft mit den **aktuellen Rechten der Person, die ihn angelegt hat**, bei jedem Lauf
  geprüft: Sie muss noch aktives Mitglied mit `reports:write` sein, das Dashboard lesen können und
  für CSV-Dateien `data:export` haben. Es laufen nur die gespeicherten Abfragen des Dashboards.
  Einen Bericht zu bearbeiten ändert nicht, mit wessen Rechten er läuft.
- Fehlt eines dieser Rechte, ist der Bericht **ausgesetzt**, nicht gelöscht: Der Lauf wird als
  „ausgesetzt“ mit dem Grund aufgezeichnet, und der Bericht läuft zur ersten geplanten Zeit wieder,
  zu der das Recht zurück ist. Ausgesetzte und pausierte Zeiten werden nicht nachgeholt.
- Jedes Mitglied unter den Empfängern muss das Dashboard lesen können. Beim Speichern wird ein
  Mitglied ohne dieses Recht abgelehnt; ein Mitglied, das es später verliert, die Organisation
  verlässt oder gesperrt wird, bleibt bei den Läufen außen vor, und der Verlauf der Läufe zählt es.
- **Fehler.** Ein Lauf scheitert als Ganzes, wenn die Abfrage oder die Schritte eines Panels
  fehlschlagen, wenn die Ergebnisse der Panels größer sind, als ein Bericht halten darf (das
  Achtfache der größten Mail), wenn die Dateien größer sind als die größte erlaubte Mail
  (standardmäßig 10 MB, gezählt, wie sie in der Mail reisen), wenn das Rendern länger als eine
  Minute dauert, wenn der Mailserver nicht erreichbar ist oder jeden Empfänger ablehnt. Dann geht
  nichts an die Empfänger, auch kein Teil des Berichts. Kalzit versucht es nach fünf Minuten noch
  einmal; scheitert auch das, bekommt der Ersteller eine Mail mit dem Grund, höchstens eine je
  Bericht und Tag.
- Eine geplante Zeit, die verstrich, während kein Server lief, oder ein Lauf, der 15 Minuten nach
  seiner Zeit noch auf seinen Platz wartet, wird als „übersprungen“ aufgezeichnet und nicht
  nachgeholt. Organisationen kommen reihum dran: Bis zu vier Berichte entstehen gleichzeitig, einer
  je Organisation.
- **Jetzt senden** stellt sofort einen Lauf in die Warteschlange, mit denselben Prüfungen.
- Läufe bleiben standardmäßig 90 Tage. Die Dateien werden nicht gespeichert: Jeder Lauf erzeugt
  sie neu.

## Adressen außerhalb der Organisation

Standardmäßig gehen Berichte nur an Mitglieder. Admins der Organisation schalten
`reports.allow_external_recipients` ein und können Adressen auf Mail-Domains beschränken
(`reports.external_domains`, zum Beispiel `example.com`). Externe Adressen brauchen außerdem die
öffentliche Adresse des Servers (`server.public_url`). Eine Adresse, die zu einem Konto des Servers
gehört, wird abgelehnt: Füge die Person über ihr Konto hinzu, damit die Leseprüfung gilt; eine
Adresse, die später zu einem Konto wird, bleibt bei den Läufen außen vor. Mails an externe
Adressen enthalten keinen Link in Kalzit außer einer Abmeldung mit einem Klick (der Link unten und
die Abmelde-Schaltfläche von Mailprogrammen). Nach dem Abmelden bleibt die Adresse bei den Läufen
dieses Berichts außen vor. Abmelde-Links funktionieren weiter, nachdem der Secrets-Schlüssel
gewechselt wurde.

## Rechte

| Recht | Rollen | Erlaubt |
|---|---|---|
| `reports:read` | Bearbeiter, Admin, Eigentümer | Berichte und ihre Läufe sehen |
| `reports:write` | Bearbeiter, Admin, Eigentümer | Anlegen, ändern, löschen, jetzt senden und die Vorschau |

Betrachter bekommen Berichte, sehen oder legen sie aber nicht an. Berichte zu Dashboards, die du
nicht lesen kannst, erscheinen bei dir nicht. Anlegen, Ändern und Löschen eines Berichts und jedes
„Jetzt senden“ stehen im Audit-Log, ohne Adressen.

## Einstellungen

| Servereinstellung | Standard | Was sie bewirkt |
|---|---|---|
| `reports.enabled` | an | Aus: Berichte bleiben erhalten, laufen aber nicht und werden nicht gesendet |
| `reports.max_reports_per_org` | 100 | Berichte, die eine Organisation haben darf |
| `reports.max_runs_per_org_hour` | 60 | Läufe, die eine Organisation je Stunde starten darf; weitere geplante Läufe werden als übersprungen aufgezeichnet |
| `reports.max_recipients` | 20 | Empfänger je Bericht |
| `reports.max_attachment_bytes` | 10 MB | Die größten Dateien einer Mail zusammen |
| `reports.history_retention_days` | 90 | Wie lange Läufe bleiben |

Einstellungen der Organisation: `reports.org_enabled` (an; eine Organisation darf Berichte nur
ausschalten), `reports.allow_external_recipients` (aus) und `reports.external_domains` (leer:
jede Domain). Ein Mailserver muss eingerichtet sein (Einstellungen > E-Mail).

## API

| Methode und Pfad | Recht | Was |
|---|---|---|
| `GET /api/orgs/{orgId}/reports` | `reports:read` | Die Berichte, neueste zuerst (`Page<Report>`) |
| `POST /api/orgs/{orgId}/reports` | `reports:write` | Anlegen (`ReportInput`); antwortet mit `201` und dem Bericht |
| `GET /api/orgs/{orgId}/reports/status` | `reports:read` | An oder aus, Mail eingerichtet, externe Adressen, Grenzen |
| `POST /api/orgs/{orgId}/reports/preview` | `reports:write` | Ein Entwurf (`ReportInput`) als PDF, mit deinen eigenen Rechten; nichts wird gespeichert oder gesendet; fehlschlagende Panels zeigen ihren Grund |
| `GET /api/orgs/{orgId}/reports/{reportId}` | `reports:read` | Ein Bericht |
| `PUT /api/orgs/{orgId}/reports/{reportId}` | `reports:write` | Ändern, mit der `version`, von der es ausging (sonst `409 version_conflict`) |
| `DELETE /api/orgs/{orgId}/reports/{reportId}` | `reports:write` | Löschen, mit seinen Läufen |
| `POST /api/orgs/{orgId}/reports/{reportId}/send` | `reports:write` | Jetzt senden; antwortet mit `202` und dem eingereihten Lauf |
| `POST /api/orgs/{orgId}/reports/{reportId}/pause`, `.../resume` | `reports:write` | Pausieren oder fortsetzen, mit `{ "version" }`. Pausieren geht immer; beim Fortsetzen wird der Bericht geprüft wie bei einer Änderung |
| `GET /api/orgs/{orgId}/reports/{reportId}/runs` | `reports:read` | Die Läufe, neueste zuerst (`Page<ReportRun>`) |
| `GET`, `POST /api/reports/unsubscribe/{token}` | öffentlich | Die Abmeldeseite und die Abmeldung mit einem Klick |

Ein Bericht als Body:

```json
{
  "name": "Lager weekly",
  "dashboardId": "0192...",
  "panelIds": ["p1", "p4"],
  "timeRange": { "from": "now-1w/w", "to": "now-1w/w" },
  "variables": { "region": "nord" },
  "schedule": { "kind": "weekly", "time": "07:00", "weekdays": ["mon"] },
  "timeZone": "Europe/Berlin",
  "formats": ["pdf", "csv"],
  "language": "de",
  "recipients": [{ "userId": "0192..." }, { "email": "partner@example.com" }],
  "paused": false
}
```

Zeitpläne: `{"kind": "daily", "time": "08:00"}`, `{"kind": "weekly", "time": "08:00", "weekdays":
["mon", "fri"]}`, `{"kind": "monthly", "time": "06:00", "day": 1}`, `{"kind": "cron",
"expression": "30 7 * * 1-5"}`. Status der Läufe: `queued`, `running`, `ok`, `partial` (einige
Empfänger ausgelassen), `failed`, `suspended`, `skipped`. Fehler tragen einen Grund wie
`reports.recipient_no_access`, `reports.external_not_allowed`, `reports.schedule_too_frequent`,
`reports.creator_no_dashboard` oder `reports.attachment_too_large`.
