# Performance baseline for 0.6

The performance check of M6 (docs/PLAN.md, M6 "Performance"): what Kalzit costs before 0.6.0, set
against 0.5.4, the regressions it found and what is left for M8 ("Performance und Tempo"). Numbers
for a later check are taken the same way, so a change shows as a change and not as a different
method.

## How it was measured

- Machine: Windows 11 Pro, 16 threads, NVMe; other builds were running beside it, so single
  numbers move by a few milliseconds. Every timing is the median (p50) and p95 of 25 requests in a
  row after three warm-up requests, sent one after the other from the same machine.
- Binaries: `cargo build --release --locked -p kalzit` of `main` at 50ce3d27 (with the embedded UI
  from `npm run build`) and of the tag `v0.5.4`, built the same way on the same machine.
- Data: the e2e fixtures (`ui/e2e/support/fixture-db.ts`: the `sales` and `dense` SQLite tables,
  `regions.csv`) plus a JSON file of 2,000 order documents. One organization with 40 data sources
  (38 SQLite, one CSV, one JSON), 60 dashboards (one with 24 panels over SQLite, CSV and JSON, the
  others with two time series), 60 saved analyses, 41 members in 8 teams. Every dashboard's panels
  ran once before the timings, so the usage counts and recents hold data. For the scale probe
  400 more dashboards of six panels each were added (460 in all).
- Neo4j and MongoDB were not measured: no container runtime was available on the machine. Their
  panel queries run through the same route as the others; their own timings belong to the
  nightly graph and document jobs.
- UI: Chromium through Playwright at 1600x1000, signed in, a new browser context per load (so no
  cached files); median of four loads. "Ready" is the page's main element visible and nothing
  `aria-busy`. Long tasks from a `PerformanceObserver` during the load.

## Server

### Start and memory

| | 0.5.4 | 0.6 (main) |
|---|---|---|
| Start to ready, first start of a new binary (fresh data directory, all migrations) | 0.80 s | 0.77 s |
| Start to ready, again on the same data | 63 ms | 64 ms |
| Memory at idle after the first start (working set / private) | 24 / 9 MiB | 23 to 38 / 9 MiB |
| After loading all 60 dashboards | 48 / 30 MiB | 49 / 31 MiB |
| After the API timings below | 54 / 36 MiB | 62 / 43 MiB |

The first start of a newly copied binary takes 0.2 to 0.9 s on Windows, most of it the virus
scanner reading the new file; a second start of the same file is 0.2 s with migrations, 60 ms
without. The 7 MiB more after the API timings come from the routes 0.5.4 does not have (usage,
status, AI overview, analysis counts) having run; at idle and after the dashboards both are equal.

### API routes (ms, p50 / p95)

| Route | 0.5.4 | 0.6 (main) |
|---|---|---|
| Dashboards list (60) | 2.6 / 3.4 | 3.0 / 4.2 |
| One dashboard (24 panels) | 1.5 / 1.9 | 1.6 / 2.0 |
| Panel query, SQLite time series, uncached | 2.1 / 2.6 | 2.3 / 2.8 |
| Panel query, SQLite time series, from the cache | 1.5 / 1.6 | 1.5 / 2.1 |
| Panel query, SQLite GROUP BY, uncached | 2.0 / 2.7 | 2.1 / 2.5 |
| Panel query, CSV, uncached | 1.7 / 2.5 | 1.9 / 2.3 |
| Panel query, JSON 2,000 documents, uncached | 14.8 / 28.1 | 14.9 / 19.0 |
| All 24 panels of a dashboard at once, uncached | 29.2 / 33.9 | 29.0 / 31.3 |
| Explore run (SQLite) | 4.4 / 5.0 | 3.7 / 4.1 |
| Data sources list (40, with the new columns) | 1.5 / 1.9 | 7.6 / 9.1 before the fix, 3.0 / 4.0 after |
| Data sources status (Start page) | - | 1.9 / 2.3 |
| Usage of one data source | - | 1.8 / 2.1 |
| Audit log page (50) | 1.5 / 2.0 | 1.7 / 2.0 |
| Saved analyses, last opened first | - | 3.2 / 4.4 |
| Saved analyses, newest change first | - | 3.2 / 4.5 |
| Saved analyses, counts per folder | - | 1.0 / 2.4 |
| Members (teams, last active) | 1.3 / 1.5 | 1.5 / 1.8 |
| AI overview (server administration) | - | 0.8 / 1.0 |
| Recents (Start) | 1.2 / 1.4 | 1.2 / 1.4 |
| Search | 2.4 / 3.0 | 2.3 / 2.6 |
| `/api/me` | 0.8 / 0.9 | 0.7 / 0.8 |

"-": the route or the sort is new in 0.6. The data source list does more in 0.6 than in 0.5.4
(address, last test, latency of the last 24 hours, last use, "used in", who changed it, teams),
in a fixed number of queries whatever the number of sources. The numbers after the fix were taken
while a build ran beside them, so they are if anything too high.

### Scale probe: 460 dashboards

| Route | 0.5.4 | 0.6 (main) |
|---|---|---|
| Dashboards list (first 100 of 460) | 2.8 / 3.6 | 2.7 / 3.2 |
| Data sources list (40 sources) | 1.4 / 1.7 | 43.1 / 52.7 before the fix, 7.7 / 8.2 after |
| Data sources status (Start page) | - | 3.1 / 3.6 |
| Usage of one data source | - | 4.7 / 6.1 |
| Search | 3.8 / 4.1 | 3.8 / 4.3 |

## Regression found and fixed

**The data source list grew with sources times dashboards.** Its "Used in" column matched every
listed source in the SQL (`model LIKE '%"<id>"%' OR ...`, one pattern per source over every
dashboard's current model) and then again in Rust per source and dashboard. With 40 sources and
460 dashboards the list took 43 ms instead of 1.4 ms in 0.5.4, and it would keep growing with
both. Now each live dashboard's current model is read once and scanned once for the quoted ids it
holds (`overview::quoted_ids`, the same match as before: a quoted id is a reference), so the cost
grows with the size of the models only: 7.7 ms for 460 dashboards, 3.0 ms for 60. The rights per
dashboard are checked as before. The unit test `quoted_ids_find_what_refers_to_finds` holds the
match equal to the old one; `the_list_shows_its_columns_without_testing` covers the column.

No other route changed in M6 is slower than its 0.5.4 counterpart beyond the noise. The routes
added in M6 were read for queries per row: the data source list, the members' teams and last
activity, the saved analyses' owner and last opened (one subquery on the primary key per row) and
the AI overview all read in a fixed number of queries.

## UI

### Bundle (gzip, `npm run build && npm run budget`)

| | 0.5.4 | 0.6 | Budget |
|---|---|---|---|
| First page load (what `index.html` loads) | 262.0 kB in 37 files | 233.7 kB in 35 files | 283.2 kB |
| Main chunk (`index-*.js`) | 170.0 kB | 137.9 kB | |
| Whole bundle | 2,473.2 kB in 172 files | 2,569.1 kB in 181 files | 2,636.7 kB |
| English / German catalog | 117.2 / 130.3 kB | 122.7 / 136.1 kB | 146.5 kB each |
| Dashboard page chunk | 94.0 kB | 103.7 kB | 117.2 kB |

The first load is 11 % smaller since setup, sign-in and help load on demand (#250). The whole
bundle grew by 4 % with the M6 screens; every limit holds.

### Page loads (Chromium, new context each time)

| Page | First paint 0.5.4 / 0.6 | Ready 0.5.4 / 0.6 | Long tasks (longest) 0.6 | Transferred 0.6 |
|---|---|---|---|---|
| Start | 204 / 212 ms | 249 / 248 ms | 1 (61 ms) | 1.8 MB |
| Dashboard with 24 panels | 224 / 228 ms | 476 / 484 to 959 ms | 1 (71 ms) | 4.1 MB |
| Explore | 224 / 224 ms | 344 / 337 ms | 0 | 2.5 MB |
| Data sources | 224 / 216 ms | 292 / 314 to 382 ms | 1 (50 ms) | 1.6 MB |

"Ready" of the dashboard and the data source list moved between runs of the same binary (both
ranges are from 0.6 runs on the same data); their medians are within the noise of 0.5.4. The one
long task per page is the first render of the app shell. "Transferred" is large because the
server sends its files uncompressed (see the M8 list).

### Interactions

`ui/e2e/budget.spec.ts` against the release binary (4x CPU throttling): typing in a panel's query
p95 34.7 ms at reference (budget 58 ms), longest task 25.8 ms, 13.4 components drawn per key
(limit 20); dragging a panel makes no long task after the warm-up; three 100,000-point styled
charts draw again with a longest task of 43 ms (budget 150 ms). Typing 57 keys in Explore at full
speed made no long task; the slowest key took 16 to 24 ms of Event Timing.

## Binary and packages

| Asset | 0.5.4 release | 0.6 (main, local build) |
|---|---|---|
| Windows x64 binary | 95,990,272 bytes (91.5 MiB) | 99,455,488 bytes (94.8 MiB, +3.6 %) |
| Windows MSI | 124,710,912 bytes | not built locally |
| Linux x64 binary | 110,435,568 bytes | not built locally |
| Linux x64 deb / rpm | 30,703,390 / 30,709,612 bytes | not built locally |

The local build of `v0.5.4` came to 95,946,752 bytes, within 0.05 % of the released file, so the
two columns compare. The 3.5 MB more are the M6 additions (the database copy, Prometheus metrics,
graph algorithms, the sub-path, the Windows event log) and the larger UI.

## Candidates for M8

Measured or seen during this check, not changed here because they are not regressions:

1. **Compress what the server sends.** Neither the UI files nor the API answers are compressed:
   the first page load is 234 kB gzip but about 1.8 MB on the wire, a dashboard about 4 MB, and a
   2,000-document answer travels as plain JSON. Precompressed `br`/`gzip` copies of the embedded
   files (built once with the UI) and on-the-fly compression for larger JSON answers would cut
   both by 70 to 85 %. The largest single win for remote and slow connections.
2. **A reference table from dashboards and library panels to data sources**, kept on save, so
   "Used in", the usage of a source, the Start page status ("unused") and the purge check read an
   index instead of every current model (now linear in the size of all models: 7.7 ms at 460
   dashboards).
3. **Dashboards with many panels**: the 24 panels of the test dashboard ask 24 requests (29 ms
   for all at once on the server); a batched or streamed panel query would save the per-request
   overhead and let the browser draw as answers arrive. Matches the M8 item "parallele Abfragen,
   Ergebnisse als Stream".
4. **Document answers**: 2,000 JSON documents take 15 ms on the server, ten times a SQLite panel;
   most of it is serializing the documents. Worth a profile together with virtualized document
   trees (M8).
5. **The members' teams** are read for the whole organization on every page of the member list
   and matched per member in a loop; with thousands of members, read only the page's members and
   group them in one pass.
6. **The first render's long task** (50 to 70 ms on every page at full speed): the app shell's
   first render; splitting the shell's initial work or deferring the router's preloads would
   bring it under 50 ms.
7. **Binary size**: 94.8 MiB on Windows. A `release` profile with `lto = "thin"`,
   `codegen-units = 1` and stripped symbols is worth measuring for size and start time against
   the longer build.
8. **Memory after use** grows by about 7 MiB with the new routes having run; a check over a day
   of mixed use would tell a cache from a leak.
9. **Neo4j and MongoDB panel timings** were not part of this check (no container runtime on the
   machine); the next baseline should take them from the nightly jobs' databases.
