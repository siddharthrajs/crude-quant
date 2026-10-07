"""create contracts and hourly_bars tables

Historical market data loaded from the Reuters hourly CSVs (see
app/db/load_hourly_bars.py). One row per named futures contract, and one row
per contract per hour holding the bar-close quote and the bar's volume.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-07
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "contracts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("product", sa.String(length=16), nullable=False),
        sa.Column("symbol", sa.String(length=16), nullable=False),
        sa.Column("delivery_month", sa.Date(), nullable=False),
        sa.UniqueConstraint("symbol", name="uq_contracts_symbol"),
        sa.UniqueConstraint("product", "delivery_month", name="uq_contracts_product_delivery_month"),
    )

    op.create_table(
        "hourly_bars",
        sa.Column("contract_id", sa.Integer(), nullable=False),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_generic", sa.SmallInteger(), nullable=False),
        sa.Column("bid", postgresql.DOUBLE_PRECISION(), nullable=True),
        sa.Column("ask", postgresql.DOUBLE_PRECISION(), nullable=True),
        sa.Column("bid_size", sa.Integer(), nullable=True),
        sa.Column("ask_size", sa.Integer(), nullable=True),
        sa.Column("volume", sa.Integer(), nullable=False, server_default="0"),
        sa.PrimaryKeyConstraint("contract_id", "ts", name="pk_hourly_bars"),
    )
    op.create_foreign_key("fk_hourly_bars_contract_id_contracts", "hourly_bars", "contracts", ["contract_id"], ["id"])
    op.create_index("ix_hourly_bars_ts", "hourly_bars", ["ts"])


def downgrade() -> None:
    op.drop_index("ix_hourly_bars_ts", table_name="hourly_bars")
    op.drop_constraint("fk_hourly_bars_contract_id_contracts", "hourly_bars", type_="foreignkey")
    op.drop_table("hourly_bars")
    op.drop_table("contracts")
