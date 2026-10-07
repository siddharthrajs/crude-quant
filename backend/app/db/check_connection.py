"""Quick DB connectivity check using the app's configured DATABASE_URL.

    .venv\\Scripts\\python -m app.db.check_connection
"""

import asyncio

from sqlalchemy import text

from app.config import settings
from app.db.base import engine


async def main() -> None:
    print(f"Connecting to {settings.database_url.split('@')[-1]} ...")
    async with engine.connect() as conn:
        version = (await conn.execute(text("select version()"))).scalar()
    print("Connected OK:", version)


if __name__ == "__main__":
    asyncio.run(main())
