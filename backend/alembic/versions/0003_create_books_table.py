"""create books table (one personal book per user, one team book per team)

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-25
"""

from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "books",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("team_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_foreign_key("fk_books_user_id_users", "books", "users", ["user_id"], ["id"])
    op.create_foreign_key("fk_books_team_id_teams", "books", "teams", ["team_id"], ["id"])
    # A user has at most one personal book, a team at most one team book -- books of the other
    # kind leave the corresponding column null, so a plain unique index (nulls not equal) suffices.
    op.create_index("ix_books_user_id", "books", ["user_id"], unique=True)
    op.create_index("ix_books_team_id", "books", ["team_id"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_books_team_id", table_name="books")
    op.drop_index("ix_books_user_id", table_name="books")
    op.drop_constraint("fk_books_team_id_teams", "books", type_="foreignkey")
    op.drop_constraint("fk_books_user_id_users", "books", type_="foreignkey")
    op.drop_table("books")
