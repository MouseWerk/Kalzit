-- The server's logo (appearance and brand settings). One row at most (`id` is always 'server');
-- the image is base64 text, so both databases store it the same way. `version` counts uploads and
-- makes the logo's URL change with every new image.

CREATE TABLE branding_logo (
    id            TEXT PRIMARY KEY,
    content_type  TEXT NOT NULL,
    data          TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    version       BIGINT NOT NULL,
    updated_by    TEXT,
    updated_at    BIGINT NOT NULL
);
