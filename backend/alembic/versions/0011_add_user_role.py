"""add users.role (admin / manager / member)

Existing superusers become admins, everyone else a member. `is_superuser` stays as the admin flag
(kept in sync by the app: is_superuser == (role == 'admin')).

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-14
"""

from alembic import op
import sqlalchemy as sa

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("role", sa.String(length=16), nullable=False, server_default="member"))
    op.execute("UPDATE users SET role = 'admin' WHERE is_superuser")
    op.create_check_constraint("ck_users_role", "users", "role IN ('admin', 'manager', 'member')")


def downgrade() -> None:
    op.drop_constraint("ck_users_role", "users", type_="check")
    op.drop_column("users", "role")
