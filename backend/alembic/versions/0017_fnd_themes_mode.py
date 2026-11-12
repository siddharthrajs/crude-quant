"""fnd.themes: key unique per mode, so live runs can reuse the backtest's theme keys

A theme belongs to the runs of one mode (backtest or live). `mode` is filled from the theme's first run.

Revision ID: 0017
Revises: 0016
Create Date: 2026-11-12
"""

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE fnd.themes ADD COLUMN mode text")
    op.execute("UPDATE fnd.themes t SET mode = r.mode FROM fnd.runs r WHERE r.id = t.first_run_id")
    op.execute("ALTER TABLE fnd.themes ALTER COLUMN mode SET NOT NULL")
    op.execute("ALTER TABLE fnd.themes ADD CONSTRAINT themes_mode_check CHECK (mode IN ('backtest', 'live'))")
    op.execute("ALTER TABLE fnd.themes DROP CONSTRAINT themes_key_key")
    op.execute("ALTER TABLE fnd.themes ADD CONSTRAINT themes_mode_key_key UNIQUE (mode, key)")


def downgrade() -> None:
    op.execute("ALTER TABLE fnd.themes DROP CONSTRAINT themes_mode_key_key")
    op.execute("ALTER TABLE fnd.themes ADD CONSTRAINT themes_key_key UNIQUE (key)")
    op.execute("ALTER TABLE fnd.themes DROP COLUMN mode")
