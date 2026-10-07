"""create teams table and link users to a team

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-25
"""

from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "teams",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_teams_name", "teams", ["name"], unique=True)

    # Seed the one team that exists today with a fixed id so it can be
    # referenced as the default for pre-existing users below.
    teams = sa.table("teams", sa.column("id", sa.Integer()), sa.column("name", sa.String()))
    op.bulk_insert(teams, [{"id": 1, "name": "Money Ballers"}])
    op.execute("SELECT setval(pg_get_serial_sequence('teams', 'id'), (SELECT MAX(id) FROM teams))")

    op.add_column("users", sa.Column("team_id", sa.Integer(), nullable=False, server_default="1"))
    op.create_foreign_key("fk_users_team_id_teams", "users", "teams", ["team_id"], ["id"])
    op.alter_column("users", "team_id", server_default=None)


def downgrade() -> None:
    op.drop_constraint("fk_users_team_id_teams", "users", type_="foreignkey")
    op.drop_column("users", "team_id")
    op.drop_index("ix_teams_name", table_name="teams")
    op.drop_table("teams")
