-- Team spaces and team ownership (docs/api/access.md, "Team spaces" and "Team ownership").
--
-- A team can own folders and dashboards. A team space is a restricted folder at the top level
-- that a team owns: its members get their roles inside it, everyone else sees it only through a
-- grant. Inside shared folders a team can own single folders and dashboards: only the team (and
-- grants) edit them, everyone with access to the folder reads them, unless the owner team makes
-- them team only (a restricted folder, or `team_only` on a dashboard). Existing folders and
-- dashboards have no owner and keep their access unchanged.
--
-- A team that owns anything cannot be deleted until its folders and dashboards are handed to
-- another team or to the organization; the reference keeps that true on PostgreSQL as well.

ALTER TABLE folders ADD COLUMN owner_team_id TEXT REFERENCES teams (id);
ALTER TABLE dashboards ADD COLUMN owner_team_id TEXT REFERENCES teams (id);
-- 1: only the owner team, grants on the dashboard and org admins see it.
ALTER TABLE dashboards ADD COLUMN team_only BIGINT NOT NULL DEFAULT 0;

CREATE INDEX folders_owner_team ON folders (owner_team_id);
CREATE INDEX dashboards_owner_team ON dashboards (owner_team_id);

-- The team a member works in per organization (the team context of the sidebar). No row: the
-- first of the member's teams. `team_id` NULL: all areas. The team is checked against the
-- member's teams on every use, so it carries no reference: a team left or deleted falls back.
CREATE TABLE team_contexts (
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    team_id    TEXT,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, org_id)
);
