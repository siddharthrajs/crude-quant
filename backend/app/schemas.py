from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Role = Literal["admin", "manager", "member"]


class InstrumentOut(BaseModel):
    item: str
    instrument_id: str
    product: str
    product_label: str
    tenor: str
    label: str
    instrument_type: str
    sort_key: list[int]


class LegIn(BaseModel):
    item: str
    weight: float


class LegOut(BaseModel):
    item: str
    weight: float


class StructureIn(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    legs: list[LegIn] = Field(min_length=1, max_length=12)


class StructureOut(BaseModel):
    id: str
    label: str
    legs: list[LegOut]
    product: str | None
    kind: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TeamOut(BaseModel):
    id: int
    name: str

    class Config:
        from_attributes = True


class UserCreateIn(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9._-]+$")
    password: str = Field(min_length=8, max_length=128)
    team_id: int
    role: Role = "member"


class UserOut(BaseModel):
    id: int
    username: str
    team_id: int
    is_active: bool
    is_superuser: bool
    role: Role
    created_at: datetime

    class Config:
        from_attributes = True


class UserDeleteIn(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=200)


class UserDeleteOut(BaseModel):
    deleted: int


class MemberOut(BaseModel):
    id: int
    username: str
    team_id: int

    class Config:
        from_attributes = True


class AccountUpdateIn(BaseModel):
    current_password: str
    new_username: str | None = Field(default=None, min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9._-]+$")
    new_password: str | None = Field(default=None, min_length=8, max_length=128)


class AccountUpdateOut(BaseModel):
    user: UserOut
    access_token: str
    token_type: str = "bearer"


class PositionCreateIn(BaseModel):
    product: str = Field(min_length=1, max_length=32)
    strategy_code: str = Field(min_length=1, max_length=32)
    strategy_label: str = Field(min_length=1, max_length=120)
    tenor: str | None = Field(default=None, max_length=16)
    legs: list[LegIn] = Field(min_length=1, max_length=12)
    size: int = Field(gt=0)
    side: Literal["long", "short"]
    average_price: float
    stop_loss: float | None = None
    take_profit: float | None = None
    share_with_team: bool = False


class PositionOut(BaseModel):
    id: int
    book_id: int
    owner_id: int
    owner_username: str
    linked_position_id: int | None
    product: str
    strategy_code: str
    strategy_label: str
    tenor: str | None
    legs: list[LegOut]
    size: int
    side: str
    average_price: float
    stop_loss: float | None
    take_profit: float | None
    status: str
    opened_at: datetime
    closed_at: datetime | None
    exit_price: float | None
    realized_pnl: float | None

    class Config:
        from_attributes = True


class PositionCloseIn(BaseModel):
    exit_price: float
    # Omitted (or equal to the position's own size) closes it fully; anything smaller leaves the
    # remainder open at its original average price -- a partial exit.
    size: int | None = Field(default=None, gt=0)


class FillOut(BaseModel):
    id: int
    size: int
    price: float
    created_at: datetime


class FillEditIn(BaseModel):
    # None = a new fill; otherwise the id of an existing fill being edited. Existing fills left out
    # of the request are deleted.
    id: int | None = None
    size: int = Field(gt=0)
    price: float


class PositionEditIn(BaseModel):
    fills: list[FillEditIn] = Field(min_length=1)
    stop_loss: float | None = None
    take_profit: float | None = None


class JournalEntryOut(BaseModel):
    id: int
    book_id: int
    position_id: int
    owner_id: int
    owner_username: str
    product: str
    strategy_label: str
    tenor: str | None
    side: str
    size: int
    average_price: float
    exit_price: float
    realized_pnl: float
    stop_loss: float | None
    take_profit: float | None
    opened_at: datetime
    closed_at: datetime

    class Config:
        from_attributes = True


class JournalDeleteIn(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=500)
