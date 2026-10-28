"""add entry/exit notes to positions and trade journal entries

`entry_note` on a position is why it was put on (Add position dialog); each journal entry it closes into
copies it, alongside the `exit_note` typed in the Close position dialog. Live and paper tables alike.

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-28
"""

from alembic import op
import sqlalchemy as sa

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None

POSITION_TABLES = ("positions", "paper_positions")
JOURNAL_TABLES = ("trade_journal_entries", "paper_trade_journal_entries")


def upgrade() -> None:
    for table in POSITION_TABLES:
        op.add_column(table, sa.Column("entry_note", sa.Text(), nullable=True))
    for table in JOURNAL_TABLES:
        op.add_column(table, sa.Column("entry_note", sa.Text(), nullable=True))
        op.add_column(table, sa.Column("exit_note", sa.Text(), nullable=True))


def downgrade() -> None:
    for table in JOURNAL_TABLES:
        op.drop_column(table, "exit_note")
        op.drop_column(table, "entry_note")
    for table in POSITION_TABLES:
        op.drop_column(table, "entry_note")
