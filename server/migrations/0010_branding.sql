-- The server's logo (appearance and brand settings). `id` is 'server' for the logo in effect and
-- 'previous' for the one before the last upload or removal, which undo brings back. The image is
-- base64 text, so both databases store it the same way. `version` counts uploads.

CREATE TABLE branding_logo (
    id            TEXT PRIMARY KEY,
    content_type  TEXT NOT NULL,
    data          TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    version       BIGINT NOT NULL,
    updated_by    TEXT,
    updated_at    BIGINT NOT NULL
);
