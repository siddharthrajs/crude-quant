from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, require_superuser
from app.auth.security import create_access_token, hash_password, verify_password
from app.db.base import get_db
from app.db.models import Team, User
from app.schemas import AccountUpdateIn, AccountUpdateOut, TokenOut, UserCreateIn, UserOut

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
        is_superuser=body.is_superuser,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user
