-- Theme variants (board Themes): besides the mode in `theme`, each person keeps one light variant
-- (`light`, `paper`, `calcite`) and one dark variant (`dark`, `graphite`, `night`). NULL follows
-- the server's defaults (`appearance.default_theme_light`, `appearance.default_theme_dark`), so
-- nothing changes for anyone until they choose a variant.

ALTER TABLE user_preferences ADD COLUMN theme_light TEXT;
ALTER TABLE user_preferences ADD COLUMN theme_dark TEXT;
