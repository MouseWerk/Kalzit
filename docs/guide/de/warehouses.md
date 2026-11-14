[English](../warehouses.md) | Deutsch

# Data-Warehouses: BigQuery, Snowflake und Databricks SQL

Kalzit liest Google BigQuery, Snowflake und Databricks SQL mit SQL über ihre REST-APIs. Jedes
liefert eine Tabelle (`frame`), wie die anderen SQL-Quellen: Du schreibst eine `SELECT`- oder
`WITH`-Anweisung im Dialekt des Warehouse, und Zeitraum und Variablen erreichen das Warehouse als
Abfrageparameter, nie als Text in der Anweisung.

Warehouses rechnen ab, was Abfragen lesen oder wie lange sie laufen. Deshalb:

- behält Kalzit Antworten standardmäßig im [Abfrage-Cache](performance.md) (60 Sekunden; zu
  ändern unter **Cache** in den Einstellungen der Datenquelle),
- bricht Kalzit eine Abfrage im Warehouse ab, wenn es nicht mehr auf sie wartet (das Zeitlimit ist
  abgelaufen, oder Panel oder Anfrage wurden geschlossen), und schickt das Zeitlimit für Abfragen
  als eigenes Limit an das Warehouse,
- fragt Kalzit, wo die API es erlaubt, höchstens eine Zeile mehr ab als das Zeilenlimit,
- schätzt Kalzit jede BigQuery-Abfrage zuerst in einem kostenlosen Probelauf und lehnt sie ab, wenn
  sie über **Höchstens abgerechnete Bytes je Abfrage** der Datenquelle liegt.

## Nur lesender Zugriff

Datenquellen sind nur lesbar. Kalzit lehnt auf dem Server alles außer einer
`SELECT`-/`WITH`-Anweisung ab, bevor sie das Warehouse erreicht, und lehnt auch Funktionen ab, die
Dateien, Stages oder Secrets lesen, andere Server abfragen, HTTP-Anfragen schicken oder KI-Modelle
aufrufen (siehe die
[API-Referenz](../../api/datasources.md#bigquery-snowflake-and-databricks-sql-sql)). Diese Prüfung
ist die zweite Linie. **Die eigentliche Grenze ist ein Login, das nur lesen kann:**

### BigQuery

Leg für Kalzit ein Dienstkonto an und gib ihm nur:

- **BigQuery Data Viewer** (`roles/bigquery.dataViewer`) auf den Datasets, die Kalzit lesen darf,
  und
- **BigQuery Job User** (`roles/bigquery.jobUser`) im Projekt, in dem die Abfragen laufen.

Kalzit fordert bei Google nur den Bereich `bigquery.readonly` an und schickt jede Abfrage zuerst
als Probelauf; BigQuery nennt die Art der Anweisung, und alles außer `SELECT` (ein Skript, DML,
DDL) wird abgelehnt, bevor es läuft.

### Snowflake

Snowflake kennt keine Sitzung nur zum Lesen, die Rolle entscheidet also alles. Eine Rolle für
Kalzit:

```sql
CREATE ROLE kalzit_reader;
GRANT USAGE ON WAREHOUSE reporting_xs TO ROLE kalzit_reader;
GRANT USAGE ON DATABASE sales TO ROLE kalzit_reader;
GRANT USAGE ON ALL SCHEMAS IN DATABASE sales TO ROLE kalzit_reader;
GRANT SELECT ON ALL TABLES IN DATABASE sales TO ROLE kalzit_reader;
GRANT SELECT ON FUTURE TABLES IN DATABASE sales TO ROLE kalzit_reader;
CREATE USER kalzit_reader DEFAULT_ROLE = kalzit_reader DEFAULT_WAREHOUSE = reporting_xs TYPE = SERVICE;
GRANT ROLE kalzit_reader TO USER kalzit_reader;
```

Gib dem Benutzer keine weitere Rolle. Ein kleines Warehouse mit `AUTO_SUSPEND` und ein Resource
Monitor halten die Kosten im Rahmen.

### Databricks SQL

Auch Databricks kennt keine Sitzung nur zum Lesen. Nimm einen Service Principal (oder für einen
Test dein eigenes persönliches Zugriffstoken) mit nur diesen Rechten in Unity Catalog:

```sql
GRANT USE CATALOG ON CATALOG main TO `kalzit-reader`;
GRANT USE SCHEMA ON SCHEMA main.sales TO `kalzit-reader`;
GRANT SELECT ON SCHEMA main.sales TO `kalzit-reader`;
```

und **CAN USE** auf dem SQL-Warehouse. Kein `MODIFY`, kein `ALL PRIVILEGES`, kein Workspace-Admin.

## Datenquelle einrichten

Unter **Datenquellen** > **Datenquelle hinzufügen** wählst du das Warehouse. Secrets (Schlüssel,
Tokens) werden mit dem [Secrets-Schlüssel](administration.md) verschlüsselt gespeichert und nie
wieder angezeigt; du kannst sie nur ersetzen oder entfernen.

### BigQuery

| Einstellung | Was du einträgst |
|---|---|
| Projekt-ID | Das Projekt, in dem die Abfragen laufen und abgerechnet werden, etwa `acme-analytics` |
| Standort | Wo die Datasets liegen, etwa `EU`, `US` oder `europe-west3`; leer lässt BigQuery wählen |
| Standard-Dataset | Für Tabellennamen ohne Dataset; die Schema-Ansicht zeigt dann nur dieses |
| Anmeldung | `serviceAccountKey` (eine JSON-Schlüsseldatei) oder `workloadIdentity` |
| Schlüssel des Dienstkontos (JSON) | Die ganze Schlüsseldatei des Dienstkontos von oben |
| Konfiguration der Workload-Identität (JSON) | Für `workloadIdentity`: eine Konfiguration der Workload Identity Federation (`gcloud iam workload-identity-pools create-cred-config ... --credential-source-file=...`) |
| Höchstens abgerechnete Bytes je Abfrage | Eine Grenze je Abfrage, etwa `10737418240` (10 GiB); leer nutzt die Grenzen des Projekts |
| API-URL | Lass `https://bigquery.googleapis.com` stehen, außer du nutzt einen Private-Service-Connect-Endpunkt |

Mit **Workload Identity Federation** verlässt kein Schlüssel Google: Die Konfiguration nennt eine
Datei mit einem Token deines Identitätsanbieters (etwa das Token eines Kubernetes-Dienstkontos).
Diese Datei muss in einem Ordner liegen, den ein Server-Admin für Dateien erlaubt hat
(`datasources.file_dirs`). Unterstützt werden nur Dateiquellen; den Metadatenserver einer Cloud-VM
nutzt Kalzit nicht, es lehnt ihn als Ziel ab.

### Snowflake

| Einstellung | Was du einträgst |
|---|---|
| Kontokennung | `myorg-myaccount` oder ein Locator wie `xy12345.eu-central-1` |
| Benutzername | Der Benutzer von oben |
| Privater Schlüssel (PEM) | Der unverschlüsselte private Schlüssel des Benutzers (`-----BEGIN PRIVATE KEY-----`) |
| Warehouse, Rolle, Datenbank, Schema | Optional; leer nutzt die Vorgaben des Benutzers |
| URL | Nur für einen Private Link; leer heißt `https://<kontokennung>.snowflakecomputing.com` |

Kalzit meldet sich mit einem Schlüsselpaar an. Erzeuge einen Schlüssel und gib dem Benutzer den
öffentlichen Teil:

```sh
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out kalzit_key.p8 -nocrypt
openssl rsa -in kalzit_key.p8 -pubout -out kalzit_key.pub
```

```sql
ALTER USER kalzit_reader SET RSA_PUBLIC_KEY = 'MIIBIjANBgkqh...';
```

Füge den Inhalt von `kalzit_key.p8` unter **Privater Schlüssel** ein. Kalzit speichert ihn
verschlüsselt, der Schlüssel selbst darf also nicht verschlüsselt sein. Anweisungen laufen in UTC
und tragen das Tag `kalzit` (`QUERY_TAG`).

### Databricks SQL

| Einstellung | Was du einträgst |
|---|---|
| Workspace-URL | Etwa `https://adb-1234567890123456.7.azuredatabricks.net` oder `https://dbc-a1b2c3d4-e5f6.cloud.databricks.com` |
| ID des SQL-Warehouse | Aus den **Connection details** des Warehouse (der letzte Teil des HTTP-Pfads) |
| Katalog, Schema | Optional; leer nutzt die Vorgaben des Warehouse |
| Anmeldung | `token` (ein persönliches Zugriffstoken) oder `oauth` (OAuth Machine-to-Machine) |
| API-Token | Für `token` |
| OAuth-Client-ID, OAuth-Secret | Für `oauth`: die Client-ID des Service Principal und ein dafür erzeugtes OAuth-Secret |

## Abfragen

Schreib SQL im Dialekt des Warehouse. Makros und Variablen funktionieren wie bei jeder SQL-Quelle
([Abfragesprachen](query-languages.md#bigquery)); so erreichen sie das jeweilige Warehouse:

| | BigQuery | Snowflake | Databricks |
|---|---|---|---|
| `$__timeFilter(col)` | `col BETWEEN TIMESTAMP_MILLIS(?) AND ...` | `col BETWEEN TO_TIMESTAMP_TZ(?, 3) AND ...` | `col BETWEEN timestamp_millis(:p1) AND ...` |
| `$__interval` | ein `INTERVAL` | Text wie `30 seconds` | Text wie `30 seconds` (für `window()`) |
| `$__interval_ms` | Ganzzahl | Ganzzahl | Ganzzahl |
| `$name` | ein Abfrageparameter | eine Bindung | ein benannter Parameter |

Eine Spalte vom Typ `DATETIME` (BigQuery) oder `TIMESTAMP_NTZ` (Snowflake, Databricks) wird als UTC
verglichen; wandle sie um, wenn sie Ortszeiten enthält. Für Zeitabschnitte nimm in BigQuery
`TIMESTAMP_BUCKET(ts, $__interval)`, in Snowflake
`TO_TIMESTAMP(FLOOR(DATE_PART(EPOCH_MILLISECOND, ts) / $__interval_ms) * $__interval_ms, 3)` und in
Databricks `window(ts, $__interval).start`.

Nicht erlaubt sind außer Schreibzugriffen: `$` außerhalb von Variablen und Makros (auch die
`$$`-Zeichenketten, `$1`-Spalten und `SYSTEM$`-Funktionen von Snowflake), selbst geschriebene
Platzhalter (`?`, `@name`), Stages (`@stage`) und `#`-Kommentare in Snowflake, rohe Zeichenketten
mit Backslash (BigQuery, Databricks) und in Databricks Tabellen, die über einen Dateipfad benannt
sind (``parquet.`/data` ``).

Die **Schema-Ansicht** zeigt Tabellen und Spalten aus `INFORMATION_SCHEMA`: in BigQuery die des
Standard-Datasets, sonst aller Datasets am Standort; in Snowflake und Databricks die aller Schemas
der aktuellen Datenbank oder des aktuellen Katalogs. Die Vorlagen in **Explore** (neueste Zeilen,
Anzahl je Wert, ein Wert über die Zeit) und der Spickzettel sind dieselben wie bei den anderen
SQL-Quellen, im Dialekt des Warehouse geschrieben.

## Fehlersuche

| Meldung | Was zu tun ist |
|---|---|
| Die Datenquelle hat die Anmeldung abgelehnt | BigQuery: Schlüssel oder Workload-Identität werden nicht angenommen. Snowflake: Der öffentliche Schlüssel ist beim Benutzer nicht gesetzt, oder Kontokennung oder Benutzername stimmen nicht. Databricks: Das Token ist abgelaufen oder das OAuth-Secret falsch. |
| BigQuery liest diese Anweisung als SCRIPT | Es läuft nur ein `SELECT`; entferne `DECLARE`, `BEGIN ... END` und Ähnliches. |
| Die Abfrage würde mehr Daten lesen, als diese Datenquelle erlaubt | Schränke Zeitraum oder Spalten ein, oder erhöhe **Höchstens abgerechnete Bytes je Abfrage**. |
| Stages (@name) sind nicht erlaubt | Kalzit liest nur Tabellen; lade Dateien zuerst in eine Tabelle. |

Die Tests von Kalzit laufen gegen aufgezeichnete API-Antworten; ein nächtlicher Job des Projekts
prüft dasselbe gegen echte Warehouses, wo Test-Zugangsdaten hinterlegt sind.
