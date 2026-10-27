# Screenshots and gallery renders

Kalzit has two sets of pictures, both taken by Playwright against the real binary:

| Set | Script | Where the images go |
|---|---|---|
| README screenshots | `ui/e2e/screenshots/readme.shots.ts` (`npm run screenshots`) | committed here, in `docs/screenshots/` |
| Gallery renders for the website | `ui/e2e/gallery/gallery.shots.ts` (`npm run gallery`) | the artifact `kalzit-gallery` of the gallery workflow; never committed |

## README screenshots

A pull request that visibly changes the UI reruns `npm run screenshots` in `ui/` and commits the
changed images in this folder (see CONTRIBUTING.md, "Screenshots").

The graph pictures (`graph-*`) need the Neo4j of the e2e specs and the field distribution
(`explore-distribution-dark`) its MongoDB; without them those tests are skipped and the images
here stay. To take every picture, run the `readme` set of the same workflow as the gallery, which
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
| `dashboard-phone-*` | the overview on a phone (390 x 844) |
| `graph-network-*` | the network and power topology in one network panel, colored by label |
| `graph-inspector-*` | the same with a server selected and the node inspector open |
| `graph-hierarchy-paths-*` | site > hall > row > rack > server as a hierarchy, and two path panels (uplinks to a core switch, the A and B power feeds of a server) |
| `graph-explorer-*` | explorer mode mid-expansion: a spine switch, then one of its leaves expanded |
| `documents-pipeline-*` | Explore on MongoDB: a saved pipeline, the preview after stage 1, the document tree |
| `documents-dashboard-*` | incidents as documents, the schema of the asset records, two field distributions |
| `explore-steps-*` | Explore with a saved analysis and its steps (moving average, trend) |
| `dashboard-all-sources-*` | one dashboard on SQLite, OpenSearch, MongoDB and Neo4j |
| `dashboard-live-*` | a live dashboard of rack temperatures |

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
