[English](../export.md) | Deutsch

# Export

Exportiere ein Panel oder ein Ergebnis aus Explore als Datei, mit angewendeten
[Schritten](calculated-fields.md), oder speichere ein Panel als Bild. API: [Export](../../api/datasources.md#export).
Das Audit-Log hat einen eigenen Export, siehe [Audit-Log](administration.md#audit-log).

Die Datei behält die Form des Ergebnisses: Eine Tabelle bleibt eine Tabelle, Dokumente bleiben
Dokumente und ein Graph bleibt ein Graph. Kalzit macht nie von selbst aus einer Form eine andere;
für eine Tabelle aus Dokumenten oder aus einem Graphen füge zuerst den Schritt hinzu, der eine
erzeugt (siehe „Tabellen aus Dokumenten und Graphen“ unten).

## So geht’s

- **Panel:** der Eintrag **Exportieren…** im Menü des Panels oder **Exportieren…** im Panel-Editor.
- **Explore:** **Exportieren…** neben dem Ergebnis.

Der Dialog fragt nach dem **Ergebnis**, wenn es mehrere gibt (jedes mit seiner Form benannt:
Tabelle, Dokumente oder Graph), nach dem **Format**, das dieses Ergebnis haben kann, und bei CSV
nach den **Zahlen in der CSV-Datei**. Die Datei enthält das Ergebnis nach allen aktiven Schritten;
Zeiten in CSV- und Excel-Dateien sind in UTC. Ein Panel exportiert seine **gespeicherte** Version:
Speichere zuerst das Dashboard, um deine Änderungen zu exportieren (der Dialog weist darauf hin).

Exportieren braucht das Recht `data:export`. Bearbeiter, Admins und Eigentümer haben es,
Betrachter nicht. Ein Panel zu exportieren setzt nur voraus, dass du sein Dashboard sehen darfst:
Die Datei enthält die gespeicherten Abfragen des Panels, du brauchst also nicht das Recht, seine
Datenquellen abzufragen. Ein Export aus Explore oder aus einem Panel, das du gerade bearbeitest,
führt deine eigenen Abfragen aus und braucht das Recht, jede Datenquelle darin abzufragen. Jeder
Export wird im [Audit-Log](administration.md#audit-log) festgehalten, mit Format, Zeitraum, Umfang
(Zeilen, Dokumente oder Knoten und Kanten) und dem Panel oder den Datenquellen, nie mit den Daten.

## Formate

| Format | Details |
|---|---|
| CSV, für Excel und andere Tabellenkalkulationen | UTF-8 mit Byte Order Mark, damit Excel Umlaute richtig liest, CRLF-Zeilenenden. **Deutsch** verwendet Semikolon und Dezimalkomma, **Englisch** Komma und Dezimalpunkt. Zeiten sind ISO 8601 in UTC. Text, der mit `=`, `+`, `-` oder `@` beginnt, bekommt ein vorangestelltes `'`, damit eine Tabellenkalkulation ihn nie als Formel ausführt. |
| Excel-Arbeitsmappe (.xlsx) | Ein Blatt mit fetter, fixierter Kopfzeile und typisierten Zellen: Zahlen, Wahr/Falsch und Zeiten sind Zellen ihres Typs. Sehr große ganze Zahlen und Zeiten vor 1900 sind Text; Text wird an der Zellgrenze von Excel bei 32.767 Zeichen abgeschnitten. |
| JSON | Das Ergebnis als Frame, mit seinen Feldern und Typen. |

### Dokumente

| Format | Details |
|---|---|
| NDJSON, ein Dokument je Zeile | Jedes Dokument auf einer eigenen Zeile, mit seinen Feldern in der Reihenfolge, in der die Datenbank sie gespeichert hat, und mit unveränderten Werten. Werkzeuge wie `jq` und `mongoimport` von MongoDB lesen es. |
| JSON | Die Dokumente mit ihrer Feldliste (Schema) und den Hinweisen zum Ergebnis, etwa dass es am Zeilenlimit abgeschnitten wurde. |

### Graphen

| Format | Details |
|---|---|
| GraphML, für Gephi, yEd und Cytoscape | Knoten mit ihren Labels (`:Person:Customer`) und Eigenschaften, Kanten mit ihrem Typ und ihren Eigenschaften. Jede Eigenschaft bekommt einen Typ, der zu all ihren Werten passt (Wahr/Falsch, ganze Zahl, Dezimalzahl oder Text); Listen und Objekte werden als JSON-Text geschrieben. Pfade sind nicht Teil von GraphML, ihre Knoten und Kanten schon. |
| JSON | Knoten, Kanten und Pfade so, wie die Abfrage sie geliefert hat, mit den Labels und Kantentypen des Graphen. |

### Tabellen aus Dokumenten und Graphen

- Dokumente: Füge den Projektionsschritt („Dokumente als Tabelle“) hinzu und wähle die Felder; der
  Export bietet dann CSV, Excel und JSON für die Tabelle an.
- Graphen: Füge einen Graph-Schritt hinzu, der eine Tabelle erzeugt, etwa Labels zählen oder den
  Grad jedes Knotens; der Export bietet dann die Tabellenformate dafür an.

## Panel als Bild

**Bild speichern (PNG)** im Menü eines Panels speichert, was das Panel zeigt, als PNG-Bild: seinen
Titel, das Diagramm, die Tabelle, den Graphen oder den Text und seine Legende, in der Darstellung,
die du siehst, scharf genug für Dokumente und Folien (mindestens doppelt so viele Pixel wie auf dem
Bildschirm). Das Bild wird in deinem Browser vom Bildschirm gezeichnet, enthält also genau das, was
du siehst, ohne Anfrage an den Server, und es wird nicht im Audit-Log festgehalten. Es wird
zusammen mit dem Export angeboten, für Mitglieder, die Daten exportieren dürfen. Geöffnete Menüs
und Tooltips gehören nicht zum Bild; eine Tabelle zeigt die Zeilen, die sichtbar sind. Panels eines
Panel-Plugins zeichnen in einem eigenen Rahmen, den der Browser Kalzit nicht lesen lässt: Ihr
Bereich bleibt im Bild leer. Bilder in einem Panel (etwa in einem Text-Panel) sind Teil davon, wenn
sie von deinem Kalzit-Server kommen; Bilder von anderen Seiten werden weggelassen.

## Grenzen

- Ein Server erstellt höchstens drei Exportdateien gleichzeitig; darüber hinaus antwortet er mit
  „ausgelastet“, und du kannst es erneut versuchen.
- Eine Datei hat höchstens 256 MiB; Excel-Dateien haben höchstens 1.048.575 Zeilen und 16.384
  Spalten. Dateien werden zuerst auf der Festplatte des Servers erstellt und dann gesendet, damit
  große Exporte seinen Speicher nicht füllen. Du kannst einen Export gleichzeitig haben. Ein
  Download, der mittendrin abbricht (etwa wenn die Verbindung abreißt oder dein Browser eine Minute
  lang nicht mehr liest), wird nicht gespeichert: Exportiere erneut.
- Der Export ist außerdem durch das Zeitlimit für Abfragen und die Grenzen der Schritte beschränkt
  (siehe [Berechnete Felder und Statistik](calculated-fields.md#grenzen)).
- Ein Export enthält ein Ergebnis. Bei mehreren Abfragen wählst du im Dialog, welches.
