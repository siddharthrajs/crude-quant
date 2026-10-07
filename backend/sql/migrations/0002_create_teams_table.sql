-- Exact SQL emitted by alembic/versions/0002_create_teams_table.py.
-- Regenerated with: alembic upgrade 0001:0002 --sql
-- Kept for reference/manual application; Alembic (not this file) is what
-- actually runs against the database.

CREATE TABLE teams (
    id SERIAL NOT NULL,
    name VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ix_teams_name ON teams (name);

INSERT INTO teams (id, name) VALUES (1, 'Money Ballers');

SELECT setval(pg_get_serial_sequence('teams', 'id'), (SELECT MAX(id) FROM teams));

ALTER TABLE users ADD COLUMN team_id INTEGER DEFAULT '1' NOT NULL;

ALTER TABLE users ADD CONSTRAINT fk_users_team_id_teams FOREIGN KEY(team_id) REFERENCES teams (id);

ALTER TABLE users ALTER COLUMN team_id DROP DEFAULT;
