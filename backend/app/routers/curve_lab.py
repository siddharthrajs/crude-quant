"""Curve lab: how the whole fly curve behaves around one anchor fly.

A "generic fly k" is the k-th 1-month butterfly from the front: c(k) - 2*c(k+1) + c(k+2), where c(1) is the
first contract that has not expired on that day. So fly 3 is a different set of contracts as time passes, which
gives it years of history (a specific contract's fly only lives about a year).

Two views come out of one request, both read from `daily_prices`:
  * correlation of every fly against every other, on daily changes and on levels. A change is taken on the
    contracts of the day's own fly (today's price minus yesterday's price of the same contracts), so a roll
    never shows up as a jump;
  * the curve conditioned on the anchor fly sitting in a range: for each fly, the spread of its level across
    every day the anchor was inside [lo, hi], next to its unconditional spread and the latest curve.
"""

from collections import defaultdict
from datetime import date, timedelta
from math import sqrt
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.db.base import get_db
from app.db.models import User
from app.routers.seasonality import DB_PRODUCT, expiry_date

router = APIRouter(prefix="/api/curve-lab", tags=["curve-lab"])

MAX_DEPTH = 12
# Matches further apart than this many calendar days belong to different episodes.
EPISODE_GAP_DAYS = 7


class CurveLabIn(BaseModel):
    product: Literal["WTI", "Brent", "CLBZZ"] = "WTI"
    # Flies 1..depth are analysed; fly k needs contracts k..k+2 months out.
    depth: int = Field(default=MAX_DEPTH, ge=3, le=MAX_DEPTH)
    anchor: int = Field(default=3, ge=1, le=MAX_DEPTH)
    lo: float
    hi: float
    # Only days on or after this date count (None = all history).
    start: date | None = None
    # Correlations use only the most recent N trading days (None = the whole sample).
    window_days: int | None = Field(default=None, ge=20)

    @model_validator(mode="after")
    def _check(self) -> "CurveLabIn":
        if self.anchor > self.depth:
            raise ValueError("anchor must be within depth")
        if self.lo > self.hi:
            self.lo, self.hi = self.hi, self.lo
        return self


class Spread(BaseModel):
    """Distribution of one fly's level over a set of days."""

    fly: int
    n: int
    mean: float | None
    p10: float | None
    p25: float | None
    p50: float | None
    p75: float | None
    p90: float | None


class Matrix(BaseModel):
    """Pairwise Pearson correlations between flies (None where fewer than 2 shared days) and the shared-day counts."""

    corr: list[list[float | None]]
    n: list[list[int]]


class Conditional(BaseModel):
    n_days: int
    n_episodes: int
    first: date | None
    last: date | None
    by_year: dict[int, int]
    matched_dates: list[date]
    spreads: list[Spread]


class CurveLabOut(BaseModel):
    product: str
    flies: list[int]
    anchor: int
    lo: float
    hi: float
    first: date | None
    last: date | None
    n_days: int
    latest_date: date | None
    latest: list[float | None]
    corr_change: Matrix
    corr_level: Matrix
    unconditional: list[Spread]
    conditional: Conditional


def month_add(d: date, k: int) -> date:
    n = d.year * 12 + d.month - 1 + k
    return date(n // 12, n % 12 + 1, 1)


def percentile(sorted_values: list[float], q: float) -> float:
    pos = (len(sorted_values) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def spread(fly: int, values: list[float]) -> Spread:
    if not values:
        return Spread(fly=fly, n=0, mean=None, p10=None, p25=None, p50=None, p75=None, p90=None)
    s = sorted(values)
    return Spread(
        fly=fly,
        n=len(s),
        mean=round(sum(s) / len(s), 4),
        **{name: round(percentile(s, q), 4) for name, q in (("p10", 0.1), ("p25", 0.25), ("p50", 0.5), ("p75", 0.75), ("p90", 0.9))},
    )


def pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 2:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx <= 0 or syy <= 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sqrt(sxx * syy)


def correlations(series: list[list[float | None]]) -> Matrix:
    """`series[i]` is fly i+1's value per day (None = no price); each pair uses only the days both have."""
    size = len(series)
    corr: list[list[float | None]] = [[None] * size for _ in range(size)]
    counts = [[0] * size for _ in range(size)]
    for i in range(size):
        for j in range(i, size):
            pairs = [(a, b) for a, b in zip(series[i], series[j]) if a is not None and b is not None]
            counts[i][j] = counts[j][i] = len(pairs)
            r = 1.0 if i == j and len(pairs) > 1 else pearson([p[0] for p in pairs], [p[1] for p in pairs])
            if r is not None:
                corr[i][j] = corr[j][i] = round(r, 4)
    return Matrix(corr=corr, n=counts)


@router.post("", response_model=CurveLabOut)
async def curve_lab(body: CurveLabIn, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)) -> CurveLabOut:
    product = DB_PRODUCT[body.product]
    rows = (
        await db.execute(
            text(
                "SELECT c.delivery_month, dp.trade_date, dp.price FROM contracts c "
                "JOIN daily_prices dp ON dp.contract_id = c.id WHERE c.product = :product"
            ),
            {"product": product},
        )
    ).all()
    if not rows:
        raise HTTPException(status_code=404, detail=f"No daily prices for {body.product}")

    prices: dict[date, dict[date, float]] = defaultdict(dict)
    months: set[date] = set()
    for delivery, trade_date, price in rows:
        prices[trade_date][delivery] = price
        months.add(delivery)
    expiries = {m: expiry_date(product, m) for m in months}
    days = sorted(prices)

    def fly(day: date, front: date, k: int) -> float | None:
        p = prices[day]
        legs = [p.get(month_add(front, k - 1 + i)) for i in range(3)]
        return None if any(v is None for v in legs) else legs[0] - 2 * legs[1] + legs[2]

    # Per trading day: each generic fly's level, and its change since the previous trading day on the same contracts.
    kept: list[date] = []
    level: list[list[float | None]] = [[] for _ in range(body.depth)]
    change: list[list[float | None]] = [[] for _ in range(body.depth)]
    for index, day in enumerate(days):
        if body.start and day < body.start:
            continue
        live = [m for m in months if expiries[m] > day]
        if not live:
            continue
        front = min(live)
        kept.append(day)
        previous = days[index - 1] if index else None
        for k in range(1, body.depth + 1):
            now = fly(day, front, k)
            before = fly(previous, front, k) if previous else None
            level[k - 1].append(None if now is None else round(now, 4))
            change[k - 1].append(None if now is None or before is None else now - before)
    if not kept:
        raise HTTPException(status_code=404, detail="No days in the selected range")

    # The latest curve: the last day on which the anchor fly has a price.
    anchor_levels = level[body.anchor - 1]
    last_with_anchor = max((i for i, v in enumerate(anchor_levels) if v is not None), default=None)
    latest_index = last_with_anchor if last_with_anchor is not None else len(kept) - 1

    matched = [i for i, v in enumerate(anchor_levels) if v is not None and body.lo <= v <= body.hi]
    episodes = sum(1 for n, i in enumerate(matched) if n == 0 or (kept[i] - kept[matched[n - 1]]).days > EPISODE_GAP_DAYS)
    by_year: dict[int, int] = defaultdict(int)
    for i in matched:
        by_year[kept[i].year] += 1

    window = slice(-body.window_days, None) if body.window_days else slice(None)
    return CurveLabOut(
        product=body.product,
        flies=list(range(1, body.depth + 1)),
        anchor=body.anchor,
        lo=body.lo,
        hi=body.hi,
        first=kept[0],
        last=kept[-1],
        n_days=len(kept),
        latest_date=kept[latest_index],
        latest=[level[k][latest_index] for k in range(body.depth)],
        corr_change=correlations([s[window] for s in change]),
        corr_level=correlations([s[window] for s in level]),
        unconditional=[spread(k + 1, [v for v in level[k] if v is not None]) for k in range(body.depth)],
        conditional=Conditional(
            n_days=len(matched),
            n_episodes=episodes,
            first=kept[matched[0]] if matched else None,
            last=kept[matched[-1]] if matched else None,
            by_year=dict(sorted(by_year.items())),
            matched_dates=[kept[i] for i in matched],
            spreads=[spread(k + 1, [v for i in matched if (v := level[k][i]) is not None]) for k in range(body.depth)],
        ),
    )
