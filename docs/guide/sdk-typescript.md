# TypeScript SDK

`@kalzit/sdk` (`sdk/typescript` in the repository) is a typed client for Kalzit's public API, for
Node 22 and later and for browsers. It signs in with a service account token, reads dashboards,
data sources and alert rules, and runs queries whose results keep their native shape: a frame, a
set of documents, a graph or a trace (Tempo, Jaeger), never converted on their own. Its types are generated from the
server (`server/src/shapes.rs`), the same ones the UI uses.

## A token

Create a service account in your organization (Administration > Service accounts) with the role
the script needs, usually `viewer` to read dashboards or `editor` to run free queries
(`datasources:query`), and make a token for it (`kz_sa_...`). The token is shown once. Keep it in
your secret store, not in the code; the docs of service accounts are in docs/api/access.md.

## Use

```ts
import { KalzitClient, asFrame, frameRows } from "@kalzit/sdk";

const kalzit = new KalzitClient({
  baseUrl: "https://kalzit.example.com",
  token: process.env.KALZIT_TOKEN!,
  orgId: "0190a1b2-...",
});

for (const d of await kalzit.dashboards.list()) console.log(d.title);

// A free query: needs datasources:query.
const result = await kalzit.queryOne(
  { datasourceId: "0190...", query: "SELECT region, revenue FROM sales" },
  { from: Date.now() - 86_400_000, to: Date.now() },
);
console.log(frameRows(asFrame(result)));

// The stored queries of a panel, as reading the dashboard allows (viewers too).
const answer = await kalzit.dashboards.queryPanel("<dashboardId>", "<panelId>", {
  from: new Date("2026-11-01"),
  to: new Date(),
});

const firing = await kalzit.alerts.rules({ state: "firing" });
```

| Method | Route | Needs |
|---|---|---|
| `me()` | `GET /api/me` | a token |
| `dashboards.list()`, `dashboards.get(id)` | `GET /api/orgs/{orgId}/dashboards[/{id}]` | `dashboards:read` |
| `dashboards.queryPanel(dashboardId, panelId, range)` | `POST .../dashboards/{id}/panels/{panelId}/query` | read on the dashboard |
| `datasources.list()`, `datasources.get(id)` | `GET /api/orgs/{orgId}/datasources[/{id}]` | read or query on the source |
| `query(queries, range, options?)`, `queryOne(query, range)` | `POST /api/orgs/{orgId}/query` | `datasources:query` |
| `alerts.rules(filter?)`, `alerts.rule(id)` | `GET .../alerting/rules[/{id}]` | `alerts:read` |
| `alerts.pause(id)`, `alerts.resume(id)` | `POST .../alerting/rules/{id}/pause|resume` | `alerts:write` |
| `request(method, path, body?)` | any route under `/api` | as the route says |

Lists are read page by page (`pages()` yields every item). A query answer holds one outcome per
`refId`: a result or an error, so one failing query does not fail the others; `resultOf` and
`queryOne` throw the error. `asFrame`, `asDocuments`, `asGraph` and `asTrace` refuse a result of another shape:
turning documents or a graph into a table is an explicit step of the query, never the client's.

## Errors

Every error answer is a `KalzitError` with `status`, the stable `code` (`not_found`, `forbidden`,
`rate_limited`, ...), the finer `reason` and its `params`, `field` for validation errors and
`retryAfterSecs` for `rate_limited`. A server that cannot be reached is `code: "network"` with
status 0. Requests time out after 60 seconds (`timeoutMs`).

## Browsers and CORS

In a browser the page's origin must be allowed in the CORS settings (`cors.enabled`,
`cors.allowed_origins`, docs/api/settings-dashboards.md, "CORS"). The client sends the token, never
the session cookie, so `cors.allow_credentials` can stay off. A token in a browser can be read by
everyone who uses the page: give such a service account `viewer` at most.

## Developing

`npm ci`, `npm run check`, `npm run typecheck`, `npm test` and `npm run build` in `sdk/typescript`;
CI runs them on Windows and Linux. After a change of the server's wire types, run
`KALZIT_UPDATE_GENERATED=1 cargo test -p kalzit --lib shapes` to write `src/generated/shapes.ts`
again (the server's test fails while it is stale).