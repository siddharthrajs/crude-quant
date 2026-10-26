"""create qh_contracts and qh_daily_bars tables

Daily bars per contract (CL, CO, WTCLCO) pulled from the QH Data API's /ohlc endpoint by app/qh/sync.py, and
each contract's delivery month and expiry, from which the generic slots (c1, c2, ...) are derived.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-23
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "qh_contracts",
        sa.Column("code", sa.String(length=24), primary_key=True),
        sa.Column("product", sa.String(length=16), nullable=False),
        sa.Column("delivery_month", sa.Date(), nullable=False),
        sa.Column("expiry", sa.Date(), nullable=False),
        sa.Column("expiry_source", sa.String(length=8), nullable=False),
        sa.Column("first_bar", sa.Date(), nullable=True),
        sa.Column("last_bar", sa.Date(), nullable=True),
        sa.Column("synced_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_qh_contracts_product", "qh_contracts", ["product"])

    op.create_table(
        "qh_daily_bars",
        sa.Column("code", sa.String(length=24), nullable=False),
        sa.Column("trade_date", sa.Date(), nullable=False),
        sa.Column("open", postgresql.DOUBLE_PRECISION(), nullable=False),
        sa.Column("high", postgresql.DOUBLE_PRECISION(), nullable=False),
        sa.Column("low", postgresql.DOUBLE_PRECISION(), nullable=False),
        sa.Column("close", postgresql.DOUBLE_PRECISION(), nullable=False),
        sa.Column("volume", sa.Integer(), nullable=False),
        sa.Column("buy_volume", sa.Integer(), nullable=True),
        sa.Column("sell_volume", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("code", "trade_date", name="pk_qh_daily_bars"),
    )
    op.create_foreign_key("fk_qh_daily_bars_code_qh_contracts", "qh_daily_bars", "qh_contracts", ["code"], ["code"])
    op.create_index("ix_qh_daily_bars_trade_date", "qh_daily_bars", ["trade_date"])


def downgrade() -> None:
    op.drop_index("ix_qh_daily_bars_trade_date", table_name="qh_daily_bars")
    op.drop_constraint("fk_qh_daily_bars_code_qh_contracts", "qh_daily_bars", type_="foreignkey")
    op.drop_table("qh_daily_bars")
    op.drop_index("ix_qh_contracts_product", table_name="qh_contracts")
    op.drop_table("qh_contracts")
