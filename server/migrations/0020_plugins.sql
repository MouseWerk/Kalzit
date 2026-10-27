-- Installed plugins, the publisher keys an administrator trusts for them, key hand-overs, the
-- organizations that block a plugin, and the host's own switches (docs/ARCHITECTURE.md,
-- "Plugins"; docs/api/plugins.md).

-- One row per installed plugin: the version that runs, and an update waiting for the approval
-- of the permissions it adds (`pending_*`). `manifest` holds the exact bytes of
-- `kalzit-plugin.toml` (the signature covers them); `dir` is the package's directory below
-- `<data_dir>/plugins/packages`. `signer` is `kalzit`, `publisher` or `unsigned`; `public_key`
-- the 32-byte key in lowercase hex that signed it (NULL when unsigned). `approved` is 1 once a
-- server administrator approved the permissions of this version; `enabled` is the
-- administrator's switch. A plugin runs only when both are 1 and its key is still trusted.
CREATE TABLE plugins (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    version             TEXT NOT NULL,
    kind                TEXT NOT NULL,
    manifest            TEXT NOT NULL,
    signer              TEXT NOT NULL,
    public_key          TEXT,
    dir                 TEXT NOT NULL,
    approved            BIGINT NOT NULL,
    enabled             BIGINT NOT NULL,
    pending_version     TEXT,
    pending_manifest    TEXT,
    pending_signer      TEXT,
    pending_public_key  TEXT,
    pending_dir         TEXT,
    installed_at        BIGINT NOT NULL,
    updated_at          BIGINT NOT NULL,
    updated_by          TEXT
);

-- Publisher keys a server administrator trusts for plugins. Kalzit's own plugin key is built in
-- and never stored here; release keys are never trusted for plugins.
CREATE TABLE plugin_keys (
    key_id      TEXT PRIMARY KEY,
    public_key  TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    added_at    BIGINT NOT NULL,
    added_by    TEXT
);

-- Verified key hand-overs (`signing::HandOver`), kept with the plugin id: updates from
-- `from_version` on may be signed by `to_key`. `signature` is the old key's signature, in hex.
CREATE TABLE plugin_handovers (
    plugin_id     TEXT NOT NULL,
    from_key      TEXT NOT NULL,
    to_key        TEXT NOT NULL,
    from_version  TEXT NOT NULL,
    signature     TEXT NOT NULL,
    added_at      BIGINT NOT NULL,
    PRIMARY KEY (plugin_id, from_key, to_key, from_version)
);

-- Plugins an organization's administrators blocked: their kinds are not offered there and the
-- organization's data sources of those kinds stop. Kept when the plugin is removed, so a
-- reinstall does not lift the block.
CREATE TABLE plugin_org_blocks (
    org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    plugin_id   TEXT NOT NULL,
    blocked_at  BIGINT NOT NULL,
    blocked_by  TEXT,
    PRIMARY KEY (org_id, plugin_id)
);

-- The host's switches, one row (`id` = 'server'): whether unsigned plugins may be installed
-- (off by default; an invalid signature is refused either way), and whether plugins may run on a
-- Linux host without Landlock (off by default: they are refused there).
CREATE TABLE plugin_host (
    id                      TEXT PRIMARY KEY,
    allow_unsigned          BIGINT NOT NULL,
    allow_without_landlock  BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL,
    updated_by      TEXT
);
