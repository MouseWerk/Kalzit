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
  Balkendiagramm, Heatmap, Histogramm, Zustands-Zeitleiste, Statusverlauf, Text und Node Graph
  (als Netzwerk-Panel). Andere Panel-Arten und Bibliotheks-Panels werden ausgelassen, und
  ausgelassene Panels fehlen, sie bleiben nicht als leere Plätze stehen. Ein Panel, von dessen
  Abfragen keine umgewandelt werden konnte, wird ebenfalls ausgelassen.
- **Abfragen** für Prometheus (PromQL), Loki (LogQL), PostgreSQL, MySQL, SQL Server, SQLite und
  ClickHouse (der SQL-Text; `$__timeFilter`, `$__timeFrom`, `$__timeTo` und `$__interval`
  funktionieren in Kalzit, andere Makros werden gemeldet), Elasticsearch (die Lucene-Abfrage;
  Aggregationen werden gemeldet) und InfluxDB (InfluxQL- oder Flux-Text). Abfragen aus Grafanas
  Abfrage-Baukasten ohne Text werden ausgelassen. `[[name]]` wird zu `$name`; Formate wie
  `${name:csv}` fallen weg, denn Kalzit bindet Werte von Variablen als Parameter.
- **Variablen**: eigene Werte, Abfrage (mit der Abfrage in der Sprache der zugeordneten Quelle),
  Konstante, Textfeld und Intervall. Variablen, die eine Datenquelle wählen, Ad-hoc-Filter und
  Grafanas Hilfsfunktionen (`label_values(...)`) werden ausgelassen.
- **Zeilen** mit Titel, eingeklapptem Zustand und Wiederholung, **Wiederholungen** von Panels,
  **Annotations-Abfragen** (nicht Grafanas eingebaute), **Links**, **Tags** und die
  **Zeiteinstellungen**: Zeitraum, Aktualisierung, Zeitzone, Wochenbeginn, Geschäftsjahr,
  Verzögerung von „jetzt“, Aktualisierungs-Intervalle und das gemeinsame Fadenkreuz oder Tooltip.
- **Optionen**: Einheiten, Nachkommastellen, Minimum und Maximum, Anzeigename, Text für „kein
  Wert“ und Schwellwerte (Farben werden zum nächsten Ton); die wichtigsten Optionen von Stat,
  Gauge, Balken-Gauge, Tortendiagramm und Legende und Tooltip der Zeitreihe. Wertzuordnungen,
  Feld-Überschreibungen und andere Darstellungsoptionen werden als nicht übernommen gemeldet.

## Der Bericht

Jedes Element bekommt eine Zeile: **übernommen**, **angenähert** (mit dem, was sich geändert hat)
oder **ausgelassen** (mit dem Grund). Der Bericht bleibt beim Dashboard; die API liefert ihn unter
`GET /api/orgs/{orgId}/dashboards/{dashboardId}/import-report`. Das umgewandelte Dashboard
durchläuft dieselben Prüfungen wie jedes Speichern, auch das Recht, jede zugeordnete Datenquelle
abzufragen.

## Über die Kommandozeile

```text
kalzit provision import-grafana lager.json --server https://kalzit.example.com --org ID \
  --map '${DS_LAGER}=0199...' --map prom-uid=0199... [--folder-id ID] [--dry-run] [--output json]
```

`kalzit import grafana` ist derselbe Befehl. `--map` ordnet eine Grafana-Datenquelle der ID einer Kalzit-Datenquelle zu: über ihre uid, ihren
Namen, die Eingabe `${DS_X}` eines Exports oder `default` für Panels ohne Quelle. `--dry-run`
wandelt um und zeigt den Bericht, ohne zu speichern. Das Token kommt aus `KALZIT_API_TOKEN`, wie
beim [Provisioning](provisioning.md); die Rolle braucht `dashboards:write` dort, wo das Dashboard
hinkommt, und `datasources:query` auf den zugeordneten Quellen.

Die API-Route ist `POST /api/orgs/{orgId}/dashboards/import/grafana` mit
`{ dashboard, datasources: { <grafana>: <Kalzit-ID> }, folderId?, dryRun? }`; sie antwortet mit dem
Bericht, dem umgewandelten Modell und dem gespeicherten Dashboard.

Um ein importiertes Dashboard als Code zu führen, exportiere es danach mit
`kalzit provision export`.
