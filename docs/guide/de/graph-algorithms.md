# Graph-Algorithmen und Pfade

Liefert eine Abfrage einen Graphen (Neo4j, Memgraph, TigerGraph und die anderen Graph-Quellen),
können Schritte darauf rechnen: wer zentral ist, welche Gruppen es gibt, wie zwei Knoten
zusammenhängen, welche Knoten sich ähneln, wo der Graph an einer einzelnen Kante hängt und welche
Kanten vermutlich fehlen. Jeder Schritt steht sichtbar in der Schrittliste, hat seine Parameter,
sagt, wo er gerechnet hat, und fasst sein Ergebnis in einem Satz zusammen. In die Datenquelle wird
nie etwas geschrieben.

## Einen Schritt hinzufügen

**Schritt hinzufügen** in Explore oder im Panel-Editor öffnet den Schritt-Katalog. Für einen
Graphen listet er die Schritte in sieben Gruppen; jede Zeile sagt, welche Frage der Schritt
beantwortet:

| Gruppe | Schritte |
| --- | --- |
| Zentralität | Grad, PageRank, Betweenness, Closeness, Eigenvektor, Harmonic |
| Communities | Louvain, Leiden, Label Propagation, Verbundene Komponenten, Stark verbundene Komponenten, k-Core, Dreiecke und Clustering |
| Ähnlichkeit | Jaccard, Overlap, Kosinus über Properties, k nächste Nachbarn |
| Pfade | Kürzester Pfad, Alle kürzesten Pfade, Gewichteter Pfad, k kürzeste Pfade, Erreichbar in n Schritten |
| Strukturen | Brücken, Gelenkpunkte, Zyklen |
| Kanten-Vorhersage | Gemeinsame Nachbarn, Adamic-Adar, Preferential Attachment |
| Umformen | Knoten zusammenfassen, Entlang aggregieren |

Die bisherigen Schritte (Anzahl je Label, Teilgraph filtern, In Tabelle umwandeln und weitere)
folgen unter „Zählen, filtern, als Tabelle“. Die Suche findet Schritte auch über ihre Frage:
„wichtig“ findet die Zentralitäten, „Kreis“ die Zyklen, „Gruppe“ die Communities.

Neben jedem Namen sagt der Katalog, wo der Schritt mit der gewählten Datenquelle rechnet: in der
Datenbank (Neo4j mit Graph Data Science, Memgraph mit MAGE) oder im Kalzit-Server. Die
Standardwerte passen, ein Schritt rechnet also gleich nach dem Hinzufügen; nur ein Pfad braucht
seine beiden Enden, die zuerst die ersten zwei Knoten des Ergebnisses sind.

## Was ein Schritt zeigt

- **Wo er gerechnet hat.** „Läuft in Neo4j (GDS)“, „Läuft in Memgraph (MAGE)“ oder „Im Server“.
  Hat ein Schritt im Server gerechnet, obwohl die Datenbank eine Bibliothek hat, sagt eine Zeile
  warum, etwa „die Bibliothek der Datenbank hat nicht geantwortet; das Ergebnis ist dasselbe“.
  Unter **Ort** lässt sich ein Schritt auf „Immer im Server“ stellen, um Läufe zu vergleichen.
- **Ein Satz.** „15 Knoten bewertet. Höchster Wert: Anna Weber (0,108).“ oder „3 Communities,
  Modularität 0,3.“ Screenreader hören ihn einmal, wenn der Schritt gerechnet hat.
- **Grenzen in einfacher Sprache.** Ein Schritt, der zu groß ist, zu lange rechnet oder zu viel
  Speicher braucht, sagt es mit der Grenze und bietet **Filter davor einfügen** an. Listen von
  Pfaden und Zyklen hören bei ihrer Höchstzahl auf und sagen „200 von mindestens 200 Zyklen“,
  statt eine Gesamtzahl zu behaupten. Eine Antwort der Datenbank, die Kalzit nicht lesen kann,
  bietet **Im Server rechnen** an.
- **Ergebnisse können abweichen.** PageRank, Eigenvektor, Louvain, Leiden, Label Propagation und
  nächste Nachbarn rechnen schrittweise; laufen sie in der Datenbank, sagt der Schritt, dass Werte
  zwischen Läufen leicht abweichen können.

Die Schritte rechnen genau auf dem Ergebnis der Abfrage, nie auf der ganzen Datenbank. Ihre
Grenzen sind Server-Einstellungen unter Einstellungen › Datenquellen (Zeit, Knoten, Speicher,
Schritte gleichzeitig, Pfade und Zyklen, Top-k, Vorschläge); Organisationen können sie nur senken.

## Ergebnisse auf der Zeichenfläche

Was ein Schritt findet, wird eine Property der Knoten (`pagerank`, `community`, `core`,
`distance`, ...) oder Kanten (`bridge`); Stilregeln, Variablen, Filter-Schritte, Tabellen und
Alert-Regeln lesen sie wie jede andere Property. Im Panel-Editor bietet die Karte eines Schritts:

- **Als Größe zeigen**: legt die Stilregel „Größe nach Wert“ an, von 5 bis 17 px über die Werte im
  Ergebnis. Die Fläche eines Knotens wächst mit seinem Wert. Die Regel steht unter Stil und lässt
  sich dort ändern oder entfernen; ist der Schritt ausgeschaltet, ruht sie.
- **Als Farbe zeigen**: färbt die Knoten nach dem Wert mit dem Farbverlauf des Panels (Optionen ›
  Farbe nach Property).
- **Farbe je Community**: legt eine Regel mit einer Farbe je Community an; die acht größten
  bekommen die Datenpalette.

Vorgeschlagene Kanten der Kanten-Vorhersage sind gepunktet und tragen eine offene Raute. Sie sind
nicht in der Datenbank, zählen nicht mit („Dazu 5 vorgeschlagene Kanten; sie zählen nicht mit“),
gehen in keinen späteren Schritt ein und fehlen im Export. **Vorschläge ausblenden** (oder die
Taste U) blendet sie aus.

## Schnellaktionen auf der Zeichenfläche

Drei Fragen gehen ohne Schrittliste. Sie rechnen im Kalzit-Server auf dem, was die Zeichenfläche
geladen hat, fragen die Datenquelle nichts und werden nicht gespeichert; darum stehen sie auch
Betrachtern offen. Auf Freigabe-Links und Snapshots sind sie aus.

- **Pfad finden** bei zwei gewählten Knoten: kürzester Pfad, alle kürzesten Pfade oder gewichteter
  Pfad (über eine Zahl an den Kanten; ohne sie bleibt der Eintrag sichtbar, mit dem Grund). Die
  Suche beachtet die Richtung der Kanten nicht, außer „Richtung der Kanten beachten“ ist
  angehakt. Der Pfad steht kräftig in Textfarbe, die anderen gefundenen Pfade leichter, der Rest
  gedimmt. J und Umschalt+J gehen durch die Pfade.
- **Wie hängen diese zusammen?** bei drei bis zehn gewählten Knoten: je ein kürzester Pfad
  zwischen je zweien, und beim Namen die Knoten, die mit den anderen nicht verbunden sind.
- **Wichtigste Knoten**: die ersten fünf Ränge nach PageRank, Grad oder Betweenness; bei
  Gleichstand teilen sich Knoten einen Rang, die Liste wird dann länger.

W startet den Pfad oder den Zusammenhang für die Auswahl, G die wichtigsten Knoten, Escape
schließt die Antwort. Im Panel-Editor macht **Als Schritt übernehmen** aus der Antwort einen
Schritt des Panels.

Siehe auch [Explore](explore.md#graph-schritte), [Berechnete Felder und Statistik](calculated-fields.md)
und die [API der Graph-Algorithmen](../../api/settings-dashboards.md#graph-algorithm-steps).
