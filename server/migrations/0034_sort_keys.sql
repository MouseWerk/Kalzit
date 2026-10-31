-- The list order of titles and names (server/src/collation.rs): each row keeps the sort key of its
-- title or name, made by the server by the rules of the UI languages, and lists order and page by
-- that key and the id. The database never compares the text itself, so SQLite and PostgreSQL (in
-- whatever locale it was set up) order alike. The server fills the keys at startup after this
-- migration, and again whenever a new build orders differently (`sort_key_state`).

ALTER TABLE dashboards ADD COLUMN sort_title TEXT NOT NULL DEFAULT '';
ALTER TABLE analyses ADD COLUMN sort_title TEXT NOT NULL DEFAULT '';
ALTER TABLE library_panels ADD COLUMN sort_name TEXT NOT NULL DEFAULT '';
ALTER TABLE playlists ADD COLUMN sort_name TEXT NOT NULL DEFAULT '';
ALTER TABLE service_accounts ADD COLUMN sort_name TEXT NOT NULL DEFAULT '';

DROP INDEX dashboards_org_title;
DROP INDEX analyses_org_title;
DROP INDEX library_panels_org_name;
DROP INDEX playlists_org_name;
CREATE INDEX dashboards_org_sort ON dashboards (org_id, sort_title, id);
CREATE INDEX analyses_org_sort ON analyses (org_id, sort_title, id);
CREATE INDEX library_panels_org_sort ON library_panels (org_id, sort_name, id);
CREATE INDEX playlists_org_sort ON playlists (org_id, sort_name, id);
CREATE INDEX service_accounts_org_sort ON service_accounts (org_id, sort_name, id);

-- The order the stored keys were made with (`collation::VERSION`); one row.
CREATE TABLE sort_key_state (
    id       BIGINT PRIMARY KEY,
    version  TEXT NOT NULL
);
