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
| Benutzer | User | Ein Konto, das sich anmelden kann. | Nutzer, Anwender |
| Konto | Account | Die Anmeldedaten und das Profil eines Benutzers. | Account (im Deutschen) |
| Rolle | Role | Satz von Rechten: Betrachter, Bearbeiter, Admin, Eigentümer oder eine eigene Rolle. | |
| Betrachter | Viewer | Feste Rolle: darf lesen. | Leser |
| Bearbeiter | Editor | Feste Rolle: darf Dashboards und Auswertungen ändern. | Redakteur |
| Admin | Admin | Feste Rolle: verwaltet die Organisation. | |
| Eigentümer | Owner | Feste Rolle: volle Rechte, auch über Admins. | Besitzer |
| Recht | Permission | Einzelne Erlaubnis wie `dashboards:write`. | Berechtigung (als Name eines Rechts) |
| Server-Admin | Server admin | Verwaltet die ganze Installation über alle Organisationen hinweg. | Superuser, Root |
| Datenquelle | Data source | Verbindung zu einer Datenbank oder einem Dienst, den Kalzit abfragt. | Datasource, Datenbankquelle, Connector |
| Abfrage | Query | Eine Anfrage an eine Datenquelle (SQL, Pipeline, Cypher, PromQL, ...). | Query (im Deutschen) |
| Dashboard | Dashboard | Seite mit Panels, abgelegt in Ordnern, mit Verlauf. | Übersichtsseite, Board |
| Ordner | Folder | Enthält Dashboards; Rechte am Ordner gelten für seinen Inhalt. | Verzeichnis |
| Panel | Panel | Eine Visualisierung in einem Dashboard. | Kachel, Widget |
| Explore | Explore | Ad-hoc-Abfragen ohne Dashboard, mit Verlauf. Name der Funktion, nicht übersetzt. | Erkunden |
| Auswertung | Analysis | Gespeicherte Abfrage mit Schritten und Ansicht, teilbar im Team. | Analyse (als Name), Report |
| Dokument | Document | Ein Eintrag aus einer Dokumentdatenbank (MongoDB), als Baum. | Datensatz (für Dokumente) |
| Feldpfad | Field path | Pfad zu einem Wert in einem Dokument, z. B. `address.city`. | |
| Knoten | Node | Ein Element eines Graphen (Neo4j, Memgraph, TigerGraph; dort „Vertex“). | Vertex, Ecke |
| Kante | Edge | Eine Beziehung zwischen zwei Knoten. | Relation, Verbindung (für Kanten) |
| Projektion | Projection | Sichtbarer Schritt, der eine Datenform in eine andere umwandelt. | Konvertierung |
| Verlauf | History | Frühere Versionen oder Abfragen, wiederherstellbar. | Historie |
| Einrichtung | Setup | Der erste Start: erste Organisation und erstes Konto anlegen. | Installation (für diesen Schritt), Onboarding |
| Einrichtungscode | Setup code | Einmaliger Code aus `setup-token.txt` im Datenordner des Servers. | Setup-Token, Einrichtungstoken, Setup token |
| Datenordner | Data folder | Ordner des Servers mit Datenbank, Schlüsseln und `setup-token.txt`. | Datenverzeichnis |
| Anmelden | Sign in | Sich mit E-Mail-Adresse und Passwort beim Server ausweisen. | Einloggen, Login (als Verb), Log in |
| Abmelden | Sign out | Die Sitzung beenden. | Ausloggen, Log out |
| Sitzung | Session | Die Anmeldung im Browser, bis zum Abmelden oder Ablauf. | |
| Betreuer | Maintainer | Rolle in einem Team: darf Mitglieder des Teams hinzufügen und entfernen. | Maintainer (im Deutschen) |
| Gesperrt | Locked | Ein Konto, das sich nicht anmelden kann, bis ein Server-Admin es entsperrt. | Deaktiviert, Disabled (in English) |
| E-Mail-Adresse | Email address | Kennung zum Anmelden. | Mail-Adresse, E-mail |
| Verwaltung | Administration | Bereich für Organisationen, Teams, Benutzer und Rollen. | Administration (im Deutschen), Admin-Bereich |
| Darstellung | Theme | System, Hell, Dunkel, Hoher Kontrast. | Thema, Design (für das Theme) |
| Computer | Computer | Das Gerät, auf dem der Browser oder der Server läuft. | Rechner |

## Schreibweise / Style

- Deutsch: „…“ als Anführungszeichen, Auslassungspunkte direkt am Wort bei Aktionen, die einen
  Dialog öffnen („Exportieren…“), Tastennamen wie auf der deutschen Tastatur (Strg, Umschalt,
  Eingabe, Entf).
- English: sentence case for labels and buttons, curly quotes “…”, keys Ctrl, Shift, Enter, Del.
