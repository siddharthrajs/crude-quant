"""create position_fills and paper_position_fills tables

The individual entries (partial fills) netted into an open position's average price. Existing open
positions are backfilled with a single fill at their current size and average price.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-12
"""

from alembic import op
import sqlalchemy as sa

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

_TABLES = (("position_fills", "positions"), ("paper_position_fills", "paper_positions"))


def upgrade() -> None:
    for fills, positions in _TABLES:
        op.create_table(
            fills,
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("position_id", sa.Integer(), nullable=False),
            sa.Column("size", sa.Integer(), nullable=False),
            sa.Column("price", sa.Numeric(18, 6), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )
        op.create_foreign_key(f"fk_{fills}_position_id_{positions}", fills, positions, ["position_id"], ["id"])
        op.create_index(f"ix_{fills}_position_id", fills, ["position_id"])
        op.execute(
            f"INSERT INTO {fills} (position_id, size, price, created_at) "
            f"SELECT id, size, average_price, opened_at FROM {positions} WHERE status = 'open'"
        )


def downgrade() -> None:
    op.drop_table("paper_position_fills")
    op.drop_table("position_fills")
