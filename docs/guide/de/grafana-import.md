[English](../grafana-import.md) | Deutsch

# Grafana-Dashboards importieren

Kalzit wandelt Dashboards, die aus Grafana als JSON exportiert wurden, in Kalzit-Dashboards um. Der
Import liest nur die JSON-Datei: Keine Abfrage läuft, keine Datenquelle wird kontaktiert. Jede
Datenquelle des Dashboards ordnest du einer Kalzit-Datenquelle zu. Der Import umfasst Dashboards;
Alerts, Benutzer, Datenquellen und anderer Inhalt aus Grafana werden nicht importiert.

## Was gelesen wird

- Das klassische Dashboard-JSON, `schemaVersion` 6 bis 41: Das alte Layout mit `rows` und Breiten
  in Zwölfteln (vor 16) wird auf das Raster mit 24 Spalten gelegt, das `gridPos`-Layout wird
  übernommen, wie es ist. Ein Export, der das Dashboard einpackt
  (`{ "dashboard": ..., "meta": ... }`), geht auch. Grafanas neueres Schema (v2, `elements` und
  `layouts`) wird mit einer Meldung abgelehnt; exportiere das Dashboard in Grafana stattdessen als
  klassisches JSON.
- **Panels** mit Gegenstück in Kalzit: Zeitreihe (auch das alte Graph-Panel), Stat (auch das alte
  Singlestat), Gauge, Balken-Gauge, Tabelle (auch die alte Tabelle), Tortendiagramm,
  Balkendiagramm, Heatmap, Histogramm, XY-Diagramm (seine erste Serien-Zuordnung: X-, Y-, Größen-
  und Farbfeld, Punkte oder Linien), Trend (mit seinem X-Feld), Zustands-Zeitleiste,
  Statusverlauf, Text, Node Graph (als Netzwerk-Panel) und Geomap (als Karte). Andere Panel-Arten
  und Bibliotheks-Panels werden ausgelassen, und ausgelassene Panels fehlen, sie bleiben nicht als leere Plätze stehen. Ein
  Panel, von dessen Abfragen keine umgewandelt werden konnte, wird ebenfalls ausgelassen.
- **Geomap**: Marker-Ebenen werden Punkt-Ebenen mit ihrem Ort (Koordinaten, Geohash oder
  Nachschlagen eines Ländercodes), Größenfeld, Größen und Abfrage; die Grundkarte wird zu den
  mitgelieferten Umrissen. Heatmap-, Routen-, GeoJSON- und andere Ebenen, andere
  Nachschlagelisten als Länder und ein fester Ausschnitt stehen im Bericht.
- **Abfragen** für Prometheus (PromQL), Loki (LogQL), PostgreSQL, MySQL, SQL Server, SQLite und
  ClickHouse (der SQL-Text; `$__timeFilter`, `$__timeFrom`, `$__timeTo` und `$__interval`
  funktionieren in Kalzit, andere Makros werden gemeldet), Elasticsearch (die Lucene-Abfrage;
  Aggregationen werden gemeldet) und InfluxDB (InfluxQL- oder Flux-Text). Abfragen aus Grafanas
  Abfrage-Baukasten ohne Text werden ausgelassen. `[[name]]` wird zu `$name`; Formate wie
  `${name:csv}` fallen weg, denn Kalzit bindet Werte von Variablen als Parameter.
- **Variablen**: eigene Werte, Abfrage (mit der Abfrage in der Sprache der zugeordneten Quelle),
  Konstante, Textfeld und Intervall, mit „Alle“ (`includeAll`, sein eigener Wert und eine
  gespeicherte Auswahl von „Alle“), getippten Werten (`allowCustomValue`) und bei
  Abfrage-Variablen dem regulären Ausdruck, der Sortierung (natürliche Sortierung wird zur
  Sortierung nach Namen) und wann die Werte neu gelesen werden. Ein regulärer Ausdruck, den Kalzit
  nicht ausführen kann (Lookaround, Rückverweise), fällt weg und wird gemeldet. Variablen, die
  eine Datenquelle wählen, Ad-hoc-Filter und Grafanas Hilfsfunktionen (`label_values(...)`)
  werden ausgelassen.
- **Zeilen** mit Titel, eingeklapptem Zustand und Wiederholung, **Wiederholungen** von Panels,
  **Annotations-Abfragen** (nicht Grafanas eingebaute), **Links**, **Tags** und die
  **Zeiteinstellungen**: Zeitraum, Aktualisierung, Zeitzone, Wochenbeginn, Geschäftsjahr,
  Verzögerung von „jetzt“, Aktualisierungs-Intervalle und das gemeinsame Fadenkreuz oder Tooltip.
- **Optionen**: siehe den nächsten Abschnitt. Jede Option landet nur dort, wo der Editor des
  Kalzit-Panels sie zeigt; ein importiertes Panel enthält nichts, was seine Optionen nicht zeigen.
- **Transformationen** mit einem Kalzit-Schritt: organize (Felder ordnen und umbenennen), filter
  fields by name, filter data by values (Zeilen filtern), limit, convert field type, reduce, merge
  (als „Untereinander stellen“: Zeilen mit gleichen Werten werden nicht zusammengefasst) und series
  to rows. Schritte für eine Tabelle wirken auf die erste Abfrage, bis ein merge oder series to
  rows die Abfragen zusammenführt; der Bericht sagt das. Andere Transformationen sowie
  Berechnungen und Bedingungen ohne Gegenstück werden weggelassen und gemeldet. Ein Namensmuster
  ohne Schrägstriche muss wie in Grafana auf den ganzen Namen passen. Ein regulärer Ausdruck, den
  Kalzit nicht lesen kann, kostet nur seine Bedingung oder den Namensfilter, mit einem Hinweis, der
  ihn nennt.

## Optionen: was übernommen wird und was nicht

| Grafana | In Kalzit |
| --- | --- |
| Einheiten (`currencyEUR`, `percent`, `percentunit`, `ms`, `s`, `bytes`, `decbytes`, `bps`, `binBps`, `short`, `none`, `reqps`, ...) | Dieselbe Einheit aus dem Katalog (Euro, Prozent, Bytes, ...). Die Datumsformate ISO und US werden zu Datum und Uhrzeit von Kalzit in Ortszeit und als nächstliegende Einheit gemeldet. Einheiten ohne eine solche, auch solche, die in anderen Stufen skalieren (`kbytes`, `Bps` als SI-Bytes pro Sekunde, `bits` und `binbps` als binäre Bits, `pps`, `rpm` als Lesevorgänge pro Minute, andere Währungen, `prefix:`), werden zum **eigenen Suffix** mit ihrem Zeichen und gemeldet; eine unbekannte Kennung fällt weg und wird gemeldet. |
| Nachkommastellen, Minimum und Maximum, Anzeigename, Text für „kein Wert“ | Übernommen. |
| Schwellwerte | Farben werden zum nächsten Ton (Grün, Gelb und Orange, Rot, Blau, Lila) oder bleiben eine freie Farbe; `transparent` wird neutral und wird gemeldet. |
| Wertzuordnungen: Wert, Bereich, Regex | Mit Text und Ton übernommen, auf jedem Panel mit Wertzuordnungen (Stat, Gauge, Balken-Gauge, Balkendiagramm, Tortendiagramm, Tabelle, Zeitreihe, Zustands-Zeitleiste, Statusverlauf). Besondere Treffer (null, NaN, true, false, leer) werden gemeldet. |
| Feld-Überschreibungen nach Name, nach einer Liste von Namen, nach regulärem Ausdruck | Überschreibungen **Mit dem Namen** oder **Passend zu einem regulären Ausdruck**, mit Farbe, Einheit, Minimum und Maximum, Nachkommastellen, Anzeigename, Wertzuordnungen, Schwellwerten, Linienbreite und den anderen Optionen des Diagrammstils, Zellanzeige, Spaltenbreite und dem ersten Datenlink. Andere Auswahlarten (nach Typ, nach Abfrage, nach Wert) und andere Eigenschaften werden gemeldet. |
| `legendFormat` von Prometheus und Loki | Die Vorlage **Namen der Reihen** der Zeitreihe (`{{label}}` und Text). Abfragen mit verschiedenen Formaten teilen sich das erste; andere Panel-Arten melden es. |
| Zeitreihe: Zeichenstil, Linieninterpolation, Linienbreite, Deckkraft der Füllung, Stapeln (normal, Prozent), Punkte, Linienstil, Lücken, Balkenausrichtung, Anzeige der Schwellwerte (`line`, `area`, `line+area`; gestrichelt wird durchgezogen) | Die gleichnamigen Optionen des Diagrammstils. Ausgeblendete Reihen und Transformationen von Reihen werden gemeldet. |
| Farbschemata | Bei Zeitreihen: Palette, feste Farbe, Schwellwerte, `shades` (eine Farbe) und die stufenlosen Schemata (Grün-Gelb-Rot, Blautöne; andere werden zum nächstliegenden und gemeldet). Bei Balkendiagrammen werden die Grün-nach-Rot-Schemata zu Schwellenfarben; andere Schemata werden gemeldet. |
| Legenden (Art, Platz, Breite, Werte) und Tooltips (Art) | Übernommen bei Zeitreihe, XY-Diagramm, Trend, Balkendiagramm, Tortendiagramm, Histogramm, Zustands-Zeitleiste und Statusverlauf. Legendenwerte bei Zeitreihen und Balkendiagrammen: letzter, erster, Summe, Perzentile und die übrigen Rechnungen, die Kalzit kennt (Standardabweichung und Varianz über eine Stichprobe); die anderen werden gemeldet. Sortierung, ausgeblendete Nullen und Größe des Tooltips bei Zeitreihen; sonst wird seine Sortierung gemeldet. |
| Werteachse (Platzierung, Beschriftung, Breite, Gitterlinien, Farbe, Achsenlinie, lineare, logarithmische oder Log-um-null-Skala, Null in der Mitte, weiche Grenzen) | Übernommen bei Zeitreihe, Balkendiagramm und Histogramm. Der lineare Bereich von „Log um null“ wird gemeldet: In Kalzit ist er fest. |
| Stat, Gauge, Balken-Gauge, Tortendiagramm | Berechnung (letzter, Mittelwert, Minimum, Maximum, Summe; andere werden gemeldet), Farb-, Graph- und Textmodus, Schwellenmarken, LCD-Anzeige, Ausrichtung, Anzeige von Wert und Name, Tortenart und Legendenwerte. |
| Balkendiagramm | Werte gezeigt oder nicht. Waagrechte Balken und Stapeln werden gemeldet: Das Balkendiagramm von Kalzit steht aufrecht, mit Balken nebeneinander. |
| Heatmap | Zählen in Buckets oder fertige Buckets lesen, Anzahl der Buckets, die Quadratwurzel-Farbskala und die Einheit der Achse. Bucket-Größen, logarithmische Buckets und Farbschemata werden gemeldet. |
| Tabelle | Die Zellarten Gauge, farbiger Hintergrund und farbiger Text werden zur Zellanzeige, dazu Spaltenfilter und -breiten. Der Organize-Schritt wird zu einem Schritt, der Spalten ausblendet, ordnet und umbenennt (siehe Transformationen oben); Überschreibungen treffen dann wie in Grafana die neuen Namen. Die Fußzeile und die Start-Sortierung werden gemeldet. |

## Der Bericht

Jedes Element bekommt eine Zeile: **übernommen**, **angenähert** (mit dem, was sich geändert hat)
oder **ausgelassen** (mit dem Grund). Der Bericht bleibt beim Dashboard; die API liefert ihn unter
`GET /api/orgs/{orgId}/dashboards/{dashboardId}/import-report`. Das umgewandelte Dashboard
durchläuft dieselben Prüfungen wie jedes Speichern, auch das Recht, jede zugeordnete Datenquelle
abzufragen.

## In der Oberfläche

**Dashboards > Aus Grafana importieren** führt durch drei Schritte. Zuerst die Datei: hochladen
oder ihr JSON einfügen, das Dashboard benennen und seinen Ordner wählen. Dann die Datenquellen:
Jede Quelle der Datei bekommt eine von Kalzit, vorgeschlagen nach Name und Art (Grafanas
Standardquelle: die Standard-Datenquelle der Organisation), oder wird weggelassen; ihre Panels entfallen dann. Zuletzt der Bericht, bevor etwas angelegt ist;
**Importieren** legt das Dashboard an und öffnet es mit einer Zeile, die zurück zum Bericht
führt (die Adresse des Dashboards mit `/import-report`).

## Über die Kommandozeile

```text
kalzit provision import-grafana lager.json --server https://kalzit.example.com --org ID \
  --map '${DS_LAGER}=0199...' --map prom-uid=0199... [--folder-id ID] [--dry-run] [--output json]
```

`kalzit import grafana` ist derselbe Befehl. `--map` ordnet eine Grafana-Datenquelle der ID einer Kalzit-Datenquelle zu: über ihre uid, ihren
Namen, die Eingabe `${DS_X}` eines Exports oder `default` für Panels ohne Quelle (fehlt
`default`, gilt die Standard-Datenquelle der Organisation, wenn sie eine hat). `--dry-run`
wandelt um und zeigt den Bericht, ohne zu speichern. Das Token kommt aus `KALZIT_API_TOKEN`, wie
beim [Provisioning](provisioning.md); die Rolle braucht `dashboards:write` dort, wo das Dashboard
hinkommt, und `datasources:query` auf den zugeordneten Quellen.

Die API-Route ist `POST /api/orgs/{orgId}/dashboards/import/grafana` mit
`{ dashboard, datasources: { <grafana>: <Kalzit-ID> }, folderId?, dryRun? }`; sie antwortet mit dem
Bericht, dem umgewandelten Modell und dem gespeicherten Dashboard.

Um ein importiertes Dashboard als Code zu führen, exportiere es danach mit
`kalzit provision export`.
