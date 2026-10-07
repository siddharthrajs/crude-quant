-- Reference DDL for the current schema, kept in sync with alembic/versions/.
-- This file documents the schema for humans; it is not executed by the app
-- or by Alembic -- migrations under alembic/versions/ are the source of
-- truth. Regenerate/update this file by hand (or via `pg_dump --schema-only`)
-- whenever a new migration lands.

-- Migration 0007: contracts and hourly_bars (historical market data)
CREATE TABLE contracts (
    id SERIAL NOT NULL,
    product VARCHAR(16) NOT NULL,
    symbol VARCHAR(16) NOT NULL,
    delivery_month DATE NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT uq_contracts_symbol UNIQUE (symbol),
    CONSTRAINT uq_contracts_product_delivery_month UNIQUE (product, delivery_month)
);

CREATE TABLE hourly_bars (
    contract_id INTEGER NOT NULL,
    ts TIMESTAMP WITH TIME ZONE NOT NULL,
    source_generic SMALLINT NOT NULL,
    bid DOUBLE PRECISION,
    ask DOUBLE PRECISION,
    bid_size INTEGER,
    ask_size INTEGER,
    volume INTEGER DEFAULT '0' NOT NULL,
    CONSTRAINT pk_hourly_bars PRIMARY KEY (contract_id, ts)
);

ALTER TABLE hourly_bars ADD CONSTRAINT fk_hourly_bars_contract_id_contracts FOREIGN KEY(contract_id) REFERENCES contracts (id);

CREATE INDEX ix_hourly_bars_ts ON hourly_bars (ts);

-- Migration 0005: trade_journal_entries table
CREATE TABLE trade_journal_entries (
    id             SERIAL PRIMARY KEY,
    book_id        INTEGER      NOT NULL REFERENCES books (id),
    position_id    INTEGER      NOT NULL REFERENCES positions (id),
    owner_id       INTEGER      NOT NULL REFERENCES users (id),
    product        VARCHAR(32)  NOT NULL,
    strategy_label VARCHAR(120) NOT NULL,
    tenor          VARCHAR(16),
    side           VARCHAR(8)   NOT NULL,
    size           INTEGER      NOT NULL,
    average_price  NUMERIC(18,6) NOT NULL,
    exit_price     NUMERIC(18,6) NOT NULL,
    realized_pnl   NUMERIC(18,6) NOT NULL,
    stop_loss      NUMERIC(18,6),
    take_profit    NUMERIC(18,6),
    opened_at      TIMESTAMPTZ  NOT NULL,
    closed_at      TIMESTAMPTZ  NOT NULL,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX ix_trade_journal_entries_book_id ON trade_journal_entries (book_id);

-- Migration 0004: positions table
CREATE TABLE positions (
    id                  SERIAL PRIMARY KEY,
    book_id             INTEGER      NOT NULL REFERENCES books (id),
    owner_id            INTEGER      NOT NULL REFERENCES users (id),
    linked_position_id  INTEGER      REFERENCES positions (id),
    product             VARCHAR(32)  NOT NULL,
    strategy_code       VARCHAR(32)  NOT NULL,
    strategy_label      VARCHAR(120) NOT NULL,
    tenor               VARCHAR(16),
    legs                JSONB        NOT NULL,
    size                INTEGER      NOT NULL,
    side                VARCHAR(8)   NOT NULL,
    average_price       NUMERIC(18,6) NOT NULL,
    stop_loss           NUMERIC(18,6),
    take_profit         NUMERIC(18,6),
    status              VARCHAR(8)   NOT NULL DEFAULT 'open',
    opened_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    closed_at           TIMESTAMPTZ,
    exit_price          NUMERIC(18,6),
    realized_pnl        NUMERIC(18,6)
);

CREATE INDEX ix_positions_book_id ON positions (book_id);
CREATE INDEX ix_positions_book_id_status ON positions (book_id, status);

-- Migration 0003: books table (one personal book per user, one team book per team)
CREATE TABLE books (
    id         SERIAL PRIMARY KEY,
    kind       VARCHAR(16) NOT NULL,
    user_id    INTEGER REFERENCES users (id),
    team_id    INTEGER REFERENCES teams (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ix_books_user_id ON books (user_id);
CREATE UNIQUE INDEX ix_books_team_id ON books (team_id);

-- Migration 0002: teams table
CREATE TABLE teams (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ix_teams_name ON teams (name);

-- Migration 0001: users table (username/password auth)
-- Migration 0002: adds team_id (FK -> teams.id)
CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(64)  NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    team_id       INTEGER      NOT NULL REFERENCES teams (id),
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    is_superuser  BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ix_users_username ON users (username);
