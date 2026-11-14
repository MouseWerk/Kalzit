# Couchbase

Kalzit liest Couchbase Server 7.x über den Query-Dienst. Abfragen sind `SELECT`-Anweisungen in
SQL++ (N1QL), und jede Ergebniszeile bleibt ein **Dokument**, so wie Couchbase es liefert.

## Verbinden

Lege unter **Verwaltung > Datenquellen** eine Datenquelle der Art **Couchbase** an.

| Einstellung | Bedeutung |
|---|---|
| URL des Query-Dienstes | Etwa `http://couchbase.intern:8093`, oder `https://...:18093` mit TLS |
| Benutzername, Passwort | Die Anmeldung; das Passwort wird verschlüsselt gespeichert |
| CA-Zertifikat | Eine eigene CA in PEM, für HTTPS mit einem Zertifikat deiner CA |
| Benutzer mit Schreibrechten erlauben | Standardmäßig aus; siehe unten |
| Bucket (für das Schema) | Das Schema listet nur die Collections dieses Buckets |

**Verbindung testen** zeigt Version und Edition von Couchbase und ob der Benutzer schreiben darf.

## Nur lesen

1. **Die Anweisung.** Kalzit führt genau ein `SELECT` aus (auch nach `WITH`, in Klammern oder nach
   `EXPLAIN`). Anweisungen, die schreiben oder Indizes, Benutzer oder Transaktionen ändern, werden
   abgelehnt, bevor etwas gesendet wird.
2. **Die Anfrage.** Jede Anweisung geht mit `readonly: true` an den Query-Dienst, der selbst jedes
   Schreiben ablehnt.
3. **Der Benutzer.** Lege einen Benutzer nur mit den Rollen `query_select` und `data_reader` auf
   den Buckets an, die du zeigen willst:

   ```sh
   couchbase-cli user-manage -c couchbase.intern -u Administrator -p '...' \
     --set --rbac-username kalzit --rbac-password 'ein langes Passwort' \
     --roles 'query_select[travel-sample],data_reader[travel-sample]' --auth-domain local
   ```

   Kalzit liest die Rollen des Benutzers (`system:my_user_info`) beim Einrichten der Datenquelle
   und bei **Verbindung testen** und lehnt einen Benutzer mit einer Rolle über das Lesen hinaus ab,
   oder einen, dessen Rollen es nicht lesen kann. Wo die Edition diese Rollen nicht hat, kann ein
   Datenquellen-Admin **Benutzer mit Schreibrechten erlauben** einschalten; dann halten die Prüfung
   der Anweisung und die lesende Anfrage Abfragen lesend.

## Abfragen

```sql
SELECT a.name, a.country
FROM `travel-sample`.inventory.airline AS a
WHERE a.country = $land
ORDER BY a.name
LIMIT 100
```

Dashboard-Variablen sind benannte Parameter: `$land` nimmt die Variable `land`. `$__timeFrom` und
`$__timeTo` sind der Zeitraum in Unix-Millisekunden (`STR_TO_MILLIS()` liest einen Datumstext),
`$__interval_ms` das Intervall. Positionsparameter (`$1`, `?`) werden abgelehnt. Eine Abfrage
braucht einen Index auf ihrer Collection, mindestens einen primären (`CREATE PRIMARY INDEX`, durch
einen Administrator).

Jede Zeile ist ein Dokument; Werte von `SELECT RAW`, die keine Objekte sind, werden zu
`{"value": ...}`. Das Zeitlimit der Abfrage geht als `timeout` der Anfrage mit.

## Schema und Explore

Das Schema listet jede `bucket.scope.collection` mit ihren Indizes und die Felder einer Stichprobe
aus den ersten 50 lesbaren Collections. Explore bietet für die gewählte Collection Einstiege an:
Dokumente, eine Zählung, eine Zählung je Wert und die Dokumentschlüssel. Mehr Beispiele stehen im
Abfragesprachen-Leitfaden ([SQL++](query-languages.md#couchbase)).

## Wenn etwas nicht klappt

- **Der Couchbase-Benutzer hat Rollen über das Lesen hinaus**: gib dem Benutzer nur
  `query_select` und `data_reader`, oder lass es von einem Datenquellen-Admin erlauben.
- **hat keinen Index, den diese Abfrage nutzen kann**: die Collection hat keinen Index; ein
  Administrator kann einen primären Index anlegen.
- **Couchbase hat die Anweisung in einer lesenden Anfrage abgelehnt**: die Anweisung hätte
  geschrieben.
