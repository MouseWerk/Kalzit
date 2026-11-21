[English](../sdk-typescript.md) | Deutsch

# TypeScript-SDK

`@kalzit/sdk` (`sdk/typescript` im Repository) ist ein typisierter Client für die öffentliche API
von Kalzit, für Node 22 und neuer und für Browser. Er meldet sich mit dem Token eines Dienstkontos
an, liest Dashboards, Datenquellen und Alert-Regeln und führt Abfragen aus, deren Ergebnisse ihre
eigene Datenform behalten: ein Frame, eine Menge von Dokumenten, ein Graph oder ein Trace (Tempo,
Jaeger), nie von selbst umgewandelt. Seine Typen werden aus dem Server erzeugt
(`server/src/shapes.rs`), dieselben wie in der Oberfläche.

## Ein Token

Lege in deiner Organisation ein Dienstkonto an (Verwaltung > Dienstkonten) mit der Rolle, die das
Skript braucht, meist `viewer`, um Dashboards zu lesen, oder `editor`, um freie Abfragen
auszuführen (`datasources:query`), und erzeuge dafür ein Token (`kz_sa_...`). Das Token wird
einmal angezeigt. Bewahre es in deinem Geheimnisspeicher auf, nicht im Code; die Doku der
Dienstkonten steht in docs/api/access.md.

## Verwendung

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

| Methode | Route | Braucht |
|---|---|---|
| `me()` | `GET /api/me` | ein Token |
| `dashboards.list()`, `dashboards.get(id)` | `GET /api/orgs/{orgId}/dashboards[/{id}]` | `dashboards:read` |
| `dashboards.queryPanel(dashboardId, panelId, range)` | `POST .../dashboards/{id}/panels/{panelId}/query` | Lesen am Dashboard |
| `datasources.list()`, `datasources.get(id)` | `GET /api/orgs/{orgId}/datasources[/{id}]` | Lesen oder Abfragen an der Quelle |
| `query(queries, range, options?)`, `queryOne(query, range)` | `POST /api/orgs/{orgId}/query` | `datasources:query` |
| `alerts.rules(filter?)`, `alerts.rule(id)` | `GET .../alerting/rules[/{id}]` | `alerts:read` |
| `alerts.pause(id)`, `alerts.resume(id)` | `POST .../alerting/rules/{id}/pause|resume` | `alerts:write` |
| `request(method, path, body?)` | jede Route unter `/api` | wie die Route es sagt |

Listen werden Seite für Seite gelesen (`pages()` liefert jedes Element). Eine Antwort auf Abfragen
enthält je `refId` ein Ergebnis: ein Resultat oder einen Fehler, sodass eine fehlschlagende
Abfrage die anderen nicht scheitern lässt; `resultOf` und `queryOne` werfen den Fehler. `asFrame`,
`asDocuments`, `asGraph` und `asTrace` lehnen ein Ergebnis anderer Datenform ab: Dokumente oder
einen Graphen in eine Tabelle zu verwandeln ist ein ausdrücklicher Schritt der Abfrage, nie des
Clients.

## Fehler

Jede Fehlerantwort ist ein `KalzitError` mit `status`, dem stabilen `code` (`not_found`,
`forbidden`, `rate_limited`, ...), dem genaueren `reason` und seinen `params`, `field` bei
Prüffehlern und `retryAfterSecs` bei `rate_limited`. Ein Server, der nicht erreichbar ist, ist
`code: "network"` mit Status 0. Anfragen laufen nach 60 Sekunden ab (`timeoutMs`).

## Browser und CORS

In einem Browser muss der Origin der Seite in den CORS-Einstellungen erlaubt sein (`cors.enabled`,
`cors.allowed_origins`, docs/api/settings-dashboards.md, „CORS“). Der Client sendet das Token,
nie das Sitzungs-Cookie, daher kann `cors.allow_credentials` aus bleiben. Ein Token im Browser kann
jeder lesen, der die Seite nutzt: Gib einem solchen Dienstkonto höchstens `viewer`.

## Entwickeln

`npm ci`, `npm run check`, `npm run typecheck`, `npm test` und `npm run build` in
`sdk/typescript`; CI führt sie unter Windows und Linux aus. Nach einer Änderung der Wire-Typen des
Servers führe `KALZIT_UPDATE_GENERATED=1 cargo test -p kalzit --lib shapes` aus, um
`src/generated/shapes.ts` neu zu schreiben (der Test des Servers schlägt fehl, solange die Datei
veraltet ist).
