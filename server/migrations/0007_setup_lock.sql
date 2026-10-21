-- One row once setup has run (fixed key 1). Setup writes it as its first statement, so two
-- servers on one database cannot both complete setup: the second fails on the key. Databases
-- that were set up before this migration get the row from their oldest account.

CREATE TABLE setup_lock (
    id       BIGINT PRIMARY KEY,
    done_at  BIGINT NOT NULL
);

INSERT INTO setup_lock (id, done_at) SELECT 1, MIN(created_at) FROM users HAVING COUNT(*) > 0;
