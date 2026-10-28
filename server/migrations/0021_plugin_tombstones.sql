-- What a removed plugin leaves behind: its id with the key that signed its last installed version
-- (NULL when unsigned) and that version. A reinstall of the id is checked against it like an
-- update, so a package signed with another key cannot take over the id and the secrets of the
-- data sources of its kind; such a change needs the administrator's confirmation and clears
-- those secrets (docs/api/plugins.md). The row goes when the id is installed again. Hand-overs of
-- the id (`plugin_handovers`) stay with it.
CREATE TABLE plugin_tombstones (
    plugin_id   TEXT PRIMARY KEY,
    version     TEXT NOT NULL,
    signer      TEXT NOT NULL,
    public_key  TEXT,
    removed_at  BIGINT NOT NULL,
    removed_by  TEXT
);
