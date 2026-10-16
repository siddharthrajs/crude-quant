"""Seasonality: the combined value of up to five weighted strategies, replayed in each past year.

A strategy is a product plus a weight per outright month (the `tenor` codes in instruments.json, e.g.
"U27"). All enabled strategies are summed (weight x size) into one set of contract legs, and that combined
position is priced every trading day from `daily_prices`. The year-k line is the same position with every
contract moved back k years (Z27 -> Z26 -> Z25 ...), so the lines are directly comparable on a calendar.

The endpoint returns price levels only; change / cumulative / spike removal / alignment are cheap and
interactive, so the frontend does them (see frontend/src/lib/seasonality.ts).
"""

from calendar import monthrange
from collections import defaultdict
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.db.base import get_db
from app.db.models import User

router = APIRouter(prefix="/api/seasonality", tags=["seasonality"])

MONTH_CODES = "FGHJKMNQUVXZ"
MAX_STRATEGIES = 5
MAX_YEARS = 8
# Product names as instruments.json / the frontend know them -> product key in the contracts table.
DB_PRODUCT = {"WTI": "CL", "Brent": "LCO", "CLBZZ": "WTCLCO"}
# A strategy's legs are priced with its own product's daily prices; a spread product expires with its WTI leg.
EXPIRY_RULE = {"CL": "cl", "WTCLCO": "cl", "LCO": "brent"}


class StrategyIn(BaseModel):
    product: Literal["WTI", "Brent", "CLBZZ"]
    size: float = 1.0
    enabled: bool = True
    # Outright tenor code ("Z26") -> weight. Zero weights are ignored.
    weights: dict[str, float]


class SeasonalityIn(BaseModel):
    strategies: list[StrategyIn] = Field(min_length=1, max_length=MAX_STRATEGIES)
    years: int = Field(default=5, ge=1, le=MAX_YEARS)


class YearSeries(BaseModel):
    year: int
    shift: int
    expiry: date | None
    dates: list[date]
    values: list[float]


class StrategySeries(BaseModel):
    """One strategy priced on its own, for pairwise stats. `index` is its position in the request's strategy list."""

    index: int
    label: str
    series: list[YearSeries]


class SeasonalityOut(BaseModel):
    label: str
    base_year: int
    legs: list[dict]
    series: list[YearSeries]
    strategies: list[StrategySeries]


def parse_tenor(code: str) -> date:
    if len(code) != 3 or code[0] not in MONTH_CODES or not code[1:].isdigit():
        raise HTTPException(status_code=422, detail=f"Bad outright tenor {code!r}; expected like 'Z26'")
    return date(2000 + int(code[1:]), MONTH_CODES.index(code[0]) + 1, 1)


def _is_bday(d: date) -> bool:
    return d.weekday() < 5


def _bdays_before(d: date, n: int) -> date:
    while n:
        d -= timedelta(days=1)
        if _is_bday(d):
            n -= 1
    return d


def expiry_date(product: str, delivery: date) -> date:
    """Approximate last trading day (weekends only, no exchange holiday calendar -- may be off by a day)."""
    prior = date(delivery.year - (delivery.month == 1), (delivery.month - 2) % 12 + 1, 1)
    if EXPIRY_RULE[product] == "cl":
        # Three business days before the 25th of the month before delivery (or before the business day preceding it).
        anchor = date(prior.year, prior.month, 25)
        while not _is_bday(anchor):
            anchor -= timedelta(days=1)
        return _bdays_before(anchor, 3)
    # Brent: last business day of the second month before delivery.
    second = date(prior.year - (prior.month == 1), (prior.month - 2) % 12 + 1, 1)
    last = date(second.year, second.month, monthrange(second.year, second.month)[1])
    while not _is_bday(last):
        last -= timedelta(days=1)
    return last


def shift_years(d: date, years: int) -> date:
    return date(d.year - years, d.month, 1)


def leg_label(product: str, delivery: date, weight: float, first: bool) -> str:
    code = f"{product}{MONTH_CODES[delivery.month - 1]}{delivery.year % 100:02d}"
    mag = abs(weight)
    body = code if mag == 1 else f"{mag:g}*{code}"
    sign = "-" if weight < 0 else ("" if first else "+")
    return f"{sign}{body}" if first else f" {sign or '+'} {body}"


@router.post("", response_model=SeasonalityOut)
async def seasonality(body: SeasonalityIn, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)) -> SeasonalityOut:
    # Sum every enabled strategy into one set of (product, delivery month) -> weight legs.
    legs: dict[tuple[str, date], float] = defaultdict(float)
    for strategy in body.strategies:
        if not strategy.enabled:
            continue
        for code, weight in strategy.weights.items():
            if weight:
                legs[(DB_PRODUCT[strategy.product], parse_tenor(code))] += weight * strategy.size
    legs = {key: w for key, w in legs.items() if abs(w) > 1e-9}
    if not legs:
        raise HTTPException(status_code=422, detail="No non-zero weights in any enabled strategy")

    ordered = sorted(legs.items(), key=lambda kv: (kv[0][1], kv[0][0]))
    base_year = min(month.year for _, month in legs)
    label = "".join(leg_label(p, m, w, i == 0) for i, ((p, m), w) in enumerate(ordered))

    # Each enabled strategy on its own too (the hedge-ratio stats compare them); it may use contracts that
    # cancel out of the sum, so the price fetch covers the union.
    own_legs: list[tuple[int, dict[tuple[str, date], float]]] = []
    for index, strategy in enumerate(body.strategies):
        mine = {(DB_PRODUCT[strategy.product], parse_tenor(code)): weight * strategy.size for code, weight in strategy.weights.items() if weight}
        if strategy.enabled and mine:
            own_legs.append((index, mine))
    every_leg = set(legs).union(*(mine.keys() for _, mine in own_legs))

    # Fetch daily prices for every (leg, shift) contract in one query.
    wanted = [(product, shift_years(month, k), k, (product, month)) for k in range(body.years) for (product, month) in sorted(every_leg)]
    rows = (
        await db.execute(
            text(
                "SELECT w.product, w.dm AS delivery_month, dp.trade_date, dp.price "
                "FROM unnest(CAST(:products AS text[]), CAST(:months AS date[])) AS w(product, dm) "
                "JOIN contracts c ON c.product = w.product AND c.delivery_month = w.dm "
                "JOIN daily_prices dp ON dp.contract_id = c.id"
            ),
            {"products": [w[0] for w in wanted], "months": [w[1] for w in wanted]},
        )
    ).all()
    prices: dict[tuple[str, date], dict[date, float]] = defaultdict(dict)
    for product, delivery, trade_date, price in rows:
        prices[(product, delivery)][trade_date] = price

    def replay(position: dict[tuple[str, date], float]) -> list[YearSeries]:
        """The position priced every day it has a price on every leg, once per past year (contracts moved back k years)."""
        out: list[YearSeries] = []
        for k in range(body.years):
            shifted = [((p, shift_years(m, k)), w) for (p, m), w in position.items()]
            common: set[date] | None = None
            for key, _ in shifted:
                days = set(prices.get(key, {}))
                common = days if common is None else common & days
            days = sorted(common or [])
            values = [round(sum(w * prices[key][d] for key, w in shifted), 4) for d in days]
            expiry = min(expiry_date(p, m) for (p, m), _ in shifted)
            # Years are labelled off the combined position so a strategy's lines match the chart's year picker.
            out.append(YearSeries(year=base_year - k, shift=k, expiry=expiry, dates=days, values=values))
        return out

    return SeasonalityOut(
        label=label,
        base_year=base_year,
        legs=[{"product": p, "month": m.isoformat(), "weight": w} for (p, m), w in ordered],
        series=replay(legs),
        strategies=[
            StrategySeries(index=index, label="".join(leg_label(p, m, w, i == 0) for i, ((p, m), w) in enumerate(sorted(mine.items(), key=lambda kv: (kv[0][1], kv[0][0])))), series=replay(mine))
            for index, mine in own_legs
        ],
    )
