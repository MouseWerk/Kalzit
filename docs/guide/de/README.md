[English](../README.md) | Deutsch

# Kalzit-Anleitung

So arbeitest du mit Kalzit, eine Seite pro Bereich. Die Anleitung beschreibt, was die Oberfläche
heute kann; die [Roadmap in der README](../../../README.md#roadmap) nennt, was noch kommt. Die
Bezeichnungen sind so geschrieben, wie die deutsche Oberfläche sie zeigt.

## Seiten

| Seite | Inhalt |
|---|---|
| [Installation](installation.md) | Die deb- und rpm-Pakete mit ihrem systemd-Dienst, Pfade, Updates und Entfernen; das Container-Image: Volume, Konfiguration, Secrets-Schlüssel, Compose mit SQLite oder PostgreSQL, Health-Check, Updates |
| [Hinter einem Reverse Proxy](reverse-proxy.md) | Kalzit unter einem Unterpfad wie `/kalzit`, Beispiele für nginx, Caddy, Traefik und IIS |
| [Überwachung](monitoring.md) | Health-Checks und Prometheus-Metriken (`/metrics`): einschalten, schützen, was sie messen |
| [HTTPS und Zertifikate](https.md) | HTTPS mit eigenen Zertifikatsdateien oder automatischen Zertifikaten über ACME (Let’s Encrypt oder eine andere Zertifizierungsstelle): Einrichtung, Prüfung, Erneuerung, Fehlersuche |
| [Erste Schritte](getting-started.md) | Einrichtung mit dem Einrichtungscode, Anmelden, die Beispieldaten und die mitgelieferte Hilfe, deine erste Datenquelle, dein erstes Dashboard und deine erste Abfrage in Explore |
| [Dashboards](dashboards.md) | Ansichts- und Bearbeitungsmodus, Menü „Hinzufügen“, Zeilen, Panel-Editor, Variablen (auch per Klick auf Dokumente, Zeilen und Graph-Knoten gesetzt), Zeitraum, Annotationen, Links, Bibliotheks-Panels, Verlauf, Papierkorb, Teilen, Kiosk, Anheften, Favoriten |
| [Panels](panels.md) | Jede Visualisierung mit ihren Optionen, die Graph-Panels mit Knotendetails, Auswahl, Pins und Explorer; Farben, Schwellenwerte, Einheiten, Wertzuordnungen, Abweichungen je Feld |
| [Explore](explore.md) | Freie Abfragen je Datenquellen-Typ (auch Cypher und GSQL), die drei Ergebnisformen, Schritte und Graph-Schritte, zum Dashboard hinzufügen |
| [Abfragesprachen für Einsteiger](query-languages.md) | Was jede Datenquelle enthält, kleine lesende Beispielabfragen je Sprache (SQL, PromQL, Flux und InfluxQL, LogQL, Lucene und JSON-DSL, MongoDB-Pipelines, Cypher, GSQL), Dateien und HTTP-JSON, und wie Zeitraum und Variablen wirken |
| [Auswertungen](saved-analyses.md) | Abfragen aus Explore speichern, die Liste unter Explore, verknüpfte Dashboard-Panels, Versionen und Konflikte |
| [Berechnete Felder und Statistik](calculated-fields.md) | Auswertungsschritte, die Ausdruckssprache, Statistik, Graph-Schritte, mit Beispielen |
| [Export](export.md) | CSV-, JSON- und Excel-Dateien und ihre Grenzen |
| [Leistung und Cache](performance.md) | Der Abfrage-Cache des Servers pro Person, seine Einstellungen je Datenquelle und für den Server, Aktualisieren, was Untersuchen zeigt, die übrigen Grenzen |
| [Datenquellen](data-sources.md) | Jeder unterstützte Typ, Verbindungseinstellungen und -zeichenfolgen, nur lesender Zugriff (inklusive der REST++-Authentifizierung von TigerGraph), Testen, Zugriff, Papierkorb |
| [Plugins](plugins.md) | Datenquellen- und Panel-Plugins aus einer Datei oder dem signierten Katalog installieren, die Prüfungen und Rechte, Status, Log, Sandbox und Netzwerk eines Plugins, vertrauenswürdige Schlüssel, unsignierte Plugins, Sperren je Organisation, Panels aus Plugins |
| [KI](ai.md) | KI mit einem Anbieter einschalten, ein Anbieter je Funktion, Grenzen, der eigene Anbieter der Organisation, was die KI von einer Datenquelle lesen darf, der Hinweis bei der ersten Nutzung, Erklären, Entwerfen und Zusammenfassen, Fragen (Chat über deine Daten) mit Verlauf und Aufbewahrung |
| [Anmeldung und Sicherheit](account-security.md) | Dein zweiter Faktor (Passkeys, Authenticator-App, Wiederherstellungscodes), der zweite Schritt der Anmeldung, einen zweiten Faktor auf dem Server und je Organisation verlangen, den zweiten Faktor einer Person zurücksetzen |
| [Verwaltung](administration.md) | Organisationen, Mitglieder, Teams, Rollen und Rechte, Audit-Log, Servereinstellungen, Updates |

Die HTTP-API hinter jeder Funktion ist in [docs/api](../../api) beschrieben (auf Englisch):
[Zugriff](../../api/access.md), [Datenquellen und Abfragen](../../api/datasources.md),
[Einstellungen und Dashboards](../../api/settings-dashboards.md),
[Dashboard-Funktionen](../../api/dashboard-features.md), [Auswertungen](../../api/analyses.md),
[Shell](../../api/shell.md), [Updates](../../api/updates.md), [Plugins](../../api/plugins.md) und
[KI](../../api/ai.md). Die Begriffe der Oberfläche erklärt das [Glossar](../../glossary.md); wie
du einen Server installierst und betreibst, steht unter [Installation](installation.md), in der
[README](../../../README.md#quick-start) und in [ARCHITECTURE](../../ARCHITECTURE.md).

## Zurechtfinden

Die **Seitenleiste** links ist die Hauptnavigation:

- **Start**: die Startseite mit deiner Organisation in Zahlen, Favoriten und zuletzt geöffneten
  Dashboards.
- **Dashboards**, **Explore** und **Datenquellen**: die Arbeit mit Daten.
- **Fragen** (Beta): Fragen zu deinen Daten in einfachen Worten, solange KI eingeschaltet ist
  ([KI](ai.md#fragen)).
- Gruppe **Organisation**: **Mitglieder**, **Einstellungen** und **Verwaltung**. Jeder Eintrag
  erscheint nur, wenn deine Rolle ihn öffnen darf.
- Deine **angehefteten Dashboards** stehen unter der Navigation, in deiner eigenen Reihenfolge.
- Die **Organisationskarte** oben zeigt die Organisation, in der du arbeitest; öffne sie für ihre
  Einstellungen, Mitglieder und Teams und zum Wechseln der Organisation (Server-Admins sehen alle
  Organisationen).

Die **Leiste oben** zeigt, wo du bist (Brotkrumen), die Suche, ein Menü **Neu** (Dashboard,
Ordner, Import, Datenquelle) und **Hilfe** (Tastenkürzel und Dokumentation). Auf dem Handy sind
Suche, Neu und Hilfe Symbolschaltflächen.

Schneller geht es so:

| Tasten | Was passiert |
|---|---|
| Strg+K (Cmd+K unter macOS) | Befehlspalette: Dashboards, Ordner, Datenquellen und Seiten über ein paar Buchstaben finden oder eine Aktion ausführen, etwa ein neues Dashboard, Explore oder die Darstellung. Sie zeigt nur, was du öffnen darfst. |
| `/` | Suche (außerhalb von Textfeldern) |
| `?` | Alle Tastenkürzel des aktuellen Bereichs |
| Strg+B | Seitenleiste ein- oder ausklappen |
| Esc | Menü, Dialog oder Palette schließen |

Deine Sprache (Englisch oder Deutsch), Darstellung (System, Hell, Dunkel, Hoher Kontrast),
Zeitzone, dein Start-Dashboard und der erste Tag der Woche stellst du auf deiner Kontoseite ein
(siehe [Verwaltung](administration.md#dein-konto)).
