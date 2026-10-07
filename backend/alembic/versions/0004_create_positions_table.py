"""create positions table

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-25
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "positions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("book_id", sa.Integer(), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=False),
        sa.Column("linked_position_id", sa.Integer(), nullable=True),
        sa.Column("product", sa.String(length=32), nullable=False),
        sa.Column("strategy_code", sa.String(length=32), nullable=False),
        sa.Column("strategy_label", sa.String(length=120), nullable=False),
        sa.Column("tenor", sa.String(length=16), nullable=True),
        sa.Column("legs", postgresql.JSONB(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("side", sa.String(length=8), nullable=False),
        sa.Column("average_price", sa.Numeric(18, 6), nullable=False),
        sa.Column("stop_loss", sa.Numeric(18, 6), nullable=True),
        sa.Column("take_profit", sa.Numeric(18, 6), nullable=True),
        sa.Column("status", sa.String(length=8), nullable=False, server_default="open"),
        sa.Column("opened_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("exit_price", sa.Numeric(18, 6), nullable=True),
        sa.Column("realized_pnl", sa.Numeric(18, 6), nullable=True),
    )
    op.create_foreign_key("fk_positions_book_id_books", "positions", "books", ["book_id"], ["id"])
    op.create_foreign_key("fk_positions_owner_id_users", "positions", "users", ["owner_id"], ["id"])
    op.create_foreign_key(
        "fk_positions_linked_position_id_positions", "positions", "positions", ["linked_position_id"], ["id"]
    )
    op.create_index("ix_positions_book_id", "positions", ["book_id"])
    op.create_index("ix_positions_book_id_status", "positions", ["book_id", "status"])


def downgrade() -> None:
    op.drop_index("ix_positions_book_id_status", table_name="positions")
    op.drop_index("ix_positions_book_id", table_name="positions")
    op.drop_constraint("fk_positions_linked_position_id_positions", "positions", type_="foreignkey")
    op.drop_constraint("fk_positions_owner_id_users", "positions", type_="foreignkey")
    op.drop_constraint("fk_positions_book_id_books", "positions", type_="foreignkey")
    op.drop_table("positions")
