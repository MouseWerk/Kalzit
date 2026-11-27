-- Kalzit's algorithm queries that Kalzit installed on a TigerGraph source with its install login
-- (docs/api/datasources.md, "TigerGraph algorithm queries"): which name, which version of the
-- shipped text and its SHA-256 (of the text with the graph's name as written for MyGraph). Kalzit
-- removes or replaces only queries recorded here; a query of the same name it did not install
-- stops an install.

CREATE TABLE tigergraph_installed_queries (
    datasource_id  TEXT NOT NULL REFERENCES datasources (id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    version        BIGINT NOT NULL,
    checksum       TEXT NOT NULL,
    installed_at   BIGINT NOT NULL,
    installed_by   TEXT,
    PRIMARY KEY (datasource_id, name)
);
