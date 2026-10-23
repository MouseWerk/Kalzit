# Data source marks

Kalzit names every data source kind with its product name and shows a neutral line glyph for the
kind of data it holds (table, file, metrics, documents, search index, graph, HTTP service). The
glyphs are Kalzit's own drawings in `ui/src/features/datasources/kindMarks.tsx`; this folder holds
no vendor artwork.

Product names and logos are trademarks of their owners. Kalzit uses the names only to identify
the data source a connection is made to; this implies no endorsement by or affiliation with their
owners.

## Why no vendor logos

Most vendors allow their names to identify a compatible product, but restrict their logos to
licensees or require written permission, and several forbid showing their logo next to other
logos or in another color. Reviewed on 2026-10-22:

| Kind | Owner | Guidelines | Logo in Kalzit |
|---|---|---|---|
| PostgreSQL | PostgreSQL Community Association | https://www.postgresql.org/about/policies/trademarks/ | No: the marks may not be modified or shown with other logos without approval |
| MySQL | Oracle | https://www.mysql.com/about/legal/logos.html | No: logo use in a product needs a written agreement |
| MariaDB | MariaDB plc / Foundation | https://mariadb.com/about-us/logos/ | No: shares the kind with MySQL, which may not show a logo |
| Microsoft SQL Server | Microsoft | https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general | No: Microsoft's logos may not be used by third parties |
| SQLite | Hipp, Wyrick & Company | no published logo policy found | No: no permission on record |
| Prometheus | Linux Foundation (CNCF) | https://www.linuxfoundation.org/legal/trademark-usage, https://cncf.io/brand-guidelines | No: logo use needs written permission |
| MongoDB | MongoDB, Inc. | https://www.mongodb.com/legal/trademark-usage-guidelines | No: logo use for integrations is not covered |
| Elasticsearch | Elastic N.V. | https://www.elastic.co/legal/trademarks | No: logos are reserved for resellers, distributors and licensees |
| OpenSearch | Linux Foundation | https://opensearch.org/trademark-brand-policy.html | No: allowed for integrations, but shares the kind with Elasticsearch |
| Neo4j | Neo4j, Inc. | Neo4j Trademark Guidelines, https://neo4j.com/?p=49003 | No: use needs a written agreement or express permission |
| Memgraph | Memgraph Ltd. | no published logo policy found | No: no permission on record |
| TigerGraph | TigerGraph, Inc. | https://www.tigergraph.com/tigergraph-brand-center/ | No: no permission for third-party use stated |

## Adding a logo later

A vendor logo may only be added with the owner's permission on record. Then:

1. Put the unaltered official SVG here, with a light and a dark variant where the mark needs one,
   and a one-color variant that follows `currentColor` for the contrast theme and small sizes.
2. Add a row above with the source URL, the license or permission and the guideline link.
3. Show it through `KindMark` (inline SVG or a same-origin asset only, never a remote URL; the
   content security policy blocks those), decorative (`aria-hidden`) next to the product name.
   Brand colors stay inside the mark; selection and focus styling stay neutral.
