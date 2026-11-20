"""Curve Lab 2: one strategy's forward curve on every day of a date range, built from the outrights in the QH tables.

  GET /api/curve-lab-2/meta     products and the settlement date range each one has
  GET /api/curve-lab-2/curves   the strategy at every position along the curve, on each settlement day in the range

A strategy is a weight pattern over adjacent contracts (spread 1:-1, fly 1:-2:1, ...). Point k of a day's curve
applies it from generic slot c(k): c1 is the first contract whose expiry is on or after the day (as in
app/qh/curve.py), so on 2026-10-27 the WTI spread curve is c1-c2, c2-c3, ... = Z26-F27, F27-G27, ...

Two values per point, both the weighted sum of the legs on that day:
  settle  official settlements (qh_settlements), or with price=close the session's last trade (qh_daily_bars.close),
          missing when any leg did not trade that day
  open    the session's first trade (qh_daily_bars.open); missing when any leg did not trade that day

With legs=spread the same strategy is built synthetically from adjacent calendar spreads S(j) = c(j) - c(j+1)
instead of outrights: its weights over the spreads are the running sums of its outright weights (fly 1:-2:1 is
S1 - S2, DFly S1 - 2*S2 + S3, 1:2 DFly S1 - 3*S2 + 2*S3; a spread is S1 itself). The spreads' closes and opens are
the spread instruments' own trades (QH daily bars of CLZ26-F27, ..., fetched live and kept for SPREAD_TTL); QH has no
spread settlements, so with price=settle a spread is its legs' settlement difference (the exchange settles it that
way). An outright has no spread form and is always built from outrights; the response's `legs` says which was used.

The days are those with at least one settlement for the product. The whole range comes back in one response so
the frontend can scrub through it without further requests.
"""

import asyncio
import time
from bisect import bisect_left
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from itertools import accumulate
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.db.base import get_db
from app.db.models import User
from app.qh.client import QhError, client
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
Price = Literal["settle", "close"]
Legs = Literal["outright", "spread"]

# Spread daily bars from QH: product -> (fetched at, codes asked for, start, end, {(code, day): (open, close)}).
SPREAD_TTL = 15 * 60
OHLC_BATCH = 50
_spread_bars: dict[str, tuple[float, frozenset[str], date, date, dict[tuple[str, date], tuple[float | None, float | None]]]] = {}


def _spread_weights(weights: tuple[int, ...]) -> tuple[int, ...]:
    """A strategy's weights over adjacent spreads: the running sums of its outright weights, dropping the last (0)."""
    return tuple(accumulate(weights))[:-1]


def _num(v: object) -> float | None:
    return None if v is None else float(v)


async def _spread_quotes(product: str, codes: set[str], start: date, end: date) -> dict[tuple[str, date], tuple[float | None, float | None]]:
    """(open, close) of each spread code on each trade date in [start, end], from QH's daily bars."""
    hit = _spread_bars.get(product)
    if hit and time.monotonic() - hit[0] < SPREAD_TTL and codes <= hit[1] and hit[2] <= start and end <= hit[3]:
        return hit[4]
    since = int(datetime.combine(start, datetime.min.time(), timezone.utc).timestamp())
    until = int(datetime.combine(end + timedelta(days=1), datetime.min.time(), timezone.utc).timestamp())
    ordered = sorted(codes)
    out: dict[tuple[str, date], tuple[float | None, float | None]] = {}
    try:
        for i in range(0, len(ordered), OHLC_BATCH):
            bars = await asyncio.to_thread(client.ohlc, ordered[i : i + OHLC_BATCH], "1D", start=since, end=until)
            for b in bars:
                d = datetime.fromtimestamp(b["time"] / 1000, timezone.utc).date()  # 1D bars are stamped with their trade date
                out[(b["product"], d)] = (_num(b.get("open")), _num(b.get("close")))
    except QhError as e:
        raise HTTPException(status_code=502, detail=f"Spread prices from QH: {e}") from e
    _spread_bars[product] = (time.monotonic(), frozenset(codes), start, end, out)
    return out


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
    price: Price = "settle",
    legs: Legs = "outright",
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict:
    if start > end:
        raise HTTPException(status_code=422, detail="Start date is after the end date")
    label, weights = STRATEGIES[strategy]
    n_legs = len(weights)
    if n_legs < 2:
        legs = "outright"  # an outright has no spread form
    spread_w = _spread_weights(weights)

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
                "SELECT s.code, s.trade_date, s.settle, b.open, b.close FROM qh_settlements s "
                "JOIN qh_contracts c ON c.code = s.code "
                "LEFT JOIN qh_daily_bars b ON b.code = s.code AND b.trade_date = s.trade_date "
                "WHERE c.product = :p AND s.trade_date BETWEEN :s AND :e"
            ),
            {"p": product, "s": start, "e": end},
        )
    ).all()
    # The days are the settlement days either way; with price=close a leg without a bar that day has no value.
    by_day: dict[date, dict[str, tuple[float | None, float | None]]] = defaultdict(dict)
    for r in prices:
        by_day[r.trade_date][r.code] = (r.settle if price == "settle" else r.close, r.open)
    days = sorted(by_day)
    if not days:
        raise HTTPException(status_code=404, detail=f"No {PRODUCTS[product].label} settlements between {start} and {end}")
    if len(days) > MAX_DAYS:
        raise HTTPException(status_code=422, detail=f"At most {MAX_DAYS} settlement days per request; narrow the range")

    fronts = {d: bisect_left(expiries, d) for d in days}  # c1: first contract expiring on or after the day
    spread_code = lambda a, b: f"{a}-{b[len(product):]}"  # CLZ26, CLF27 -> CLZ26-F27
    spread_px: dict[tuple[str, date], tuple[float | None, float | None]] = {}
    if legs == "spread":
        wanted = {
            spread_code(codes[i], codes[i + 1])
            for f in set(fronts.values())
            for i in range(f, min(f + depth + n_legs - 2, len(codes) - 1))
        }
        spread_px = await _spread_quotes(product, wanted, days[0], days[-1])

    out_days = []
    for d in days:
        front = fronts[d]
        held = codes[front : front + depth + n_legs - 1]
        quotes = by_day[d]
        settle, opens = [], []
        if legs == "spread":
            # Spread j = held[j] - held[j+1]: its own open and close; a settlement from its legs' settlements.
            spreads = []
            for a, b in zip(held, held[1:]):
                bar = spread_px.get((spread_code(a, b), d), (None, None))
                if price == "settle":
                    sa, sb = quotes.get(a, (None, None))[0], quotes.get(b, (None, None))[0]
                    solid = None if sa is None or sb is None else sa - sb
                else:
                    solid = bar[1]
                spreads.append((solid, bar[0]))
            for k in range(len(held) - n_legs + 1):
                part = spreads[k : k + n_legs - 1]
                settle.append(_weighted([q[0] for q in part], spread_w))
                opens.append(_weighted([q[1] for q in part], spread_w))
        else:
            for k in range(len(held) - n_legs + 1):
                part = [quotes.get(code, (None, None)) for code in held[k : k + n_legs]]
                settle.append(_weighted([q[0] for q in part], weights))
                opens.append(_weighted([q[1] for q in part], weights))
        out_days.append({
            "date": d.isoformat(),
            # Each point's legs are refs[k : k + len(weights)].
            "refs": [code[len(product):] for code in held],
            # The solid curve: settlements, or closes with price=close.
            "settle": settle,
            "open": opens,
        })
    return {
        "product": product,
        "product_label": PRODUCTS[product].label,
        "strategy": strategy,
        "strategy_label": label,
        "weights": list(weights),
        "price": price,
        "legs": legs,
        "days": out_days,
    }
