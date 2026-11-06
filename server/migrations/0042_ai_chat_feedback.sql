-- "Hilfreich" or "Nicht hilfreich" on an answer of "Fragen": one rating per answer and person,
-- kept with the chat and deleted with it. Only the rating is stored, never a text; the audit log
-- records that a rating was given, without the answer.
CREATE TABLE ai_chat_feedback (
    chat_id     TEXT NOT NULL,
    seq         BIGINT NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    helpful     BIGINT NOT NULL,
    created_at  BIGINT NOT NULL,
    PRIMARY KEY (chat_id, seq, user_id),
    FOREIGN KEY (chat_id, seq) REFERENCES ai_chat_messages (chat_id, seq) ON DELETE CASCADE
);
