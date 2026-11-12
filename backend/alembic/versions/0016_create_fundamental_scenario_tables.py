"""create the `fnd` schema: daily fundamental reports, the facts pulled from them, and the scenario forecasts

One run per report date. A run reads that day's Platts reports (`fnd.reports`, condensed into `fnd.report_facts`),
scores the open scenarios (`fnd.resolutions`), then writes a probability and a Brent range for every open scenario
(`fnd.forecasts`). Scenarios belong to themes and come in mutually exclusive sets of three (bearish / base /
bullish) that share a horizon, so the probabilities in a set sum to 100 on each run. Only the what is stored:
labels, tests, numbers and outcomes, not the reasoning behind them.

Completing a run (status -> 'complete') fires pg_notify('fnd_run', <run id>), the same push pattern as
cns.headlines -> 'cns_headline'.

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-11
"""

from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS fnd")

    op.execute("""
    CREATE TABLE fnd.reports (
        id            serial PRIMARY KEY,
        report_date   date NOT NULL,
        product       text NOT NULL CHECK (product IN ('oilgram_news', 'oilgram_price')),
        source        text NOT NULL,
        file_sha256   text NOT NULL UNIQUE,
        pages         integer,
        text_chars    integer,
        loaded_at     timestamptz NOT NULL DEFAULT now(),
        UNIQUE (report_date, product)
    )""")

    # Condensed, structured facts from one report date (both products). Input to the run, kept so a run can be
    # reproduced without re-reading the PDFs.
    op.execute("""
    CREATE TABLE fnd.report_facts (
        report_date   date PRIMARY KEY,
        facts         jsonb NOT NULL,
        extractor     text NOT NULL,
        extracted_at  timestamptz NOT NULL DEFAULT now()
    )""")

    op.execute("""
    CREATE TABLE fnd.runs (
        id            serial PRIMARY KEY,
        run_date      date NOT NULL,
        mode          text NOT NULL CHECK (mode IN ('backtest', 'live')),
        status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'complete')),
        ref_contract  text NOT NULL,
        ref_price     double precision NOT NULL,
        analyst       text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        UNIQUE (run_date, mode)
    )""")

    op.execute("""
    CREATE TABLE fnd.themes (
        id            serial PRIMARY KEY,
        key           text NOT NULL UNIQUE,
        name          text NOT NULL,
        impact        text NOT NULL CHECK (impact IN ('highest', 'high', 'medium', 'low')),
        first_run_id  integer NOT NULL REFERENCES fnd.runs(id),
        last_run_id   integer NOT NULL REFERENCES fnd.runs(id),
        status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dormant', 'closed'))
    )""")

    # A set of three mutually exclusive scenarios for one theme over one horizon.
    op.execute("""
    CREATE TABLE fnd.scenario_sets (
        id              serial PRIMARY KEY,
        theme_id        integer NOT NULL REFERENCES fnd.themes(id),
        created_run_id  integer NOT NULL REFERENCES fnd.runs(id),
        horizon_end     date NOT NULL,
        UNIQUE (theme_id, horizon_end)
    )""")

    # test_kind 'price': evaluated automatically from qh_settlements on horizon_end -- metric is one of
    #   brent_ref (settle of the run's ref contract), brent_m1, brent_m1m2, wti_m1, wti_brent_m1;
    #   op is '<', '>=' or 'between' (value_lo <= x < value_hi).
    # test_kind 'report': resolved from report facts up to horizon_end; test_text is the definition.
    op.execute("""
    CREATE TABLE fnd.scenarios (
        id          serial PRIMARY KEY,
        set_id      integer NOT NULL REFERENCES fnd.scenario_sets(id),
        direction   text NOT NULL CHECK (direction IN ('bearish', 'base', 'bullish')),
        label       text NOT NULL,
        test_kind   text NOT NULL CHECK (test_kind IN ('price', 'report')),
        metric      text,
        op          text CHECK (op IN ('<', '>=', 'between')),
        value_lo    double precision,
        value_hi    double precision,
        test_text   text NOT NULL,
        UNIQUE (set_id, direction)
    )""")

    op.execute("""
    CREATE TABLE fnd.forecasts (
        run_id       integer NOT NULL REFERENCES fnd.runs(id) ON DELETE CASCADE,
        scenario_id  integer NOT NULL REFERENCES fnd.scenarios(id),
        probability  double precision NOT NULL CHECK (probability BETWEEN 0 AND 100),
        brent_lo     double precision NOT NULL,
        brent_hi     double precision NOT NULL,
        PRIMARY KEY (run_id, scenario_id)
    )""")

    op.execute("""
    CREATE TABLE fnd.resolutions (
        scenario_id     integer PRIMARY KEY REFERENCES fnd.scenarios(id),
        resolved_date   date NOT NULL,
        outcome         text NOT NULL CHECK (outcome IN ('yes', 'no', 'void')),
        observed_value  double precision,
        source          text NOT NULL
    )""")

    op.execute("""
    CREATE FUNCTION fnd.runs_notify() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF NEW.status = 'complete' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'complete') THEN
            PERFORM pg_notify('fnd_run', NEW.id::text);
        END IF;
        RETURN NEW;
    END $$""")
    op.execute("""
    CREATE TRIGGER runs_notify AFTER INSERT OR UPDATE OF status ON fnd.runs
        FOR EACH ROW EXECUTE FUNCTION fnd.runs_notify()""")


def downgrade() -> None:
    op.execute("DROP SCHEMA fnd CASCADE")
