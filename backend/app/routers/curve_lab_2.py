"""Curve Lab 2: one strategy's forward curve on every day of a date range, built from the outrights in the QH tables.

  GET /api/curve-lab-2/meta     products and the settlement date range each one has
  GET /api/curve-lab-2/curves   the strategy at every position along the curve, on each settlement day in the range

A strategy is a weight pattern over adjacent contracts (spread 1:-1, fly 1:-2:1, ...). Point k of a day's curve
applies it from generic slot c(k): c1 is the first contract whose expiry is on or after the day (as in
app/qh/curve.py), so on 2026-10-27 the WTI spread curve is c1-c2, c2-c3, ... = Z26-F27, F27-G27, ...

Two values per point, both the weighted sum of the legs on that day:
  settle  official settlements (qh_settlements)
  open    the session's first trade (qh_daily_bars.open); missing when any leg did not trade that day

The days are those with at least one settlement for the product. The whole range comes back in one response so
the frontend can scrub through it without further requests.
"""

from bisect import bisect_left
from collections import defaultdict
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.db.base import get_db
from app.db.models import User
from app.qh.products import PRODUCTS

router = APIRouter(prefix="/api/curve-lab-2", tags=["curve-lab-2"])

MAX_DEPTH = 24
# Settlement days in one request (~20 years), to bound the response.
MAX_DAYS = 5000

# Weights across adjacent contracts, from the front leg. DFly12 is Fly(T) - 2*Fly(T+1).
STRATEGIES: dict[str, tuple[str, tuple[int, ...]]] = {
    "outright": ("Outright", (1,)),
    "spread": ("Spread", (1, -1)),
    "fly": ("Fly", (1, -2, 1)),
    "dfly": ("DFly", (1, -3, 3, -1)),
    "dfly12": ("1:2 DFly", (1, -4, 5, -2)),
}

Product = Literal["CL", "CO", "WTCLCO"]
StrategyId = Literal["outright", "spread", "fly", "dfly", "dfly12"]


def _weighted(values: list[float | None], weights: tuple[int, ...]) -> float | None:
    if any(v is None for v in values):
        return None
    return round(sum(w * v for w, v in zip(weights, values)), 6)


@router.get("/meta")
async def meta(db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)) -> dict:
    rows = (
        await db.execute(
            text(
                "SELECT c.product, min(s.trade_date) AS first, max(s.trade_date) AS last FROM qh_settlements s "
                "JOIN qh_contracts c ON c.code = s.code GROUP BY c.product"
            )
        )
    ).all()
    ranges = {r.product: {"first": r.first.isoformat(), "last": r.last.isoformat()} for r in rows}
    return {
        "products": [{"root": p.root, "label": p.label, **ranges.get(p.root, {"first": None, "last": None})} for p in PRODUCTS.values()],
        "strategies": [{"id": k, "label": label, "weights": list(w)} for k, (label, w) in STRATEGIES.items()],
        "max_depth": MAX_DEPTH,
    }


@router.get("/curves")
async def curves(
    product: Product,
    strategy: StrategyId,
    start: date,
    end: date,
    depth: int = Query(default=MAX_DEPTH, ge=1, le=MAX_DEPTH),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict:
    if start > end:
        raise HTTPException(status_code=422, detail="Start date is after the end date")
    label, weights = STRATEGIES[strategy]
    n_legs = len(weights)

    contracts = (
        await db.execute(
            text("SELECT code, expiry FROM qh_contracts WHERE product = :p AND expiry >= :s ORDER BY delivery_month"),
            {"p": product, "s": start},
        )
    ).all()
    codes = [c.code for c in contracts]
    expiries = [c.expiry for c in contracts]
    prices = (
        await db.execute(
            text(
                "SELECT s.code, s.trade_date, s.settle, b.open FROM qh_settlements s "
                "JOIN qh_contracts c ON c.code = s.code "
                "LEFT JOIN qh_daily_bars b ON b.code = s.code AND b.trade_date = s.trade_date "
                "WHERE c.product = :p AND s.trade_date BETWEEN :s AND :e"
            ),
            {"p": product, "s": start, "e": end},
        )
    ).all()
    by_day: dict[date, dict[str, tuple[float, float | None]]] = defaultdict(dict)
    for r in prices:
        by_day[r.trade_date][r.code] = (r.settle, r.open)
    days = sorted(by_day)
    if not days:
        raise HTTPException(status_code=404, detail=f"No {PRODUCTS[product].label} settlements between {start} and {end}")
    if len(days) > MAX_DAYS:
        raise HTTPException(status_code=422, detail=f"At most {MAX_DAYS} settlement days per request; narrow the range")

    out_days = []
    for d in days:
        front = bisect_left(expiries, d)  # c1: first contract expiring on or after the day
        held = codes[front : front + depth + n_legs - 1]
        quotes = by_day[d]
        settle, opens = [], []
        for k in range(len(held) - n_legs + 1):
            legs = [quotes.get(code, (None, None)) for code in held[k : k + n_legs]]
            settle.append(_weighted([q[0] for q in legs], weights))
            opens.append(_weighted([q[1] for q in legs], weights))
        out_days.append({
            "date": d.isoformat(),
            # Each point's legs are refs[k : k + len(weights)].
            "refs": [code[len(product):] for code in held],
            "settle": settle,
            "open": opens,
        })
    return {
        "product": product,
        "product_label": PRODUCTS[product].label,
        "strategy": strategy,
        "strategy_label": label,
        "weights": list(weights),
        "days": out_days,
    }
