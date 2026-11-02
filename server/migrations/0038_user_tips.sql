-- Tips in the UI (docs/api/shell.md, "Preferences"): whether the user wants them at all (NULL:
-- yes) and the ids of the tips they have seen, as a JSON array of strings, so each tip appears
-- once and follows the person from browser to browser.

ALTER TABLE user_preferences ADD COLUMN show_tips BIGINT;
ALTER TABLE user_preferences ADD COLUMN seen_tips TEXT;
