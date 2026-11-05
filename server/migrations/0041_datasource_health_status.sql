-- The start page's data source status: how long the last connection test took, and since when a
-- failing source has failed without a passing test in between (null while it passes). Tests that
-- ran before this migration have neither.
ALTER TABLE datasource_health ADD COLUMN latency_ms BIGINT;
ALTER TABLE datasource_health ADD COLUMN failing_since BIGINT;
