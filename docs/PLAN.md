# Kalzit: Plan

Arbeitstitel war Granit; der Produktname ist Kalzit (siehe Abschnitt 14).

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
| TigerGraph 3.10+ und 4.x (GSQL) | graph | HTTP-Client-Factory: REST++ `/query/{graph}/{query}` für installierte, GSQL-Server `/gsql/v1/queries/interpret` für interpretierte Abfragen; Token über `/gsql/v1/tokens` (3.x: `/requesttoken`) aus einem verschlüsselt gespeicherten Geheimnis | M3 |
| InfluxDB (1.x InfluxQL, 2.x/3.x SQL und Flux) | frame | HTTP-API | M5 |
| Loki (Logs) | frame mit Log-Zeilen | HTTP-API | M5 |
| ClickHouse | frame | HTTP (natives Protokoll: M7) | M5 |
| Graphite | frame | HTTP-API | M7 |
| Redis | frame bzw. documents (Hashes, JSON) | `redis` | M7 |
| Oracle | frame | `oracle` (braucht Oracle-Client, daher eigenes Plugin) | M7 |
| Tempo, Jaeger (Traces) | graph (Span-Baum) | HTTP/gRPC | M7 |
| CSV/JSON-Datei, HTTP-JSON | frame bzw. documents | eingebaut | M2 |

- Gemeinsame Basis für SQL-Quellen: ein Editor mit Schema-Browser (Datenbanken, Tabellen, Spalten),
  Makros für Zeitbereich und Intervall (`$__timeFilter`, `$__interval`), Variablen, Nur-Lesen-Prüfung
  (nur `SELECT`/`WITH`, zusätzlich Read-only-Transaktion, wo die Datenbank das anbietet).
- Jede Quelle ist intern ein Plugin mit derselben Schnittstelle (Abschnitt 7); Quellen, die externe
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
  inkl. Active Directory (wichtig für Windows-Umgebungen) und SAML 2.0 (seit M5), dazu SCIM 2.0 für
  Personen und Gruppen; Rollen- und Team-Zuordnung aus Gruppen; Zwei-Faktor mit TOTP und Passkeys
  (WebAuthn), erzwingbar auf dem Server und pro Organisation.
- **Benutzerverwaltung**: Einladung per Mail-Link (nur Hash gespeichert, läuft ab), Passwort
  vergessen, Konto sperren, Sitzungen ansehen und beenden ("überall abmelden").
- **Dienstkonten und API-Tokens**: nur Hash gespeichert, Ablaufdatum, Bereich (Scopes).
- **Audit-Log**: wer hat was wann geändert (Anmeldungen, Rechte, Dashboards, Datenquellen,
  Plugins, Einstellungen), durchsuchbar, Aufbewahrungsdauer einstellbar, Export.

## 7. Plugins

| Typ | Läuft wo | Schnittstelle |
|---|---|---|
| Datenquelle | Eigener Prozess neben dem Server, in einer Sandbox | gRPC über lokale Verbindung (Named Pipe unter Windows, Unix-Socket unter Linux; stdio für Handshake und Logs) |
| Panel | Browser, in einem abgeschotteten iframe (sandbox) | Web-Bundle (ein ES-Modul) mit kleiner, versionierter Nachrichten-API: Daten rein, Ereignisse raus; deklariert unterstützte Formen |
| App (M7) | Beides | Seiten plus Backend-Teil |

- Die eingebauten Datenquellen (SQL-Quellen, Prometheus, MongoDB, Neo4j/Memgraph usw.) benutzen **dieselbe** Schnittstelle
  wie externe Plugins, nur in den Server einkompiliert; ein In-Process-Adapter bedient jede von
  ihnen über das Plugin-Protokoll, so ist die Plugin-API von Anfang an echt.
- **Manifest** (`kalzit-plugin.toml`, TOML, versioniert mit `manifest = 1`): ID (umgekehrter
  Domainname wie `dev.example.redis`, damit nie gleich einem eingebauten Typ), Name, Version,
  Typ (`datasource` oder `panel`), gelieferte bzw. angezeigte Formen (`frame`, `documents`,
  `graph`), Einstellungsformular, Rechte (Netzwerkziele), Plattform-Binaries (`windows-x64`,
  `linux-x64`, `linux-arm64`) mit SHA-256, Mindestversion von Kalzit; bei Datenquellen dazu die
  Protokollversion und die Fähigkeiten, bei Panels statt Binaries das Web-Bundle mit Hash und
  Version der Nachrichten-API. `files` hält jede Datei des Pakets mit SHA-256 fest; Kalzit
  lehnt Pakete mit weiteren Dateien oder Links ab. Der Validator im Crate `kalzit-plugin-api`
  meldet alle Fehler auf einmal, jeden mit Pfad und Code.
- **Protokoll** (Entscheidung des Owners vom 27.10.2026): gRPC (tonic/prost), Kalzit ist der
  Client. Verbindung unter Windows über eine Named Pipe, unter Linux über einen Unix-Socket;
  stdio nur für den Handshake und die Logs des Plugins. Version 1 enthält Health, Schema,
  Einstellungsprüfung, Abfrage mit gestreamtem Ergebnis in der nativen Form, Abbruch und
  Deadlines; dazu die Fähigkeiten `check_on_save` und `watch`. Feldverteilungen und Pushdown von
  Graph-Schritten bleiben vorerst den eingebauten Quellen vorbehalten, weil sie an Kalzits
  Schrittsprache hängen, die noch kein stabiler Vertrag ist. Kalzit setzt die Grenzen der
  Abfrage (Zeilen, Elemente, Bytes, Teile) selbst durch und prüft jeden Wert gegen seinen Typ.
  Version 1 wächst nur: Kalzit nennt in `Describe` seine Unterversion und die Erweiterungen,
  die es kennt, und ein Plugin nutzt nur diese.
- **Signatur** (Entscheidung vom 27.10.2026): Ed25519 über das Manifest (das die Hashes aller
  Dateien festhält), in einem eigenen Signaturkontext, getrennt von den Release-Signaturen.
  Vertraut wird Kalzits eigenem Plugin-Schlüssel und Herausgeber-Schlüsseln, die ein Admin
  hinzufügt; die Release-Schlüssel gelten nie für Plugins. Unsignierte Plugins nur mit einem
  ausdrücklichen Admin-Schalter, standardmäßig aus. Eine ungültige Signatur wird immer
  abgelehnt, auch mit diesem Schalter. Wird ein vertrauter Schlüssel entfernt, laufen seine
  Plugins nach einer Bestätigung nicht mehr. Eine Plugin-ID ist an ihren Schlüssel gebunden:
  Updates müssen mit demselben Schlüssel signiert sein oder mit einem, an den der alte die ID
  per signierter Übergabe weitergereicht hat; ältere Versionen werden nie installiert. IDs
  unter `io.kalzit.` und `dev.kalzit.` sind Kalzits eigenem Schlüssel vorbehalten.
- **Rechte und Organisationen** (Entscheidung vom 27.10.2026): Ein Update, das neue Rechte
  (Netzwerkziele) verlangt, läuft erst nach erneuter Freigabe durch einen Admin.
  Organisations-Admins können installierte Plugins für ihre Organisation sperren.
- **Panel-Plugins** (Entscheidung vom 27.10.2026): laufen im Browser in einem iframe mit
  `sandbox`, nicht als gRPC-Prozess, und sprechen mit Kalzit nur über die versionierte
  Nachrichten-API (Daten und Einstellungen hinein, Ereignisse wie Klick oder Auswahl heraus).
- **Katalog** (Entscheidung vom 27.10.2026): ein signierter, gehosteter Index, standardmäßig aus;
  die Offline-Installation aus einer Datei geht immer. Jeder Index trägt eine fortlaufende
  Nummer und ein Ablaufdatum, damit niemand einen alten Index wieder ausliefern oder einfrieren
  kann.
- **Sandbox** (Entscheidung vom 27.10.2026): Plugin-Prozesse laufen, wo das Betriebssystem es
  erlaubt, in einer Sandbox (Windows: Job Object und eingeschränktes Token; Linux: Namespaces,
  seccomp, Landlock). Netzwerk nur zu den im Manifest erklärten Zielen und nur über Kalzit.
- **SDKs**: Rust (seit M4), TypeScript/Node und Go in M7.
- Plugin-Prozesse werden mit Zeitlimit gestartet, überwacht und neu gestartet; ein abgestürztes
  Plugin legt nur seine Panels lahm, nicht den Server.
- Stand M4: Protokoll (`plugin-api/proto`), Manifest mit Validator, Signaturkontext, Registry der
  Datenquellen-Typen und In-Process-Adapter für die eingebauten Quellen sind fertig, ebenso der
  Host für Datenquellen-Plugins (Installation aus einer Datei mit allen Prüfungen, Vertrauen,
  Freigabe der Rechte, Prozesse mit Überwachung, Neustart und Sandbox, Admin-API in
  `docs/api/plugins.md`) und Kalzits Netzwerk-Connector: Plugins haben kein eigenes Netzwerk
  (Linux: seccomp-Filter und eigener Netzwerk-Namespace, Windows: AppContainer ohne
  Capabilities) und erreichen nur die im Manifest erklärten Ziele über Kalzit.
  Panel-Nachrichten-API und Panel-Host sind fertig: Panel-Plugins erscheinen in der
  Visualisierungsauswahl, laufen im abgeschotteten iframe ohne Netz und ohne Zugriff auf Kalzit,
  ihr Optionseditor entsteht aus dem Manifest. Der Katalog ist fertig (standardmäßig aus, ohne
  voreingestellte Adresse, signierte Liste mit Schutz vor Rücksprung und Ablauf, Rücknahmen,
  Installation über denselben Weg wie eine Datei). Die Oberfläche folgt dem Board
  `docs/design/blueprint/Plugins.dc.html`.

## 8. Windows- und Linux-Server

- **Ein Binary** `kalzit` mit eingebetteter Weboberfläche, für Windows x64, Linux x64 und Linux
  arm64.
- **Windows**: `kalzit service install|uninstall` als Windows-Dienst (Start und Stopp über die
  Dienste-Verwaltung), Daten unter `%ProgramData%\Kalzit`, Log im Datenordner und frühe Fehler im
  Ereignisprotokoll, Installer als MSI (seit M5; signiert, sobald das Code-Signing des Projekts
  eingerichtet ist). Ein winget-Paket kommt in M6: Das Manifest erzeugt der Release-Workflow,
  die Einreichung bei winget-pkgs ist ein Schritt von Hand.
- **Linux**: `.deb` und `.rpm` für x64 und arm64 mit gehärteter systemd-Unit, `/etc/kalzit`,
  `/var/lib/kalzit`, eigener Systembenutzer; Docker-Image für amd64 und arm64.
- **Geheimnisse** (Passwörter und Tokens von Datenquellen, Schlüssel der KI-Anbieter, Mailserver,
  ACME-Konto und -Zertifikat): verschlüsselt mit AES-256-GCM in der Datenbank bzw. im Datenordner,
  nicht im Credential Store des Betriebssystems. Nur der Secrets-Schlüssel kommt von außen, in
  dieser Reihenfolge: `KALZIT_SECRETS_KEY`, unter Linux systemd credentials
  (`kalzit-secrets-key`), unter Windows eine mit DPAPI geschützte Schlüsseldatei, als letzte
  Möglichkeit `secrets.key` mit Rechten 0600 im Datenordner (mit Warnung im Log). Nie im Klartext
  in Config oder Log.
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
| Netzwerk | Adresse und Port für HTTP und HTTPS, öffentliche URL, Unterpfad (`server.base_path`, z. B. `/kalzit`, seit M6), HTTP → HTTPS-Umleitung |
| TLS | eigenes Zertifikat und Schlüssel (PEM, Neuladen ohne Neustart), automatisch über ACME/Let's Encrypt (HTTP-01, TLS-ALPN-01; in der UI mit einem Speichern nach Prüfung, weil ein falscher Wert nicht aussperrt: HTTPS behält das bisherige Zertifikat), minimale TLS-Version 1.2, HTTP/2 |
| Reverse Proxy | vertrauenswürdige Proxys (IP-Bereiche), `X-Forwarded-*` oder `Forwarded` nach RFC 7239 nur von diesen (`security.forwarded_headers`), Beispielkonfigurationen für nginx, Caddy, IIS, Traefik (`docs/guide/reverse-proxy.md`) |
| Sicherheit | HSTS (an, Dauer), CSP, Cookie-Flags, Login-Ratenlimit |
| Sitzungen | Dauer, Leerlauf-Timeout |
| Passwörter | Mindestlänge (fest 12 Zeichen), 2FA-Pflicht und erlaubte Verfahren |
| Anmeldung | lokale Anmeldung an/aus, OIDC, SAML, LDAP/AD, Standardrolle neuer Benutzer |
| Mail (SMTP) | Server, Port, STARTTLS/TLS, Absender, Testmail senden |
| Darstellung | Standardsprache, Standardthema (hell, dunkel, System, Kontrast), Startseite, Logo und Name (Branding) |
| Daten | Datenbank (SQLite/PostgreSQL), Abfrage-Timeouts und Limits global, Abfrage-Cache, Aufbewahrung von Verlauf, Audit-Log und Nutzung |
| Betrieb | Log-Level und -Format (Text/JSON), Health (`/healthz`), Readiness (`/readyz`), Prometheus-Metriken (`/metrics`, standardmäßig aus, nur mit Token oder erlaubten Netzen; seit M6) |
| Plugins | Katalog an/aus mit Adresse, unsignierte Plugins erlauben (aus); die Pakete liegen im Datenordner (eigener Ordner: M8) |
| Updates | Prüfung auf neue Versionen (aus, opt-in), keine Telemetrie |
| Info | Version, Build, Lizenz (AGPL-3.0 mit Link zum Quellcode, wie die Lizenz es bei Netzwerknutzung verlangt), Systemstatus |

Aus der ursprünglichen Liste in M7 verschoben (Entscheidung des Inhabers zu M6): CORS,
Selbstregistrierung, Backup-Zeitplan und -Ziel. Erlaubte Einbettung (`frame-ancestors`, bis dahin
keine Einbettung), gleichzeitige Sitzungen, „Angemeldet bleiben“ und die Prüfung gegen bekannte
geleakte Passwörter kommen mit den übrigen Einstellungslücken in M8 (Entscheidung des Inhabers vom
6. November 2026, Abschnitt 12).

Jede Änderung in der UI landet im Audit-Log; Einstellungen mit mehreren abhängigen Feldern (SMTP,
OIDC, LDAP) haben einen expliziten Speichern-Knopf mit Verbindungstest, alle anderen gelten sofort
mit Rückgängig (Ausnahme nach `design/principles.md`, in `CLAUDE.md` festgehalten).

## 9. Technik

| Bereich | Wahl | Begründung |
|---|---|---|
| Server | Rust (axum, tokio, sqlx) | Ein natives Binary für Windows und Linux, Windows-Dienst ohne Zusatz, bekannter Stack aus Arcalo |
| Treiber | `mongodb` (offiziell), `neo4rs` (Bolt, auch Memgraph), `sqlx` (PostgreSQL, MySQL/MariaDB, SQLite), `tiberius` (SQL Server), HTTP-Client-Factory für API-Quellen (Prometheus, Elasticsearch, TigerGraph) | Native Typen bleiben erhalten (BSON, Bolt-Strukturen, SQL-Typen) |
| Eigene Daten | SQLite (Standard, ein Server), PostgreSQL (mehrere Kalzit-Server, HA) | Kein Pflicht-Datenbankserver für kleine Installationen |
| Frontend | React 19.3 mit React Compiler 1.0, TypeScript 7 (nativer Compiler), Vite 8 (Rolldown), TanStack Router und Query | Stand Oktober 2026; größtes Ökosystem für Panels und Plugin-Autoren, typsichere Routen |
| CSS | Eigene Tokens in modernem CSS: OKLCH-Farben, `light-dark()`, Cascade Layers, Container Queries, View Transitions, Popover-API und Anchor Positioning | Kein CSS-Framework nötig, Guard-Tests prüfen die Regeln |
| Werkzeuge | Biome (Format und Lint), Vitest 5, Playwright | Schnell, wenige Abhängigkeiten |
| HTTPS | rustls (kein OpenSSL, identisch auf Windows und Linux) | Keine Systembibliothek nötig |
| Zeitreihen | uPlot | Sehr schnell bei vielen Punkten |
| Graphen | Sigma.js + Graphology (WebGL); ForceAtlas2 für Netzwerke, für Hierarchien ein eigenes Schichten-Layout (Zyklen aufbrechen, Schichten nach längstem Pfad, Baryzentrum-Sortierung) im Layout-Worker | Zehntausende Knoten flüssig, keine zusätzliche Layout-Bibliothek im Start-Bundle; ELK (elkjs) ist seit M5 ein optionales Hierarchie-Layout, das erst bei Auswahl nachgeladen wird |
| Diagramme sonst | ECharts | Balken, Heatmaps, Verteilungen |
| Live-Daten | WebSocket; MongoDB Change Streams, sonst Polling | Push statt ständiges Neuladen |
| Plugin-Protokoll | gRPC (tonic/prost) über Named Pipe (Windows) bzw. Unix-Socket (Linux); das Protokoll wird mit protox (Protobuf-Compiler in Rust) übersetzt, kein protoc nötig | Plattformübergreifend, SDKs in mehreren Sprachen |

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
   mit den Rechten des angemeldeten Benutzers ab, nur lesend; Schlüssel der Anbieter liegen
   verschlüsselt in der Datenbank wie die Geheimnisse von Datenquellen (Abschnitt 8,
   „Geheimnisse“).
   **Stand: abgeschlossen (Oktober 2026, Version 0.4.0).** Enthalten: Host für
   Datenquellen-Plugins (gRPC-Protokoll 1, Installation aus Datei mit allen Prüfungen, Signaturen
   und vertraute Schlüssel, Freigabe der Netzwerkziele, Prozesse mit Überwachung und Neustart),
   Sandbox auf Windows (eingeschränktes Token, Job Object, AppContainer ohne Netz) und Linux
   (Landlock, seccomp, Namespaces), Netzwerk nur über Kalzits Connector, Plugin-Seiten unter
   Verwaltung > Plugins und Sperre je Organisation, Rust-SDK mit `kalzit-plugin` zum Packen und
   Signieren, Panel-Plugins im abgeschotteten iframe mit Optionseditor aus dem Manifest, der
   signierte Katalog (standardmäßig aus) und die Beispiele „CSV and JSON over HTTP“ und „KPI
   tile“. KI: OpenAI-kompatibler und Anthropic-Client, Anbieter des Servers und der Organisation,
   ein Anbieter je Funktion, Angabe „Daten verlassen das eigene Netz“, Grenzen, Hinweis vor dem
   ersten Aufruf, Freigabe und ausgenommene Felder je Quelle, Erklären, Entwerfen und
   Zusammenfassen, „Fragen“ (Beta) mit Werkzeugen, Verlauf und Aufbewahrung, Audit jedes Aufrufs.
   Offen für M6: `Release`-Aufrufe an Plugins bei geänderten oder gelöschten Quellen; Kategorien
   über die Art hinaus im Katalog; der Schalter „Über Proxy laden“ des Katalog-Boards.

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
     wählen. Gespeichert werden sie mit „Fragen“; ein stündlicher Lauf löscht abgelaufene Chats.
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
   optionales Hierarchie-Layout, nur bei Auswahl nachgeladen; SAML und SCIM; Abfrage-Cache auf dem
   Server (pro Abfrage, Variablen und Zeitbereich, mit Rechten im Schlüssel); Nutzungsstatistiken
   (welche Dashboards, Abfragen und Quellen wie oft und wie langsam).
   **Stand: abgeschlossen (Oktober 2026, Version 0.5.0; Betrieb, Cache und neue Quellen schon mit
   0.4.2).** Enthalten: Windows-Dienst mit MSI (Assistent auf Deutsch und Englisch, Selbst-Update
   nur mit `SELFUPDATE=1`), deb- und rpm-Pakete mit gehärteter systemd-Unit, HTTPS-Zertifikate
   über ACME (HTTP-01 und TLS-ALPN-01, Erneuerung ohne Neustart), der Abfrage-Cache auf dem Server
   (pro Person, mit Rechten im Schlüssel), ClickHouse über die HTTP-Schnittstelle, InfluxDB 1.x
   bis 3.x und Loki, ELK als optionales Hierarchie-Layout; OIDC, SAML 2.0 und LDAP/Active
   Directory mit Gruppenzuordnung und nächtlichem Abgleich, SCIM 2.0, Zwei-Faktor mit Passkeys,
   Authenticator-App und Wiederherstellungscodes, letzte Anmeldungen, Dienstkonten mit API-Tokens,
   Mailserver mit Einladungen und Passwort-Reset, mehrere Kalzit-Server auf einer
   PostgreSQL-Datenbank mit leitendem Server und der Seite Verwaltung > Instanzen, Nutzung je
   Dashboard, Panel und Datenquelle (nie je Person). Backup und Wiederherstellung: Kalzit sichert
   die SQLite-Datenbank vor jedem Update und mit „Jetzt sichern“ auf der Update-Seite; PostgreSQL
   sichert `pg_dump`. Die Anleitung dazu (`docs/guide/backup.md`) kam in M6, ein Backup-Zeitplan
   ist M7. Pakete für Linux arm64 kamen in M6 (Version 0.6.0); das native Protokoll von
   ClickHouse ist M7.
7. **M6 Feinschliff**: Ein Meilenstein nur zum Beheben und Polieren, ohne neue Funktionen: alle
   offenen Fehler und Review-Punkte, UI-Mängel aus den Durchgängen (z. B. überlappende Beschriftungen
   in Graphen, eigene Auswahllisten statt Browser-Standard), instabile Tests, Performance,
   Barrierefreiheit, Doku und Screenshots, ein vollständiger Durchgang nach
   `quality/perfection-pass.md` über alle Bereiche. Dazu gehört auch, was schon versprochen, aber nie
   gebaut wurde: Graph-Export (GraphML, JSON, Bild), Graph-Algorithmen der Datenbank (Neo4j GDS,
   Memgraph MAGE) nur lesend im Stream-Modus freischalten, Form je Label laut Graph-Board, aus den
   Server-Einstellungen (Abschnitt 8) der Unterpfad und `/metrics`. Außerdem
   die beiden Ausnahmen in `.cargo/audit.toml` entfernen (RUSTSEC-2023-0071 `rsa`,
   RUSTSEC-2026-0387 `crypto-bigint`, nur über webauthn-rs), sobald webauthn-rs auf Crates mit den
   Korrekturen wechselt, und dann auf die erste stabile 0.6-Version gehen.
8. **M7 Ausbau**: in Versionen 0.7.x je Bereich, Alerting zuerst (Entscheidung des Inhabers vom
   10. November 2026; Einzelheiten zum Alerting in Abschnitt 13):
   - 0.7.0 Alerting-Kern: Regeln, geplante Auswertung, Zustände mit „für“-Dauer, Mail und
     signierter Webhook, Stummschaltungen, Verlauf, Alert-Badge an Panels.
   - 0.7.1 Alerting-Ausbau: Routing-Bäume, Gruppierung über Regeln hinweg, Eskalation, weitere
     Kanäle, Vorlagen für Nachrichten.
   - 0.7.2 Teilen: Freigabe-Links und Snapshots (eigenes Recht für öffentliche Links).
   - 0.7.3 Provisioning als Code (Git mit Kommandozeile: Dashboards, Quellen, Rollen und
     Alert-Regeln als Dateien) und Import von Grafana-Dashboards (soweit sinnvoll).
   - 0.7.4 Berichte: geplante PDF- und CSV-Berichte per Mail.
   - 0.7.5 Neue Quellen: Graphite, Redis, Oracle, Traces (Tempo, Jaeger), weitere Graph-Quellen
     (ArangoDB, Gremlin) und Dokument-Quellen (Couchbase), Data-Warehouses (BigQuery, Snowflake,
     Databricks), das native Protokoll von ClickHouse.
   - 0.7.6 Server-Einstellungen aus Abschnitt 8: CORS, Selbstregistrierung, Backup-Zeitplan und
     -Ziel; dazu die SDKs für TypeScript/Node und Go und App-Plugins (Abschnitt 7).
9. **M8 Analyse-Tiefe**: Aus dem Abgleich mit Grafana und Graph-Werkzeugen (Oktober 2026), aus M7
   herausgelöst:
   - Analyse und Explore: zweite Runde des Schritt-Katalogs, tieferes Explore (Verlauf, Vergleich,
     geteilte Ansichten), tiefere Variablen (siehe Einstellungslücken unten), Dashboard-Tabs und
     Regeln zum Ein- und Ausblenden, XY- und Karten-Panel (GeoJSON), Prognose- und
     Ausreißer-Schritte, Drill-down ohne Abfrage je Ergebnisform.
   - Graph-Analyse (nur lesend): Algorithmen als Schritte (Zentralität, Communities, Pfade) mit Größe
     oder Farbe nach Wert, Filterleiste mit Histogrammen, Schema-Panel einer Graph-Quelle, Karten- und
     Koordinaten-Layout, radiales Layout, Icons und bedingte Darstellung, Suchen-als-Graph und
     kürzester Pfad zwischen zwei Knoten, gespeicherte Erkundungen, Explorer für TigerGraph,
     Abfrageplan (EXPLAIN/PROFILE). Das Graph-Board wird vorher erweitert.
   - KI: ein MCP-Server, über den andere KI-Werkzeuge Kalzit mit den Rechten einer Person nur lesend
     nutzen.
   - Performance und Tempo: gemessene Beschleunigung über die Performance-Prüfung in M6 hinaus:
     Startzeit und Größe der Binärdatei, erste Darstellung und Bundle-Größe der Oberfläche, Laden
     von Dashboards mit vielen Panels (parallele Abfragen, Ergebnisse als Stream), große Ergebnisse
     (virtualisierte Tabellen und Dokumentbäume, Graph-Darstellung über 20.000 Knoten mit
     Detailstufen), Abfrage-Cache pro Panel mit TTL, Speicher und CPU des Servers unter Last; dazu
     eine Benchmark-Suite in der CI, die bei Verschlechterungen fehlschlägt.
   - Nachzügler aus M6: Erweiterungen aus den Reviews in M6, die keine Fehlerbehebungen sind: Liste
     „Letzte Anmeldungen“ (2FA-Board Frame 4A), erneute Anmeldung beim Anbieter (`max_age`) vor dem
     Einrichten des ersten zweiten Faktors, arm64-Binaries für die Beispiel-Plugins (`csv-http`),
     „Mehr laden“ auch in gespeicherten Analysen und in der Vorschau des Panel-Editors,
     Audit-Eintrag und Hinweis bei wiederholt falschem Passwort innerhalb einer Sitzung,
     einstellbare Aufbewahrung des Papierkorbs für Datenquellen (bisher fest 30 Tage) und eine
     Einstellung für den Plugin-Ordner (bisher fest im Datenordner).
   - Einstellungslücken (Entscheidung des Inhabers vom 6. November 2026): Optionen, die übliche
     Dashboard-Plattformen haben und Kalzit noch fehlen. Eigene Beschreibung und eigener Entwurf;
     die Einzelheiten werden vor dem Bau gegen öffentliche Dokumentation geprüft, ohne fremden
     Code oder fremde Begriffe zu übernehmen:
     - Variablen: voneinander abhängige Variablen, Neuladen bei geändertem Zeitraum, Option „Alle“
       mit eigenem Wert dafür, Sortierung, Filtern der Werte mit regulärem Ausdruck; Ad-hoc-Filter
       und eine Variable, die die Datenquelle wählt.
     - Dashboard-Darstellung, gespeichert je Dashboard: Zeitauswahl, Variablenleiste und Links
       ausblenden, nur lesbar markieren, Beschreibung.
     - Abfrage-Optionen je Panel: höchste Zahl der Datenpunkte, kleinstes Intervall, eigene
       Cache-Dauer.
     - Benutzerverwaltung des Servers: Detailseite einer Person mit ihren Organisationen und der
       Rolle je Organisation, Abmelden auf allen Geräten erzwingen, Person löschen, Organisation
       löschen.
     - Passwort- und Sitzungsregeln: einstellbare Mindestlänge, Prüfung gegen bekannte geleakte
       Passwörter, Zahl gleichzeitiger Sitzungen, „Angemeldet bleiben“.
     - Sicherheits-Header: erlaubte Einbettung, eigene CSP, Cookie-Flags, HSTS mit Preload.
     - Kontingente je Organisation und Person.
     - Vorgaben je Organisation und Team: Standardthema, Sprache, Start-Dashboard, Zeitzone des
       Teams.
     - Annotationen: ausblenden, nur auf gewählten Panels, Abfrage nach Tags, Zuordnung der Felder.
     - Dashboard-Links: als Auswahlliste, Zeitraum und Variablen mitnehmen, Tooltip, Icon.
     - Log-Dateien: Rotation und Filter.

     Freigabe-Links und Snapshots bleiben in M7.
10. **M9 Plugin-Store**: Community-Store für Plugins: Website-Bereich mit allen Plugins
    (Beschreibung, Screenshots, Versionen, Herausgeber-Schlüssel), Einreichung durch
    Community-Entwickler über ein eigenes Repository, Prüfung und Signatur der Einreichungen,
    Rücknahmen; der signierte Katalog dort ist die Quelle für den Katalog in Kalzit (M4). Die
    Store-Seiten der Website bleiben bis M9 verborgen.

Jeder Meilenstein endet mit grüner CI auf beiden Plattformen, Doku-Seiten zu jeder neuen Funktion
und einem Durchgang nach `quality/perfection-pass.md`.

## 13. Alerting (M7)

Entscheidungen des Inhabers vom 10. November 2026; die Oberfläche folgt dem Board
`docs/design/blueprint/Alerting.dc.html`, das vor dem Bau freigegeben wird. Alerting ist die
erste Version von M7 (0.7.0, Kern); Routing, Gruppierung und Eskalation folgen in 0.7.1.

**Grundidee**: Eine Alert-Regel ist eine gespeicherte Abfrage, ein expliziter Reduzier-Schritt und
eine Bedingung. Alle drei stehen als sichtbare Schritte in der Regel, wie die Schritte in Explore.
Die Abfrage behält ihre native Form (`frame`, `documents`, `graph`); der Reduzier-Schritt ist
formgerecht und macht aus dem Ergebnis eine Zahl je Instanz. Es gibt keine implizite Umwandlung:
Wer aus Dokumenten eine Zeitreihe braucht, setzt davor einen sichtbaren Schritt wie `toFrame`
(Entscheidung 13 in Abschnitt 14).

### Regel und Reduzier-Schritt

- **Abfrage**: Datenquelle, Abfragetext in der Sprache der Quelle, die sichtbaren Schritte davor
  (optional) und ein relativer Zeitraum (z. B. „letzte 10 Minuten“), der `$__timeFilter` und
  `$__interval` füllt. Variablen haben feste Werte, die in der Regel stehen. Eine Regel entsteht
  neu, aus einem Panel („Alert-Regel erstellen“ im Panel-Menü) oder aus einer gespeicherten
  Auswertung. Sie hält eine eigene Kopie der Abfrage; der Bezug zum Panel bleibt für das Badge
  erhalten, ändert sich das Panel, zeigt die Regel einen Hinweis mit „Abfrage übernehmen“.
- **Reduzieren, je Form**:
  - `frame`: je Serie (jedes Zahlenfeld mit seinen Labels; bei langen Tabellen je
    Label-Kombination) eine der Funktionen `last`, `min`, `max`, `mean`, `sum`, `count`. `last`
    nimmt den Wert mit dem jüngsten Zeitstempel, ohne Zeitfeld die letzte Zeile. Jede Serie wird
    eine eigene Instanz mit ihren Labels.
  - `documents`: Anzahl der Dokumente im Ergebnis (welche passen, entscheidet die Abfrage) oder
    ein Feldwert über einen Pfad (`$.queue.depth`) mit `first`, `min`, `max`, `mean`, `sum`.
    Dokumente ohne das Feld zählen nicht mit und werden in der Vorschau genannt; ein Feld mit
    Text statt Zahl ergibt den Zustand Fehler, nie eine stille Umwandlung. Eine Instanz je Regel.
  - `graph`: Anzahl der Knoten, Kanten oder Pfade, optional auf ein Label bzw. einen Kantentyp
    beschränkt. Eine Instanz je Regel.
- **Bedingung**: `>`, `>=`, `<`, `<=`, `=`, `≠`, „außerhalb von“ und „innerhalb von“ (zwei
  Grenzen) gegen feste Zahlen.
- **Weiteres je Regel**: Intervall (Standard 1 Minute), „für“-Dauer (Standard 0, also sofort),
  Verhalten bei keinen Daten (Zustand „Keine Daten“, OK oder Feuert) und bei Fehlern (Zustand
  „Fehler“ oder letzten Zustand halten), Labels (Schlüssel und Wert, z. B. `team=lager`),
  Kontaktpunkte (bis zu 5), Erinnerung bei anhaltendem Feuern (Standard 4 Stunden, aus möglich),
  Beschreibung und optional ein Link zu einer Anleitung. Eine Regel lässt sich pausieren.
- **Vorschau**: Im Editor zeigt „Jetzt auswerten“ das Ergebnis jedes Schritts in seiner Form (Serien
  mit reduziertem Wert, Dokumente mit Anzahl bzw. Feldwerten, Graph mit Zählung) und den Zustand,
  den jede Instanz jetzt hätte. Die Vorschau läuft mit den Rechten der bearbeitenden Person, nicht
  mit der Dienstidentität.

### Datenmodell

| Tabelle | Inhalt |
|---|---|
| `alert_rules` | Organisation, Name, Beschreibung, Datenquelle, Abfrage und Schritte (JSON in der Sprache der Quelle), Zeitraum, Reduzieren und Bedingung (JSON mit `shape`), Intervall, „für“-Dauer, Verhalten bei keinen Daten und Fehlern, Labels, Erinnerung, pausiert, optional Dashboard und Panel, Version, erstellt und geändert von und wann |
| `alert_rule_contact_points` | Regel zu Kontaktpunkt (n:m) |
| `alert_instances` | Regel, Fingerprint (SHA-256 aus Regel-ID und sortierten Labels), Labels, Zustand, seit wann, Beginn von „ausstehend“, letzte Auswertung mit Wert oder Fehlertext, letzte Benachrichtigung mit Zustand |
| `alert_history` | Zustandswechsel je Instanz: von, nach, Wert, Zeitpunkt, ggf. Stummschaltung; dazu Zustellungen (Kontaktpunkt, Art, Versuch, Ergebnis) |
| `alert_contact_points` | Organisation, Name, Art (`mail`, `webhook`), Einstellungen (Empfänger und Sprache bzw. URL), Geheimnis verschlüsselt wie die Geheimnisse von Datenquellen (Abschnitt 8), letzter Zustellstatus |
| `alert_silences` | Organisation, Label-Bedingungen, Beginn, Ende, Kommentar, erstellt von, vorzeitig beendet von |
| `datasources.alerting_enabled` | Freigabe für Alerting je Quelle (Standard: aus) |

Jede Organisation hat eine **Dienstidentität „Alerting“** (ein Dienstkonto der Art `alerting`, ohne
Tokens, nicht löschbar, nicht anmeldbar). Ihre Rechte sind fest: `datasources:query`, nur auf
Quellen mit Alerting-Freigabe. Die geplante Auswertung läuft immer mit ihr, nie mit den Rechten
der Person, die die Regel angelegt hat; so hängt eine Regel nicht an einem Konto, das gesperrt
oder entfernt wird.

### Auswertung

- **Planer**: ein Job nur auf dem leitenden Server (`cluster::spawn_job`, wie `mail:cleanup`).
  Jede Regel hat einen festen Versatz innerhalb ihres Intervalls (aus der Regel-ID abgeleitet),
  damit nicht alle Regeln zur vollen Minute laufen. Wechselt die Leitung, übernimmt der neue
  leitende Server ab dem nächsten Takt.
- **Intervalle**: kleinstes Intervall 30 Sekunden (Server-Einstellung `alerting.min_interval`),
  „für“-Dauer ein Vielfaches des Intervalls, höchstens 24 Stunden.
- **Gleichzeitigkeit**: höchstens 8 Auswertungen auf dem Server, 4 je Organisation und 2 je
  Datenquelle gleichzeitig (einstellbar). Organisationen kommen reihum dran, damit eine
  Organisation mit vielen Regeln die anderen nicht aufhält. Ist eine Regel beim nächsten Takt
  noch nicht dran gewesen, wird der Takt übersprungen, nicht nachgeholt; das zählt eine Metrik
  und steht in der Regel („2 Auswertungen ausgelassen“).
- **Zeitlimit**: je Auswertung das kleinere aus dem Zeitlimit der Quelle, dem Intervall und
  `alerting.evaluation_timeout` (Standard 30 Sekunden). Überschreiten ergibt den Zustand Fehler.
  Die Grenzen der Quelle (Zeilen, Dokumente, Knoten, Bytes) gelten unverändert.
- **Abfrage-Cache**: Auswertungen lesen nie aus dem Cache und schreiben nicht hinein.
- **Neustart**: Zustand, Beginn von „ausstehend“ und letzte Benachrichtigung jeder Instanz stehen
  in der Datenbank. Nach dem Start geht es mit dem nächsten Takt weiter; eine laufende „für“-Dauer
  zählt ab dem gespeicherten Beginn weiter, war der Server länger aus als die „für“-Dauer, wird
  nach der ersten Auswertung entschieden. Bereits gemeldetes Feuern wird nicht erneut gemeldet,
  nur bei Fälligkeit der Erinnerung.
- **Mehrere Organisationen**: Regeln, Kontaktpunkte, Stummschaltungen und Verlauf gehören je zu
  einer Organisation; eine Regel kann nur Quellen und Kontaktpunkte ihrer Organisation nutzen.
  Der Server-Admin kann Alerting für den Server ausschalten, ein Organisations-Admin für die
  Organisation (Regeln bleiben erhalten, werden aber nicht ausgewertet).

### Zustände

| Zustand | Bedeutung |
|---|---|
| OK | Bedingung nicht erfüllt |
| Ausstehend | Bedingung erfüllt, „für“-Dauer läuft noch |
| Feuert | Bedingung länger als die „für“-Dauer erfüllt |
| Keine Daten | `frame` ohne eine einzige Serie oder ein Feldwert, der in allen Dokumenten fehlt; eine Anzahl von 0 Dokumenten, Knoten, Kanten oder Pfaden ist ein Wert, keine fehlenden Daten |
| Fehler | Abfrage fehlgeschlagen, Zeitlimit, Quelle nicht freigegeben oder Wert keine Zahl |

- OK → Ausstehend, sobald die Bedingung erfüllt ist; Ausstehend → Feuert nach der „für“-Dauer;
  Ausstehend → OK ohne Meldung, wenn die Bedingung vorher endet. Mit „für“ = 0 geht es direkt
  von OK zu Feuert.
- Feuert → OK meldet „Behoben“. Keine Daten und Fehler laufen ebenfalls über die „für“-Dauer und
  werden wie Feuern gemeldet, mit eigenem Betreff; ist für die Regel „OK“ oder „letzten Zustand
  halten“ gewählt, entsteht kein eigener Zustand.
- Eine Serie, die in drei Auswertungen nacheinander fehlt, wird als Instanz beendet (Behoben mit
  dem Hinweis „Serie nicht mehr vorhanden“).
- Pausierte Regeln haben keine Instanzen; beim Fortsetzen beginnt alles bei OK.
- Die Farben der Zustände folgen den Tokens (`--danger` Feuert, `--warn` Ausstehend und Fehler,
  `--ok` OK, neutral Keine Daten und Stumm), immer zusammen mit Text, nie nur als Farbe.

### Benachrichtigungen

- **Inhalt**: Betreff „[Feuert] Regelname · Organisation“ (bzw. Behoben, Keine Daten, Fehler,
  Erinnerung); Zustand und seit wann, je Instanz die Labels, der reduzierte Wert und die Bedingung
  („Lager-API p95 = 1,84 s, Bedingung > 1,5 s“), Beschreibung und Anleitungslink der Regel, Links zu
  Regel, Panel und „Stummschalten“. Keine Zeilen, Dokumente oder Knoten aus dem Ergebnis, nur die
  reduzierten Werte. Sprache je Kontaktpunkt (Deutsch oder Englisch).
- **Eine Nachricht je Regel und Auswertung** mit allen Instanzen, die sich in dieser Auswertung
  geändert haben; Gruppierung über Regeln hinweg kommt in 0.7.1.
- **Deduplizierung**: Gesendet wird nur bei einem Zustandswechsel, der gemeldet wird, und bei
  fälliger Erinnerung. Schlüssel ist (Fingerprint, Kontaktpunkt, Zustand, Beginn des Zustands);
  ein zweiter Versand mit demselben Schlüssel wird nicht ausgelöst, auch nicht nach einem
  Neustart oder Wechsel der Leitung. Stummgeschaltete Instanzen werden ausgewertet und stehen im
  Verlauf, aber nicht gesendet; endet die Stummschaltung bei weiterhin feuernder Instanz, wird
  einmal gemeldet.
- **Zustellung**: im Hintergrund, bis zu 3 Versuche (nach 10 Sekunden, 1 Minute, 5 Minuten),
  10 Sekunden Zeitlimit je Versuch. Das Ergebnis jedes Versuchs steht im Verlauf und am
  Kontaktpunkt („Letzte Zustellung fehlgeschlagen: 503“).
- **Mail**: über den Mailserver aus Verwaltung > E-Mail (Abschnitt 8); ohne Mailserver lässt sich
  kein Mail-Kontaktpunkt anlegen. Bis zu 20 Empfänger je Kontaktpunkt. Text und HTML.
- **Webhook**: `POST` mit JSON (`Content-Type: application/json`, höchstens 256 KB), Nutzlast mit
  `version: 1`, Organisation, Regel, Zustand, Instanzen mit Labels und Werten, Links. Die URL läuft
  durch dieselbe Ziel-Prüfung wie Datenquellen (private Netze erlaubt, Kalzit selbst und
  Metadaten-Adressen nie), Weiterleitungen werden nicht verfolgt. `http://` geht mit Hinweis.
- **Webhook-Signatur**: Kalzit erzeugt je Kontaktpunkt ein Geheimnis (32 Byte, einmal angezeigt,
  danach nur „Neu erzeugen“). Header `Kalzit-Signature: t=<Unix-Sekunden>,v1=<hex>` mit
  HMAC-SHA256 über `<t>.<Rohtext der Nutzlast>`; dazu `Kalzit-Delivery` (eindeutig je Nachricht,
  bleibt bei Wiederholungen gleich) und `Kalzit-Event` (`firing`, `resolved`, `no_data`, `error`,
  `reminder`, `test`). Empfänger sollen Zeitstempel älter als 5 Minuten ablehnen. Nach dem
  Neuerzeugen gilt das alte Geheimnis 24 Stunden weiter; in der Zeit trägt der Header zwei
  `v1`-Werte. Die Anleitung bekommt Prüfbeispiele.
- **Kontaktpunkte verwalten** nur Organisations-Admins (`alerts:contacts`, siehe „Rechte und
  Audit“); Bearbeiter sehen sie ohne Bearbeiten und wählen sie in der Regel aus.
- **Testsenden** an jedem Kontaktpunkt mit Beispielinhalt (`Kalzit-Event: test`), höchstens
  5 je Minute und Kontaktpunkt.

### Stummschaltungen

- Label-Bedingungen (`=`, `≠`, `=~` mit regulärem Ausdruck in linearer Laufzeit), alle müssen
  passen; dazu Beginn, Ende (höchstens 90 Tage) und ein Pflichtkommentar. Anlegen frei oder aus
  einer Instanz (Bedingungen vorausgefüllt mit Regel und Labels) mit Dauer 1 Stunde, 4 Stunden,
  1 Tag oder bis zu einem Zeitpunkt. Vor dem Speichern zeigt die Seite, welche Instanzen jetzt
  betroffen sind.
- Stummschaltungen unterdrücken nur das Senden, nie die Auswertung. Vorzeitig beenden geht
  jederzeit; abgelaufene bleiben bis zum Ende der Aufbewahrung sichtbar.

### Verlauf und Aufbewahrung

- Verlauf je Organisation: Zustandswechsel und Zustellungen, filterbar nach Regel, Zustand,
  Label und Zeitraum; je Regel als Zeitleiste der Zustände.
- Aufbewahrung als Server-Einstellung `alerting.history_retention_days` (Standard 90 Tage); eine
  Organisation kann sie nur verkürzen. Ein stündlicher Job auf dem leitenden Server löscht
  Abgelaufenes, wie bei den Chats der KI.

### Rechte und Audit

- Neue Rechte (Entscheidung des Inhabers vom 10. November 2026), alle drei auch in eigenen Rollen
  wählbar:
  - `alerts:read` (Betrachter und höher): Regeln, Zustände, Verlauf, Stummschaltungen, das Badge
    und die Kontaktpunkte (nur Name, Art und letzte Zustellung; Empfänger gekürzt, die URL nur mit
    Host) sehen.
  - `alerts:write` (Bearbeiter und höher): Regeln und Stummschaltungen anlegen, ändern und
    löschen. Eine Regel wählt nur aus vorhandenen Kontaktpunkten.
  - `alerts:contacts` (Organisations-Admin und höher): Kontaktpunkte anlegen, ändern, löschen,
    testen und das Webhook-Geheimnis neu erzeugen. Nur so bestimmt die Organisation, wohin
    reduzierte Werte gesendet werden.
- Speichern einer Regel verlangt `alerts:write`, `datasources:query` auf der Quelle für die
  speichernde Person und die Alerting-Freigabe der Quelle. Die Freigabe setzt, wer die Quelle
  bearbeiten darf (`datasources:write`); wird sie entzogen, gehen die Regeln dieser Quelle in den
  Zustand Fehler („Quelle nicht für Alerting freigegeben“) und das wird gemeldet.
- Das Badge an einem Panel sieht nur, wer das Dashboard lesen darf und `alerts:read` hat. Links in
  Nachrichten führen zur Anmeldung; wer kein Recht hat, sieht nach der Anmeldung nichts.
- Alles wird auf dem Server geprüft, für jede Anfrage und jede Regel; ein Guard-Test deckt die
  neuen Routen ab.
- Audit-Log: `alert_rule.created|updated|deleted|paused|resumed`,
  `alert_contact_point.created|updated|deleted|tested|secret_rotated`,
  `alert_silence.created|expired`, `datasource.alerting_changed`, `alerting.settings_changed`. Nie
  Geheimnisse, Empfänger-Adressen nur gekürzt. Auswertungen stehen im Verlauf, nicht im Audit-Log.

### Grenzen (Standardwerte, Server-Einstellungen)

| Grenze | Standard |
|---|---|
| Regeln je Organisation | 500 |
| Instanzen je Regel | 100 (darüber: Zustand Fehler „Zu viele Serien“) |
| Kontaktpunkte je Regel | 5 |
| Kleinstes Intervall | 30 Sekunden |
| Zeitlimit je Auswertung | 30 Sekunden |
| Gleichzeitige Auswertungen | 8 Server, 4 je Organisation, 2 je Datenquelle |
| Webhook-Nutzlast | 256 KB |
| Aufbewahrung des Verlaufs | 90 Tage |

Organisationen können die Grenzen nur senken.

### Nicht in 0.7.0

Routing-Bäume und Benachrichtigungsrichtlinien, Gruppierung über Regeln hinweg, Eskalation und
Bereitschaftspläne, wiederkehrende Ruhezeiten, weitere Kanäle (Slack, Teams, PagerDuty, SMS und
andere), eigene Vorlagen für Nachrichten, Regeln über mehrere Abfragen oder Ausdrücke zwischen
Abfragen, Instanzen je Feldwert bei Dokumenten oder je Teilgraph, Hysterese (eigene Grenze für
Behoben), Regeln als Dateien (kommt mit Provisioning in 0.7.3), Regeln im Ordner mit Rechten je
Ordner, Anbindung externer Alert-Manager, KI-Funktionen am Alerting.

## 14. Entscheidungen

Getroffen (stehen auch in `CLAUDE.md`):

1. Server in Rust.
2. Lizenz AGPL-3.0.
3. Nur selbst gehostet.
4. Graph-Quellen zum Start: Neo4j, Memgraph und TigerGraph.
5. UI auf Deutsch mit „du“ und Englisch.
6. Alle üblichen Datenquellen werden unterstützt (Abschnitt 3), nicht nur MongoDB und Graphen.
7. Ausrichtung: Plattform zur Visualisierung und Auswertung von Daten allgemein, nicht nur Monitoring.
8. Mehrere Organisationen pro Installation.
9. Alerting in M7, nach dem Kern und dem Feinschliff in M6; die Analyse-Tiefe folgt danach in M8.
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
15. Alerting (M7, Entscheidung vom 10.11.2026): Regel = gespeicherte Abfrage, expliziter
    Reduzier-Schritt und Bedingung auf allen drei Formen; Kanäle zuerst Mail und signierter
    Webhook; Rechte `alerts:read`, `alerts:write` und `alerts:contacts` (Kontaktpunkte nur für
    Organisations-Admins); Auswertung mit einer Dienstidentität der
    Organisation und nur auf freigegebenen Quellen; Einzelheiten in Abschnitt 13.
