-- The list order of titles and names (server/src/collation.rs): each row keeps the sort key of its
-- title or name, made by the server by the rules of the UI languages, and lists order and page by
-- that key and the id. The keys are bytes (`bytea` on PostgreSQL; SQLite stores them as BLOBs),
-- which both databases compare byte by byte whatever their collation, so SQLite and PostgreSQL
-- order alike. The database never compares the text itself. The server fills the keys at startup
-- after this migration, repairs missing ones at every start and recomputes all of them when a new
-- build orders differently (`sort_key_state`). Until then a key is empty and sorts first.

ALTER TABLE dashboards ADD COLUMN sort_title BYTEA NOT NULL DEFAULT '';
ALTER TABLE analyses ADD COLUMN sort_title BYTEA NOT NULL DEFAULT '';
ALTER TABLE library_panels ADD COLUMN sort_name BYTEA NOT NULL DEFAULT '';
ALTER TABLE playlists ADD COLUMN sort_name BYTEA NOT NULL DEFAULT '';
ALTER TABLE service_accounts ADD COLUMN sort_name BYTEA NOT NULL DEFAULT '';

DROP INDEX dashboards_org_title;
DROP INDEX analyses_org_title;
DROP INDEX library_panels_org_name;
DROP INDEX playlists_org_name;
CREATE INDEX dashboards_org_sort ON dashboards (org_id, sort_title, id);
CREATE INDEX analyses_org_sort ON analyses (org_id, sort_title, id);
CREATE INDEX library_panels_org_sort ON library_panels (org_id, sort_name, id);
CREATE INDEX playlists_org_sort ON playlists (org_id, sort_name, id);
CREATE INDEX service_accounts_org_sort ON service_accounts (org_id, sort_name, id);
-- Rows still without a key, which every start fills: normally none, so these stay empty.
CREATE INDEX dashboards_sort_missing ON dashboards (id) WHERE sort_title = '';
CREATE INDEX analyses_sort_missing ON analyses (id) WHERE sort_title = '';
CREATE INDEX library_panels_sort_missing ON library_panels (id) WHERE sort_name = '';
CREATE INDEX playlists_sort_missing ON playlists (id) WHERE sort_name = '';
CREATE INDEX service_accounts_sort_missing ON service_accounts (id) WHERE sort_name = '';

-- The order the stored keys were made with (`collation::VERSION`); one row.
CREATE TABLE sort_key_state (
    id       BIGINT PRIMARY KEY,
    version  TEXT NOT NULL
);
