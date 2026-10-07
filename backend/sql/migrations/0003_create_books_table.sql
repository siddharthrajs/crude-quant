-- Exact SQL emitted by alembic/versions/0003_create_books_table.py.
-- Regenerated with: alembic upgrade 0002:0003 --sql
-- Kept for reference/manual application; Alembic (not this file) is what
-- actually runs against the database.

CREATE TABLE books (
    id SERIAL NOT NULL,
    kind VARCHAR(16) NOT NULL,
    user_id INTEGER,
    team_id INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

ALTER TABLE books ADD CONSTRAINT fk_books_user_id_users FOREIGN KEY(user_id) REFERENCES users (id);

ALTER TABLE books ADD CONSTRAINT fk_books_team_id_teams FOREIGN KEY(team_id) REFERENCES teams (id);

CREATE UNIQUE INDEX ix_books_user_id ON books (user_id);

CREATE UNIQUE INDEX ix_books_team_id ON books (team_id);
