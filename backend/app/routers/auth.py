from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_superuser
from app.auth.security import create_access_token, hash_password, verify_password
from app.db.base import get_db
from app.db.models import (
    Book, PaperPosition, PaperPositionFill, PaperTradeJournalEntry, Position, PositionFill, Team,
    TradeJournalEntry, User, WatchlistItem,
)
from app.schemas import (
    AccountUpdateIn, AccountUpdateOut, TokenOut, UserCreateIn, UserDeleteIn, UserDeleteOut, UserOut,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=TokenOut)
async def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_db),
) -> TokenOut:
    user = (await db.execute(select(User).where(User.username == form_data.username))).scalar_one_or_none()
    if user is None or not user.is_active or not verify_password(form_data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = create_access_token(subject=user.username)
    return TokenOut(access_token=token)


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)) -> User:
    return user


@router.patch("/me", response_model=AccountUpdateOut)
async def update_me(
    body: AccountUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> AccountUpdateOut:
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Current password is incorrect")

    if body.new_username is None and body.new_password is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Nothing to update")

    if body.new_username and body.new_username != user.username:
        existing = (await db.execute(select(User).where(User.username == body.new_username))).scalar_one_or_none()
        if existing is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already exists")
        user.username = body.new_username

    if body.new_password:
        user.password_hash = hash_password(body.new_password)

    await db.commit()
    await db.refresh(user)
    # The JWT's subject is the username -- issue a fresh token so a rename doesn't log the caller out.
    token = create_access_token(subject=user.username)
    return AccountUpdateOut(user=UserOut.model_validate(user), access_token=token)


@router.get("/users", response_model=list[UserOut])
async def list_users(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_superuser),
) -> list[User]:
    return list((await db.execute(select(User).order_by(User.username))).scalars().all())


@router.post("/users/delete", response_model=UserDeleteOut)
async def delete_users(
    body: UserDeleteIn,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_superuser),
) -> UserDeleteOut:
    """Permanently deletes the accounts and everything they own: positions, fills, journal entries,
    watchlist items and personal books (live and paper)."""
    ids = set(body.ids)
    if admin.id in ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You can't delete your own account")
    found = set((await db.execute(select(User.id).where(User.id.in_(ids)))).scalars().all())
    if found != ids:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Unknown user id(s): {sorted(ids - found)}")

    for position, fill, journal in (
        (Position, PositionFill, TradeJournalEntry),
        (PaperPosition, PaperPositionFill, PaperTradeJournalEntry),
    ):
        owned = select(position.id).where(position.owner_id.in_(ids))
        await db.execute(update(position).where(position.linked_position_id.in_(owned)).values(linked_position_id=None))
        await db.execute(delete(fill).where(fill.position_id.in_(owned)))
        await db.execute(delete(journal).where(or_(journal.owner_id.in_(ids), journal.position_id.in_(owned))))
        await db.execute(delete(position).where(position.owner_id.in_(ids)))
    await db.execute(delete(WatchlistItem).where(WatchlistItem.user_id.in_(ids)))
    await db.execute(delete(Book).where(Book.kind == "personal", Book.user_id.in_(ids)))
    await db.execute(delete(User).where(User.id.in_(ids)))
    await db.commit()
    return UserDeleteOut(deleted=len(ids))


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreateIn,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_superuser),
) -> User:
    existing = (await db.execute(select(User).where(User.username == body.username))).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already exists")

    team = (await db.execute(select(Team).where(Team.id == body.team_id))).scalar_one_or_none()
    if team is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown team")

    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        team_id=body.team_id,
        role=body.role,
        is_superuser=body.role == "admin",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user
