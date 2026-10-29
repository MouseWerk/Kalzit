-- The plugin catalog as this server last took it (docs/api/plugins.md, "Catalog"), one row
-- (`id` = 'server'). `accepted` is the JSON object of the highest index sequence accepted per
-- catalog key (full public key in hex): it is never lowered, so an older index is refused as a
-- rollback, also after the URL changed or the catalog was turned off and on. `index_json` holds the
-- exact bytes of the last index taken from `source_url`, signed by `key_hex`; `fetched_at` is when
-- it was taken, `checked_at` the last check that confirmed it, `attempted_at` the last try. The
-- `error_*` columns describe the last failed try (reason code, English text, JSON params) until a
-- check succeeds.
CREATE TABLE plugin_catalog (
    id             TEXT PRIMARY KEY,
    accepted       TEXT NOT NULL,
    source_url     TEXT,
    index_json     TEXT,
    key_hex        TEXT,
    fetched_at     BIGINT,
    checked_at     BIGINT,
    attempted_at   BIGINT,
    error_reason   TEXT,
    error_message  TEXT,
    error_params   TEXT,
    error_at       BIGINT
);

-- Publisher keys an administrator explicitly allowed to sign the catalog index. Trusting a key for
-- plugins alone does not let it sign the catalog; Kalzit's own plugin keys always may.
ALTER TABLE plugin_keys ADD COLUMN may_sign_catalog BIGINT NOT NULL DEFAULT 0;
