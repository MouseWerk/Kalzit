[English](../performance.md) | Deutsch

# Leistung und Cache

Wie Kalzit Dashboards schnell hält, ohne deine Datenbanken zu belasten, und was du einstellst, wenn
eine Quelle langsam ist oder immer aktuell sein muss.

## Der Abfrage-Cache

Kalzit behält die Antworten von Abfragen eine Zeit lang auf dem Server. Wenn du ein Dashboard
erneut öffnest, zu ihm zurückwechselst oder ein anderes Panel dasselbe fragt, kommt die Antwort
aus dem Speicher statt aus der Datenbank.

- **Pro Person.** Eine Antwort wird für die Person behalten, die sie ausgeführt hat. Niemand sieht
  je eine Antwort, die mit den Rechten eines anderen entstanden ist: Jede Person hat ihre eigenen
  Einträge, und Kalzit prüft deine Rechte bei jedem Laden, bevor es in den Cache schaut.
- **Aktualisieren fragt die Datenbank.** Die Schaltfläche **Aktualisieren** eines Dashboards führt
  die Abfragen immer in ihren Quellen aus und behält die neuen Antworten. Das Öffnen eines
  Dashboards, die automatische Aktualisierung und ein neuer Zeitraum nutzen den Cache.
- **Relative Zeiträume.** Bei einem Zeitraum, der jetzt endet („Letzte 6 Stunden“), schiebt Kalzit
  den Zeitraum auf einen runden Schritt zurück, damit dicht aufeinanderfolgende Ladevorgänge sich
  eine Antwort teilen. Der Schritt ist das Intervall des Panels, mindestens eine Sekunde und
  höchstens so lange, wie die Quelle Antworten behält. Der neueste Punkt kann also bis zu einen
  Schritt alt sein; mit dem Standard höchstens eine Minute.
- **Live bleibt live.** Live-Updates (Change Streams und das Abfragen live aktualisierter
  Dashboards), Exporte, Anmerkungen und Feldverteilungen fragen immer die Quelle.
- **Nur Antworten.** Fehler und Zeitüberschreitungen werden nie behalten: Das nächste Laden
  versucht es erneut.

### Pro Datenquelle

Jede Datenquelle hat in ihren Einstellungen einen Abschnitt **Cache**:

- **Antworten auf dem Server zwischenspeichern**: standardmäßig an für SQL-Datenbanken
  (PostgreSQL, MySQL und MariaDB, SQL Server, SQLite), Elasticsearch und OpenSearch, Neo4j,
  Memgraph und TigerGraph; standardmäßig aus für Prometheus, MongoDB, Dateien, HTTP-APIs und
  Plugins, deren Werte oft live sind.
- **Antworten behalten für (Sekunden)**: standardmäßig 60, bis zu einem Tag. Nimm ein paar Sekunden
  für Daten, die sich oft ändern, Minuten für aufwendige Auswertungen über Daten, die sich langsam
  ändern. Schalte den Cache für Werte aus, die immer aktuell sein müssen.

Jede Änderung an den Einstellungen einer Datenquelle verwirft ihre behaltenen Antworten.

### Für den Server

Unter **Verwaltung > Einstellungen > Datenquellen und Ziele** finden Server-Admins:

- **Abfrage-Cache**: an oder aus für den ganzen Server. Ausgeschaltet wird nichts behalten, und was
  behalten wurde, wird verworfen.
- **Speicher des Abfrage-Caches (Bytes)**: wie viel Speicher alle behaltenen Antworten zusammen
  belegen dürfen (standardmäßig 256 MiB). Ist er voll, gehen die am längsten nicht verwendeten
  Antworten zuerst; eine einzelne Antwort, die größer als ein Viertel davon ist, wird nicht
  behalten.
- **Abfrage-Cache jetzt**: wie viele Antworten behalten werden, wie viel Speicher sie belegen und
  wie oft Ladevorgänge seit dem Start des Servers aus dem Cache kamen, mit **Cache leeren**. Das
  Leeren wird im Audit-Log verzeichnet.

Änderungen an Rechten (Freigaben, Rollen, Mitglieder, Teams, eingeschränkte Ordner) verwerfen die
behaltenen Antworten der Organisation sofort.

## Sehen, was passiert ist

Die Ansicht **Untersuchen** eines Panels (und der Tab **Untersuchen** in Explore) sagt pro Abfrage,
ob die Antwort aus dem Abfrage-Cache kam und wie alt sie ist, oder dass sie in der Datenquelle lief
und wie lange sie behalten wird. API-Clients lesen den Header `X-Kalzit-Cache` (`hit`, `miss`,
`refresh` oder `off`) und den Teil `cache` jeder Antwort; `Cache-Control: no-cache` fragt die
Quellen direkt ([API](../../api/datasources.md#query-cache)).

## Weitere Limits, die den Server ansprechbar halten

- Jede Abfrage hat ein Zeitlimit (standardmäßig 30 s) und ein Zeilenlimit (100.000), pro Quelle
  innerhalb des Maximums des Servers ([Datenquellen](data-sources.md#grenzen-für-jede-quelle)).
- Höchstens 8 Abfragen pro Person und 64 auf dem ganzen Server laufen gleichzeitig; weitere warten.
- Die Antworten einer Anfrage dürfen 128 MiB Speicher belegen, die aller laufenden Anfragen 1 GiB.
