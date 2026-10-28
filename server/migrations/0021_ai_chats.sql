-- The chats of "Fragen", the AI agent chat (docs/api/ai.md, "Chat"). A chat belongs to the person
-- who started it, in one organization; nobody else reads it, administrators included. Chats are
-- deleted `ai.chat_retention_days` after their last message by an hourly job, and go with their
-- user and organization.
--
-- `datasource_ids` is the JSON list of the sources chosen in the composer (empty: every source
-- the person may read that is open to AI). `search_title` is the title in lower case, made by
-- the server, so a search compares the same way on SQLite and PostgreSQL.

CREATE TABLE ai_chats (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    search_title    TEXT NOT NULL,
    datasource_ids  TEXT NOT NULL,
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL
);

CREATE INDEX ai_chats_user ON ai_chats (user_id, org_id, updated_at);
-- The retention job deletes by organization and age.
CREATE INDEX ai_chats_org_updated ON ai_chats (org_id, updated_at);

-- The messages of a chat in order: a question (`user`) or an answer (`assistant`) with its
-- rounds of text and tool calls. `content` is JSON; a tool result keeps only what was sent to the
-- provider (redacted and cut by `ai::redact`), never more of a result.
CREATE TABLE ai_chat_messages (
    chat_id     TEXT NOT NULL REFERENCES ai_chats (id) ON DELETE CASCADE,
    seq         BIGINT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  BIGINT NOT NULL,
    PRIMARY KEY (chat_id, seq)
);
