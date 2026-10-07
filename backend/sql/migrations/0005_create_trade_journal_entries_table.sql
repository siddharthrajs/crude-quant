-- Exact SQL emitted by alembic/versions/0005_create_trade_journal_entries_table.py.
-- Regenerated with: alembic upgrade 0004:0005 --sql
-- Kept for reference/manual application; Alembic (not this file) is what
-- actually runs against the database.

CREATE TABLE trade_journal_entries (
    id SERIAL NOT NULL,
    book_id INTEGER NOT NULL,
    position_id INTEGER NOT NULL,
    owner_id INTEGER NOT NULL,
    product VARCHAR(32) NOT NULL,
    strategy_label VARCHAR(120) NOT NULL,
    tenor VARCHAR(16),
    side VARCHAR(8) NOT NULL,
    size INTEGER NOT NULL,
    average_price NUMERIC(18, 6) NOT NULL,
    exit_price NUMERIC(18, 6) NOT NULL,
    realized_pnl NUMERIC(18, 6) NOT NULL,
    stop_loss NUMERIC(18, 6),
    take_profit NUMERIC(18, 6),
    opened_at TIMESTAMP WITH TIME ZONE NOT NULL,
    closed_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

ALTER TABLE trade_journal_entries ADD CONSTRAINT fk_trade_journal_entries_book_id_books FOREIGN KEY(book_id) REFERENCES books (id);

ALTER TABLE trade_journal_entries ADD CONSTRAINT fk_trade_journal_entries_position_id_positions FOREIGN KEY(position_id) REFERENCES positions (id);

ALTER TABLE trade_journal_entries ADD CONSTRAINT fk_trade_journal_entries_owner_id_users FOREIGN KEY(owner_id) REFERENCES users (id);

CREATE INDEX ix_trade_journal_entries_book_id ON trade_journal_entries (book_id);
