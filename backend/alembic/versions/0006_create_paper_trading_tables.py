"""create paper_positions and paper_trade_journal_entries tables

Simulated twins of `positions` / `trade_journal_entries` for the Paper Trade tab.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-06
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "paper_positions",
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
    op.create_foreign_key("fk_paper_positions_book_id_books", "paper_positions", "books", ["book_id"], ["id"])
    op.create_foreign_key("fk_paper_positions_owner_id_users", "paper_positions", "users", ["owner_id"], ["id"])
    op.create_foreign_key(
        "fk_paper_positions_linked_position_id_paper_positions",
        "paper_positions", "paper_positions", ["linked_position_id"], ["id"],
    )
    op.create_index("ix_paper_positions_book_id", "paper_positions", ["book_id"])
    op.create_index("ix_paper_positions_book_id_status", "paper_positions", ["book_id", "status"])

    op.create_table(
        "paper_trade_journal_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("book_id", sa.Integer(), nullable=False),
        sa.Column("position_id", sa.Integer(), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=False),
        sa.Column("product", sa.String(length=32), nullable=False),
        sa.Column("strategy_label", sa.String(length=120), nullable=False),
        sa.Column("tenor", sa.String(length=16), nullable=True),
        sa.Column("side", sa.String(length=8), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("average_price", sa.Numeric(18, 6), nullable=False),
        sa.Column("exit_price", sa.Numeric(18, 6), nullable=False),
        sa.Column("realized_pnl", sa.Numeric(18, 6), nullable=False),
        sa.Column("stop_loss", sa.Numeric(18, 6), nullable=True),
        sa.Column("take_profit", sa.Numeric(18, 6), nullable=True),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_foreign_key(
        "fk_paper_trade_journal_entries_book_id_books", "paper_trade_journal_entries", "books", ["book_id"], ["id"]
    )
    op.create_foreign_key(
        "fk_paper_trade_journal_entries_position_id_paper_positions",
        "paper_trade_journal_entries", "paper_positions", ["position_id"], ["id"],
    )
    op.create_foreign_key(
        "fk_paper_trade_journal_entries_owner_id_users", "paper_trade_journal_entries", "users", ["owner_id"], ["id"]
    )
    op.create_index("ix_paper_trade_journal_entries_book_id", "paper_trade_journal_entries", ["book_id"])


def downgrade() -> None:
    op.drop_table("paper_trade_journal_entries")
    op.drop_table("paper_positions")
