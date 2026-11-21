[English](../sdk-go.md) | Deutsch

# Go-SDK

`github.com/MouseWerk/Kalzit/sdk/go` (`sdk/go` im Repository) ist ein Client für die öffentliche
API von Kalzit in Go, ohne Abhängigkeiten außer der Standardbibliothek. Er meldet sich mit dem
Token eines Dienstkontos an, liest Dashboards, Datenquellen und Alert-Regeln und führt Abfragen
aus, deren Ergebnisse ihre eigene Datenform behalten (`QueryResult` mit `Frame`, `Documents`,
`Graph` oder `Trace`; `AsFrame`, `AsDocuments`, `AsGraph` und `AsTrace` lehnen ein Ergebnis
anderer Datenform ab).

## Verwendung

Lege ein Dienstkonto und ein Token an wie beim TypeScript-SDK
([TypeScript-SDK](sdk-typescript.md), „Ein Token“).

```go
import kalzit "github.com/MouseWerk/Kalzit/sdk/go"

client, err := kalzit.New("https://kalzit.example.com", os.Getenv("KALZIT_TOKEN"), orgID)
if err != nil {
	log.Fatal(err)
}
ctx := context.Background()
dashboards, err := client.Dashboards(ctx)

now := time.Now().UnixMilli()
result, err := client.QueryOne(ctx, kalzit.QueryItem{
	DatasourceID: sourceID,
	Query:        "SELECT region, revenue FROM sales",
}, kalzit.TimeRange{From: now - 86_400_000, To: now})
if err != nil {
	var kerr *kalzit.Error
	if errors.As(err, &kerr) && kerr.Code == "rate_limited" {
		time.Sleep(time.Duration(kerr.RetryAfterSecs) * time.Second)
	}
	log.Fatal(err)
}
frame, err := result.AsFrame()
for _, row := range frame.Rows() {
	fmt.Println(row["region"], row["revenue"])
}
```

| Methode | Route | Braucht |
|---|---|---|
| `Me` | `GET /api/me` | ein Token |
| `Dashboards`, `Dashboard` | `GET /api/orgs/{orgId}/dashboards[/{id}]` | `dashboards:read` |
| `QueryPanel` | `POST .../dashboards/{id}/panels/{panelId}/query` | Lesen am Dashboard |
| `Datasources`, `Datasource` | `GET /api/orgs/{orgId}/datasources[/{id}]` | Lesen oder Abfragen an der Quelle |
| `Query`, `QueryOne` | `POST /api/orgs/{orgId}/query` | `datasources:query` |
| `AlertRules`, `AlertRule` | `GET .../alerting/rules[/{id}]` | `alerts:read` |
| `PauseAlertRule` | `POST .../alerting/rules/{id}/pause|resume` | `alerts:write` |
| `Do` | jede Route unter `/api` | wie die Route es sagt |

Werte in Frames behalten ihre JSON-Form: Zahlen als `float64`, `int64`-Werte als Dezimalstrings,
Zeiten als Unix-Millisekunden, fehlende Werte als `nil`. Dokumente bleiben `json.RawMessage`,
damit ihre typisierten Werte (`{"$type": "objectId", "value": ...}`) nicht verloren gehen. Fehler
sind `*kalzit.Error` mit `Status`, `Code`, `Reason`, `Params`, `Field` und `RetryAfterSecs`; ein
Server, der nicht erreichbar ist, ist `Code == "network"`. `WithHTTPClient` setzt Timeouts, einen
Proxy oder eine private Zertifizierungsstelle (der Standard-Client wartet 60 Sekunden).

## Entwickeln

`gofmt -l .`, `go vet ./...` und `go test ./...` in `sdk/go`; CI führt sie unter Windows und Linux
aus. Die Wire-Typen sind von Hand nach `server/src/shapes.rs` geschrieben; halte sie im Gleichschritt.
