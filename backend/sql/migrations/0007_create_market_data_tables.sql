-- Exact SQL emitted by alembic/versions/0007_create_market_data_tables.py.
-- Regenerated with: alembic upgrade 0006:0007 --sql
-- Kept for reference/manual application; Alembic (not this file) is what
-- actually runs against the database.

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

