[English](../alerting.md) | Deutsch

# Alerting

Alerting behält eine Abfrage für dich im Auge. Eine Regel führt eine gespeicherte Abfrage nach
Zeitplan aus, reduziert ihr Ergebnis auf eine Zahl und meldet, wenn eine Bedingung für diese Zahl
erfüllt ist. Die Meldungen gehen an Kontaktpunkte (Mail, Webhook, Slack, Microsoft Teams), direkt
oder über einen Baum von Richtlinien, der sie bündelt und eskaliert. Die HTTP-API steht in
[docs/api/alerting.md](../../api/alerting.md) (auf Englisch).

**Alerting** in der Seitenleiste erscheint mit `alerts:read`, solange Alerting für den Server und
die Organisation an ist, mit der Zahl der feuernden Regeln daneben. Es hat fünf Seiten:
**Regeln**, **Kontaktpunkte**, **Stummschaltungen**, **Verlauf** und **Richtlinien**.

> [!NOTE]
> Ist Alerting für den Server oder die Organisation aus, bleiben die Regeln erhalten, werden aber
> nicht ausgewertet. Die Seiten sagen das oben.

## Vor der ersten Regel

1. Eine Datenquelle muss für Alerting freigegeben sein: **Für Alerting freigeben** im Abschnitt
   **Alerting** der Quelle. Das darf, wer Datenquellen bearbeiten darf (Admins). Ohne Freigabe
   lässt sich auf dieser Quelle keine Regel speichern.
2. Ein Kontaktpunkt für die Meldungen (ein Admin der Organisation legt ihn an, siehe unten). Eine
   Regel ohne Kontaktpunkt wird ausgewertet, sendet aber nichts.
3. Eine Regel: aus einem Panel (Panel-Menü > **Alert-Regel erstellen**), über **Neue Regel** auf
   der Seite Regeln oder durch Duplizieren.

Geplante Auswertungen laufen nie mit deinen Rechten. Sie laufen mit der Dienstidentität
„Alerting“ der Organisation, die nur freigegebene Datenquellen abfragen darf, lesend und mit den
Grenzen der jeweiligen Quelle. Eine Regel hängt deshalb nicht daran, dass ein Konto aktiv bleibt.
Auswertungen lesen nie aus dem Abfrage-Cache.

## Regeln

Eine Regel hat drei Teile, alle als sichtbare Schritte im Editor, wie die Schritte in
[Explore](explore.md):

- **Abfrage**: eine Datenquelle, die Abfrage in ihrer Sprache, optionale Schritte danach und ein
  relativer Zeitraum wie „Letzte 10 Minuten“, der den Zeitfilter füllt. Variablen haben feste
  Werte, die in der Regel gespeichert sind. Eine Regel hält eine eigene Kopie der Abfrage. Stammt
  sie aus einem Panel und ändert sich dessen Abfrage später, sagt der Editor das und bietet
  **Abfrage übernehmen** an.
- **Reduzieren**: macht aus dem Ergebnis je nach Datenform eine Zahl je Instanz. Nichts wird
  stillschweigend umgewandelt: Willst du Dokumente als Tabelle reduzieren, setz zuerst den
  sichtbaren Schritt **In Tabelle projizieren** davor (siehe
  [Dokumente als Tabelle](calculated-fields.md#dokumente-als-tabelle)).
- **Bedingung**: vergleicht die Zahl mit festen Werten: größer als, größer gleich, kleiner als,
  kleiner gleich, gleich, ungleich, außerhalb von oder innerhalb von (zwei Grenzen).

| Datenform | Reduzieren | Instanzen |
|---|---|---|
| `frame` | `last`, `min`, `max`, `mean`, `sum` oder `count` je Serie (bei langen Tabellen je Label-Kombination); `last` nimmt den Wert mit dem jüngsten Zeitstempel, ohne Zeitfeld die letzte Zeile | Eine je Serie, mit ihren Labels |
| `documents` | Die Anzahl der Dokumente oder ein Feldwert über einen Feldpfad wie `$.queue.depth` mit `first`, `min`, `max`, `mean` oder `sum`; Dokumente ohne das Feld zählen nicht mit, ein Feld mit Text ergibt den Zustand Fehler | Eine je Regel |
| `graph` | Die Anzahl der Knoten, Kanten oder Pfade, optional nur für ein Label oder einen Kantentyp | Eine je Regel |

Bei Dokumenten und Graphen ist 0 ein Wert (also OK), keine fehlenden Daten. Eine Abfrage, die
einen Trace liefert, braucht zuerst einen Tabellenschritt (Span-Tabelle oder Trace-Tabelle); die
Tabelle wird dann reduziert.

**Auswertung** je Regel: das Intervall (standardmäßig mindestens 30 Sekunden, höchstens ein Tag),
die Dauer **Feuert nach** („für“; ein Vielfaches des Intervalls, höchstens ein Tag; standardmäßig
„Sofort“), was **Wenn keine Daten kommen** geschieht (Zustand Keine Daten, OK oder Feuert) und
**Wenn die Abfrage fehlschlägt** (Zustand Fehler oder Letzten Zustand halten). Unter **Labels und
Benachrichtigung** hat eine Regel Labels (`team=lager`, höchstens 20), eine Beschreibung, einen
optionalen Link zu einer Anleitung, eine **Erinnerung bei anhaltendem Feuern** und ihren Weg der
Benachrichtigung (siehe unten). **Jetzt auswerten** zeigt das Ergebnis jedes Schritts und den
Zustand, den jede Instanz jetzt hätte, mit deinen Rechten. Vor **Speichern** wird nichts
gespeichert. Eine Regel lässt sich pausieren; Pausieren beendet ihre Instanzen ohne Meldung, beim
Fortsetzen beginnen sie bei OK.

### Zustände

| Zustand | Bedeutung |
|---|---|
| OK | Die Bedingung ist nicht erfüllt |
| Ausstehend | Die Bedingung ist erfüllt, aber noch nicht so lange wie die „für“-Dauer |
| Feuert | Die Bedingung ist die „für“-Dauer lang erfüllt; das wird gemeldet |
| Keine Daten | Die Abfrage lieferte nichts zum Reduzieren (wenn die Regel so eingestellt ist) |
| Fehler | Die Auswertung ist fehlgeschlagen: Abfragefehler, Zeitlimit, falsche Datenform, ein Feld ohne Zahl, eine Datenquelle ohne Freigabe oder ein von der Quelle abgeschnittenes Ergebnis |

Pausiert und Stumm erscheinen daneben. Zustände stehen immer als Text, die Farbe ist nur ein
Zusatz. Kehrt eine feuernde Instanz zu OK zurück, geht das Behoben als eigene Nachricht raus.

## Kontaktpunkte

Ein Kontaktpunkt sagt, wohin Meldungen gehen. Anlegen und ändern dürfen Organisations-Admins
(`alerts:contacts`); alle mit `alerts:read` sehen sie in Kurzform.

| Art | Was sie braucht | Hinweise |
|---|---|---|
| Mail | 1 bis 20 Empfänger und eine Sprache (Deutsch oder Englisch) | Braucht einen Mailserver (Einstellungen > E-Mail) |
| Webhook | Eine `http://`- oder `https://`-Adresse und eine Sprache | Signiert mit HMAC-SHA256 im Header `Kalzit-Signature`; das Geheimnis für die Signatur wird einmal angezeigt, nach dem Neuerzeugen gilt das alte 24 Stunden weiter; Empfänger sollten Zeitstempel älter als 5 Minuten ablehnen |
| Slack | Die Webhook-URL des Kanals (nur `https://`) | Die URL ist das Geheimnis: verschlüsselt gespeichert, danach nur Host und Ende sichtbar |
| Teams | Die URL eines Teams-Workflows, der beim Empfang einer Webhook-Anforderung postet | Wie Slack; gesendet als Adaptive Card |

Adressen von Webhook, Slack und Teams durchlaufen dieselbe Ziel-Prüfung wie Datenquellen: private
Netze sind erlaubt, Kalzit selbst und Metadaten-Adressen nie, Weiterleitungen werden nicht
verfolgt; ist ein Ausgangs-Proxy eingestellt, geht es darüber. **Testsenden** (höchstens 5 je
Minute und Kontaktpunkt) sendet Beispielinhalt. Ein Kontaktpunkt lässt sich nicht löschen, solange
Regeln oder Richtlinien ihn verwenden.

Nachrichten an Slack und Teams zeigen Zustand, Gruppe und je Instanz Regel, Labels, reduzierten
Wert und Bedingung, mit Schaltflächen, um die Regel oder das Panel zu öffnen und stummzuschalten;
bis zu 10 Instanzen, danach „und N weitere“. Nachrichten enthalten nie Zeilen, Dokumente oder
Knoten aus dem Ergebnis.

## Wege der Benachrichtigung

Jede Regel wählt unter **Benachrichtigung**, wie ihre Instanzen zugestellt werden:

- **Direkt an Kontaktpunkte**: bis zu 5 Kontaktpunkte, eine Nachricht je Auswertung, ohne Baum. Es
  gilt die Erinnerung der Regel selbst.
- **Über Richtlinien**: Die Labels der Regel entscheiden, wohin es geht, wie gebündelt wird und
  wann eskaliert wird.

### Richtlinien

**Richtlinien** zeigt den Baum der Organisation. Seine Wurzel **Standard** passt auf alle
Instanzen, lässt sich weder verschieben noch löschen und setzt alle Zeiten selbst. Jede Instanz
läuft von Standard aus nach unten. Auf jeder Ebene übernimmt die erste passende Richtlinie sie;
mit **weiter prüfen** werden auch die folgenden geprüft, sodass eine Instanz mehrere Wege nehmen
kann (ein Kontaktpunkt bekommt sie trotzdem nur einmal). Leere Felder erbt eine Richtlinie von der
Richtlinie darüber.

Eine Richtlinie hat:

- **Passt auf**: bis zu 10 Bedingungen auf Labels (`=`, `!=`, `=~`, `!~`; reguläre Ausdrücke
  gelten für den ganzen Wert, ein fehlendes Label zählt als leer). Die Labels sind die der Instanz
  und der Regel, dazu der Name der Regel als `alertname`.
- **Kontaktpunkte**: bis zu 5; leer kommen sie von oben.
- **Gruppieren nach**: Labels (Instanzen mit denselben Werten kommen in eine Nachricht, auch aus
  verschiedenen Regeln), **Alle zusammen** oder **Jede einzeln**.
- **Gruppenwartezeit**, **Gruppenintervall** und **Wiederholen**: die Wartezeit vor der ersten
  Nachricht einer neuen Gruppe (30 Sekunden an der Wurzel), die kürzeste Zeit zwischen Nachrichten
  über Änderungen (5 Minuten an der Wurzel) und die Zeit, nach der eine Gruppe, die unverändert
  weiterfeuert, als Erinnerung wiederholt wird (4 Stunden an der Wurzel, oder aus).
- **Eskalation**: bis zu 3 Stufen. Feuert eine Gruppe nach der Wartezeit einer Stufe noch (5
  Minuten bis 24 Stunden, gezählt ab dem Beginn des Feuerns der Gruppe, jede Stufe später als die
  vorige), geht die ganze Gruppe einmal an die Kontaktpunkte der Stufe; danach bekommen sie auch
  Änderungen, Erinnerungen und das Behoben. Eine Stummschaltung aller feuernden Instanzen hält die
  Eskalation an.

Admins legen Richtlinien an, bearbeiten, verschieben (Zeilenmenü oder Ziehen), duplizieren und
löschen sie. Alle mit `alerts:read` können den Baum öffnen, die aktiven Gruppen jeder Richtlinie
sehen und **Weg prüfen** nutzen: Gib Labels ein oder wähle eine Regel, um zu sehen, welche Wege
sie nähmen. Eine Organisation darf bis zu 100 Richtlinien haben, fünf Ebenen tief.

> [!TIP]
> Gib deinen Regeln Labels wie `team` und `severity` und lass die Richtlinien danach verteilen.
> Eine Regel mit „Direkt an Kontaktpunkte“ läuft nicht durch den Baum; die Seite Richtlinien sagt,
> wie viele Regeln direkt gehen.

## Stummschaltungen

Eine Stummschaltung hält Meldungen zurück, nie die Auswertung: Passende Instanzen werden weiter
ausgewertet und aufgezeichnet, nur nicht gemeldet. **Stummschaltung** legt eine an, aus
Bedingungen auf Labels (alle müssen passen; `=`, `≠`, `=~`; `alertname` ist der Name der Regel),
einer Dauer (1 Stunde, 4 Stunden, 1 Tag oder bis zu einem Zeitpunkt, höchstens 90 Tage) und einem
Pflichtkommentar. Der Dialog zeigt, welche Instanzen sie jetzt betrifft; eine Stummschaltung ohne
betroffene Instanz lässt sich trotzdem speichern, für geplante Arbeiten. Du kannst sie auch von
einer Regel oder einer Instanz aus starten. Stummschaltungen sind als aktiv, geplant oder
abgelaufen aufgelistet; **Beenden** beendet eine vorzeitig. Endet eine Stummschaltung, während
eine Instanz noch feuert, wird die Instanz einmal gemeldet. Anlegen und Beenden stehen im
Audit-Log.

## Verlauf

Der **Verlauf** listet die Zustandswechsel und Zustellungen der Organisation. Filtere nach
Zeitraum (letzte Stunde bis letzte 30 Tage), Regel, Zustand, Label und Art (Zustandswechsel oder
Zustellungen). Eine Zustellung zeigt den Kontaktpunkt und das Ergebnis: zugestellt, keine Antwort
innerhalb von 10 Sekunden, Adresse abgelehnt, keine Verbindung, nicht gesendet, weil die Meldungen
je Stunde der Organisation aufgebraucht sind, und weitere. Der Verlauf bleibt standardmäßig 90
Tage. Panels mit Regeln zeigen ein Abzeichen, eine gestrichelte Schwellenwert-Linie und eine
ruhige Fläche für die Zeit, in der eine Regel gefeuert hat; die beiden letzten kannst du im
Panel-Menü ausblenden.

## Rechte

| Recht | Eingebaute Rollen | Erlaubt |
|---|---|---|
| `alerts:read` | Betrachter und höher | Regeln mit ihren Zuständen, Stummschaltungen, Verlauf, Kontaktpunkte in Kurzform, den Richtlinienbaum mit seinen Gruppen und **Weg prüfen** sehen |
| `alerts:write` | Bearbeiter und höher | Regeln anlegen, ändern, pausieren, fortsetzen und löschen; Stummschaltungen anlegen und beenden |
| `alerts:contacts` | Admin und höher | Kontaktpunkte und Richtlinien anlegen, ändern und löschen; Geheimnisse von Webhooks neu erzeugen; Details von Kontaktpunkten und die letzte Zustellung sehen |

Alle drei lassen sich eigenen Rollen geben. Eine Regel zu speichern braucht außerdem
`datasources:query` auf ihrer Datenquelle, und eine Regel kann nur Kontaktpunkte der eigenen
Organisation verwenden.

### Was Personen ohne Zugriff auf die Quelle sehen

Alerting gibt nicht mehr preis, als die Rechte an einer Datenquelle erlauben. Darfst du die
Datenquelle einer Regel weder lesen noch abfragen:

- Du siehst ihre Zustände und Zahlen, aber keine Labels, Werte oder Fehlerdetails; Instanzen
  zeigen verborgene Fingerabdrücke (`hidden-N`, je Antwort nummeriert).
- Die Abfrage der Regel ist verborgen, die Regel lässt sich nur ansehen.
- Gruppen auf der Seite Richtlinien zeigen weder Kennung, Richtlinie, Kontaktpunkt noch Stelle
  unter den Gruppen einer Richtlinie; sie werden als verborgene Gruppen gezählt.
- **Weg prüfen** und der Weg einer Regel folgen nur den eigenen Labels der Regel und `alertname`;
  der echte Weg kann abweichen.

Kontaktpunkte zeigen Empfänger nur als Anzahl (oder gekürzt) und Webhooks nur mit ihrem Host.

## Grenzen und Einstellungen

Server-Admins setzen die Grenzen unter Alerting in den Servereinstellungen; Organisationen dürfen
sie nur strenger machen. Standardmäßig: höchstens 500 Regeln und 50 Kontaktpunkte je
Organisation, 100 Instanzen je Regel, 5 Kontaktpunkte je Regel, 200 aktive und geplante
Stummschaltungen, 1000 Nachrichten je Stunde und 90 Tage Verlauf. Auf dem Server laufen höchstens
8 Auswertungen gleichzeitig, 4 je Organisation und 2 je Datenquelle (eine Datenquelle darf in
ihrem Abschnitt **Alerting** weniger einstellen). Eine Regel, die vor ihrem nächsten Takt nicht
starten kann, lässt ihn aus; die Regel zeigt „N Auswertungen ausgelassen“.
