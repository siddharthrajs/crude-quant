"""create qh_settlements and qh_sync_state tables

Daily settlement prices per contract from the QH Data API's /common/dailymarketdata endpoint (app/qh/sync.py).
The Strategy Lab prices strategies from these: a settlement exists for every listed contract every day, whether or
not it traded, and every leg settles at the same moment -- last trades of thin months do not (qh_daily_bars).

qh_sync_state records, per product, the trade date the settlement history was loaded from.

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-23
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "qh_settlements",
        sa.Column("code", sa.String(length=24), nullable=False),
        sa.Column("trade_date", sa.Date(), nullable=False),
        sa.Column("settle", postgresql.DOUBLE_PRECISION(), nullable=False),
        sa.Column("volume", sa.Integer(), nullable=True),
        sa.Column("oi", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("code", "trade_date", name="pk_qh_settlements"),
    )
    op.create_foreign_key("fk_qh_settlements_code_qh_contracts", "qh_settlements", "qh_contracts", ["code"], ["code"])
    op.create_index("ix_qh_settlements_trade_date", "qh_settlements", ["trade_date"])

    op.create_table(
        "qh_sync_state",
        sa.Column("product", sa.String(length=16), primary_key=True),
        sa.Column("settlements_from", sa.Date(), nullable=True),
        sa.Column("settlements_synced_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("qh_sync_state")
    op.drop_index("ix_qh_settlements_trade_date", table_name="qh_settlements")
    op.drop_constraint("fk_qh_settlements_code_qh_contracts", "qh_settlements", type_="foreignkey")
    op.drop_table("qh_settlements")
