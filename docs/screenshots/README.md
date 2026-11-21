# Screenshots and gallery renders

Kalzit has two sets of pictures and one product video, all taken by Playwright against the real
binary:

| Set | Script | Where the images go |
|---|---|---|
| Guide screenshots | `ui/e2e/screenshots/readme.shots.ts` (`npm run screenshots`) | committed here, in `docs/screenshots/` |
| Gallery renders for the README and the website | `ui/e2e/gallery/gallery.shots.ts` (`npm run gallery`) | the artifact `kalzit-gallery` of the gallery workflow; the WebP files are committed in `docs/screenshots/gallery/` |
| Product video "Kalzit in 60 seconds" | `ui/e2e/video/product.video.ts` (`npm run video`) | the artifact `video` of the gallery workflow; not committed |

All pictures are taken at desktop size; there are no phone captures.

## Guide screenshots

The user guide (`docs/guide/`) and the docs pages of the website show these. A pull request that
visibly changes the UI reruns `npm run screenshots` in `ui/` and commits the changed images in this
folder (see CONTRIBUTING.md, "Screenshots").

The sign-in pictures (`sign-in-providers`, `sign-in-ldap`, `sign-in-saml`, `recent-sign-ins-*`;
`ui/e2e/screenshots/sign-in.shots.ts`) answer the providers and the recent sign-ins from fixtures
in that file, since the e2e services have no identity provider or directory; `service-accounts`
and `scim` are taken against the real server.

The graph pictures (`graph-*`) need the Neo4j of the e2e specs and the field distribution
(`explore-distribution-dark`) its MongoDB; without them those tests are skipped and the images
here stay. The plugin pictures (`plugins`, `plugin-details`, `plugins-trust`,
`data-source-plugin`) need the test plugin (`KALZIT_E2E_PLUGIN_BINARY`, built by
`cargo build -p kalzit-test-plugin`). To take every picture, run the `readme` set of the same workflow as the gallery, which
starts and seeds the e2e services, and commit the images you changed from its artifact:

```sh
gh workflow run gallery.yml --ref <branch> -f set=readme
gh run download <run-id> --name kalzit-screenshots --dir docs/screenshots
```

## Gallery renders

Curated scenes on a fictional data center, "Site Basalt" (three halls, racks, switches, power and
cooling). Every name, vendor and figure is invented and computed, so a rerun gives near-identical
images. Each scene is 1600 x 1000 at twice the device scale (3200 x 2000 pixels), as PNG and as
WebP (quality 90), mostly in dark and light:

| File | Scene |
|---|---|
| `setup-*` | the first-run setup page |
| `sign-in-*` | the sign-in page |
| `dashboard-overview-*` | site overview: stats, time series, bar chart, bar gauge, table, a hall variable |
| `graph-network-*` | the network and power topology in one network panel, colored by label |
| `graph-inspector-*` | the same with a server selected and the node inspector open |
| `graph-hierarchy-paths-*` | site > hall > row > rack > server as a hierarchy, and two path panels (uplinks to a core switch, the A and B power feeds of a server) |
| `graph-explorer-*` | explorer mode mid-expansion: a spine switch, then one of its leaves expanded |
| `documents-pipeline-*` | Explore on MongoDB: a saved pipeline, the preview after stage 1, the document tree |
| `documents-dashboard-*` | incidents as documents, the schema of the asset records, two field distributions |
| `explore-steps-*` | Explore with a saved analysis and its steps (moving average, trend) |
| `explore-start-*` | Explore on the metrics source with an empty editor: "Start here" with `rack_metrics` picked, one starter's query shown, the schema list |
| `explore-cheat-sheet-*` | the same after a starter ran: the rows, the tip after the first result, the SQL cheat sheet |
| `dashboard-all-sources-*` | one dashboard on SQLite, OpenSearch, MongoDB and Neo4j |
| `dashboard-live-*` | a live dashboard of rack temperatures |
| `explore-explain-*` | Explore with a saved query on PUE per hall and its explanation |
| `explore-summarize-*` | the same with the result summarized |
| `ask-answer-*` | Ask: a question, the assistant's steps with the query and its result, the answer, the model pane |
| `ai-settings-*` | Settings > AI: switch, status and two providers |
| `ai-functions-*` | Settings > AI: the provider per function and the limits |
| `plugins-installed-*` | Settings > Plugins: a data source plugin and a panel plugin, signed |
| `plugin-page-*` | the page of the data source plugin with its permissions and sandbox layers |
| `plugin-install-*` | "Install from file" at the review: the checks passed, the targets to grant |
| `plugins-trust-*` | "Signature and trust" with the publisher key |
| `plugins-catalog-*` | the catalog tab, from a stubbed catalog answer (see below) |
| `dashboard-plugin-panel-*` | four panels of the example panel plugin "KPI tile" and a time series |

The AI scenes talk to a stand-in for a local model server (`ui/e2e/gallery/assistant.ts`, an
OpenAI-compatible endpoint on Ollama's port when it is free) that answers the connection test,
explanations, summaries and the tool calls of Ask; every figure in its answers is computed from
the gallery's SQLite file. The plugin scenes install the test plugin (`KALZIT_E2E_PLUGIN_BINARY`)
as two fictional data source plugins and the example panel plugin `examples/plugins/panel-kpi`,
all signed with a publisher key the run makes and trusts (publisher `basalt.example`). The catalog
scene is stubbed: Kalzit loads a catalog only over HTTPS with a certificate the system trusts,
which the run cannot give its own server, so the browser gets a made-up answer of
`GET /api/admin/plugin-catalog` for a list signed by that key; the server never loads a list.

The README and the gallery page of the website show the same files: the WebP renders live in
`gallery/` here, and the website keeps copies of them in `src/assets/gallery/`. After a rerun, copy
the WebP files of the artifact into both places (the PNG files are not committed):

```sh
gh run download <run-id> --name kalzit-gallery --dir <folder>
cp <folder>/*.webp docs/screenshots/gallery/
```

### Run it

The gallery needs MongoDB, OpenSearch and Neo4j with the gallery data, so it runs in CI:

```sh
gh workflow run gallery.yml --ref <branch> -f set=gallery
gh run watch                                  # or: gh run list --workflow gallery.yml
gh run download <run-id> --name kalzit-gallery --dir <folder>
```

The workflow (`.github/workflows/gallery.yml`, manual only, set `gallery`) starts the services
with `.github/scripts/e2e-services.sh start` and `ready`, seeds the gallery data with
`e2e-services.sh seed-gallery` (MongoDB: `ui/e2e/fixtures/gallery-datacenter.js` into the database
`kalzit_gallery`; Neo4j: `ui/e2e/fixtures/gallery-datacenter.cypher`, which replaces the e2e shop
graph), builds Kalzit and runs `npm run gallery` with one worker. The SQLite metrics and the
OpenSearch log events are written by the script itself (`ui/e2e/gallery/datacenter.ts`).

Locally, with those services running and seeded the same way, set `KALZIT_E2E_MONGODB`,
`KALZIT_E2E_OPENSEARCH` and `KALZIT_E2E_NEO4J` as `e2e-services.sh ready` does and run
`npm run gallery` in `ui/`. The images land in `ui/e2e/.output/gallery`, or in
`KALZIT_GALLERY_OUT` when set.

To change a scene, edit `gallery.shots.ts`; to change the data, `datacenter.ts` and the two gallery
fixtures. The e2e fixtures (`mongo-orders.js`, `graph-shop.cypher`) stay as they are: the e2e specs
count on them.

## Product video

"Kalzit in 60 seconds" is one take on an empty Kalzit at 1920 x 1080: Data sources > Add > Neo4j,
the connection typed in and tested, a Cypher query in Explore shown as a graph with a node's
details, the result added to a new dashboard that also holds a table (the same Neo4j source) and a
time series (the sales file of the e2e setup), the dashboard hovered, and a closing card. The data
is the e2e shop graph (`ui/e2e/fixtures/graph-shop.cypher`) and the generated sales file; every
name in them is invented. The captions and the pointer are an overlay the test draws into the
page, not part of the product. The table and the time series panel are added through the API
between two shots, so the take stays within a minute.

```sh
gh workflow run gallery.yml --ref <branch> -f set=video
gh run download <run-id> --name video --dir <folder>
```

The workflow records the take with Playwright's video recording, cuts it to the marks the test
writes (`cut.json`) and converts it with ffmpeg to `kalzit-in-60-seconds.mp4` (H.264, yuv420p,
30 fps, faststart, a silent AAC track) and `kalzit-in-60-seconds-square.mp4` (1080 x 1080, the
16:9 picture letterboxed), for X, LinkedIn and Mastodon. Locally, with the Neo4j of
`e2e-services.sh` and `KALZIT_E2E_NEO4J` set, `npm run video` in `ui/` writes the WebM recording
to `ui/e2e/.output/video`, or to `KALZIT_VIDEO_OUT` when set.
