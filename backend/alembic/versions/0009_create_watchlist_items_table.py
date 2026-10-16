"""create watchlist_items table

A user's saved strategy combinations from the Seasonality tab: the weighted outright legs, the base range
measured on their price level, and the settings that range was measured with (so it can be refreshed).
The live price is never stored; the Watchlist tab prices the legs client-side off the tick stream.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-12
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "watchlist_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("legs", postgresql.JSONB(), nullable=False),
        sa.Column("legs_key", sa.String(length=400), nullable=False),
        sa.Column("settings", postgresql.JSONB(), nullable=False),
        sa.Column("range", postgresql.JSONB(), nullable=False),
        sa.Column("range_as_of", sa.Date(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "legs_key", name="uq_watchlist_items_user_id_legs_key"),
    )
    op.create_foreign_key("fk_watchlist_items_user_id_users", "watchlist_items", "users", ["user_id"], ["id"])
    op.create_index("ix_watchlist_items_user_id", "watchlist_items", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_watchlist_items_user_id", table_name="watchlist_items")
    op.drop_constraint("fk_watchlist_items_user_id_users", "watchlist_items", type_="foreignkey")
    op.drop_table("watchlist_items")
