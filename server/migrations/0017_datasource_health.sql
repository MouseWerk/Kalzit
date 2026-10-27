-- The last "Test connection" of a stored data source: whether it passed, its warnings (a JSON
-- list of `{reason, params, message}`, scrubbed of secrets like every answer) and when it ran.
-- The data source page shows the warnings to everyone who may see the source until the next test
-- replaces them; a change of the source's settings or secrets drops the row.

CREATE TABLE datasource_health (
    datasource_id  TEXT PRIMARY KEY REFERENCES datasources (id) ON DELETE CASCADE,
    ok             BIGINT NOT NULL,
    warnings       TEXT NOT NULL,
    tested_at      BIGINT NOT NULL
);
