# Glossar / Glossary

Ein Begriff pro Konzept, überall gleich: in der Oberfläche, in der Doku, in Release Notes und
Fehlermeldungen. Die deutschen Texte sprechen mit „du“ an. Die Spalte „Nicht verwenden“ wird vom
Übersetzungstest geprüft (`ui/src/i18n/i18n.test.ts`): diese Wörter dürfen in keinem Katalog
vorkommen.

One term per concept, everywhere: UI, docs, release notes and error messages. The "Avoid" column is
checked by the translation test (`ui/src/i18n/i18n.test.ts`): these words must not appear in any
catalog.

## Begriffe / Terms

| Deutsch | English | Bedeutung / Meaning | Nicht verwenden / Avoid |
|---|---|---|---|
| Organisation | Organization | Oberste Einheit einer Installation; besitzt Teams, Datenquellen, Dashboards. Eine Installation hat mehrere. | Mandant, Tenant, Organisierung |
| Team | Team | Gruppe von Benutzern in einer Organisation; erhält Rechte gemeinsam. | Gruppe (für Teams), Group (for teams) |
| Benutzer | User | Ein Konto, das sich anmelden kann; Name der Liste aller Konten unter Verwaltung > Benutzer und Wort für den Login einer Datenquelle oder eines Mailservers. | Nutzer, Anwender |
| Person | Person | Ein Mensch, der Kalzit nutzt. In Texten über Menschen „Person“ statt „Benutzer“: Grenzen pro Person, „für alle Personen“, nie je Person gezählt. | |
| Konto | Account | Die Anmeldedaten und das Profil eines Benutzers. | Account (im Deutschen) |
| Login (Datenbank-Login) | Login (database login) | Benutzername und Passwort, mit denen Kalzit sich bei einer Datenquelle anmeldet; nie das Kalzit-Konto. „Login“ allein nur bei Datenquellen, sonst „Datenbank-Login“. | Konto (für die Datenbank), Account (für die Datenbank) |
| Rolle | Role | Satz von Rechten: Betrachter, Bearbeiter, Admin, Eigentümer oder eine eigene Rolle. | |
| Betrachter | Viewer | Feste Rolle: darf lesen. | Leser |
| Bearbeiter | Editor | Feste Rolle: darf Dashboards und Auswertungen ändern. | Redakteur |
| Admin | Admin | Feste Rolle: verwaltet die Organisation. | |
| Eigentümer | Owner | Feste Rolle: volle Rechte, auch über Admins. | Besitzer |
| Recht | Permission | Einzelne Erlaubnis wie `dashboards:write`. | Berechtigung (als Name eines Rechts) |
| Server-Admin | Server admin | Verwaltet die ganze Installation über alle Organisationen hinweg. | Superuser, Root |
| Datenquelle | Data source | Verbindung zu einer Datenbank oder einem Dienst, den Kalzit abfragt. | Datasource, Datenbankquelle, Connector |
| Abfrage | Query | Eine Anfrage an eine Datenquelle (SQL, Pipeline, Cypher, PromQL, ...). | Query (im Deutschen) |
| Nutzung | Usage | Stündliche Zähler je Dashboard, Panel und Datenquelle (Aufrufe, Läufe, Abfragen, Dauer, Fehler) unter Verwaltung > Nutzung; nie je Person. | Nutzungsstatistik (als Name) |
| Abfrage-Cache | Query cache | Antworten von Abfragen, die der Server pro Person eine Zeit lang behält; „Aktualisieren“ fragt immer die Datenquelle. Kurz „Cache“, wo der Zusammenhang klar ist (Abschnitt einer Datenquelle, „Cache leeren“). | Zwischenspeicher (als Name), Puffer, Server-Cache (im Deutschen), server cache (in English) |
| Dashboard | Dashboard | Seite mit Panels, abgelegt in Ordnern, mit Verlauf. | Übersichtsseite, Board |
| Ordner | Folder | Enthält Dashboards; Rechte am Ordner gelten für seinen Inhalt. | Verzeichnis |
| Team-Bereich | Team space | Ordner ganz oben, der einem Team gehört; nur das Team sieht ihn, bis es ihn freigibt. | Teamraum, Team-Space, Teamordner |
| Eigentümer-Team | Owner team | Das Team, dem ein Ordner oder Dashboard gehört; nur es (und Freigaben) bearbeitet ihn. | Besitzerteam, Owner-Team |
| Sichtbarkeit | Visibility | Wer Inhalte eines Teams außer dem Team sieht: alle mit Zugriff (nur lesen) oder „Nur Team“. | |
| Panel | Panel | Eine Visualisierung in einem Dashboard. | Kachel, Widget |
| Karten | Cards | Die Darstellung einer Liste, etwa der Dashboards, als Karten mit Vorschau statt als Tabelle; die Karten sind keine Panels. | Kacheln (für diese Ansicht), Tiles (in English) |
| Bibliothekspanel | Library panel | Ein Panel, das an einer Stelle gepflegt und in mehrere Dashboards eingefügt wird; verknüpfte Kopien übernehmen jede Änderung. | Bibliotheks-Panel (im Deutschen) |
| Schwellenwert | Threshold | Ein Wert, ab dem ein Panel eine andere Farbe oder Stufe zeigt. | Schwellwert (im Deutschen) |
| Variable | Variable | Ein Platzhalter wie `$host` in Abfragen und Titeln, gesetzt in der Leiste über dem Dashboard oder durch einen Klick auf eine Zeile, ein Dokument oder einen Knoten; geht als Parameter an die Datenbank, nie als Text in die Abfrage. | |
| Anmerkung | Annotation | Eine Markierung an einem Zeitpunkt oder Zeitraum in Zeitreihen, mit Text, im Team sichtbar; von Hand oder aus einer Anmerkungsabfrage. | Annotation (im Deutschen), Notiz (für Anmerkungen) |
| Papierkorb | Trash | Gelöschte Dashboards, Ordner, Auswertungen und Datenquellen liegen hier eine Zeit lang und lassen sich wiederherstellen. | Mülleimer, Trash (im Deutschen) |
| Datenform | Result shape | Die Form eines Ergebnisses: `frame` (Tabelle oder Zeitreihe), `documents` (Dokumente) oder `graph` (Knoten und Kanten). Bleibt erhalten; umgewandelt wird nur in einem sichtbaren Schritt. | Ergebnisform (im Deutschen), Datentyp (für die Form) |
| Explore | Explore | Ad-hoc-Abfragen ohne Dashboard, mit Verlauf. Name der Funktion, nicht übersetzt. | Erkunden |
| Auswertung | Analysis | Gespeicherte Abfrage mit Schritten und Ansicht, teilbar im Team. | Analyse (als Name), Report |
| Dokument | Document | Ein Eintrag aus einer Dokumentdatenbank (MongoDB), als Baum. | Datensatz (für Dokumente) |
| Logs | Logs | Die Ansicht in Explore, die Dokumente als Logzeilen zeigt: Zeit, Text und Level je Dokument, mit dem Volumen je Level darüber. Keine eigene Datenform; Name in beiden Sprachen. | Protokolle |
| Logzeile | Log line | Ein Eintrag in der Logs-Ansicht; dahinter steht genau ein Dokument der Quelle. | Protokollzeile |
| Level | Level | Die Stufe einer Logzeile: Kritisch, Fehler, Warnung, Info, Debug, Trace oder unbekannt; als Punkt und Wort, nie nur als Farbe. | Schweregrad |
| Feldpfad | Field path | Pfad zu einem Wert in einem Dokument, z. B. `address.city`. | |
| Knoten | Node | Ein Element eines Graphen (Neo4j, Memgraph, TigerGraph). In der UI immer „Knoten“, auch wenn die Quelle selbst einen anderen Begriff verwendet. | Vertex, Ecke |
| Kante | Edge | Eine Beziehung zwischen zwei Knoten. | Relation, Verbindung (für Kanten) |
| Stil | Style | Die Regeln für Farbe, Größe, Form, Icon, Rahmen, Beschriftung und Abzeichen von Knoten und Kanten in einem Panel („Stilregeln“). Nicht die Darstellung (Hell, Dunkel) der Oberfläche. | |
| Schritt | Step | Ein sichtbarer, abschaltbarer Rechenschritt auf dem Ergebnis der Abfragen, gespeichert mit dem Panel. | Transformation (in der Oberfläche) |
| Berechnetes Feld | Calculated field | Ein neues Feld aus einem Ausdruck über die Felder einer Tabelle. | Formelfeld |
| Projektion | Projection | Sichtbarer Schritt, der eine Datenform in eine andere umwandelt. | Konvertierung |
| Verlauf | History | Frühere Versionen oder Abfragen, wiederherstellbar. | Historie |
| Einrichtung | Setup | Der erste Start: erste Organisation und erstes Konto anlegen. | Installation (für diesen Schritt), Onboarding |
| Einrichtungscode | Setup code | Einmaliger Code aus `setup-token.txt` im Datenordner des Servers. | Setup-Token, Einrichtungstoken, Setup token |
| Datenordner | Data folder | Ordner des Servers mit Datenbank, Schlüsseln, ACME-Zertifikaten, Plugins und `setup-token.txt`; die Einstellung heißt `paths.data_dir`. | Datenverzeichnis, data directory (in English) |
| Anmelden | Sign in | Sich mit E-Mail-Adresse und Passwort beim Server ausweisen. | Einloggen, Login (als Verb), Log in |
| Abmelden | Sign out | Die Sitzung beenden. | Ausloggen, Log out |
| Sitzung | Session | Die Anmeldung im Browser, bis zum Abmelden oder Ablauf. | |
| Anbieter | Provider | Der Dienst, über den sich Personen mit SSO anmelden (OpenID Connect, SAML), oder ein LDAP-Verzeichnis; auf der Anmeldeseite „Mit … anmelden“. | Identity Provider (im Deutschen), Provider (im Deutschen) |
| Einladung | Invitation | Ein Link an die E-Mail-Adresse einer Person, mit dem sie einer Organisation beitritt, mit Rolle und auf Wunsch Team; gilt sieben Tage und einmal. | Invite (im Deutschen) |
| Registrierung | Registration | Personen erstellen ihr Konto selbst, mit einer Adresse einer zugelassenen Domain; nur wenn die Server-Einstellung „Registrierung“ sie einschaltet, auf Wunsch mit Freigabe durch Admins. | Sign-up (im Deutschen) |
| Zweiter Faktor | Second factor | Was nach dem Passwort bestätigt, dass du es bist: Passkey, Authenticator-App oder Wiederherstellungscode. | Zwei-Faktor-Code |
| Zertifikat | Certificate | Das HTTPS-Zertifikat des Servers: aus eigenen Dateien oder über ACME (Let’s Encrypt oder eine andere Zertifizierungsstelle) bestellt und erneuert. | Cert |
| Secrets-Schlüssel | Secrets key | Der Schlüssel, mit dem Kalzit gespeicherte Passwörter, Tokens, KI-Schlüssel und ACME-Dateien in der Datenbank und im Datenordner verschlüsselt. Er kommt aus `KALZIT_SECRETS_KEY`, systemd credentials (Linux) oder DPAPI (Windows), zuletzt aus `secrets.key` im Datenordner. | Master-Key, Masterschlüssel |
| Kalzit-Server | Kalzit server | Ein laufendes Kalzit-Programm. Mehrere teilen sich eine PostgreSQL-Datenbank hinter einem Load Balancer; SQLite trägt genau einen. | Knoten (für Server), Node (für Server) |
| Instanzen | Instances | Name der Seite Verwaltung > Instanzen, die die Kalzit-Server auf einer Datenbank zeigt. Ein einzelner Eintrag heißt „Server“. | Instanz (im Deutschen), Cluster-Knoten |
| Leitender Server | Leader | Der Kalzit-Server, der die Aufgaben ausführt, die nur einmal laufen dürfen (Aufräumen, Katalog, Update-Prüfung, Zertifikate); stoppt er, übernimmt ein anderer. | Master, Primärserver |
| Wartungsfenster | Maintenance window | Die Zeit am Tag, in der geplante Updates laufen dürfen. | Wartungszeitraum |
| Passkey | Passkey | Anmeldung mit Fingerabdruck, Gesicht, Geräte-PIN oder Sicherheitsschlüssel (WebAuthn). | Hauptschlüssel |
| Wiederherstellungscode | Recovery code | Einmal gültiger Code, der den zweiten Faktor ersetzt, wenn das Gerät fehlt. | Backup-Code, Notfallcode |
| Betreuer | Maintainer | Rolle in einem Team: darf Mitglieder des Teams hinzufügen und entfernen. | Maintainer (im Deutschen) |
| Gesperrt | Locked | Ein Konto, das sich nicht anmelden kann, bis ein Server-Admin es entsperrt. Nur für diese Sperre durch Admins; Wartezeiten nach Fehlversuchen heißen „Pause“. | Deaktiviert, Disabled (in English) |
| Pause | Pause | Die Wartezeit nach zu vielen Fehlversuchen beim Anmelden, beim Code des zweiten Faktors oder beim Einrichtungscode; endet von selbst, die Seite nennt die Zeit. Das Konto ist dabei nicht gesperrt. | vorübergehend gesperrt (im Deutschen), temporarily locked (in English) |
| E-Mail-Adresse | Email address | Kennung zum Anmelden. | Mail-Adresse, E-mail |
| Verwaltung | Administration | Bereich für Organisationen, Teams, Benutzer und Rollen. | Administration (im Deutschen), Admin-Bereich |
| Darstellung | Theme | Der Modus (System, Hell, Dunkel, Hoher Kontrast) mit je einer hellen und einer dunklen Variante. | Thema, Design (für das Theme) |
| Variante (Darstellung) | Variant (theme) | Hell, Papier oder Kalzit auf der hellen Seite, Dunkel, Graphit oder Nacht auf der dunklen; „System“ wechselt zwischen den beiden gewählten. Papier, Kalzit, Graphit und Nacht sind Eigennamen (Paper, Calcite, Graphite, Night). Die deutsche Variante „Kalzit“ heißt nach Entscheidung des Inhabers bewusst wie das Produkt (Entwurf „Themes“, Entscheidung 5): Sie benennt das Mineral und behält den Namen auch bei einem eigenen Produktnamen. | |
| Computer | Computer | Das Gerät, auf dem der Browser oder der Server läuft. | Rechner |
| KI | AI | Die eingebauten Funktionen, die ein Sprachmodell nutzen; standardmäßig aus. | AI (im Deutschen), Künstliche Intelligenz |
| KI-Anbieter | AI provider | Der Dienst, der die Antworten liefert: eine OpenAI-kompatible API (auch lokal, etwa Ollama) oder Anthropic. | Provider (im Deutschen), LLM-Anbieter |
| Schlüssel (KI) | API key | Der Zugangsschlüssel eines KI-Anbieters; nur verschlüsselt gespeichert, nie angezeigt. | API-Key (im Deutschen), Token (für den Schlüssel) |
| Fragen | Ask | Der Chat über die eigenen Daten (Beta): die KI liest Schemas und führt lesende Abfragen und Panels mit den Rechten der fragenden Person aus. Name der Funktion. | |
| Plugin | Plugin | Eine Erweiterung aus einem signierten Paket: ein Datenquellen-Typ (eigener Prozess in einer Sandbox) oder ein Panel-Typ (im abgeschotteten Rahmen im Browser). | |
| Herausgeber | Publisher | Wer ein Plugin veröffentlicht, wie es das Manifest nennt; bestätigt wird nur der Schlüssel, der es signiert. | |
| Katalog | Catalog | Die signierte Liste von Plugins zum Installieren; standardmäßig aus. | |
| Dienstkonto | Service account | Ein Konto für Skripte und andere Systeme in einer Organisation, mit einer Rolle; arbeitet nur mit API-Tokens und meldet sich nie an. | Servicekonto |
| API-Token | API token | Der Zugang eines Dienstkontos: einmal angezeigt, nur als Hash gespeichert, läuft spätestens nach einem Jahr ab. | Zugangstoken, Personal access token |
| Handbuch | Handbook | Kalzits Anleitung in der App: im Programm enthalten, durchsuchbar, nur zum Lesen; Hilfe > Handbuch und „Hilfe zu dieser Seite“. Die Dateien im Repository (`docs/guide`) heißen weiter „Anleitung“ / “guide”. | |
| Logs | Logs | Die Ansicht und das Panel für Logzeilen aus Loki, Elasticsearch, OpenSearch und Dokument-Quellen. Eine Ansicht auf die Datenform `documents`, die Zeit, Text und Level liest; keine eigene Datenform und keine Projektion. In beiden Sprachen „Logs“. | |
| Logzeile | Log line | Ein Eintrag in der Logs-Ansicht: ein Dokument mit Zeitpunkt, Text und, wenn vorhanden, Level. | |
| Level | Level | Die Schwere einer Logzeile, in jeder Quelle auf sieben Werte gebracht: Kritisch, Fehler, Warnung, Info, Debug, Trace, unbekannt (Critical, Error, Warning, Info, Debug, Trace, unknown). Als Punkt und Wort gezeigt, nie nur als Farbe. | |
| Volumen je Level | Volume by level | Das gestapelte Balkendiagramm über der Logs-Liste: Anzahl der Logzeilen je Level über den ganzen Zeitraum; aus einer Zählabfrage der Quelle, sonst aus den geladenen Zeilen und dann so beschriftet. | |
| Umgebung zeigen | Show context | Die Logzeilen direkt vor und nach einer Zeile im selben Strom, ohne die Textfilter der Abfrage; eine neue Abfrage, braucht `datasources:query`. | |
| Freie Filter | Ad hoc filters | Variablen-Art: Filter aus Feld, Vergleich und Wert, die als Chips in der Variablenleiste stehen und für alle Panels einer Datenquelle gelten; der Server baut sie in die Abfrage ein, Werte als Parameter. | |
| Danach filtern / Herausfiltern | Filter for / Filter out | Aktionen an einem Wert in einem Panel oder einer Logzeile: nur Zeilen mit diesem Wert behalten oder sie weglassen. In Explore ändert das die Abfrage sichtbar, auf einem Dashboard setzt es einen Chip der Freien Filter. | |
| Schalter (Variable) | Switch (variable) | Variablen-Art: an oder aus, mit je einem Wert, als Schalter in der Variablenleiste. | |
| Datenquelle (Variable) | Data source (variable) | Variablen-Art: wählt die Datenquelle aller Panels, die sie nutzen; zeigt jeder Person nur Quellen, die sie abfragen darf. | |
| „Alle“ | “All” | Der Eintrag einer Auswahl-Variable, der alle Werte meint: geht als Liste aller Werte an die Datenquelle, oder als ein eigener Wert für „Alle“, immer als Parameter. | |
| Abfrage-Optionen | Query options | Die Zeile über den Abfragen im Panel-Editor: Höchstzahl Datenpunkte, kleinstes Intervall, eigener Zeitraum, Zeitverschiebung, Zeitangabe ausblenden. | |
| Besonderer Wert | Special value | Art einer Wertzuordnung für Null, NaN, Leer, Wahr und Falsch. | |
| Fußzeile | Footer | Die Zeile unter einer Tabelle mit einer Rechnung je Spalte (Summe, Mittel, Anzahl, …); sagt, worüber sie rechnet. | |
| Trend (Panel) | Trend (panel) | Panel wie die Zeitreihe, dessen X-Achse ein Zahlfeld mit aufsteigenden Werten ist statt der Zeit. | |
| Trendlinie | Trend line | Der neue Name des Schritts „Trend“, der eine Trendlinie durch die Werte legt. Die Kataloge nennen ihn noch „Trend“; umbenannt wird er mit dem PR, der das Panel „Trend“ einführt, damit Panel und Schritt nicht gleich heißen. | |
| XY-Diagramm | XY chart | Panel, das zwei Zahlfelder gegeneinander stellt: jede Zeile ein Punkt, wahlweise verbunden. | |
| Ebene (Karte) | Layer (map) | Eine Art, Orte auf der Karte zu zeichnen: Punkte, Dichte, Flächen, Linien (Points, Density, Areas, Lines); höchstens vier je Karte. | |
| Ort (Karte) | Place (map) | Woher die Karte die Lage einer Zeile nimmt: Koordinaten, Geohash oder Nachschlagen eines Länder- oder Regionscodes; Zeilen „ohne Ort“ werden gezählt und genannt. | |
| Felder ordnen und umbenennen | Arrange and rename fields | Schritt: Reihenfolge und Namen der Felder, ein- und ausblenden. | |
| Felder nach Name filtern | Filter fields by name | Schritt: nur Felder behalten, deren Name passt. | |
| Typ umwandeln | Convert type | Schritt: Text zu Zahl, Zeit oder Wahrheitswert. | |
| Felder herauslösen | Extract fields | Schritt: neue Felder aus JSON oder Schlüssel=Wert in einem Textfeld. | |
| Text formatieren / Zeit formatieren | Format text / Format time | Schritte: Text groß, klein, gekürzt; Zeitpunkt als Text in einem Muster. | |
| Zeilen filtern | Filter rows | Schritt: Zeilen nach Werten behalten oder weglassen. | |
| Sortieren / Begrenzen | Sort / Limit | Schritte: Zeilen nach Feldern ordnen; nur die ersten N Zeilen behalten. | |
| Nach Labels verknüpfen | Join by labels | Schritt: Serien über ihre Labels zu einer Tabelle verbinden. | |
| Untereinander stellen / Nebeneinander stellen | Stack tables / Place side by side | Schritte: Tabellen mit gleichen Feldern zu einer machen; alle Felder aller Abfragen in eine Tabelle stellen. | |
| Nachschlagen | Look up | Schritt, der Werte aus einer Liste ergänzt (etwa Land zu Code); auch die Art, wie die Karte einen Ort aus einem Code findet. | |
| Serien zu Zeilen / Zeilen zu Feldern / Labels zu Feldern | Series to rows / Rows to fields / Labels to fields | Schritte, die eine Tabelle umformen, ohne Werte zu ändern. | |
| Transponieren | Transpose | Schritt: Zeilen und Spalten tauschen. | |
| Zur Matrix gruppieren | Group to matrix | Schritt: zwei Felder als Zeile und Spalte, eines als Wert. | |
| Nach Werten aufteilen | Split by values | Schritt: eine Tabelle je Wert eines Feldes. | |
| Zeitreihen vorbereiten | Prepare time series | Schritt: lange Tabelle zu einer Serie je Wert und zurück. | |
| Verschachtelte Tabellen | Nested tables | Schritt: Gruppen als Zeilen, die sich aufklappen. | |
| Reduzieren | Reduce | Schritt: jede Serie auf einen Wert bringen (Letzter, Summe, Mittel, …). | |
| Histogramm (Schritt) / Heatmap berechnen | Histogram (step) / Calculate heatmap | Schritte: Werte in Klassen zählen; Klassen über Zeit und Wert. | |
| Optionen aus Abfrageergebnis | Options from query result | Schritt: Min, Max, Einheit und Schwellenwerte eines Panels aus einer Abfrage setzen. | |

## Schreibweise / Style

- Deutsch: „…“ als Anführungszeichen, ’ als Apostroph, Auslassungspunkte direkt am Wort bei
  Aktionen, die einen Dialog öffnen („Exportieren…“), Tastennamen wie auf der deutschen Tastatur
  (Strg, Umschalt, Eingabe, Entf, Pos1, Ende, Bild auf, Bild ab, Esc).
- English: sentence case for labels and buttons, curly quotes “…” and the apostrophe ’ (data
  source’s), keys Ctrl, Shift, Enter, Del, Home, End, PgUp, PgDn, Esc.
