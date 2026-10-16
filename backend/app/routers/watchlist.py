"""The signed-in user's watchlist of Seasonality combinations.

An item stores what to watch (weighted outright legs) and two base ranges to watch it against, measured over past
years with the same settings: the range of its price LEVEL and the range of its DAILY CHANGE. The live price and the
live move itself are worked out in the browser off the tick stream.
"""

import math
import re
from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.db.base import get_db
from app.db.models import User, WatchlistItem

router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])

TENOR_RE = re.compile(r"^[FGHJKMNQUVXZ]\d{2}$")


class WatchLeg(BaseModel):
    product: Literal["WTI", "Brent", "CLBZZ"]
    tenor: str
    weight: float

    @field_validator("tenor")
    @classmethod
    def _tenor(cls, v: str) -> str:
        if not TENOR_RE.match(v):
            raise ValueError("tenor must look like 'K27'")
        return v

    @field_validator("weight")
    @classmethod
    def _weight(cls, v: float) -> float:
        if not math.isfinite(v) or v == 0:
            raise ValueError("weight must be a non-zero number")
        return v


class WatchRange(BaseModel):
    """A base range in price units, already rounded to ticks by the client."""

    lo: float
    mid: float
    hi: float
    sd: float
    n: int

    @field_validator("lo", "mid", "hi", "sd")
    @classmethod
    def _finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("range values must be finite")
        return v


class WatchRanges(BaseModel):
    """The two ranges an item watches. Either may be missing when there was too little data to measure it."""

    level: WatchRange | None = None
    change: WatchRange | None = None


class WatchSettings(BaseModel):
    """What the ranges were measured with, kept so they can be refreshed the same way later."""

    shifts: list[int] = Field(min_length=1, max_length=8)
    min_days: int = Field(ge=0)
    max_days: int = Field(ge=0)
    sigma: float = Field(gt=0, le=10)
    basis: Literal["others", "all"]
    # Whether one-off spike days were dropped from the daily-change range (the level range is never despiked).
    remove_spikes: bool = False


class WatchlistIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    legs: list[WatchLeg] = Field(min_length=1, max_length=40)
    settings: WatchSettings
    ranges: WatchRanges
    range_as_of: date | None = None


class WatchlistRangeIn(BaseModel):
    settings: WatchSettings
    ranges: WatchRanges
    range_as_of: date | None = None


class WatchlistOut(BaseModel):
    id: int
    name: str
    legs: list[WatchLeg]
    settings: WatchSettings
    ranges: WatchRanges
    range_as_of: date | None
    created_at: datetime
    updated_at: datetime


def _legs_key(legs: list[WatchLeg]) -> str:
    return "|".join(f"{leg.product}:{leg.tenor}:{leg.weight:g}" for leg in sorted(legs, key=lambda l: (l.product, l.tenor)))


def _check(ranges: WatchRanges) -> None:
    present = [r for r in (ranges.level, ranges.change) if r is not None]
    if not present:
        raise HTTPException(status_code=422, detail="At least one range is required")
    if any(r.lo > r.hi for r in present):
        raise HTTPException(status_code=422, detail="Range low is above range high")


def _ranges_of(item: WatchlistItem) -> dict:
    """The item's two ranges. Rows saved before an item held both are one flat range of `settings.mode`; keep what maps."""
    stored = item.range
    if "lo" not in stored:
        return stored
    mode = item.settings.get("mode", "level")
    return {mode: stored} if mode in ("level", "change") else {}


def _out(item: WatchlistItem) -> WatchlistOut:
    return WatchlistOut(
        id=item.id,
        name=item.name,
        legs=item.legs,
        settings=item.settings,
        ranges=_ranges_of(item),
        range_as_of=item.range_as_of,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


async def _owned(db: AsyncSession, user: User, item_id: int) -> WatchlistItem:
    item = (await db.execute(select(WatchlistItem).where(WatchlistItem.id == item_id, WatchlistItem.user_id == user.id))).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Watchlist item not found")
    return item


@router.get("", response_model=list[WatchlistOut])
async def list_items(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> list[WatchlistOut]:
    rows = (await db.execute(select(WatchlistItem).where(WatchlistItem.user_id == user.id).order_by(WatchlistItem.created_at))).scalars().all()
    return [_out(row) for row in rows]


@router.post("", response_model=WatchlistOut, status_code=status.HTTP_201_CREATED)
async def add_item(body: WatchlistIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> WatchlistOut:
    _check(body.ranges)
    key = _legs_key(body.legs)
    existing = (await db.execute(select(WatchlistItem.id).where(WatchlistItem.user_id == user.id, WatchlistItem.legs_key == key))).first()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This combination is already on your watchlist")
    item = WatchlistItem(
        user_id=user.id,
        name=body.name,
        legs=[leg.model_dump() for leg in body.legs],
        legs_key=key,
        settings=body.settings.model_dump(),
        range=body.ranges.model_dump(),
        range_as_of=body.range_as_of,
    )
    db.add(item)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This combination is already on your watchlist")
    await db.refresh(item)
    return _out(item)


@router.patch("/{item_id}", response_model=WatchlistOut)
async def refresh_range(item_id: int, body: WatchlistRangeIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> WatchlistOut:
    _check(body.ranges)
    item = await _owned(db, user, item_id)
    item.settings = body.settings.model_dump()
    item.range = body.ranges.model_dump()
    item.range_as_of = body.range_as_of
    await db.commit()
    await db.refresh(item)
    return _out(item)


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_item(item_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    item = await _owned(db, user, item_id)
    await db.delete(item)
    await db.commit()
