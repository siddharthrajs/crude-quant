"""create trade_journal_entries table

Revision ID: 0005
Revises: 0004
Create Date: 2026-09-25
"""

from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "trade_journal_entries",
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
        "fk_trade_journal_entries_book_id_books", "trade_journal_entries", "books", ["book_id"], ["id"]
    )
    op.create_foreign_key(
        "fk_trade_journal_entries_position_id_positions",
        "trade_journal_entries", "positions", ["position_id"], ["id"],
    )
    op.create_foreign_key(
        "fk_trade_journal_entries_owner_id_users", "trade_journal_entries", "users", ["owner_id"], ["id"]
    )
    op.create_index("ix_trade_journal_entries_book_id", "trade_journal_entries", ["book_id"])


def downgrade() -> None:
    op.drop_index("ix_trade_journal_entries_book_id", table_name="trade_journal_entries")
    op.drop_constraint("fk_trade_journal_entries_owner_id_users", "trade_journal_entries", type_="foreignkey")
    op.drop_constraint(
        "fk_trade_journal_entries_position_id_positions", "trade_journal_entries", type_="foreignkey"
    )
    op.drop_constraint("fk_trade_journal_entries_book_id_books", "trade_journal_entries", type_="foreignkey")
    op.drop_table("trade_journal_entries")
