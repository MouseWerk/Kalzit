# Data source logos

Product names and logos are trademarks of their owners. Kalzit shows them only to identify the
data source a connection is made to (nominative use, as other dashboard tools do), always next to
the product's name and never as Kalzit's own branding. No endorsement by, sponsorship by or
affiliation with their owners is implied.

## Files

The SVG files in this folder are copied unchanged from Simple Icons, version **16.35.0** (npm
package `simple-icons@16.35.0`, https://simpleicons.org, https://github.com/simple-icons/simple-icons).
The Simple Icons collection is released under CC0 1.0 (public domain dedication); that license
covers the drawings, not the trademarks they show. Simple Icons states in its `DISCLAIMER.md` that
users must follow each brand's own guidelines. Kalzit bundles the files with the web interface
(no runtime dependency, no remote loading) and draws each one as a single path in the brand color
given by Simple Icons, on a light tile so that the dark marks stay visible in the dark theme, and
in the text color in the high-contrast theme.

| File                | Kind                                  | Brand color | Source named by Simple Icons                                                  | Owner's guidelines                                                                      |
| ------------------- | ------------------------------------- | ----------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `postgresql.svg`    | PostgreSQL                            | `#4169E1`   | https://wiki.postgresql.org/wiki/Logo                                         | https://www.postgresql.org/about/policies/trademarks/                                   |
| `mysql.svg`         | MySQL / MariaDB                       | `#4479A1`   | https://www.mysql.com/about/legal/logos.html                                  | https://www.mysql.com/about/legal/logos.html                                            |
| `mariadb.svg`       | MySQL / MariaDB                       | `#003545`   | https://mariadb.com/about-us/logos/                                           | https://mariadb.com/about-us/logos/                                                     |
| `sqlite.svg`        | SQLite                                | `#003B57`   | https://github.com/sqlite/sqlite (art/sqlite370.eps)                          | none published; https://sqlite.org/copyright.html for the code                          |
| `prometheus.svg`    | Prometheus                            | `#E6522C`   | https://prometheus.io                                                         | https://www.linuxfoundation.org/legal/trademark-usage, https://cncf.io/brand-guidelines |
| `influxdb.svg`      | InfluxDB                              | `#22ADF6`   | https://influxdata.github.io/branding/logo/downloads/                         | https://influxdata.github.io/branding/logo/usage/                                       |
| `clickhouse.svg`    | ClickHouse                            | `#FFCC01`   | https://github.com/ClickHouse/ClickHouse (website/images/logo-clickhouse.svg) | none named by Simple Icons                                                              |
| `mongodb.svg`       | MongoDB                               | `#47A248`   | https://www.mongodb.com/pressroom                                             | https://www.mongodb.com/legal/trademark-usage-guidelines                                |
| `elasticsearch.svg` | Elasticsearch / OpenSearch (prepared) | `#005571`   | https://www.elastic.co/brand                                                  | https://www.elastic.co/legal/trademarks                                                 |
| `opensearch.svg`    | Elasticsearch / OpenSearch (prepared) | `#005EB8`   | https://opensearch.org/trademark-brand-policy.html                            | https://opensearch.org/trademark-brand-policy.html                                      |
| `neo4j.svg`         | Neo4j (prepared)                      | `#4581C3`   | https://neo4j.com/brand/#logo                                                 | https://neo4j.com/brand/                                                                |

"Prepared" kinds arrive with later changes; their logos are mapped in
`ui/src/features/datasources/kindMarks.tsx` already.

## Kinds without a logo

These keep Kalzit's neutral line glyph for their family of data:

| Kind                 | Why                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microsoft SQL Server | Not in Simple Icons (Microsoft brands were removed in Simple Icons 13.0.0 at Microsoft's request); Microsoft offers its product icons only for architecture diagrams and documentation, and its trademark guidelines (https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general) do not allow its logos in other products |
| Memgraph             | Not in Simple Icons; no official press kit found                                                                                                                                                                                                                                                                                                    |
| TigerGraph           | Not in Simple Icons; the brand center (https://www.tigergraph.com/tigergraph-brand-center/) offers no file for third-party use                                                                                                                                                                                                                      |
| Loki                 | Not in Simple Icons; its mark belongs to Grafana Labs, whose logos Kalzit does not use                                                                                                                                                                                                                                                              |
| File, HTTP JSON      | Not products: Kalzit's own glyphs                                                                                                                                                                                                                                                                                                                   |

## Adding a logo

1. Copy the unaltered SVG from the Simple Icons version above (or, where Simple Icons has none, the
   vendor's official press-kit file, unaltered) into this folder.
2. Add a row above: file, kind, color, source and the owner's guideline link.
3. Map it in `KIND_LOGOS` (`kindMarks.tsx`), add its `--brand-*` color to `tokens.css` and its
   color rule to `datasources.css`. Logos are content: no brand color in selection, focus or
   current-state styling.
