[English](../provisioning.md) | Deutsch

# Provisioning als Code

Dashboards, Datenquellen, eigene Rollen und Alert-Regeln können als Dateien in einem Ordner
liegen, meist einem Git-Checkout, und kommen über die Kommandozeile zu Kalzit:
`kalzit provision plan` zeigt, was sich ändern würde, `kalzit provision apply` ändert es,
`kalzit provision export` schreibt den gespeicherten Stand als Dateien. Die Kommandozeile spricht
mit der API eines laufenden Servers und dem Token eines Dienstkontos; auf anderem Weg kommen keine
Dateien zum Server, und der Server liest keine eigenen Ordner.

## Sätze

Ein **Provisioning-Satz** ist ein Ordner mit Dateien für eine Organisation. Ihm gehören die
Ressourcen, die er angelegt oder übernommen hat: Eine Ressource gehört höchstens einem Satz, und
ein anderer Satz kann sie nicht übernehmen. Eine Organisation kann mehrere Sätze haben (etwa einen
je Repository eines Teams), jeder mit eigenem Namen; ohne Namen heißt der Satz `default`.

Was ein Satz verwaltet, ist für normale Änderungen in der Oberfläche und der API
**schreibgeschützt**: Ändern, Verschieben, Löschen und Wiederherstellen antworten mit
`409 conflict`, dem Grund `provisioning.read_only`, dem Satz und der Datei, die du stattdessen
änderst. Ebenso das Umbenennen, Verschieben, Beschränken, Übergeben oder Löschen eines Ordners mit
verwalteten Dashboards. Manches gehört nicht zu den Dateien und bleibt frei: ob eine Alert-Regel
pausiert ist, Stummschaltungen und der KI-Zugriff einer Datenquelle.

Im Notfall kann ein Organisations-Admin eine Ressource **entsperren** (`provisioning:write`,
protokolliert). Sie lässt sich dann bearbeiten wie jede andere, bis ihr Satz wieder angewendet
wird: Das nächste Anwenden überschreibt sie mit dem Stand der Datei und sperrt sie wieder.

In der Oberfläche trägt ein verwaltetes Dashboard, eine Datenquelle, Alert-Regel oder Rolle für
Personen mit `provisioning:read` die Kennzeichnung **Aus Dateien verwaltet**; sie öffnet Satz,
Datei und letzte Anwendung und enthält das Entsperren. **Verwaltung > Provisioning** zeigt die
Sätze, die verwalteten Ressourcen, die Anwendungen aus dem Audit-Log und wo der Server von den
Dateien abweicht.

## Der Ordner

```text
lager/
  org.yaml
  datasources/lager.yaml
  roles/auditors.yaml
  dashboards/lager.yaml
  alert-rules/lager-hoch.json
```

`org.yaml` nennt die Organisation mit ihrer ID (`name` ist für Menschen, die die Datei lesen) und
den Satz:

```yaml
apiVersion: kalzit/v1
kind: Organization
id: 0199a0b1-...
name: MouseWerk
set: lager
```

Jede andere YAML- oder JSON-Datei unter dem Ordner ist eine Ressource. Ordner und Dateien, deren
Name mit `.` beginnt (wie `.git`), und Dateien anderer Art werden übersprungen. Jede Datei hat
dieselbe Hülle:

```yaml
apiVersion: kalzit/v1      # optional
kind: Dashboard            # DataSource, Role, Dashboard oder AlertRule
uid: lager-board           # bleibt, wenn die Datei verschoben oder umbenannt wird
spec: { ... }
```

Die `uid` (1 bis 100 Buchstaben, Ziffern, `.`, `_` und `-`) benennt die Ressource dauerhaft:
Umbenennen oder Verschieben der Datei ändert sonst nichts. Eine Datei, deren `uid` die ID einer in
der Oberfläche angelegten Ressource ist, **übernimmt** diese: Der Satz übernimmt sie, wie sie ist,
und spätere Anwendungen ändern sie. In den Dateien nennen `datasourceId` und `dashboard`
Datenquellen und Dashboards mit ihrer uid (oder, für Ressourcen, die der Satz nicht verwaltet, mit
ihrer ID).

### DataSource

```yaml
kind: DataSource
uid: lager
spec:
  name: Lager
  type: postgres
  settings:
    host: db.example.com
    database: lager
    user: leser
  secrets:
    password: { env: LAGER_PASSWORD }
  alerting:
    enabled: true
    maxConcurrent: 4
```

`settings` sind die Felder des Formulars in der Oberfläche ([Datenquellen](data-sources.md)).
Dateien enthalten nie Geheimnisse. Ein Geheimnis nennt entweder eine **Umgebungsvariable**
(`{ env: NAME }`) oder eine **Datei** (`{ fromFile: PFAD }`, relativ zum Ordner des Satzes oder
absolut; ein Zeilenumbruch am Ende fällt weg), die die Kommandozeile dort liest, wo sie läuft, und
mit der Anfrage schickt, oder behält, was Kalzits **verschlüsselter Speicher** für diese Quelle
hat (`{ store: true }`, einmal in der Oberfläche gesetzt). Kalzits eigene Variablen (`KALZIT_*`),
Dateien auf anderen Rechnern und Pfade mit einem Teil, der wie Kalzit heißt (Datenordner,
Konfiguration, Schlüssel), werden abgelehnt, bevor etwas gelesen wird. Eine Datei mit Geheimnis
gehört nicht in den Git-Checkout. Ein
Geheimnis, das in der Datei fehlt, wird entfernt. Ändern die Einstellungen, wohin die Quelle sich
verbindet (Host, Port, Benutzer, TLS), wird ein gespeichertes Geheimnis nicht dorthin geschickt:
Nenne eine Variable dafür, so wie die Oberfläche es neu eingeben lässt. `alerting` ist die
Freigabe für Alerting; ohne sie ist die Quelle nicht freigegeben.

### Role

```yaml
kind: Role
uid: auditors
spec:
  name: Prüfer
  description: Liest das Audit-Log
  permissions: [audit:read, dashboards:read]
```

Nur eigene Rollen; wer eine Rolle hat, gehört nicht zu den Dateien.

### Dashboard

```yaml
kind: Dashboard
uid: lager-board
spec:
  folder: Betrieb/Lager
  model:
    schemaVersion: 2
    title: Lager
    timeRange: { from: now-6h, to: now }
    panels:
      - id: p1
        type: table
        title: Werte
        grid: { x: 0, y: 0, w: 12, h: 8 }
        targets:
          - refId: A
            datasourceId: lager
            query: { sql: "SELECT host, v FROM m" }
```

`model` ist das Dashboard-Modell des JSON-Editors ([Dashboards](dashboards.md)); ohne
`timeRange` gilt der Standard der Organisation. `folder` ist ein Pfad aus Ordnernamen (eine Liste,
wenn ein Name `/` enthält); fehlende Ordner werden angelegt, Team-Bereiche werden nicht benutzt.
Verwaltete Dashboards können keine Bibliotheks-Panels oder gespeicherten Auswertungen verknüpfen.

### AlertRule

Die Felder einer Regel in der API ([Alerting](../../api/alerting.md)), mit `contactPoints`
(Namen) statt `contactPointIds` und `dashboard` (eine uid) statt `dashboardId`. Kontaktpunkte und
Benachrichtigungsrichtlinien selbst gehören nicht zu den Dateien, ebenso wenig, ob die Regel
pausiert ist. Die Datenquelle der Regel muss für Alerting freigegeben sein.

YAML-Aliase (`*name`) werden nicht gelesen, damit eine Datei beim Lesen nicht wachsen kann.

## Die Kommandozeile

```text
kalzit provision plan   <Ordner> --server https://kalzit.example.com [--org ID] [--set NAME] [--prune] [--exit-code]
kalzit provision apply  <Ordner> --server https://kalzit.example.com [--org ID] [--set NAME] [--prune]
kalzit provision export <Ordner> --server https://kalzit.example.com --org ID [--set NAME]
kalzit provision import-grafana <Datei> ...   (siehe Grafana-Dashboards importieren)
```

- Das Token kommt aus `KALZIT_API_TOKEN`: ein Token eines Dienstkontos der Organisation
  (**Verwaltung**, **Dienstkonten**), dessen Rolle `provisioning:read` (Plan, Export) und
  `provisioning:write` (Anwenden) hat, dazu die Schreibrechte jeder Art, die der Satz ändert:
  `datasources:write`, `roles:write`, `dashboards:write`, `folders:write`, `alerts:write` und
  `datasources:query` auf den Quellen seiner Dashboards und Regeln. Organisations-Admins und
  Eigentümer haben sie alle. `--server` kann auch aus `KALZIT_API_URL` kommen.
- Die Adresse muss `https://` sein; einfaches `http://` nur zu diesem Rechner, denn Token und
  Geheimnisse reisen mit der Anfrage. Weiterleitungen werden nicht verfolgt: Gib bei `--server`
  die Adresse an, unter der der Server antwortet. Die Organisation (`--org` oder `id` in
  `org.yaml`) ist ihre ID.
- **plan** prüft jede Datei mit denselben Regeln wie die Oberfläche und listet je Ressource, was
  ein Anwenden täte: anlegen, ändern (mit den geänderten Feldern), übernehmen, löschen,
  unverändert oder verwaist, und ob die gespeicherte Ressource vom zuletzt angewendeten Stand
  **abgewichen** ist. Alle Probleme der Dateien kommen auf einmal. Mit `--exit-code` endet es mit
  0, wenn sich nichts ändern würde, mit 2, wenn sich etwas ändern würde, und mit 1 bei einem
  Fehler, für Prüfungen in einer Pipeline.
- Dateipfade folgen überall derselben Regel: relativ, `/` zwischen Ordnern, kein Teil beginnt
  mit `.`, kein `\` oder `:`, YAML oder JSON, und keine zwei Pfade, die sich nur in Groß- und
  Kleinschreibung unterscheiden.
- **apply** wendet alles oder nichts in einer Transaktion an. Hat sich seit dem Plan etwas
  geändert, lehnt es ab; plane und wende erneut an. Ressourcen, deren Dateien fehlen, bleiben
  (verwaltet und schreibgeschützt, als verwaist gemeldet), außer mit `--prune`: Dann kommen
  Dashboards und Datenquellen in den Papierkorb, Rollen und Regeln werden gelöscht. Danach wird
  jede Datenquelle getestet, die das Anwenden angelegt oder geändert hat; eine fehlgeschlagene
  Verbindung ist eine Warnung, kein Grund, das Anwenden zurückzunehmen.
- **export** schreibt die Organisation als Dateien des Satzes: seine eigenen Ressourcen unter
  ihren Dateien und uids, Ressourcen ohne Satz unter ihren IDs (ein Anwenden des Exports übernimmt
  sie) und Geheimnisse als Verweise. Ressourcen anderer Sätze, Ressourcen, die du nicht lesen
  darfst (ein vor dir verborgenes Dashboard, eine Regel, deren Datenquelle du weder lesen noch
  abfragen darfst oder deren Dashboard du nicht lesen darfst), und Dashboards mit
  Bibliotheks-Panels oder gespeicherten Auswertungen werden als ausgelassen gelistet, die nicht
  lesbaren ohne Namen. Jeder Pfad wird vor der ersten Datei geprüft, und nichts wird durch einen
  Link geschrieben. Die Liste der verwalteten Ressourcen lässt dieselben weg.
- Die Ausgabe folgt der Systemsprache (Deutsch oder Englisch); `--output json` gibt die Antwort
  des Servers mit englischen Feldnamen aus.

Jedes Anwenden steht im Audit-Log (**Provisioning-Dateien angewendet**, mit den Zahlen), ebenso
jede Änderung, die es macht, mit Satz, uid und Datei.

## API

| Route | Recht | |
|---|---|---|
| `GET /api/orgs/{orgId}/provisioning/resources` | `provisioning:read` | Die verwalteten Ressourcen aller Sätze mit Abweichung |
| `POST /api/orgs/{orgId}/provisioning/plan` | `provisioning:read` | `{ set?, files: [{ path, content }], prune?, secretValues? }`, antwortet mit dem Plan |
| `POST /api/orgs/{orgId}/provisioning/apply` | `provisioning:write` | Derselbe Body; antwortet mit Plan und Warnungen |
| `GET /api/orgs/{orgId}/provisioning/export?set=` | `provisioning:read` | Die Dateien des Satzes |
| `POST /api/orgs/{orgId}/provisioning/resources/{kind}/{uid}/unlock` | `provisioning:write` | Entsperrt eine Ressource (`dashboard`, `datasource`, `role`, `alert_rule`) |
