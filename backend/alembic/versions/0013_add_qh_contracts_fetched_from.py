"""add qh_contracts.fetched_from

The trade date each contract's full history was fetched from, so that moving settings.qh_history_start earlier
re-fetches contracts that were loaded from a later start. Contracts loaded so far were fetched from 2019-01-01.

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-23
"""

from alembic import op
import sqlalchemy as sa

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("qh_contracts", sa.Column("fetched_from", sa.Date(), nullable=True))
    op.execute("UPDATE qh_contracts SET fetched_from = DATE '2019-01-01' WHERE synced_at IS NOT NULL")


def downgrade() -> None:
    op.drop_column("qh_contracts", "fetched_from")
