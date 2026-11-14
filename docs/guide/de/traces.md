[English](../traces.md) | Deutsch

# Traces

Ein Trace folgt einer Anfrage durch deine Dienste: Jeder Dienst, den sie durchläuft, schreibt einen
**Span** mit Operation, Start, Dauer und Status, und jeder Span nennt den Span, der ihn aufgerufen
hat. Kalzit liest Traces aus [Tempo](data-sources.md#tempo) und [Jaeger](data-sources.md#jaeger)
und behält sie in ihrer eigenen Form, `trace`, neben `frame`, `documents` und `graph`. Ein Trace
wird nie von selbst zur Tabelle oder zum Graphen: Jede Umwandlung ist ein Schritt, den du
hinzufügst, siehst und abschaltest.

Die Trace-Ansichten (ein Wasserfall der Spans und eine Trace-Ansicht in Explore) kommen später.
Bis dahin läuft eine Trace-Quelle in Explore und auf Dashboards über ihre Abfrage (als JSON
geschrieben), und die Schritte unten werden über das Dashboard-Modell oder die API in die Schritte
eines Panels gesetzt; ihre Editoren kommen mit den Trace-Ansichten.

## Suchen

Eine Suche braucht keine Abfragesprache. Gib eines dieser Felder an; ein Span-Set passt, wenn ein
Span alle erfüllt:

| Feld | Beispiel | Was es behält |
|---|---|---|
| `service` | `"shop"` | Spans dieses Dienstes (bei Jaeger Pflicht) |
| `operation` | `"POST /checkout"` | Spans dieser Operation |
| `tags` | `{"http.status_code": "500"}` | Spans mit diesen Attributwerten |
| `minDuration`, `maxDuration` | `"250ms"`, `"2s"` | Spans, die mindestens oder höchstens so lange dauern |
| `status` | `"error"` | Spans mit diesem Status (`ok`, `error`, `unset`; Jaeger kennt kein `unset`) |
| `limit` | `20` | angefragte Traces: standardmäßig 100 bei Tempo, 20 bei Jaeger, höchstens 1.000 |

Die Antwort ist eine **Tabelle** mit einer Zeile je Trace: `traceId`, `rootService`,
`rootOperation`, `start`, `duration` (Millisekunden) und die Zählungen der Quelle (Tempo:
`matchedSpans`; Jaeger: `spans`, `errors`, `services`). Für Tempo schreibt Kalzit das TraceQL der
Suche und zeigt es mit der Antwort (`executedQuery`), etwa
`{ resource.service.name = "shop" && status = error }`; du kannst TraceQL auch selbst schreiben
(`{"traceql": "..."}`). Findet eine Suche so viele Traces, wie sie angefragt hat, sagt sie das
(`trace.search_limit`).

Eine Trace-ID (`{"traceId": "..."}`) liefert den ganzen Trace in der Form `trace`. Die Listen von
Diensten, Operationen und Tag-Werten sind Tabellen und füllen so Dashboard-Variablen.

## Die Form trace

Ein Ergebnis `trace` ist eine Liste von Spans, sortiert nach Trace und dann nach Startzeit, mit den
Feldern von OpenTelemetry:

| Feld | Inhalt |
|---|---|
| `traceId` | die ID des Traces, Hex in Kleinbuchstaben (32 Ziffern; 16 bei 64-Bit-IDs von Jaeger) |
| `spanId` | die ID des Spans, Hex in Kleinbuchstaben (16 Ziffern) |
| `parentSpanId` | der aufrufende Span; fehlt bei einem Wurzel-Span |
| `service` | der Dienst, der den Span geschrieben hat (`service.name`) |
| `operation` | was der Span getan hat (`GET /cart`, `SELECT orders`) |
| `kind` | `server`, `client`, `producer`, `consumer`, `internal` oder `unspecified` |
| `start` | Beginn in Unix-**Mikrosekunden** |
| `duration` | Dauer in Mikrosekunden (Nachkommastellen behalten Nanosekunden) |
| `status` | `unset`, `ok` oder `error`, mit `statusMessage`, wenn der Dienst eine Meldung mitgibt |
| `attributes` | die Attribute des Spans (Jaeger: Tags), mit ihren Typen |
| `events` | Ereignisse während des Spans (Jaeger: Logs): `time`, `name`, `attributes` |
| `links` | Verweise auf andere Spans: `traceId`, `spanId`, `attributes` |
| `resource` | die Attribute des Prozesses, der ihn geschrieben hat (`host.name`, ...) |
| `scope` | die Instrumentierungs-Bibliothek, die ihn geschrieben hat: `name`, `version` |

Mikrosekunden sind in den Zahlen eines Browsers genau, Nanosekunden nicht; darum bleiben Zeiten im
Trace Mikrosekunden, und eine Tabelle der Spans zählt Zeit in Millisekunden wie jede andere
Tabelle.

**Grenzen.** Ein Trace behält höchstens 10.000 Spans. Ein größerer behält immer seine Wurzel und
jeden Span mit Fehler, dann die frühesten übrigen, und sagt, dass er gekürzt wurde
(`trace.span_limit`). Auch die Größengrenze der Antwort kann einen Trace kürzen
(`trace.size_limit`).

## Schritte auf einem Trace

Schritte, die einen Trace lesen, laufen auf dem Server mit der Abfrage. Sie lassen ihn einen Trace
oder machen eine Tabelle oder einen Graphen daraus; die Schritte danach lesen, was sie gemacht
haben.

| Schritt | Ergibt | Was |
|---|---|---|
| **Spans filtern** (`filterSpans`) | Trace | die Spans bestimmter `services`, `operations` oder `kinds`, mit einem `status`, zwischen `minDurationMs` und `maxDurationMs`, oder deren `attribute` eine Bedingung erfüllt (Span-Attribute, sonst Ressourcen-Attribute) |
| **Kritischer Pfad** (`criticalPath`) | Trace | je Trace die Spans, die seine Dauer bestimmen: von der Wurzel aus das Kind, das zuletzt fertig wurde, dann dessen eigener kritischer Pfad und so weiter; Spans neben einem langsameren fallen weg |
| **Span-Tabelle** (`spanTable`) | Tabelle | eine Zeile je Span (unten) |
| **Trace-Tabelle** (`traceTable`) | Tabelle | eine Zeile je Trace: `traceId`, `rootService`, `rootOperation`, `start`, `duration` (ms), `spans`, `errors`, `services` |
| **Service-Karte** (`serviceMap`) | Graph | die Dienste und die Aufrufe zwischen ihnen (unten) |
| **Span-Baum** (`spanTree`) | Graph | jeder Span ein Knoten (`Span`), jeder Eltern-Span eine Kante `CHILD` zu seinem Kind |

### Span-Tabelle

Eine Zeile je Span: `traceId`, `spanId`, `parentSpanId`, `service`, `operation`, `start` (Zeit),
`duration` (Zahl, Millisekunden), `status`, `statusMessage`, `kind` sowie `attributes`,
`resource`, `events` und `links` als JSON. Nenne unter **Attribute** Schlüssel, die eigene Spalten
werden sollen, typisiert nach ihren Werten: `http.status_code` wird eine Zahlenspalte. Zuerst
zählen die Attribute des Spans, dann die der Ressource; ein Schlüssel, der schon eine feste Spalte
ist (`service`), heißt `attributes.service`.

```json
{ "id": "s1", "type": "spanTable", "frame": "A", "attributes": ["http.status_code"] }
```

### Service-Karte

Die Service-Karte wird auf dem Server berechnet:

- jeder Dienst ist ein Knoten mit dem Label `Service` und den Eigenschaften `name`, `spans`
  (seine Spans) und `errors` (Spans mit Status `error`);
- jeder Aufruf eines Dienstes durch einen anderen ist eine Kante `CALLS` vom Aufrufer zum
  aufgerufenen Dienst, mit `calls`, `errors` (fehlgeschlagene Aufrufe) und `durationTotalMs`,
  `durationMeanMs` und `durationMaxMs` der aufgerufenen Spans.

Ein Span zählt als Aufruf, wenn sein Eltern-Span im Ergebnis ist und zu einem anderen Dienst
gehört; Aufrufe innerhalb eines Dienstes sind keine Kanten. Über 100.000 Spans fragt der Schritt
zuerst nach (`steps.service_map_large`) und läuft mit `"confirmLarge": true`.

```json
{ "id": "s2", "type": "serviceMap", "frame": "A" }
```

## Beispiel

Zwei Checkout-Anfragen, die erste über `frontend`, `cart` (mit einem Redis-Aufruf darin) und einen
fehlschlagenden Aufruf von `payment`, die zweite über `frontend` und `payment`:

- die Span-Tabelle hat sieben Zeilen, eine je Span; der fehlgeschlagene Zahlungs-Span hat
  `status` `error` und `statusMessage` `card declined`; die Trace-Tabelle hat zwei Zeilen;
- die Service-Karte hat die Knoten `audit`, `cart`, `frontend` und `payment` und zwei Kanten:
  `frontend → cart` (ein Aufruf) und `frontend → payment` (zwei Aufrufe, ein Fehler, 50 ms
  mittlere Dauer). Der Redis-Aufruf bleibt innerhalb von `cart`, und ein Span ohne vorhandenen
  Eltern-Span ist kein Aufruf;
- der kritische Pfad des ersten Traces ist das Frontend, die Zahlung, der Warenkorb und sein
  Redis-Aufruf: Jeder davon wurde als letzter vor dem nächsten fertig.

## Alerts auf Traces

Eine Alert-Regel reduziert eine Tabelle, Dokumente oder einen Graphen, nie einen rohen Trace: Eine
Regel, deren Abfrage einen Trace liefert, hält mit „Tabellen-Schritt hinzufügen“ an. Füge der
Abfrage der Regel eine Span-Tabelle oder eine Trace-Tabelle hinzu und reduziere diese Tabelle.

## Exporte

Ein Trace wird als **OTLP-JSON** exportiert, das Format, das Werkzeuge von OpenTelemetry wieder
lesen. Für CSV oder Excel füge zuerst eine Span-Tabelle oder eine Trace-Tabelle hinzu.
