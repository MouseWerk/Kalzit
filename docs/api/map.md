# API: map images

The map panel and the source of its map images (board `docs/design/blueprint/Graph081.dc.html`,
frames 15 to 17; user guide: [Map](../guide/panels.md#map)). Routes follow the API conventions
(JSON in camelCase, times in Unix milliseconds, errors as `{ error: { code, message, field?,
reason?, params? } }`).

## Rules

- **Off by default.** After installation there is no source: maps draw coordinates over the
  outlines Kalzit ships with (Natural Earth, public domain, simplified: countries, large lakes and
  first-level regions, about 0.5 MB in the binary) and a graticule. No request leaves the server,
  neither from the browser nor from Kalzit.
- **One source per server**, set by a server administrator under Verwaltung > Karte
  (Administration > Map). It is a server setting for all organizations; organizations cannot
  override it.
- **Browsers only talk to Kalzit.** With a source, the browser asks Kalzit for each map image
  (`/api/map/tiles/{z}/{x}/{y}`); the server fetches it from the source, keeps it in its cache
  and hands it on. The content security policy stays `img-src 'self' data: blob:`; no viewer
  ever fetches a foreign server, and the access key never reaches a browser.
- **Fetching** goes through the outbound proxy (`network.proxy_url`) when one is set, with a
  timeout of 10 seconds, without following redirects, and takes only a PNG, JPEG or WebP image
  (recognized by its first bytes) of at most 2 MiB. At most 8 fetches run at once for the whole
  server. An image the source does not have (`404`, `410`) is answered `404` and drawn as an
  empty place; it is no failure. Failures of the source as a whole (it cannot be reached, does
  not answer in time, refuses the key, or answers `5xx`) count per person or public link: after
  5 in a row the source is left alone for that requester for 30 seconds, so one person cannot
  pause it for everyone. For 30 seconds after such a failure, until an image loads again,
  `MapInfo.available` is `false` and maps draw the outlines at once instead of waiting for
  every image.
- **Offline**: Kalzit works fully without network access. Map images are optional and off by
  default; without them, or while they fail, maps draw the bundled outlines.
- **Target rules**: the address is checked like a data source target
  (`datasources.allowed_targets`; metadata addresses and Kalzit's own data are always refused),
  when it is saved and again on every connection. An address that is Kalzit itself (its public
  address, or one of its own ports on this machine) is refused. Only `https`, except `http` to
  this machine (a map server next to Kalzit). No user, password or fragment in the address: an
  access key goes into `{key}` and is stored encrypted in the secret store (`server_secrets`,
  re-encrypted by `kalzit secrets rotate`).
- **Placeholders in the path or query only**: with any numbers and any key the address keeps
  its scheme, user, host and port, so neither can be steered through `{z}`, `{x}`, `{y}` or
  `{key}`.
- **Checked images only**: `z`, `x` and `y` are plain decimal numbers, `z` at most the source's
  `maxZoom` (and never above 22), `x` and `y` below `2^z`. Anything else is `404 not_found`
  without asking the source.
- **Rate limit**: one person, or all visitors of one public link together, may make Kalzit fetch
  600 images a minute from the source; images from the cache do not count. Beyond that `429
  rate_limited` with `Retry-After`.
- **Cache**: files in `<data dir>/map-tiles/<source>/<z>/<x>/<y>.<ext>`, one folder per source
  address (a hash, never the key). Bounded in size (`cacheMaxMb`, the oldest images go first)
  and age (`cacheTtlDays`). Each server of a cluster keeps its own. Switching the map images off
  empties it. A request still holding a source that was replaced meanwhile neither reads nor
  writes nor deletes anything in the new source's folder.
- **Audit**: `map.tiles_changed` for every save and every switch, with the source's host,
  `enabled`, and for a save the zoom and cache limits and whether a key is set or changed;
  never the address's path or query, never the key.

## Source

```json
{ "enabled": true, "urlTemplate": "https://karten.example.org/tiles/{z}/{x}/{y}.png",
  "attribution": "© Beispiel-Kartendienst und Mitwirkende", "maxZoom": 14,
  "cacheMaxMb": 2048, "cacheTtlDays": 7 }
```

| Field | Default | Meaning |
|---|---|---|
| `urlTemplate` | | Up to 2000 characters, with `{z}`, `{x}` and `{y}`; `{key}` is the only other placeholder. |
| `attribution` | | Required, up to 200 characters. Shown on every map with map images and in every export. |
| `maxZoom` | `14` | 0 to 22. |
| `cacheMaxMb` | `2048` | 16 to 102400. |
| `cacheTtlDays` | `7` | 1 to 365. |

The fields depend on each other, so they are saved in one explicit step, and only after the
server loaded one image with exactly these values (the image `6/33/21`, or the highest zoom
below 6, over central Europe). Switching off applies at once and keeps the fields; switching on
again is its undo and needs no new test, but the target rules are checked again. The source is
stored as the versioned server setting `map.tiles`; it is not one of the settings the general
settings routes change.

## Routes

| Method and path | Who | What |
|---|---|---|
| `GET /api/admin/map` | server admin | `MapAdminView` |
| `POST /api/admin/map/test` | server admin | `{source, key?}`: loads one image with these values; `TestResult` |
| `PUT /api/admin/map` | server admin | `{source, key?, version}`: tests, then saves and switches on; `MapAdminView`, `409 version_conflict` with `current` |
| `PUT /api/admin/map/enabled` | server admin | `{enabled, version}`: off at once, or on again; `MapAdminView`, `409 version_conflict` with `current` |
| `GET /api/map` | signed in | `MapInfo` |
| `GET /api/map/tiles/{z}/{x}/{y}` | signed in | the image, `Cache-Control: private, max-age=3600` |
| `GET /api/public/dashboards/{token}/map` | public link | `MapInfo`, when the link shows a map panel |
| `GET /api/public/dashboards/{token}/map/tiles/{z}/{x}/{y}` | public link | the image, when the link shows a map panel; `Cache-Control: no-store` |

`source` in a test or save is the source without `enabled`. `key`: left out keeps the stored key,
but only while the address keeps its scheme, host and port (a changed address cannot carry the
stored key elsewhere); `""` removes it. Tests and saves count like data source connection tests
per administrator.

`MapAdminView`: `{source (as above, or null before the first save), hasKey, version, proxy
("host:port" of the outbound proxy, or null), cache: {bytes, tiles}, lastError}`.
`lastError` is `{reason, params, message, at}` of the last failed fetch until one succeeds, or
null; it never contains the key.

`TestResult`: `{z, x, y, bytes, contentType, elapsedMs, viaProxy}`.

`MapInfo`: `{tiles: false}` while the map images are off, else `{tiles: true, attribution,
maxZoom, available}`. `available` is `false` while the source failed lately or the requester's
fetches are paused (see Rules); it carries nothing else about the failure.

Public links: a link reaches the map images only when one of its panels is a map panel, and
answers every other case (no map panel, a link that does not work, a path that names no image)
like every link that does not work: `404 not_found` with `sharing.unavailable`. Public snapshots
have no map images; their maps draw the outlines. Of a graph on a map panel a visitor gets only
each node's caption and the properties that hold its place.

## Map panel options

The panel type `map` reads all three shapes as they are: `frame` rows with latitude and
longitude, `documents` with a GeoJSON point or two number fields, and `graph` nodes with a typed
`point` or two number properties, with edges as lines. Options (`ui/src/panels/map/options.ts`,
checked by the server like other panel options):

| Option | Default | Meaning |
|---|---|---|
| `coords` | `auto` | `auto`, `point` or `latLon`. |
| `pointField` | `""` | The property or field holding a point; empty finds one. |
| `latField`, `lonField` | `""` | The two numbers; empty finds names such as `lat` and `lon`. |
| `sizeField` | `""` | A number column that sizes row points. |
| `caption` | `""` | The property or field named on a point. |
| `outlines` | `regions` | `regions`, `countries` or `none`, while there are no map images. |
| `fit` | `data` | `data` or `world`. |
| `edges` | `straight` | `straight` or `none`. |
| `clusterDistance` | `12` | Pixels, 0 to 80; 0 never bundles. |

Field names are at most 100 characters.

## Reasons

| Reason | Code | When |
|---|---|---|
| `map.url_invalid` | `422 validation` on `urlTemplate` | empty, longer than `params.maxChars`, control characters, or not a URL with a host |
| `map.url_placeholders` | `422 validation` on `urlTemplate` | `{z}`, `{x}` or `{y}` missing, another placeholder, a brace that does not close, or a placeholder in the scheme, user, host or port |
| `map.url_not_https` | `422 validation` on `urlTemplate` | not `https` (plain `http` only to this machine) |
| `map.url_credentials` | `422 validation` on `urlTemplate` | a user, password or fragment in the address |
| `map.url_kalzit` | `422 validation` on `urlTemplate` | the address points at this Kalzit server |
| `map.attribution_required` | `422 validation` on `attribution` | empty |
| `map.attribution_invalid` | `422 validation` on `attribution` | longer than `params.maxChars` or control characters |
| `map.max_zoom_invalid` | `422 validation` on `maxZoom` | above `params.max` |
| `map.cache_size_invalid` | `422 validation` on `cacheMaxMb` | outside `params.min` to `params.max` |
| `map.cache_ttl_invalid` | `422 validation` on `cacheTtlDays` | outside `params.min` to `params.max` |
| `map.key_invalid` | `422 validation` on `key` | longer than `params.maxChars` or control characters |
| `map.key_required` | `422 validation` on `key` | the address has `{key}` and no key was sent or stored for this host |
| `map.key_unused` | `422 validation` on `key` | a key was sent for an address without `{key}` |
| `map.source_failed` | `422 validation` | the source could not be reached; `message` says why |
| `map.source_timeout` | `422 validation` | the source did not answer in 10 seconds |
| `map.source_denied` | `422 validation` | the source answered `401` or `403`; `params.status` |
| `map.source_status` | `422 validation` | the source answered another status than `200`; `params.status` |
| `map.not_an_image` | `422 validation` | the answer is not a PNG, JPEG or WebP image |
| `map.tile_too_large` | `422 validation` | the answer is larger than `params.maxBytes` |
| `map.tiles_unavailable` | `503 busy` | an image could not be fetched for a map; the map shows outlines |
| `map.not_configured` | `409 conflict` | switching on while no source was ever saved |

A test or save refused by the target rules answers the shared `target.*` reasons
(docs/api/datasources.md) on `urlTemplate`. The reasons of a failed fetch also appear in
`lastError` of `MapAdminView`.
