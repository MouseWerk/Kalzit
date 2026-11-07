[English](../query-languages.md) | Deutsch

# Abfragesprachen für Einsteiger

Diese Seite ist für dich, wenn du [Explore](explore.md) öffnest und noch nie eine Abfrage in der
Sprache deiner Datenquelle geschrieben hast. Jeder Abschnitt unten zeigt, was die Quelle enthält,
ein paar kleine Abfragen zum Einstieg und wie Kalzits Zeitraum und die Dashboard-Variablen in die
Abfrage gelangen. Die genauen Regeln je Art stehen in der API-Referenz: [Datenquellen und Abfragen](../../api/datasources.md#queries-post-orgsorgidquery).

Du musst nicht mit einem leeren Editor anfangen:

- **Hier anfangen** erscheint, solange der Editor leer ist. Seine Startaktionen setzen eine sichere,
  nur lesende Abfrage für die gewählte Datenquelle ein, etwa die ersten Zeilen einer Tabelle oder
  die neuesten Logzeilen. Führe sie so aus, wie sie ist, und ändere sie dann Stück für Stück.
- Die Liste **Schema** zeigt die Tabellen, Collections, Metriken, Indizes oder Labels der Quelle.
  Neben einem Eintrag setzt **Zeilen zeigen** eine Abfrage für seine ersten Zeilen ein, **Zählen**
  zählt sie und **Aufbau zeigen** listet seine Spalten oder Felder mit ihren Typen.
- **Spickzettel** (Umschalt+F1 überall, oder Strg+/ / Cmd+/ außerhalb des Editors, wo diese Tasten
  Zeilen auskommentieren) öffnet eine kurze Referenz der aktuellen Sprache: die gängigen Klauseln,
  die Makros und wie Variablen geschrieben werden.
- Schlägt eine Abfrage fehl, kommt der Fehler mit einem **Hinweis** in einfachen Worten: was die
  Quelle nicht angenommen hat und was du stattdessen versuchen kannst.
- **Abfrage zeigen** neben einer Startaktion oder einem Schritt zeigt die Abfrage dahinter, damit
  du lesen kannst, wie sie geschrieben ist, und die Sprache an deinen eigenen Daten lernst.

Jedes Ergebnis behält seine eigene Form: ein `frame` (Zeilen und Spalten), `documents` (so, wie die
Datenbank sie speichert) oder ein `graph` (Knoten und Kanten). Kalzit wandelt nie eine Form
heimlich in eine andere um; eine Umwandlung ist ein Schritt, den du hinzufügst. Datenquellen sind
nur lesend: Eine Abfrage, die die Datenbank beschreiben, löschen oder ändern würde, wird
abgewiesen, bevor sie die Quelle erreicht (siehe [Datenquellen](data-sources.md#nur-lesend)).

## Wie Zeitraum und Variablen wirken

Der Zeitraum, den du in Explore (oder auf dem Dashboard) wählst, filtert in den meisten Sprachen
nichts von selbst: Du setzt ein **Makro** wie `$__timeFilter(created_at)` oder `$__timeFrom` in die
Abfrage, und Kalzit füllt den Zeitraum ein. Prometheus, Loki und die Suchquellen sind die
Ausnahmen: Sie fragen immer den gewählten Zeitraum ab. Makros wie `$__interval` liefern ein
Gruppierungsintervall, das zum Zeitraum und zur Breite des Panels passt. **Dashboard-Variablen**
werden `$name` (oder `${name}`) geschrieben und auf einem Dashboard gefüllt; Explore hat keine
Variablen, also probiere eine Abfrage zuerst mit einem festen Wert und ersetze ihn durch die
Variable, sobald die Abfrage in einem Panel steht. Ein Wert ändert nie den Aufbau einer Abfrage:
SQL, Cypher und MongoDB erhalten Werte als gebundene Parameter, und PromQL, LogQL, InfluxQL und
Lucene bekommen sie in den Text geschrieben, wobei jedes Anführungszeichen und Sonderzeichen
maskiert wird.

## PostgreSQL

PostgreSQL enthält Tabellen aus Zeilen und Spalten, gruppiert in Schemas (meist `public`). Du liest
sie mit einer einzigen `SELECT`- oder `WITH`-Anweisung.

```sql
SELECT * FROM orders ORDER BY created_at DESC LIMIT 100
```

Die 100 neuesten Bestellungen mit allen Spalten.

```sql
SELECT status, count(*) AS orders FROM orders GROUP BY status ORDER BY orders DESC LIMIT 100
```

Wie viele Bestellungen es je Status gibt, die größte Gruppe zuerst.

```sql
SELECT id, total, created_at FROM orders WHERE total > 100 AND status = 'paid' ORDER BY total DESC LIMIT 100
```

Bezahlte Bestellungen über 100, die größten zuerst.

```sql
SELECT c.name, count(o.id) AS orders, sum(o.total) AS revenue
FROM customers c JOIN orders o ON o.customer_id = c.id
GROUP BY c.name ORDER BY revenue DESC LIMIT 100
```

Bestellungen und Umsatz je Kunde, durch Verknüpfen zweier Tabellen.

```sql
SELECT date_bin($__interval, created_at, TIMESTAMP '2000-01-01') AS time, count(*) AS orders
FROM orders WHERE $__timeFilter(created_at)
GROUP BY 1 ORDER BY 1 LIMIT 1000
```

Bestellungen im Zeitverlauf innerhalb des gewählten Zeitraums, eine Zeile je Intervall (`date_bin`
braucht PostgreSQL 14 oder neuer); das ergibt eine Zeitreihe.

**Zeitraum und Variablen:** `$__timeFilter(column)` behält die Zeilen im Zeitraum, `$__timeFrom`
und `$__timeTo` sind seine Enden, `$__interval` ist ein `interval`-Wert und `$__interval_ms`
dasselbe in Millisekunden. Eine Variable ist `$status`; eine Variable mit mehreren Werten gehört in
`IN ($status)`. Variablen kommen als Text an, wandle sie also für andere Spaltentypen um:
`id = $id::int`.

## MySQL und MariaDB

MySQL und MariaDB enthalten Tabellen in Datenbanken. Du liest sie mit einer einzigen `SELECT`- oder
`WITH`-Anweisung; Namen dürfen in Backticks stehen.

```sql
SELECT * FROM orders ORDER BY created_at DESC LIMIT 100
```

Die 100 neuesten Bestellungen.

```sql
SELECT status, COUNT(*) AS orders FROM orders GROUP BY status ORDER BY orders DESC LIMIT 100
```

Anzahl der Bestellungen je Status.

```sql
SELECT id, total FROM orders WHERE status = 'paid' AND total > 100 ORDER BY total DESC LIMIT 100
```

Bezahlte Bestellungen über 100.

```sql
SELECT c.name, COUNT(o.id) AS orders
FROM customers c JOIN orders o ON o.customer_id = c.id
GROUP BY c.name ORDER BY orders DESC LIMIT 100
```

Bestellungen je Kunde.

```sql
SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(created_at) * 1000 / $__interval_ms) * $__interval_ms / 1000) AS time,
       COUNT(*) AS orders
FROM orders WHERE $__timeFilter(created_at)
GROUP BY 1 ORDER BY 1 LIMIT 1000
```

Bestellungen je Intervall innerhalb des gewählten Zeitraums.

**Zeitraum und Variablen:** `$__timeFilter(column)`, `$__timeFrom`, `$__timeTo`, `$__interval`
(Text wie `30s`) und `$__interval_ms` (eine ganze Zahl). Zeiten werden in UTC verglichen.
Variablen sind `$name`, Listen gehören in `IN ($name)`.

## SQLite

Eine SQLite-Quelle ist eine Datenbankdatei mit Tabellen. Kalzit öffnet sie nur lesend und liest
sie mit einer einzigen `SELECT`- oder `WITH`-Anweisung.

```sql
SELECT * FROM orders LIMIT 100
```

Die ersten 100 Zeilen einer Tabelle.

```sql
SELECT status, COUNT(*) AS orders FROM orders GROUP BY status ORDER BY orders DESC LIMIT 100
```

Anzahl der Bestellungen je Status.

```sql
SELECT id, total, created_at FROM orders WHERE total > 100 ORDER BY created_at DESC LIMIT 100
```

Die neuesten Bestellungen über 100.

```sql
SELECT strftime('%Y-%m-%d', created_at) AS day, COUNT(*) AS orders
FROM orders WHERE $__timeFilter(created_at)
GROUP BY day ORDER BY day LIMIT 1000
```

Bestellungen je Tag innerhalb des gewählten Zeitraums.

```sql
SELECT c.name, SUM(o.total) AS revenue
FROM customers c JOIN orders o ON o.customer_id = c.id
GROUP BY c.name ORDER BY revenue DESC LIMIT 100
```

Umsatz je Kunde.

**Zeitraum und Variablen:** `$__timeFilter(column)` funktioniert für Zeiten, die als Text oder als
Unix-Sekunden oder -Millisekunden gespeichert sind; `$__timeFrom` und `$__timeTo` sind Text
(`YYYY-MM-DD HH:MM:SS.SSS`, UTC), dazu `$__interval` und `$__interval_ms`. Variablen sind `$name`,
Listen gehören in `IN ($name)`.

## SQL Server

SQL Server enthält Tabellen in Datenbanken und Schemas (meist `dbo`). Du liest sie mit einer
einzigen `SELECT`- oder `WITH`-Anweisung. SQL Server kennt kein `LIMIT`: Schreibe `TOP` nach
`SELECT`.

```sql
SELECT TOP 100 * FROM orders ORDER BY created_at DESC
```

Die 100 neuesten Bestellungen.

```sql
SELECT TOP 100 status, COUNT(*) AS orders FROM orders GROUP BY status ORDER BY orders DESC
```

Anzahl der Bestellungen je Status.

```sql
SELECT TOP 100 id, total FROM orders WHERE status = 'paid' AND total > 100 ORDER BY total DESC
```

Bezahlte Bestellungen über 100.

```sql
SELECT TOP 100 c.name, COUNT(o.id) AS orders
FROM customers c JOIN orders o ON o.customer_id = c.id
GROUP BY c.name ORDER BY orders DESC
```

Bestellungen je Kunde.

```sql
SELECT TOP 1000 CAST(created_at AS date) AS day, COUNT(*) AS orders
FROM orders WHERE $__timeFilter(created_at)
GROUP BY CAST(created_at AS date) ORDER BY day
```

Bestellungen je Tag innerhalb des gewählten Zeitraums.

**Zeitraum und Variablen:** `$__timeFilter(column)`, `$__timeFrom`, `$__timeTo`, `$__interval`
und `$__interval_ms`, wie bei den anderen SQL-Quellen. Variablen sind `$name`, Listen gehören in
`IN ($name)`. Abfragehinweise (`OPTION (...)`) und Tabellenhinweise außer `NOLOCK` werden
abgewiesen.

## ClickHouse

ClickHouse enthält große Tabellen für Auswertungen, oft eine Zeile je Ereignis. Du liest sie mit
SQL im eigenen Dialekt von ClickHouse, mit einer einzigen `SELECT`- oder `WITH`-Anweisung.

```sql
SELECT * FROM events ORDER BY ts DESC LIMIT 100
```

Die 100 neuesten Ereignisse.

```sql
SELECT path, count() AS requests FROM events GROUP BY path ORDER BY requests DESC LIMIT 100
```

Anfragen je Pfad, die meistbesuchten zuerst.

```sql
SELECT path, status FROM events WHERE status >= 500 ORDER BY ts DESC LIMIT 100
```

Die neuesten fehlgeschlagenen Anfragen.

```sql
SELECT toStartOfInterval(ts, $__interval) AS time, count() AS requests
FROM events WHERE $__timeFilter(ts)
GROUP BY time ORDER BY time LIMIT 1000
```

Anfragen je Intervall innerhalb des gewählten Zeitraums.

**Zeitraum und Variablen:** Die SQL-Makros (`$__timeFilter(column)`, `$__timeFrom`, `$__timeTo`,
`$__interval`, `$__interval_ms`) und Variablen (`$name`) werden zu ClickHouse-Abfrageparametern.
`SETTINGS`- und `FORMAT`-Klauseln, von Hand geschriebene Parameter wie `{name:Type}` und
Tabellenfunktionen, die Dateien oder andere Server lesen, werden abgewiesen.

## Prometheus

Prometheus enthält Metriken: benannte Zahlenreihen über die Zeit, jede mit Labels wie `job` oder
`status`. Du liest sie mit PromQL. Es gibt kein `LIMIT`: Eine Bereichsabfrage ist durch den
Zeitraum und die Schrittweite begrenzt.

```promql
up
```

Jedes Ziel und ob es erreichbar war (1) oder nicht (0).

```promql
http_requests_total{status="500"}
```

Der Anfragenzähler, nur für Reihen mit dem Label `status="500"`.

```promql
sum by (status) (rate(http_requests_total[$__rate_interval]))
```

Anfragen pro Sekunde, eine Linie je Status.

```promql
topk(5, sum by (path) (rate(http_requests_total[$__rate_interval])))
```

Die fünf meistbesuchten Pfade.

```promql
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[$__rate_interval])))
```

Das 95. Perzentil der Anfragedauer.

**Zeitraum und Variablen:** Jede Abfrage deckt den gewählten Zeitraum ab; schalte **Sofortabfrage**
ein für einen einzelnen Wert an seinem Ende. `$__rate_interval` ist ein sicheres Fenster für
`rate()`; `$__interval`, `$__interval_ms`, `$__range`, `$__timeFrom` und `$__timeTo`
(Unix-Sekunden) gibt es ebenfalls. Variablen funktionieren nur innerhalb von Zeichenketten in
Anführungszeichen, etwa `job="$job"`; eine Variable mit mehreren Werten wird zu `a|b`, verwende sie
also mit `=~`: `job=~"$job"`.

## InfluxDB

InfluxDB enthält Messungen (etwa `cpu`) mit Feldern (den Werten) und Tags (etwa `host`) über die
Zeit, in einer Datenbank oder einem Bucket. Je nach Version schreibst du Flux (1.8, 2.x), InfluxQL
(jede Version) oder SQL (3.x).

```flux
from(bucket: v.bucket)
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "cpu")
  |> limit(n: 100)
```

Flux: die ersten 100 Werte der Messung `cpu` je Reihe innerhalb des gewählten Zeitraums.

```flux
from(bucket: v.bucket)
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "cpu" and r._field == "usage")
  |> aggregateWindow(every: v.windowPeriod, fn: mean)
```

Flux: die mittlere Auslastung je Intervall, eine Linie je Reihe.

```sql
SELECT mean("usage") FROM "cpu" WHERE $__timeFilter GROUP BY time($__interval), "host" LIMIT 1000
```

InfluxQL: die mittlere Auslastung je Intervall und Host innerhalb des gewählten Zeitraums.

```sql
SHOW MEASUREMENTS LIMIT 100
```

InfluxQL: welche Messungen die Datenbank enthält.

```sql
SELECT time, host, usage FROM cpu WHERE time >= $__timeFrom AND time <= $__timeTo ORDER BY time DESC LIMIT 100
```

SQL (3.x): die neuesten Zeilen von `cpu` innerhalb des gewählten Zeitraums.

**Zeitraum und Variablen:** In Flux verwendest du `v.timeRangeStart`, `v.timeRangeStop`,
`v.windowPeriod` (das Intervall) und `v.bucket` (den Bucket der Quelle); `$__timeFrom`,
`$__timeTo`, `$__interval`, `$__interval_ms` und `$__range` funktionieren auch. In InfluxQL nimmt
`$__timeFilter` keine Spalte, und `GROUP BY time($__interval)` gruppiert nach dem Intervall. In
Flux und InfluxQL funktionieren Variablen nur innerhalb von Zeichenketten, etwa `r.host == "$host"`
oder `"host" = '$host'`. `to()` in Flux und `INTO` in InfluxQL werden abgewiesen.

## Loki

Loki enthält Logzeilen in Streams; jeder Stream ist durch seine Labels benannt, etwa
`{app="shop"}`. Du liest sie mit LogQL: Zuerst wählst du Streams nach Label, dann filterst du die
Zeilen.

```logql
{app="shop"}
```

Die neuesten Logzeilen der `shop`-Streams (höchstens 1.000 Zeilen, wenn du kein niedrigeres Limit
setzt).

```logql
{app="shop"} |= "error"
```

Nur Zeilen, die `error` enthalten.

```logql
{app="shop"} | json | status >= 500
```

Liest jede Zeile als JSON und behält die mit einem `status` von 500 oder mehr.

```logql
sum by (level) (count_over_time({app="shop"}[$__interval]))
```

Anzahl der Zeilen je Level und Intervall: eine Metrikabfrage, die eine Zeitreihe ergibt.

```logql
sum(rate({app="shop"} |= "error" [$__rate_interval]))
```

Fehlerzeilen pro Sekunde.

**Zeitraum und Variablen:** Jede Abfrage deckt den gewählten Zeitraum ab; Logabfragen ergeben
`documents` (eines je Zeile), Metrikabfragen ein `frame`. `$__interval`, `$__rate_interval`,
`$__range` und die anderen Prometheus-Makros funktionieren genauso. Variablen funktionieren nur
innerhalb von Zeichenketten in Anführungszeichen, etwa `{app="$app"}`; eine Variable mit mehreren
Werten wird zu `a|b` für `=~`.

## Elasticsearch und OpenSearch

Elasticsearch und OpenSearch enthalten JSON-Dokumente in Indizes, oft ein Index je Tag
(`logs-2026.11.02`), erfasst durch ein Muster wie `logs-*`. Du durchsuchst sie mit einer
**Lucene**-Suchzeichenkette oder mit **JSON-DSL** (einem JSON-Suchkörper). Setze die **Anzahl
Treffer**, damit die Antwort klein bleibt (500, wenn leer).

```text
status:500
```

Lucene: Dokumente, deren Feld `status` 500 ist.

```text
status:500 AND path:"/checkout"
```

Lucene: beide Bedingungen; setze Werte mit Leer- oder Sonderzeichen in Anführungszeichen.

```text
level:error AND NOT service:billing
```

Lucene: Fehler aller Dienste außer einem.

```json
{ "query": { "range": { "duration_ms": { "gte": 1000 } } }, "sort": [{ "@timestamp": "desc" }], "size": 100 }
```

JSON-DSL: die 100 neuesten Dokumente, die eine Sekunde oder länger gedauert haben.

```json
{ "aggs": { "per_status": { "terms": { "field": "status", "size": 10 } } } }
```

JSON-DSL: die Anzahl der Dokumente je Status, als Tabelle mit einer Zeile je Wert.

```json
{ "aggs": { "time": { "date_histogram": { "field": "@timestamp", "fixed_interval": "$__interval" } } } }
```

JSON-DSL: die Anzahl der Dokumente je Intervall, eine Zeitreihe.

**Zeitraum und Variablen:** Wenn **Nach dem Zeitraum filtern** eingeschaltet ist, wird der gewählte
Zeitraum immer als Filter auf das **Zeitfeld** angehängt, du schreibst ihn also nicht selbst.
`$__timeFrom` und `$__timeTo` (Unix-ms), `$__interval` und `$__interval_ms` gibt es auch. In Lucene
wird eine Variable wie `country:$country` zu einer Phrase in Anführungszeichen; in JSON-DSL ist
eine Variable oder ein Makro eine ganze Zeichenkette wie `"$country"` oder `"$__interval"`. **Mit
einer Vorlage beginnen** in Explore setzt die gängigen Formen ein.

## CSV- und JSON-Dateien

Eine Dateiquelle liest eine CSV-, JSON- oder NDJSON-Datei; CSV ergibt ein `frame`, JSON und NDJSON
ergeben `documents`. Es gibt keine Abfragesprache: Die Datenquelle nennt bereits die Datei und wie
sie gelesen wird, also ist die Abfrage leer und die ganze Datei wird bei jedem Lauf gelesen,
innerhalb der Zeilen- und Größengrenzen.

Stattdessen formst du die Daten mit **Schritten** im Bereich **Schritte und Aktionen** rechts:

- **Gruppieren** zählt oder summiert je Wert, etwa Bestellungen je Status.
- **Berechnetes Feld** fügt eine Spalte aus einem Ausdruck hinzu, etwa `total * 1.19`.
- **Statistik** liefert Anzahl, Summe, Mittelwert, Median und mehr je Feld.
- Bei JSON-Dokumenten macht **Projektionsschritt hinzufügen** zuerst aus gewählten Feldern
  Tabellenspalten.

Unter [Berechnete Felder und Statistik](calculated-fields.md) findest du jeden Schritt und die
Ausdruckssprache.

**Zeitraum und Variablen:** Eine Datei hat keine Makros. Zeitraum und Variablen filtern die Datei
nicht; sie wird immer ganz gelesen.

## HTTP JSON

Eine HTTP-JSON-Quelle liest JSON von einer Web-API mit `GET`-Anfragen und ergibt `documents`. Statt
einer Abfragesprache füllst du drei Felder aus:

- **Pfad**: wird unter der URL der Quelle angehängt, etwa `orders/open`. Er muss unterhalb dieser
  URL bleiben.
- **Abfrageparameter**: Paare aus Name und Wert, etwa `status` = `paid` oder `page_size` = `100`.
- **Pfad zu den Dokumenten**: wo die Liste in der Antwort steht, als Pfad mit Punkten wie
  `data.items` (Zahlen wählen Array-Elemente: `results.0.rows`). Leer verwendet die Einstellung der
  Quelle oder die ganze Antwort.

```json
{ "path": "orders", "params": { "status": "paid", "page_size": 100 }, "documentsPath": "data.items" }
```

Bezahlte Bestellungen von `<source URL>/orders?status=paid&page_size=100`, ein Dokument je Element
von `data.items`.

```json
{ "path": "customers", "params": { "country": "$country" }, "documentsPath": "results" }
```

Kunden des Landes, das in einer Dashboard-Variable gewählt ist.

**Zeitraum und Variablen:** Kalzit hängt den Zeitraum nicht an die Anfrage an; ob die API nach Zeit
filtern kann, hängt von der API ab. Ein Parameter, dessen Wert genau `$name` ist, übernimmt den
Wert der Variable; eine Variable mit mehreren Werten wiederholt den Parameter
(`country=AT&country=CH`). Mit Schritten rechts projizierst, gruppierst oder berechnest du weiter.

## MongoDB

MongoDB enthält Dokumente (verschachtelte, JSON-ähnliche Einträge) in Collections. Du liest eine
Collection mit einer **Aggregations-Pipeline** (einer Liste von Stufen, von denen jede mit der
Ausgabe der vorigen arbeitet) oder mit **Find** (ein Filter, eine Projektion, eine Sortierung und
ein Limit). Wähle die **Collection** in Explore; die Beispiele unten schreiben sie der
Vollständigkeit halber neben die Pipeline (die API nimmt die Pipeline als Text).

```json
{ "collection": "orders", "pipeline": [ { "$sort": { "created_at": -1 } }, { "$limit": 100 } ] }
```

Die 100 neuesten Bestellungen.

```json
{ "collection": "orders", "pipeline": [
  { "$match": { "status": "paid", "total": { "$gt": 100 } } },
  { "$limit": 100 }
] }
```

Bezahlte Bestellungen über 100.

```json
{ "collection": "orders", "pipeline": [
  { "$group": { "_id": "$status", "orders": { "$sum": 1 } } },
  { "$sort": { "orders": -1 } },
  { "$limit": 100 }
] }
```

Anzahl der Bestellungen je Status, die größte Gruppe zuerst.

```json
{ "collection": "orders", "pipeline": [
  { "$match": { "$__timeFilter": "created_at" } },
  { "$lookup": { "from": "customers", "localField": "customer_id", "foreignField": "_id", "as": "customer" } },
  { "$limit": 100 }
] }
```

Bestellungen innerhalb des gewählten Zeitraums, jede mit angehängtem Kundendokument.

```json
{ "collection": "orders", "filter": "{\"status\": \"paid\"}", "projection": "{\"total\": 1, \"created_at\": 1}",
  "sort": "{\"created_at\": -1}", "limit": 100 }
```

Dieselbe Art Frage mit **Find**: bezahlte Bestellungen, nur zwei Felder, neueste zuerst, höchstens
100.

In der Pipeline-Ansicht lässt sich jede Stufe ausschalten und als Vorschau ansehen (**Vorschau nach
Stufe N**); so siehst du gut, was eine Stufe tut. `$out` und `$merge` schreiben und werden
abgewiesen.

**Zeitraum und Variablen:** `{"$__timeFilter": "created_at"}` innerhalb eines `$match` oder eines
Filters behält die Dokumente im Zeitraum; `"$__timeFrom"` und `"$__timeTo"` sind seine Enden als
Datumswerte und `"$__interval_ms"` das Intervall. Eine Variable wird als ganze Zeichenkette
geschrieben, `"${status}"`; eine Variable mit mehreren Werten wird zu einem Array, für
`{ "status": { "$in": "${status}" } }`.

## Neo4j und Memgraph

Neo4j und Memgraph enthalten einen Graphen: Knoten mit Labels (etwa `Person`) und Beziehungen mit
Typen (etwa `KNOWS`), beide mit Eigenschaften. Du liest sie mit Cypher, das mit `MATCH` das Muster
beschreibt, nach dem du suchst, und mit `RETURN`, was zurückkommt. Jede Abfrage läuft in einer
lesenden Transaktion.

```cypher
MATCH (p:Person) RETURN p LIMIT 100
```

Die ersten 100 `Person`-Knoten.

```cypher
MATCH (p:Person) RETURN p.city AS city, count(*) AS people ORDER BY people DESC LIMIT 100
```

Anzahl der Personen je Stadt, als Tabelle.

```cypher
MATCH (a:Person)-[k:KNOWS]->(b:Person) WHERE a.city = 'Graz' RETURN a, k, b LIMIT 100
```

Personen in einer Stadt und wen sie kennen, als Graph.

```cypher
MATCH path = shortestPath((a:Person {name: 'Ana'})-[:KNOWS*..4]-(b:Person {name: 'Ben'})) RETURN path
```

Die kürzeste Kette von Bekanntschaften zwischen zwei Personen, höchstens vier Schritte; verwende
dafür das Panel **Pfade**.

```cypher
MATCH (a:Person)-[k:KNOWS]->(b:Person) WHERE k.since >= $__timeFrom AND k.since <= $__timeTo RETURN a, k, b LIMIT 100
```

Bekanntschaften, die innerhalb des gewählten Zeitraums entstanden sind.

```cypher
CALL db.labels()
```

Welche Knoten-Labels die Datenbank enthält.

```cypher
CALL community_detection.get() YIELD node, community_id RETURN community_id, count(*) AS size
```

Memgraph mit MAGE: wie groß jede Community ist. Graphalgorithmen, die nur lesen, sind in beiden
Datenbanken erlaubt (Neo4j GDS im Modus `stream` und `stats` auf einem Graphen, den ein Admin
projiziert hat); siehe [Graphalgorithmen](data-sources.md#graphalgorithmen-neo4j-gds-memgraph-mage).

**Zeitraum und Variablen:** `$__timeFrom` und `$__timeTo` sind DateTime-Werte in UTC,
`$__timeFromMs`, `$__timeToMs` und `$__interval_ms` ganze Zahlen in Millisekunden. Variablen sind
Cypher-Parameter, etwa `WHERE p.name = $name` oder `WHERE p.id IN $ids`. Ein auf einem Dashboard
gewählter Wert ist Text: Vergleiche mit `toInteger($id)`, wenn die Eigenschaft Zahlen enthält.

## TigerGraph

TigerGraph enthält einen Graphen aus Knoten (etwa `Person`) und Kanten (etwa `KNOWS`) in einem
benannten Graphen. Du liest ihn mit GSQL, entweder als interpretierte Abfrage, die du in Explore
schreibst (**GSQL schreiben**), oder indem du eine der **installierten Abfragen** des Graphen
ausführst (**Installierte Abfrage ausführen**). Eine interpretierte Abfrage ist ein einziges
`INTERPRET QUERY (...) FOR GRAPH <graph> { ... }` und verwendet den Graphen der Datenquelle; ein
`SELECT`-Block wählt Knoten aus und `PRINT` gibt sie zurück.

```gsql
INTERPRET QUERY () FOR GRAPH Social {
  start = {Person.*};
  result = SELECT p FROM start:p LIMIT 100;
  PRINT result;
}
```

Die ersten 100 `Person`-Knoten.

```gsql
INTERPRET QUERY () FOR GRAPH Social {
  start = {Person.*};
  result = SELECT p FROM start:p WHERE p.city == "Graz" ORDER BY p.name LIMIT 100;
  PRINT result;
}
```

Personen in einer Stadt, nach Namen sortiert.

```gsql
INTERPRET QUERY () FOR GRAPH Social {
  MapAccum<STRING, SumAccum<INT>> @@per_city;
  start = {Person.*};
  result = SELECT p FROM start:p ACCUM @@per_city += (p.city -> 1);
  PRINT @@per_city;
}
```

Anzahl der Personen je Stadt, gezählt in einem Akkumulator.

```gsql
INTERPRET QUERY () FOR GRAPH Social {
  SetAccum<EDGE> @@edges;
  start = {Person.*};
  friends = SELECT t FROM start:s -(KNOWS:e)- Person:t ACCUM @@edges += e LIMIT 100;
  PRINT friends, @@edges;
}
```

Personen und wen sie kennen, einen Schritt entlang `KNOWS`; werden auch die Kanten ausgegeben,
ergibt das einen Graphen.

```gsql
INTERPRET QUERY (STRING city) FOR GRAPH Social {
  start = {Person.*};
  result = SELECT p FROM start:p WHERE p.city == city LIMIT 100;
  PRINT result;
}
```

Derselbe Filter mit einem deklarierten Parameter `city`, gefüllt in Explore oder aus einer
Dashboard-Variable.

**Zeitraum und Variablen:** GSQL hat keine Makros, und Variablen werden nie zu GSQL-Text: `$name`
im Code wird abgewiesen. Deklariere stattdessen einen Parameter, wie im letzten Beispiel; ein leer
gelassener Parameter übernimmt die Dashboard-Variable mit demselben Namen. Für einen Zeitfilter
deklarierst du `DATETIME`-Parameter und füllst sie aus Variablen. Eine installierte Abfrage listet
in Explore ihre Parameter mit ihren Typen und folgt derselben Regel.
