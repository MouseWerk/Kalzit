-- Recent sign-ins (docs/api/access.md, "Recent sign-ins"). The half-signed-in state keeps the
-- directory or identity provider of its first step and whether that was the break-glass admin's
-- password, so the sign-in recorded after the second step names them. Refusals of a provider that
-- had found the person name the person as their actor; this index lists them per person.

ALTER TABLE sign_in_challenges ADD COLUMN provider_id TEXT;
ALTER TABLE sign_in_challenges ADD COLUMN break_glass BIGINT NOT NULL DEFAULT 0;

CREATE INDEX audit_events_actor_time ON audit_events (actor_user_id, created_at, id);
