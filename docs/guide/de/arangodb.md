# ArangoDB

Kalzit liest ArangoDB ab 3.11 über die HTTP-API. Abfragen schreibst du in AQL. Ein Ergebnis mit
Kanten oder Traversal-Pfaden ist ein **Graph**; jedes andere Ergebnis bleibt eine Liste von
**Dokumenten**, so wie ArangoDB sie speichert. Zur Tabelle wird nur, was du mit einem Schritt dazu
machst.

## Verbinden

Lege unter **Verwaltung > Datenquellen** eine Datenquelle der Art **ArangoDB** an.

| Einstellung | Bedeutung |
|---|---|
| URL | Die HTTP-API, etwa `http://arango.intern:8529` oder `https://arango.intern:8529` |
| Datenbank | Die Datenbank, die gelesen wird; leer `_system` |
| Benutzername, Passwort | Die Anmeldung; das Passwort wird verschlüsselt gespeichert |
| CA-Zertifikat | Eine eigene CA in PEM, für HTTPS mit einem Zertifikat deiner CA |
| Benutzer mit Schreibrechten erlauben | Standardmäßig aus; siehe unten |
| Knoten- und Kantenlimit | Der größte Graph, den eine Abfrage liefert |

Die Adresse muss wie bei jeder Datenquelle von den Zielregeln des Servers erlaubt sein.

**Verbindung testen** zeigt Version und Edition von ArangoDB und ob der Benutzer schreiben darf.

## Nur lesen

ArangoDB hat keinen Nur-Lese-Modus für Abfragen, daher hält Kalzit eine Datenquelle auf drei Wegen
lesend:

1. **Der Benutzer.** Lege einen Benutzer nur mit Lesezugriff (`ro`) auf die Datenbank an, ohne
   `rw` auf einer ihrer Collections:

   ```js
   // arangosh, als Administrator
   const users = require("@arangodb/users");
   users.save("kalzit", "ein langes Passwort");
   users.grantDatabase("kalzit", "shop", "ro");
   ```

   Kalzit liest die Zugriffsstufen des Benutzers beim Einrichten der Datenquelle und bei
   **Verbindung testen** und lehnt einen Benutzer ab, der schreiben darf oder dessen Stufen es
   nicht lesen kann. Nur ein Datenquellen-Admin kann **Benutzer mit Schreibrechten erlauben**
   einschalten; dann sagt **Verbindung testen**, dass nur die Prüfungen von Kalzit Abfragen lesend
   halten.
2. **Der Abfragetext.** `INSERT`, `UPDATE`, `REPLACE`, `REMOVE` und `UPSERT` werden abgelehnt,
   ebenso benutzerdefinierte Funktionen (`MYFUNCS::x()`), `CALL` und `APPLY`, bevor etwas gesendet
   wird.
3. **Der Parser von ArangoDB.** Jede Abfrage lässt Kalzit zuerst von ArangoDB parsen, ohne sie
   auszuführen, und lehnt sie ab, wenn ihr Syntaxbaum eine schreibende Operation oder den Aufruf
   einer Benutzerfunktion enthält.

## Abfragen

```aql
FOR p IN persons
  FILTER p.land == @land
  SORT p.name
  LIMIT 100
  RETURN p
```

Dashboard-Variablen sind Bind-Parameter: `@land` nimmt die Variable `land`. `@__timeFrom` und
`@__timeTo` sind der Zeitraum in Unix-Millisekunden, `@__interval_ms` das Intervall. `@@name`
nennt eine Collection; das darf nur eine Konstante oder eigene Variable, deren Wert ein
Collection-Name ist.

```aql
FOR v, e, p IN 1..3 OUTBOUND 'persons/ada' knows
  LIMIT 25
  RETURN p
```

Ein Traversal, das Pfade (oder Kanten) zurückgibt, liefert einen Graphen: die Id eines Knotens ist
die `_id` des Dokuments, sein Label die Collection, seine Eigenschaften das Dokument ohne `_id` und
`_rev`; der Typ einer Kante ist ihre Kanten-Collection. Graph-Schritte, das Graph-Panel und der
Explorer arbeiten damit wie mit jedem Graphen.

Ergebnisse liest Kalzit stapelweise aus einem streamenden Cursor bis zum Zeilenlimit; das
Zeitlimit der Abfrage geht als `maxRuntime` an ArangoDB.

## Schema und Explore

Das Schema listet die Dokument-Collections als Knoten-Labels, die Kanten-Collections als
Kantentypen und die Attributnamen aus einer Stichprobe jeder Collection. Explore bietet für die
gewählte Collection Einstiege an: Dokumente, eine Zählung, Nachbarn entlang der Kanten und Pfade bis
drei Schritte. Mehr Beispiele stehen im Abfragesprachen-Leitfaden
([AQL](query-languages.md#arangodb)).

## Wenn etwas nicht klappt

- **Der ArangoDB-Benutzer darf schreiben**: der Benutzer hat `rw` auf der Datenbank oder einer
  Collection. Vergib stattdessen `ro`, oder lass es von einem Datenquellen-Admin erlauben.
- **Kalzit kann die Zugriffsstufen nicht lesen**: der Benutzer darf seine Stufen nicht lesen, oder
  es ist kein Benutzer gesetzt (ein Server ohne Anmeldung). Verwende einen Benutzer mit Passwort.
- **ArangoDB hat mit einem Fehler geantwortet**: die Meldung stammt von ArangoDB, etwa ein
  Syntaxfehler mit Zeile und Spalte.
