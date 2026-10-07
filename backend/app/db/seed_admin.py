"""One-off CLI to create a user directly in Postgres.

There is no public registration endpoint by design -- this is how accounts
get created. Run once per account, from the backend/ directory:

    .venv\\Scripts\\python -m app.db.seed_admin --username admin --team-id 1 --superuser
    .venv\\Scripts\\python -m app.db.seed_admin --username admin --password "..." --team-id 1 --superuser

Omit --password to have one generated and printed once (it is not stored
anywhere -- save it immediately). Run `alembic upgrade head` first so the
users table exists.
"""

import argparse
import asyncio
import secrets

from sqlalchemy import select

from app.auth.security import hash_password
from app.db.base import async_session_maker
from app.db.models import User


async def create_user(username: str, password: str, team_id: int, is_superuser: bool) -> None:
    async with async_session_maker() as db:
        existing = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if existing is not None:
            raise SystemExit(f"User '{username}' already exists (id={existing.id})")

        user = User(username=username, password_hash=hash_password(password), team_id=team_id, is_superuser=is_superuser)
        db.add(user)
        await db.commit()
        await db.refresh(user)
        print(f"Created user '{user.username}' (id={user.id}, team_id={user.team_id}, superuser={user.is_superuser})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--username", required=True)
    parser.add_argument("--password", help="omit to generate a random password")
    parser.add_argument("--team-id", type=int, required=True, help="id of the team this user belongs to")
    parser.add_argument("--superuser", action="store_true", help="mark this user as a superuser")
    args = parser.parse_args()

    password = args.password or secrets.token_urlsafe(18)
    generated = args.password is None

    asyncio.run(create_user(args.username, password, args.team_id, args.superuser))

    if generated:
        print(f"Generated password (save this now, it will not be shown again): {password}")


if __name__ == "__main__":
    main()
