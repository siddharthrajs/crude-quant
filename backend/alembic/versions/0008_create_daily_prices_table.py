"""create daily_prices table

One cleaned settlement-style price per contract per trading day, derived from
`hourly_bars` by app/db/build_daily_prices.py. The seasonality tab reads this
table instead of re-aggregating ~2M hourly bars on every request.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-12
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "daily_prices",
        sa.Column("contract_id", sa.Integer(), nullable=False),
        sa.Column("trade_date", sa.Date(), nullable=False),
        sa.Column("price", postgresql.DOUBLE_PRECISION(), nullable=False),
        sa.Column("bar_hour", sa.SmallInteger(), nullable=False),
        sa.PrimaryKeyConstraint("contract_id", "trade_date", name="pk_daily_prices"),
    )
    op.create_foreign_key("fk_daily_prices_contract_id_contracts", "daily_prices", "contracts", ["contract_id"], ["id"])


def downgrade() -> None:
    op.drop_constraint("fk_daily_prices_contract_id_contracts", "daily_prices", type_="foreignkey")
    op.drop_table("daily_prices")
