-- Exact SQL emitted by alembic/versions/0004_create_positions_table.py.
-- Regenerated with: alembic upgrade 0003:0004 --sql
-- Kept for reference/manual application; Alembic (not this file) is what
-- actually runs against the database.

CREATE TABLE positions (
    id SERIAL NOT NULL,
    book_id INTEGER NOT NULL,
    owner_id INTEGER NOT NULL,
    linked_position_id INTEGER,
    product VARCHAR(32) NOT NULL,
    strategy_code VARCHAR(32) NOT NULL,
    strategy_label VARCHAR(120) NOT NULL,
    tenor VARCHAR(16),
    legs JSONB NOT NULL,
    size INTEGER NOT NULL,
    side VARCHAR(8) NOT NULL,
    average_price NUMERIC(18, 6) NOT NULL,
    stop_loss NUMERIC(18, 6),
    take_profit NUMERIC(18, 6),
    status VARCHAR(8) DEFAULT 'open' NOT NULL,
    opened_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    closed_at TIMESTAMP WITH TIME ZONE,
    exit_price NUMERIC(18, 6),
    realized_pnl NUMERIC(18, 6),
    PRIMARY KEY (id)
);

ALTER TABLE positions ADD CONSTRAINT fk_positions_book_id_books FOREIGN KEY(book_id) REFERENCES books (id);

ALTER TABLE positions ADD CONSTRAINT fk_positions_owner_id_users FOREIGN KEY(owner_id) REFERENCES users (id);

ALTER TABLE positions ADD CONSTRAINT fk_positions_linked_position_id_positions FOREIGN KEY(linked_position_id) REFERENCES positions (id);

CREATE INDEX ix_positions_book_id ON positions (book_id);

CREATE INDEX ix_positions_book_id_status ON positions (book_id, status);
