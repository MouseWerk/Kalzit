-- AI providers, their keys, usage counters and the per-data-source opt-in (docs/ARCHITECTURE.md,
-- "AI"). A provider with `org_id` NULL is server-wide; one with an `org_id` is that organization's
-- override and is used for its members instead of the server's. `is_default` marks the provider
-- used for calls within its scope (at most one per scope, enforced by the API).

CREATE TABLE ai_providers (
    id          TEXT PRIMARY KEY,
    org_id      TEXT REFERENCES orgs (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    base_url    TEXT NOT NULL,
    model       TEXT NOT NULL,
    is_default  BIGINT NOT NULL,
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL,
    updated_by  TEXT,
    -- Which request field carries the answer's token budget: NULL picks it by host
    -- (`max_completion_tokens` for api.openai.com, `max_tokens` elsewhere).
    token_limit_field TEXT,
    -- The last connection test: passed (1) or not (0), its reason when it failed, and when.
    -- Cleared whenever base URL, model or key change, so a pass always belongs to the settings.
    last_test_ok      BIGINT,
    last_test_reason  TEXT,
    last_tested_at    BIGINT
);

CREATE INDEX ai_providers_org ON ai_providers (org_id, id);

-- API keys, encrypted like data source secrets (server/src/secrets.rs): AES-256-GCM with
-- `ai-provider:<id>` and the field name as associated data; rotation re-encrypts these rows too.
CREATE TABLE ai_provider_secrets (
    provider_id  TEXT NOT NULL REFERENCES ai_providers (id) ON DELETE CASCADE,
    field        TEXT NOT NULL,
    key_id       TEXT NOT NULL,
    nonce        TEXT NOT NULL,
    ciphertext   TEXT NOT NULL,
    PRIMARY KEY (provider_id, field)
);

-- Calls and tokens per day (UTC, `YYYY-MM-DD`), organization and user, for the limits and the
-- usage pages. A call counts and reserves its token budget when it starts; when it ends, the
-- reservation is replaced by the tokens it used. `user_id` has no foreign key: a deleted user's
-- rows keep counting for the organization's month.
CREATE TABLE ai_usage (
    day              TEXT NOT NULL,
    org_id           TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    user_id          TEXT NOT NULL,
    requests         BIGINT NOT NULL,
    input_tokens     BIGINT NOT NULL,
    output_tokens    BIGINT NOT NULL,
    reserved_tokens  BIGINT NOT NULL,
    PRIMARY KEY (day, org_id, user_id)
);

CREATE INDEX ai_usage_org_day ON ai_usage (org_id, day);

-- What AI may read of a data source. `readable` is the opt-in (a source without a row, or with
-- 0, is closed to AI: no schema, no results). `excluded_fields` is a JSON list of field names or
-- paths whose values AI never receives (`ai::redact`); it is kept while the source is closed.
CREATE TABLE ai_datasource_access (
    datasource_id    TEXT PRIMARY KEY REFERENCES datasources (id) ON DELETE CASCADE,
    readable         BIGINT NOT NULL,
    excluded_fields  TEXT NOT NULL,
    updated_by       TEXT,
    updated_at       BIGINT NOT NULL
);

-- The first-use notice ("what leaves the server"), acknowledged once per user and provider.
-- Without a row, AI calls of that user through that provider are refused (`ai.notice_required`).
CREATE TABLE ai_notice_acks (
    user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider_id      TEXT NOT NULL REFERENCES ai_providers (id) ON DELETE CASCADE,
    acknowledged_at  BIGINT NOT NULL,
    PRIMARY KEY (user_id, provider_id)
);
