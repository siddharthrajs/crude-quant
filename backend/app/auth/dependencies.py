"""Reusable auth dependency for protecting routes with a bearer token.

Not wired into the existing market-data routes yet -- add
`user: User = Depends(get_current_user)` to any route that should require
login.
"""

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import jwt

from app.auth.security import decode_access_token
from app.db.base import get_db
from app.db.models import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")

_credentials_exception = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Could not validate credentials",
    headers={"WWW-Authenticate": "Bearer"},
)


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    try:
        payload = decode_access_token(token)
    except jwt.PyJWTError:
        raise _credentials_exception

    username = payload.get("sub")
    if not username:
        raise _credentials_exception

    user = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if user is None or not user.is_active:
        raise _credentials_exception
    return user


async def require_superuser(user: User = Depends(get_current_user)) -> User:
    if not user.is_superuser:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Superuser access required")
    return user


async def require_manager(user: User = Depends(get_current_user)) -> User:
    """Managers (and admins, who can do everything a manager can)."""
    if user.role not in ("manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Manager access required")
    return user
