# Kalzit: Plan

Arbeitstitel war Granit; der Produktname ist Kalzit (siehe Abschnitt 13).

Kalzit ist eine selbst gehostete Plattform zur Visualisierung und Auswertung von Daten, im
Funktionsumfang von Grafana (Dashboards, Datenquellen, Rollen, Teams, Plugins), neu entworfen. Sie
richtet sich nicht nur an Monitoring, sondern an jede Art von Daten: Geschäftsdaten, Produktdaten,
Beziehungsnetze, Metriken. Der Unterschied: Dokumentdatenbanken (MongoDB) und Graphdatenbanken
(Neo4j, Memgraph, TigerGraph) sind gleichberechtigte, native Datenformen. Ein Ergebnis aus MongoDB
bleibt ein Baum von Dokumenten, ein Ergebnis aus Neo4j bleibt ein Graph aus Knoten und Kanten.
Nichts wird intern in eine Tabelle gepresst. Daneben werden alle üblichen Quellen unterstützt
(MySQL, PostgreSQL, SQL Server, Prometheus, ...). Server läuft auf Windows und Linux.

Grundlage: https://github.com/mauricekleindienst/AICodeGuidelines. Kalzit ist eine Neuentwicklung,
kein Fork: kein Grafana-Code, kein Grafana-Name oder -Logo im Produkt. Lizenz: AGPL-3.0. Betrieb:
nur selbst gehostet, keine Cloud-Variante.

---

## 1. Kernidee: drei native Datenformen statt "alles ist ein DataFrame"

Grafana normalisiert jedes Ergebnis zu einem DataFrame (Spalten mit gleich langen Feldern).
Verschachtelte Dokumente werden dabei flachgeklopft, Graphen zu zwei Tabellen ("nodes", "edges")
zerlegt. Genau das baut Kalzit nicht nach.

Jede Abfrage liefert einen **Result Envelope** mit genau einer Form:

```ts
type QueryResult =
  | { shape: "frame";     frame: Frame }        // Zeitreihen, SQL-Tabellen, Metriken
  | { shape: "documents"; docs: DocumentSet }   // MongoDB & Co.
  | { shape: "graph";     graph: GraphSet };    // Neo4j, Memgraph, TigerGraph & Co.

interface DocumentSet {
  documents: Document[];          // Original-BSON als typisiertes JSON (ObjectId, Date, Decimal128,
                                  // Binary bleiben als eigene Typen erhalten, kein String-Cast)
  schema: FieldSchema;            // aus Stichprobe abgeleitet: Pfade, Typen je Pfad, Häufigkeit in %,
                                  // Array-Längen, polymorphe Felder (z. B. 80 % string, 20 % int)
  cursor?: CursorToken;           // Nachladen statt alles auf einmal
}

interface GraphSet {
  nodes: Node[];                  // id, labels[], properties (typisiert)
  edges: Edge[];                  // id, type, from, to, properties
  paths?: Path[];                 // wenn die Abfrage Pfade zurückgibt, bleiben sie als Pfade erhalten
  schema: GraphSchema;            // Labels, Kantentypen, Property-Keys je Label
  truncated?: { reason: string; limit: number };
}
```

Regeln:

- Panels deklarieren, welche Formen sie verstehen. Der Panel-Picker zeigt zuerst die, die zur
  Form passen.
- **Projektionen sind sichtbar und gewollt, nie versteckt.** Wer aus Dokumenten eine Zeitreihe will
  (z. B. `$.metrics.cpu` über `$.ts`), legt im Query-Editor einen Schritt "Projektion" an. Er steht
  als Schritt beim Panel (Entscheidung 13), ist abschaltbar und rückgängig zu machen, und das
  Original bleibt verfügbar. Es gibt keine implizite Konvertierung im Backend.
- Transformationen arbeiten formgerecht: Dokument-Transformationen (Feld auswählen, Array
  entfalten, gruppieren) und Graph-Transformationen (Nachbarschaft erweitern, Subgraph filtern,
  Knoten zusammenfassen) sind eigene Kataloge, nicht Tabellen-Transformationen mit anderem Namen.

## 2. Visualisierung, die zur Datenform passt

### Dokumente (MongoDB)

- **Dokument-Explorer**: Liste mit aufklappbarem Baum je Dokument, Typ-Anzeige pro Wert,
  Pfad kopieren, Werte filtern per Klick (erzeugt `$match`-Stufe).
- **Schema-Panel**: alle Feldpfade mit Typverteilung und Abdeckung in %, Ausreißer sichtbar
  (Feld fehlt in 3 % der Dokumente, Typ gemischt). Das ist bei Mongo die eigentlich wertvolle Sicht.
- **Feldverteilung**: Histogramm, Top-Werte, Min/Max je Feldpfad, auch innerhalb von Arrays.
- **Verschachtelte Arrays**: Drilldown-Ansicht (Array als eigene Unterliste, nicht als JSON-String).
- **Dokumentkarte**: ein Dokument als lesbare Karte (für "Detail zu Variable $id").
- **Geo**: GeoJSON-Felder direkt auf einer Karte.
- Zeitreihe, Stat, Balken funktionieren über eine sichtbare Projektion (s. o.).

### Graphen (Neo4j, Memgraph, TigerGraph)

- **Netzwerk-Panel** (WebGL, Sigma.js + Graphology): Force-Layout, Farbe nach Label, Größe nach
  Property oder Grad, Kantenstärke nach Property, Beschriftung je nach Zoomstufe.
- **Hierarchie-/Baum-Layout** für gerichtete, azyklische Strukturen (Abhängigkeiten, Org-Charts).
- **Pfad-Panel**: kürzeste Wege und Pfade als lesbare Abfolge Knoten → Kante → Knoten.
- **Explorer-Modus**: Klick auf einen Knoten lädt die Nachbarschaft nach (Abfrage beim Aufklappen,
  mit Limit), Rückgängig für jeden Schritt.
- **Graph-Kennzahlen**: Grad, Komponenten, optional Community-Erkennung (Neo4j GDS / MAGE, wenn
  vorhanden; sonst im Client für kleine Graphen).
- **Zeitregler** für Kanten mit Zeitstempel (Graph zu Zeitpunkt t).
- **Große Graphen**: hartes Knotenlimit pro Panel mit sichtbarem Hinweis, Clustering und
  Level-of-Detail statt Absturz des Browsers.
- Auswahl und Hervorhebung nach den Design-Regeln: der Rest des Graphen wird gedimmt, der gewählte
  Knoten bekommt Beschriftung und Gewicht. Keine Glow-Ringe oder Akzentrahmen.

### Querverbindungen

- Dashboard-Variablen funktionieren formübergreifend: ein Klick auf ein Mongo-Dokument setzt
  `$customerId`, das Graph-Panel zeigt die Beziehungen dieses Kunden.
- Data Links aus Dokument-Feldern und Knoten-Properties.

### Datenauswertung

Dashboards zeigen, die Auswertung beantwortet Fragen. Beides arbeitet auf denselben Abfragen.

- **Explore**: Ad-hoc-Abfragen ohne Dashboard, mit Verlauf; ein Ergebnis lässt sich mit einem
  Klick als Panel in ein Dashboard übernehmen.
- **Gespeicherte Auswertungen**: Abfrage, Schritte und Ansicht als benannte Auswertung, mit Rechten
  wie Dashboards, teilbar im Team.
- **Berechnete Felder und Ausdrücke**: Formeln über Felder einer Quelle und über mehrere Abfragen
  hinweg (z. B. Umsatz aus SQL geteilt durch Sitzungen aus Prometheus), formgerecht: für Dokumente
  auf Feldpfaden, für Graphen auf Knoten- und Kanten-Properties.
- **Statistik**: Summe, Mittelwert, Median, Perzentile, Standardabweichung, Trend, gleitender
  Durchschnitt, Korrelation zweier Reihen, Vergleich mit Vorperiode (Woche, Monat, Jahr).
- **Gruppieren und Pivotieren** für `frame`, **Gruppieren nach Feldpfad und Array-Entfaltung** für
  `documents`, **Aggregation über Nachbarschaften und Pfade** für `graph` (z. B. Kunden mit den
  meisten gemeinsamen Produkten).
- **Drilldown**: von der Kennzahl über die Gruppe bis zum einzelnen Datensatz, Dokument oder Knoten.
- **Anmerkungen** an Zeitpunkten und Datensätzen, im Team sichtbar.
- **Export**: CSV (Trennzeichen und Dezimalkomma je nach Sprache, BOM für Excel), Excel, JSON;
  Dokumente als JSON/NDJSON, Graphen als GraphML/JSON. Export nur mit Recht `data:export`.
- Schwere Auswertungen laufen in der Datenbank (Pushdown: SQL `GROUP BY`, Mongo `$group`, Cypher-
  Aggregation), nicht im Browser; nur wo die Quelle es nicht kann, rechnet der Server.

## 3. Datenquellen

Neben den nativen Dokument- und Graph-Quellen unterstützt Kalzit alle üblichen Standards. Jede Quelle
liefert die Form, die ihr Datenmodell hat; relationale und Zeitreihen-Quellen sind von Natur aus
`frame`.

| Quelle | Form | Treiber | Meilenstein |
|---|---|---|---|
| PostgreSQL (inkl. TimescaleDB) | frame | `sqlx` | M1 |
| MySQL, MariaDB | frame | `sqlx` | M1 |
| Microsoft SQL Server | frame | `tiberius` (wichtig für Windows-Umgebungen) | M1 |
| SQLite | frame | `sqlx` | M1 |
| Prometheus (PromQL, auch Mimir, Thanos, VictoriaMetrics) | frame | HTTP-API | M1 |
| MongoDB | documents | `mongodb` | M2 |
| Elasticsearch, OpenSearch | documents (Treffer), frame (Aggregationen) | HTTP-API | M2 |
| Neo4j, Memgraph | graph | `neo4rs` (Bolt) | M3 |
| TigerGraph 3.10+ und 4.x (GSQL) | graph | HTTP-Client-Factory: REST++ `/query/{graph}/{query}` für installierte, GSQL-Server `/gsql/v1/queries/interpret` für interpretierte Abfragen; Token über `/gsql/v1/tokens` (3.x: `/requesttoken`) aus einem Secret im Credential Store | M3 |
| InfluxDB (1.x InfluxQL, 2.x/3.x SQL und Flux) | frame | HTTP-API | M5 |
| Loki (Logs) | frame mit Log-Zeilen | HTTP-API | M5 |
| ClickHouse | frame | HTTP/native | M5 |
| Graphite | frame | HTTP-API | M6 |
| Redis | frame bzw. documents (Hashes, JSON) | `redis` | M6 |
| Oracle | frame | `oracle` (braucht Oracle-Client, daher eigenes Plugin) | M6 |
| Tempo, Jaeger (Traces) | graph (Span-Baum) | HTTP/gRPC | M6 |
| CSV/JSON-Datei, HTTP-JSON | frame bzw. documents | eingebaut | M2 |

- Gemeinsame Basis für SQL-Quellen: ein Editor mit Schema-Browser (Datenbanken, Tabellen, Spalten),
  Makros für Zeitbereich und Intervall (`$__timeFilter`, `$__interval`), Variablen, Nur-Lesen-Prüfung
  (nur `SELECT`/`WITH`, zusätzlich Read-only-Transaktion, wo die Datenbank das anbietet).
- Jede Quelle ist intern ein Plugin mit derselben Schnittstelle (Abschnitt 8); Quellen, die externe
  Client-Bibliotheken brauchen (Oracle), werden als separates Plugin ausgeliefert, damit das
  Haupt-Binary ohne Zusatzinstallation auf Windows und Linux läuft.
- Für jede Quelle gibt es Integrationstests gegen die echte Datenbank in einem Container und eine
  Doku-Seite.

## 4. Query-Editoren

- **MongoDB**: Aggregation-Pipeline-Editor mit Vorschau nach jeder Stufe (wie Compass),
  Autovervollständigung aus dem gesampelten Schema, Modus "find" für einfache Filter, Zeitbereich
  des Dashboards als Makro (`$__timeFilter("ts")`).
- **Cypher**: Editor mit Autovervollständigung für Labels, Kantentypen und Properties aus dem
  Schema, optional ein visueller Pattern-Builder (`(:Kunde)-[:KAUFT]->(:Produkt)`).
- **SQL**: Standard-Editor für PostgreSQL/MySQL.
- Alle Editoren: Abfrage wird serverseitig ausgeführt, nie direkt vom Browser zur Datenbank.

## 5. Sicherheit beim Abfragen

- Datenquellen sind standardmäßig **nur lesend**:
  - MongoDB: Pipelines mit `$out`, `$merge` und schreibenden Befehlen werden abgelehnt; zusätzlich
    Empfehlung und Prüfung eines DB-Users mit `read`-Rolle.
  - Neo4j/Memgraph: Ausführung in Read-Transaktionen (`AccessMode::Read`); `CREATE`, `MERGE`,
    `DELETE`, `SET`, `CALL ... write` werden abgelehnt.
  - TigerGraph kennt keine Read-Transaktion wie Bolt, daher sichern zwei Ebenen ab:
    - **Zwingend ein lesender Nutzer**: Rolle `queryreader` (ab 4.1 das gleichwertige Recht
      `EXECUTE_QUERY` je Abfrage). Kalzit prüft die Rechte beim Speichern und beim Verbindungstest
      und lehnt die Datenquelle ab, wenn der Nutzer mehr darf.
    - **Prüfung des GSQL-Texts** mit einem echten Tokenizer und Parser, kein Muster-Abgleich;
      was sich nicht parsen lässt, wird abgelehnt. Erlaubt ist genau ein Abfragekörper.
      Abgelehnt werden `INSERT INTO`, `UPDATE`, `DELETE` und `DELETE FROM` (auch als eigene
      Anweisung), Attribut-Zuweisungen in `ACCUM`/`POST-ACCUM`, Aufrufe anderer Abfragen,
      Dateiausgabe (`PRINT ... TO_CSV`, `FILE`-Objekte), Loading Jobs sowie Schema-, Rechte- und
      Verwaltungsanweisungen (`CREATE`, `ALTER`, `DROP`, `RUN SCHEMA_CHANGE`, `INSTALL QUERY`,
      `GRANT`, `REVOKE`, `CLEAR GRAPH STORE`). Globale Akkumulatoren (`@@`) gelten nur für
      einen Lauf und sind kein Schreiben.
    - Installierte Abfragen werden nur ausgeführt, wenn ihr GSQL-Text lesbar ist und die
      Prüfung besteht. Ist er nicht lesbar, nur über eine vom Admin freigegebene Liste; eine
      freigegebene Abfrage, die TigerGraph als schreibend kennzeichnet (`graphUpdate` in der
      Abfrage-Info), wird trotzdem abgelehnt, sonst schützt allein der lesende Nutzer.
    - Gegen TigerGraph 4.2.5 (Community Edition, nächtlicher Job) geklärt: `queryreader` darf
      den eigenen Nutzer-Eintrag lesen und interpretierte Abfragen ausführen (ohne
      `EXECUTE_QUERY`), aber den Text installierter Abfragen nicht (`READ_QUERY` fehlt), daher
      laufen sie mit einem reinen `queryreader` nur über die Freigabeliste. Die Rolle hat in 4.2
      zusätzlich `APP_ACCESS_DATA` und `READ_POLICY` (beides lesend). Schreibende Abfragen lehnt
      der Server für ihn ab. REST++-Authentifizierung ist in einer frischen Community Edition
      aus; ohne sie läuft jede installierte Abfrage für jeden, daher ist sie Voraussetzung.
    - Kalzit ruft weder Upsert- noch Lade-Endpunkte von REST++ auf.
    - Variablen gehen als typisierte Abfrageparameter an REST++, nie als Text in den GSQL-Code.
- Limits je Datenquelle: Zeitlimit, maximale Dokumente/Knoten, maximale Antwortgröße.
- Collection- bzw. Label-Allowlist pro Datenquelle möglich.
- Guard-Tests prüfen genau diese Ablehnungen (Testfälle mit schreibenden Abfragen).

## 6. Organisationen, Teams, Rollen

- **Modell**: Server → Organisationen → Teams → Benutzer; Ordner (verschachtelt) → Dashboards und
  gespeicherte Auswertungen; Datenquellen gehören zur Organisation.
- **Zwei Ebenen von Rollen**:
  - *Server-Ebene*: Server-Admin (Server-Einstellungen, Organisationen, alle Benutzer, Plugins,
    Lizenz- und Systeminfo) und normale Benutzer.
  - *Organisations-Ebene*: Eigentümer, Admin, Bearbeiter, Betrachter als feste Rollen, dazu
    **eigene Rollen** aus feingranularen Rechten.
- **Rechte-Katalog** (Aktion:Ressource, mit Bereich): `dashboards:read|write|delete|share`,
  `folders:read|write|permissions`, `datasources:query|read|write|permissions`,
  `analyses:read|write`, `data:export`, `teams:read|write|members`, `users:read|invite|write`,
  `roles:read|write`, `serviceaccounts:write`, `annotations:write`, `audit:read`,
  `plugins:install|configure`, `settings:read|write`. Bereich: alle, ein Ordner, eine Datenquelle,
  ein Team.
- **Zuweisung** an Benutzer, Teams und Dienstkonten; effektive Rechte sind die Vereinigung aus
  Rolle, Team-Rollen und direkten Freigaben. Ein "Warum darf ich das?"-Dialog zeigt die Herkunft
  jedes Rechts.
- **Vererbung**: Rechte an Ordnern gelten für Unterordner und enthaltene Dashboards; Rechte pro
  Datenquelle (wer darf abfragen, wer darf bearbeiten). Kein Recht ohne Grundlage: Standard ist
  "kein Zugriff".
- **Schutzregeln**: der letzte Eigentümer einer Organisation und der letzte Server-Admin können
  nicht entfernt oder herabgestuft werden; niemand kann sich selbst mehr Rechte geben, als er hat.
- **Prüfung immer auf dem Server**, pro Anfrage und pro Ressource (Guideline: nie nur im UI). Ein
  Guard-Test stellt sicher, dass jede Route eine Rechteprüfung deklariert.
- **Anmeldung**: lokale Benutzer (Argon2id), OIDC (Entra ID, Keycloak, Google, Authentik), LDAP
  inkl. Active Directory (wichtig für Windows-Umgebungen), SAML später; Rollen- und Team-Zuordnung
  aus Gruppen; Zwei-Faktor mit TOTP und Passkeys (WebAuthn), erzwingbar pro Organisation.
- **Benutzerverwaltung**: Einladung per Mail-Link (nur Hash gespeichert, läuft ab), Passwort
  vergessen, Konto sperren, Sitzungen ansehen und beenden ("überall abmelden").
- **Dienstkonten und API-Tokens**: nur Hash gespeichert, Ablaufdatum, Bereich (Scopes).
- **Audit-Log**: wer hat was wann geändert (Anmeldungen, Rechte, Dashboards, Datenquellen,
  Plugins, Einstellungen), durchsuchbar, Aufbewahrungsdauer einstellbar, Export.

## 7. Plugins

| Typ | Läuft wo | Schnittstelle |
|---|---|---|
| Datenquelle | Eigener Prozess neben dem Server | gRPC über lokale Verbindung (stdio/Named Pipe unter Windows, Unix-Socket unter Linux) |
| Panel | Browser | ES-Modul mit festgelegter Panel-API, deklariert unterstützte Formen |
| App | Beides | Seiten plus Backend-Teil |

- Die eingebauten Datenquellen (SQL-Quellen, Prometheus, MongoDB, Neo4j/Memgraph usw.) benutzen **dieselbe** Schnittstelle
  wie externe Plugins, nur in den Server einkompiliert. So ist die Plugin-API von Anfang an echt.
- **Manifest**: Name, Version, Typ, gelieferte Formen (`frame`, `documents`, `graph`), benötigte
  Rechte (Netzwerkziele), Plattform-Binaries (`windows-x64`, `linux-x64`, `linux-arm64`).
- **Signatur**: Ed25519, öffentliche Schlüssel im Server; unsignierte Plugins nur nach expliziter
  Freigabe durch einen Admin.
- **SDKs**: Rust zuerst, danach TypeScript/Node und Go.
- Plugin-Prozesse werden mit Zeitlimit gestartet, überwacht und neu gestartet; ein abgestürztes
  Plugin legt nur seine Panels lahm, nicht den Server.

## 8. Windows- und Linux-Server

- **Ein Binary** `kalzit` mit eingebetteter Weboberfläche, für Windows x64, Linux x64 und Linux
  arm64.
- **Windows**: `kalzit service install|uninstall|start|stop` als Windows-Dienst, Daten unter
  `%ProgramData%\Kalzit`, Logs zusätzlich ins Ereignisprotokoll, Installer als MSI (ohne
  kostenpflichtiges Code-Signing), winget-Paket.
- **Linux**: `.deb` und `.rpm` mit systemd-Unit, `/etc/kalzit`, `/var/lib/kalzit`, eigener
  Systembenutzer; Docker-Image.
- **Geheimnisse** (Datenquellen-Passwörter, Signaturschlüssel): verschlüsselt in der Datenbank, der
  Hauptschlüssel aus dem OS-Speicher: Windows DPAPI/Credential Manager, Linux systemd-credentials
  oder Umgebungsvariable/Datei mit Rechten 0600. Nie im Klartext in Config oder Log.
- Pfade, Zeilenenden, Groß-/Kleinschreibung und reservierte Dateinamen (`CON`, `COM1`) werden an
  der Grenze normalisiert (Guideline `quality/bug-classes.md`).
- **CI-Matrix**: jeder Build, jeder Unit- und jeder e2e-Test läuft auf `ubuntu-latest` **und**
  `windows-latest`. Ein Release nur, wenn beide grün sind.

### Server-Einstellungen

Einstellungen kommen aus drei Quellen mit fester Rangfolge: Umgebungsvariable (`KALZIT_*`) vor
Konfigurationsdatei (`kalzit.toml`) vor Datenbank (in der UI geändert). Was per Datei oder
Umgebung gesetzt ist, zeigt die UI gesperrt mit Hinweis auf die Quelle. Netzwerk- und
TLS-Einstellungen sind nur über Datei/Umgebung änderbar (sonst sperrt man sich aus).

| Bereich | Einstellungen |
|---|---|
| Netzwerk | Adresse und Port für HTTP und HTTPS, öffentliche URL, Unterpfad (`/kalzit`), HTTP → HTTPS-Umleitung |
| TLS | eigenes Zertifikat und Schlüssel (PEM, Neuladen ohne Neustart), automatisch über ACME/Let's Encrypt, minimale TLS-Version 1.2, HTTP/2 |
| Reverse Proxy | vertrauenswürdige Proxys (IP-Bereiche), `X-Forwarded-*` nur von diesen (`Forwarded` nach RFC 7239 folgt in M5), Beispielkonfigurationen für nginx, Caddy, IIS, Traefik |
| Sicherheit | HSTS (an, Dauer), CSP, Cookie-Flags, CORS (aus), erlaubte Einbettung (`frame-ancestors`), Login-Ratenlimit |
| Sitzungen | Dauer, Leerlauf-Timeout, gleichzeitige Sitzungen, "Angemeldet bleiben" |
| Passwörter | Mindestlänge, Prüfung gegen bekannte geleakte Passwörter (k-Anonymität, abschaltbar), 2FA-Pflicht |
| Anmeldung | lokale Anmeldung an/aus, OIDC, LDAP/AD, Selbstregistrierung (aus), Standardrolle neuer Benutzer |
| Mail (SMTP) | Server, Port, STARTTLS/TLS, Absender, Testmail senden |
| Darstellung | Standardsprache, Standardthema (hell, dunkel, System, Kontrast), Startseite, Logo und Name (Branding) |
| Daten | Datenbank (SQLite/PostgreSQL), Abfrage-Timeouts und Limits global, Cache, Aufbewahrung von Verlauf, Audit-Log und Papierkorb |
| Betrieb | Log-Level und -Format (Text/JSON), Health (`/healthz`), Readiness (`/readyz`), Prometheus-Metriken (`/metrics`, optional geschützt), Backup-Zeitplan und -Ziel |
| Plugins | Katalog an/aus, unsignierte Plugins erlauben (aus), Plugin-Verzeichnis |
| Updates | Prüfung auf neue Versionen (aus, opt-in), keine Telemetrie |
| Info | Version, Build, Lizenz (AGPL-3.0 mit Link zum Quellcode, wie die Lizenz es bei Netzwerknutzung verlangt), Systemstatus |

Jede Änderung in der UI landet im Audit-Log; Einstellungen mit mehreren abhängigen Feldern (SMTP,
OIDC, LDAP) haben einen expliziten Speichern-Knopf mit Verbindungstest, alle anderen gelten sofort
mit Rückgängig (Ausnahme nach `design/principles.md`, in `CLAUDE.md` festgehalten).

## 9. Technik

| Bereich | Wahl | Begründung |
|---|---|---|
| Server | Rust (axum, tokio, sqlx) | Ein natives Binary für Windows und Linux, Windows-Dienst ohne Zusatz, bekannter Stack aus Arcalo |
| Treiber | `mongodb` (offiziell), `neo4rs` (Bolt, auch Memgraph), `sqlx` (PostgreSQL, MySQL/MariaDB, SQLite), `tiberius` (SQL Server), HTTP-Client-Factory für API-Quellen (Prometheus, Elasticsearch, TigerGraph) | Native Typen bleiben erhalten (BSON, Bolt-Strukturen, SQL-Typen) |
| Eigene Daten | SQLite (Standard, ein Server), PostgreSQL (mehrere Instanzen/HA) | Kein Pflicht-Datenbankserver für kleine Installationen |
| Frontend | React 19.3 mit React Compiler 1.0, TypeScript 7 (nativer Compiler), Vite 8 (Rolldown), TanStack Router und Query | Stand Oktober 2026; größtes Ökosystem für Panels und Plugin-Autoren, typsichere Routen |
| CSS | Eigene Tokens in modernem CSS: OKLCH-Farben, `light-dark()`, Cascade Layers, Container Queries, View Transitions, Popover-API und Anchor Positioning | Kein CSS-Framework nötig, Guard-Tests prüfen die Regeln |
| Werkzeuge | Biome (Format und Lint), Vitest 5, Playwright | Schnell, wenige Abhängigkeiten |
| HTTPS | rustls (kein OpenSSL, identisch auf Windows und Linux) | Keine Systembibliothek nötig |
| Zeitreihen | uPlot | Sehr schnell bei vielen Punkten |
| Graphen | Sigma.js + Graphology (WebGL); ForceAtlas2 für Netzwerke, für Hierarchien ein eigenes Schichten-Layout (Zyklen aufbrechen, Schichten nach längstem Pfad, Baryzentrum-Sortierung) im Layout-Worker | Zehntausende Knoten flüssig, keine zusätzliche Layout-Bibliothek im Bundle; ELK (elkjs) kommt höchstens in M5 als optionales Layout |
| Diagramme sonst | ECharts | Balken, Heatmaps, Verteilungen |
| Live-Daten | WebSocket; MongoDB Change Streams, sonst Polling | Push statt ständiges Neuladen |
| Plugin-Protokoll | gRPC (tonic) | Plattformübergreifend, SDKs in mehreren Sprachen |

Dashboards werden als versioniertes JSON mit Schema-Version gespeichert; jede Version hat einen
Migrationsschritt. Jede Speicherung erzeugt eine Version (Verlauf, Wiederherstellen), Löschen geht
zuerst in den Papierkorb mit Rückgängig.

## 10. Design und Texte

- Guideline `design/principles.md` vollständig: Tokens, keine Akzentrahmen oder Glows für
  Zustände, neutraler Fokusring nur auf `:focus-visible`, keine farbigen Balken links, AA-Kontrast
  in hellem, dunklem und Kontrast-Thema (auch für Graph-Farben und Diagrammfüllungen: 3:1).
- Panels mit Tastatur bedienbar (Pfeiltasten im Dokumentbaum, Knotenauswahl im Graphen per Tab
  und Pfeil), F6 zwischen Regionen.
- UI auf Deutsch ("du") und Englisch über i18n-Kataloge, Glossar ab Tag 1
  (z. B. „Datenquelle“, „Panel“, „Dokument“, „Knoten“, „Kante“).
- Breiten: 900, 1280, 1920 px und Smartphone (Dashboards lesen unterwegs).

## 11. Tests und Qualität

| Ebene | Was |
|---|---|
| Unit | Result Envelope, Schema-Sampling (polymorphe Felder, Umlaute/Emoji in Feldnamen), Rechteauflösung, Dashboard-Migrationen |
| Integration | Jede Datenquelle gegen die echte Datenbank in Containern (MongoDB, Neo4j, Memgraph, PostgreSQL, MySQL, MariaDB, SQL Server, Prometheus, ...) (lokal und CI, Linux; Windows mit Dienst-Installationen oder Fakes). TigerGraph ist für den PR-Check zu groß (Image 2,5 GB komprimiert, Abfragen installieren dauert Minuten, kein Windows-Container): im PR-Check ein Fake, gegen die echte Community Edition (ohne Lizenz, läuft auf GitHub-Runnern) ein nächtlicher Linux-Job, auch manuell startbar |
| Contract | Plugin-Protokoll gegen ein Test-Plugin; abstürzende und hängende Plugins |
| E2E | Playwright gegen den Produktions-Build, auf Linux und Windows; Login einmal pro Lauf |
| Guard | Nur-Lesen-Regeln (Mongo `$out`/`$merge`, Cypher-Schreibklauseln, GSQL-Schreibanweisungen), CSS-Design-Regeln, ein HTTP-Client, i18n-Parität, Rechteprüfung an jeder Route |
| Budget | Deterministischer Datengenerator: 1 Mio. Dokumente, Graph mit 100.000 Knoten / 500.000 Kanten. Ziele z. B. Netzwerk-Panel 20.000 Knoten in < 1 s gezeichnet, Dokument-Explorer scrollt flüssig bei 10.000 Treffern |

Jeder Fix mit Test, der ohne den Fix fehlschlägt; keine übersprungenen Tests; CI-Rot hat Vorrang.

## 12. Meilensteine

1. **M0 Fundament**: Repository, `CLAUDE.md`, CI-Matrix Windows/Linux, Server-Gerüst mit HTTP und
   HTTPS (eigenes Zertifikat), Proxy-Unterstützung, Sicherheits-Header, Health/Readiness, eigene
   Datenbank mit Migrationen (SQLite/PostgreSQL), Ersteinrichtung, lokale Anmeldung,
   Design-Tokens, i18n, Guard-Tests.
2. **M1 Kern**: Organisationen, Teams, vollständiges Rollen- und Rechtesystem, Benutzerverwaltung,
   Server-Einstellungen in der UI, Audit-Log; Ordner und Dashboards mit Verlauf;
   Datenquellen-Verwaltung mit verschlüsselten Zugangsdaten; Query-API mit Result Envelope und
   Plugin-Schnittstelle (intern); PostgreSQL, MySQL/MariaDB, SQL Server, SQLite, Prometheus;
   Zeitreihe, Stat, Balken, Tabelle; Explore, berechnete Felder, Statistik, Export.
3. **M2 MongoDB nativ**: Treiber, Pipeline-Editor mit Stufen-Vorschau, Schema-Sampling,
   Dokument-Explorer, Schema-Panel, Feldverteilung, Projektionen, Change Streams;
   Elasticsearch/OpenSearch, CSV/JSON/HTTP-JSON; gespeicherte Auswertungen; Docker-Image
   (linux/amd64 und linux/arm64 auf ghcr.io, Compose-Beispiele mit SQLite und PostgreSQL; auf
   Wunsch des Owners aus M5 vorgezogen).
   **Stand: abgeschlossen (Oktober 2026, Version 0.2.0).** Dazu kamen Live-Aktualisierung über
   eine WebSocket-Verbindung (Change Streams bei MongoDB, sonst Abfrage im Intervall) und die
   Feldverteilung über das ganze Ergebnis in der Datenbank. Das Docker-Image ist aus M5 in M2
   gewandert. Die E2E-Tests in CI prüfen HTTP-JSON auf beiden Plattformen, MongoDB und
   OpenSearch unter Linux; unter Windows deckt diese die Checkliste der Release Notes ab, da
   Windows-Runner keine Linux-Container ausführen.
4. **M3 Graph nativ**: Neo4j und Memgraph über Bolt mit Cypher-Editor, TigerGraph über GSQL mit
   GSQL-Editor und Auswahl installierter Abfragen (Knoten- und Kantenmengen aus `PRINT`-Blöcken
   werden zum `graph`, Knoten-ID ist Typ plus ID, Kanten-IDs werden abgeleitet; Kanten erscheinen
   nur, wenn die Abfrage sie ausgibt; andere `PRINT`-Werte werden zum `frame`), Netzwerk-,
   Hierarchie- und Pfad-Panel, Explorer-Modus, Graph-Aggregationen, Variablen über Formen hinweg.
   **Stand: abgeschlossen (Oktober 2026, Version 0.3.0).** Enthalten: Neo4j, Memgraph und
   TigerGraph mit Cypher- und GSQL-Editor; Netzwerk-, Hierarchie- und Pfad-Panel mit
   Knotendetails, Mehrfachauswahl, Pins und pro Betrachter gespeicherter Ansicht; Explorer mit
   Schrittleiste, Rücknahme, Abbruch und „Als Abfrage in Explore öffnen“; Graph-Schritte (Zählen,
   Grad, Top N, gemeinsame Nachbarn, Graph zu Tabelle), bei Neo4j und Memgraph als Cypher in der
   Datenbank; Variablen über alle drei Formen (Klick auf Dokument, Zeile oder Knoten, Cypher- und
   GSQL-Parameter, Abfragevariablen aus Graphen und Dokumenten); dazu die neue Anmeldung und
   Ersteinrichtung mit Prüfung des Einrichtungscodes, Beispieldaten und mitgelieferter Hilfe.
   Die Hierarchie behält das eigene Schichten-Layout; ELK bleibt ein optionales Layout für M5.
   Der Explorer bleibt für TigerGraph-Quellen aus; seine Nachbarschaftsabfragen sind Cypher.
   TigerGraph prüft ein nächtlicher Lauf gegen die echte Community Edition (mit REST++-
   Authentifizierung, `queryreader` und typisierten Parametern installierter Abfragen); Test
   connection warnt bei REST++ ohne Authentifizierung. Neo4j und Memgraph laufen in den E2E-Tests
   unter Linux; unter Windows deckt sie die Checkliste der Release Notes ab.
5. **M4 Plugins und KI**: externe Plugin-Prozesse, Manifest, Signaturen, Katalog, Rust-SDK,
   Beispiel-Plugins (eine Datenquelle, ein Panel). Eingebaute KI-Funktionen über eine
   Anbieter-Schnittstelle: OpenAI und OpenAI-kompatible APIs, LiteLLM als Proxy, weitere Anbieter
   und lokale Modelle (z. B. Ollama, OpenAI-kompatible lokale Server); einfache Aufrufe (Abfrage
   erklären oder entwerfen, Ergebnis zusammenfassen) und agentenbasierte Abläufe, die mit Werkzeugen
   arbeiten (Datenquellen lesen, Explore-Schritte vorschlagen). KI ist standardmäßig aus: ein
   Schalter in den Server-Einstellungen schaltet alle KI-Funktionen ein oder aus, und ohne
   verbundenen Anbieter erscheinen keine KI-Knöpfe oder -Hinweise in der Oberfläche. KI fragt nur
   mit den Rechten des angemeldeten Benutzers ab, nur lesend; Zugangsdaten liegen im Credential Store.

   Entscheidungen des Inhabers zur KI (27.10.2026), Architektur in `docs/ARCHITECTURE.md` („AI“),
   API in `docs/api/ai.md`:
   - M4 enthält alle KI-Funktionen. Reihenfolge: erst der Kern (Anbieter, Einstellungen, Grenzen,
     Audit, Status), dann einfache Aufrufe (Abfrage erklären oder entwerfen, Ergebnis
     zusammenfassen), danach der Agenten-Chat mit Werkzeugen.
   - Anbieter: ein OpenAI-kompatibler Client (OpenAI, LiteLLM, Ollama und andere lokale Server mit
     dieser API) und ein nativer Anthropic-Client (Messages API). Modelle sind frei einstellbar;
     Kalzit hat keine eingebaute Modellliste.
   - Anbieter werden serverweit eingerichtet (Server-Admin); eine Organisation kann mit eigenem
     Anbieter und Schlüssel übersteuern (Org-Admin, `settings:write`).
   - Grenzen pro Benutzer (Aufrufe und Tokens pro Tag, UTC) und pro Organisation (Tokens pro
     Kalendermonat), dazu gleichzeitige Aufrufe auf dem Server und pro Benutzer. Organisationen
     können die Grenzen nur senken und KI für ihre Mitglieder ausschalten. Angezeigt werden
     Tokens und Aufrufe, keine Kosten oder Währungen.
   - Chat-Verläufe werden pro Benutzer gespeichert, mit einstellbarer Aufbewahrung (Standard
     30 Tage, `ai.chat_retention_days`); eine Organisation kann eine kürzere Aufbewahrung
     wählen. Die Speicherung kommt mit dem Chat-Paket.
   - Pro Datenquelle wird freigegeben, ob KI sie lesen darf (Standard: nein); das entscheidet,
     wer die Quelle bearbeiten darf. „Erklären“ und „Entwerfen“ lesen das Schema einer Quelle
     nur nach dieser Freigabe, sonst nur den eingegebenen Abfragetext.
   - Pro Datenquelle lassen sich Felder ausnehmen: Ihre Werte erreichen die KI nie, nur der
     Name. Das setzt ein gemeinsamer Helfer auf dem Server durch (`ai::redact`), den alle
     KI-Funktionen nutzen.
   - Vor dem ersten KI-Aufruf sieht jede Person einmal je Anbieter einen Hinweis, welche Daten
     wohin gehen; die Bestätigung wird gespeichert, vorher lehnt der Server KI-Aufrufe ab.
   - Die Oberfläche folgt dem freigegebenen Board `docs/design/blueprint/AI.dc.html`.
   - Basis-Adressen der Anbieter laufen durch dieselbe Ziel-Prüfung wie Datenquellen; Kalzit selbst
     ist als Ziel ausgeschlossen. Schlüssel liegen verschlüsselt wie die Geheimnisse von
     Datenquellen und erscheinen nie in Antworten, Logs oder im Audit-Log.
   - Jeder KI-Aufruf wird protokolliert (wer, Anbieter, Modell, Tokens, Zweck, Ergebnis), nie der
     Inhalt von Frage oder Antwort.
6. **M5 Betrieb**: OIDC, LDAP/AD, 2FA (TOTP, Passkeys), SMTP und Einladungen, ACME, Dienstkonten, Audit-Log, Windows-Dienst und MSI, deb/rpm,
   Backup und Wiederherstellung, HA mit PostgreSQL; InfluxDB, Loki, ClickHouse; ELK (elkjs) als
   optionales Hierarchie-Layout, nur bei Auswahl nachgeladen.
7. **M6 Ausbau**: Alerting, Freigabe-Links, Provisioning als Code, Import von Grafana-Dashboards
   (soweit sinnvoll); Graphite, Redis, Oracle, Traces (Tempo, Jaeger), weitere Graph-Quellen
   (ArangoDB, Gremlin) und Dokument-Quellen (Couchbase).

Jeder Meilenstein endet mit grüner CI auf beiden Plattformen, Doku-Seiten zu jeder neuen Funktion
und einem Durchgang nach `quality/perfection-pass.md`.

## 13. Entscheidungen

Getroffen (stehen auch in `CLAUDE.md`):

1. Server in Rust.
2. Lizenz AGPL-3.0.
3. Nur selbst gehostet.
4. Graph-Quellen zum Start: Neo4j, Memgraph und TigerGraph.
5. UI auf Deutsch mit „du“ und Englisch.
6. Alle üblichen Datenquellen werden unterstützt (Abschnitt 3), nicht nur MongoDB und Graphen.
7. Ausrichtung: Plattform zur Visualisierung und Auswertung von Daten allgemein, nicht nur Monitoring.
8. Mehrere Organisationen pro Installation.
9. Alerting in M6, nach dem Kern.
10. Öffentliches Repository auf GitHub.
11. Produktname Kalzit (statt Arbeitstitel Granit).
12. Website mit Astro und ausdrucksstarker Bewegung, angelehnt an die Referenz des Inhabers; Hosting wird später entschieden.
13. Die Projektion (Abschnitt 1) steht nicht in der Abfrage, sondern als Schritt `toFrame` in den
    `transformations` des Panels (bzw. den Schritten in Explore): Die Abfrage bleibt in der Form
    der Datenquelle, die Projektion ist sichtbar, abschaltbar, und die Schritte danach arbeiten
    mit ihrer Tabelle. Schritte laufen im Browser für die Anzeige und auf dem Server für den
    Export, mit denselben Regeln (`docs/api/settings-dashboards.md`, „Analysis steps“).
14. KI (M4): standardmäßig aus, ein Schalter für alles; OpenAI-kompatibler und nativer
    Anthropic-Client; serverweite Anbieter mit Übersteuerung pro Organisation; Grenzen pro
    Benutzer und Organisation; Chat-Aufbewahrung standardmäßig 30 Tage; Freigabe pro Datenquelle;
    nur mit den Rechten des Benutzers und nur lesend (Abschnitt 12, M4).
