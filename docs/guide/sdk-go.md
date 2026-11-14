# Go SDK

`github.com/MouseWerk/Kalzit/sdk/go` (`sdk/go` in the repository) is a client for Kalzit's public
API in Go, without dependencies beyond the standard library. It signs in with a service account
token, reads dashboards, data sources and alert rules, and runs queries whose results keep their
native shape (`QueryResult` with `Frame`, `Documents` or `Graph`).

## Use

Make a service account and a token as for the TypeScript SDK (docs/guide/sdk-typescript.md, "A
token").

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

| Method | Route | Needs |
|---|---|---|
| `Me` | `GET /api/me` | a token |
| `Dashboards`, `Dashboard` | `GET /api/orgs/{orgId}/dashboards[/{id}]` | `dashboards:read` |
| `QueryPanel` | `POST .../dashboards/{id}/panels/{panelId}/query` | read on the dashboard |
| `Datasources`, `Datasource` | `GET /api/orgs/{orgId}/datasources[/{id}]` | read or query on the source |
| `Query`, `QueryOne` | `POST /api/orgs/{orgId}/query` | `datasources:query` |
| `AlertRules`, `AlertRule` | `GET .../alerting/rules[/{id}]` | `alerts:read` |
| `PauseAlertRule` | `POST .../alerting/rules/{id}/pause|resume` | `alerts:write` |
| `Do` | any route under `/api` | as the route says |

Frame values keep their JSON form: numbers as `float64`, `int64` values as decimal strings, times
as Unix milliseconds, missing values as `nil`. Documents stay `json.RawMessage`, so their typed
values (`{"$type": "objectId", "value": ...}`) are not lost. Errors are `*kalzit.Error` with
`Status`, `Code`, `Reason`, `Params`, `Field` and `RetryAfterSecs`; a server that cannot be reached
is `Code == "network"`. `WithHTTPClient` sets timeouts, a proxy or a private CA (the default
client waits 60 seconds).

## Developing

`gofmt -l .`, `go vet ./...` and `go test ./...` in `sdk/go`; CI runs them on Windows and Linux.
The wire types are written by hand after `server/src/shapes.rs`; keep them in step with it.