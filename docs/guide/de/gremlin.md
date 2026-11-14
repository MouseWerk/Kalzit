# Gremlin

Kalzit liest Graphdatenbanken, die das Protokoll von Apache TinkerPop Gremlin Server sprechen (ab
3.7, über WebSocket mit GraphSON 3.0), etwa Gremlin Server mit TinkerGraph oder JanusGraph; die CI
prüft es gegen Gremlin Server. Abfragen sind Gremlin-Traversals. Knoten, Kanten und Pfade daraus
sind ein **Graph**; andere Werte sind **Dokumente**.

## Verbinden

Lege unter **Verwaltung > Datenquellen** eine Datenquelle der Art **Gremlin** an.

| Einstellung | Bedeutung |
|---|---|
| WebSocket-URL | Etwa `ws://graph.intern:8182/gremlin`, oder `wss://...` mit TLS |
| Traversal-Quelle | Der Name, unter dem der Server den Graphen anbietet; leer `g` |
| Benutzername, Passwort | Für Server mit Anmeldung (SASL PLAIN); das Passwort wird verschlüsselt gespeichert |
| CA-Zertifikat | Eine eigene CA in PEM, für `wss://` mit einem Zertifikat deiner CA |
| Knoten- und Kantenlimit | Der größte Graph, den eine Abfrage liefert |

Kalzit verbindet sich mit der Adresse, die die Zielregeln des Servers erlauben, prüft den Namen
einmal und behält ihn für die TLS-Prüfung. **Verbindung testen** führt `g.inject(1)` auf der
Traversal-Quelle aus.

## Nur lesen

Kalzit sendet nie ein Skript. Es liest dein Traversal selbst, prüft es und sendet es als Bytecode,
sodass Gremlin Server kein Groovy ausführt:

1. **Die Prüfung von Kalzit.** Ein Traversal beginnt mit `g.V()`, `g.E()` oder `g.inject()` und
   nutzt nur lesende Schritte, auch in anonymen Traversals. `addV`, `addE`, `property`, `drop`,
   `mergeV`, `mergeE`, `io`, `call`, `sideEffect`, Lambdas (`{ ... }`) und Quellschritte wie
   `withStrategies` werden abgelehnt, bevor etwas gesendet wird.
2. **Die Prüfung des Servers.** Jedes Traversal geht unter der `ReadOnlyStrategy` von TinkerPop an
   den Server, der einen Schritt ablehnt, der den Graphen ändern würde, was auch immer die Prüfung
   von Kalzit übersehen hätte.

Gremlin Server selbst kennt keine Benutzer nur mit Leserechten. Wo deine Datenbank welche hat,
verwende einen.

## Abfragen

```groovy
g.V().hasLabel('person').has('age', gt(30)).order().by('age', desc).limit(10)
```

```groovy
g.V().has('person', 'name', 'marko').outE('knows').inV().path()
```

Eine Dashboard-Variable ist ihr bloßer Name, wo ein Wert steht: `has('land', land)` nimmt die
Variable `land`, als Wert, nie als Text. `__timeFrom` und `__timeTo` sind der Zeitraum in
Unix-Millisekunden, `__interval_ms` das Intervall. Prädikate (`gt(5)`, `P.within('a', 'b')`,
`TextP.containing('ar')`), Tokens (`desc`, `T.id`, `local`, `keys`) und anonyme Traversals
(`__.out()` oder `out()` in einem Schritt) schreibst du wie in der Gremlin-Konsole. Ein
abschließendes `.toList()` fällt weg, `.next()` wird zu `limit(1)`.

Knoten werden Knoten (ihre Id als Text, ihr Label, ihre Eigenschaften), Kanten werden Kanten, und
ein `path()` bleibt ein Pfad. `elementMap()`, `valueMap()`, `project()` und andere Werte liefern
Dokumente; Zählungen und Einzelwerte sind `{"value": ...}`.

## Schema und Explore

Das Schema listet Knoten- und Kanten-Labels und die Eigenschaftsschlüssel einer Stichprobe.
Explore bietet für das gewählte Label Einstiege an: Knoten, Pfade zu Nachbarn und Zählungen je
Label. Mehr Beispiele stehen im Abfragesprachen-Leitfaden ([Gremlin](query-languages.md#gremlin)).

## Wenn etwas nicht klappt

- **ist kein Schritt, den Kalzit ausführt**: der Schritt steht nicht auf der Liste der lesenden
  Schritte (darunter Graph-Algorithmen, die einen Graph-Computer brauchen).
- **Gremlin Server hat das Traversal abgelehnt, weil es Daten ändern würde**: die
  `ReadOnlyStrategy` des Servers hat einen ändernden Schritt gefunden.
- **Die WebSocket-Verbindung ist fehlgeschlagen**: prüfe die URL und ihren Pfad (meist
  `/gremlin`) und bei `wss://` das Zertifikat.
