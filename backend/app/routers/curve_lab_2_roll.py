"""Curve Lab 2 roll transition: every front-contract expiry as one event, for following the 2nd month into the front.

  GET /api/curve-lab-2/roll-events?product=CL&strategy=spread

For each contract N that was the front when it expired (day E, its last settlement), the window E-W .. E+W
settlement days (W = 21) with the same contracts on every day:
  in        the strategy from N+1 (N+1 is c2 before E, c1 after), e.g. spread N+1 - N+2
  out       the strategy from N, up to E (it ends when N expires)
  px        outright settlements of N (to E), N+1, N+2
  oi        open interest of N (to E), N+1, N+2, from qh_settlements.oi (QH /common/dailymarketdata)
  L         settlement days from E to N+1's own expiry; null while N+1 is still trading. The incoming series stop
            the day before that expiry, so N+1's own expiry day never enters the statistics.
  back      the curve was in backwardation (N above N+1) at the start of the window

`sections` are the default phases on the E-relative axis, from the data: the roll starts 3 settlement days before
the median day (rolls since 2016) on which N+1's open interest first exceeds N's; pre-roll is the 5 days before it;
after E, post-roll is the new front's first 5 days and its own roll starts as many days before its own expiry as
the old front's did (median L).
"""

import statistics
from bisect import bisect_left
from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.db.base import get_db
from app.db.models import User
from app.qh.products import PRODUCTS
from app.routers.curve_lab_2 import STRATEGIES, Product, StrategyId

router = APIRouter(prefix="/api/curve-lab-2", tags=["curve-lab-2"])

W = 21
ROLL_LEAD = 3
PRE_DAYS = 5
POST_DAYS = 5
CROSSOVER_FROM = date(2016, 1, 1)


def _weighted(values: list[float | None], weights: tuple[int, ...]) -> float | None:
    if any(v is None for v in values):
        return None
    return round(sum(w * v for w, v in zip(weights, values)), 6)


def _sections(cross: int, length: int) -> list[dict]:
    roll = cross - ROLL_LEAD  # first roll day, negative
    pre = roll - PRE_DAYS
    own = max(POST_DAYS + 1, length + roll)  # the new front's own roll, same distance before its expiry
    out = [
        ("early", "Early (as c2)", -W, pre - 1),
        ("pre", "Pre-roll", pre, roll - 1),
        ("roll", "Roll", roll, -1),
        ("expiry", "Expiry day", 0, 0),
        ("post", "Post-roll (new c1)", 1, POST_DAYS),
        ("front", "Settled as front", POST_DAYS + 1, own - 1),
        ("own", "Its own roll", own, W),
    ]
    return [{"id": i, "label": label, "from": a, "to": b} for i, label, a, b in out if a <= b]


@router.get("/roll-events")
async def roll_events(
    product: Product,
    strategy: StrategyId,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict:
    label, weights = STRATEGIES[strategy]
    n_legs = len(weights)
    contracts = (await db.execute(text("SELECT code, expiry FROM qh_contracts WHERE product = :p ORDER BY delivery_month"), {"p": product})).all()
    rows = (
        await db.execute(
            text("SELECT s.code, s.trade_date, s.settle, s.oi FROM qh_settlements s JOIN qh_contracts c ON c.code = s.code WHERE c.product = :p"),
            {"p": product},
        )
    ).all()
    if not rows:
        raise HTTPException(status_code=404, detail=f"No {PRODUCTS[product].label} settlements")

    codes = [c.code for c in contracts]
    expiries = [c.expiry for c in contracts]
    index = {c: i for i, c in enumerate(codes)}
    px: dict[date, dict[int, float]] = defaultdict(dict)
    oi: dict[date, dict[int, int]] = defaultdict(dict)
    for r in rows:
        k = index[r.code]
        px[r.trade_date][k] = r.settle
        if r.oi is not None:
            oi[r.trade_date][k] = r.oi
    days = sorted(px)
    pos = {d: i for i, d in enumerate(days)}
    strip = lambda code: code[len(product):]  # noqa: E731

    events, crossovers, lengths = [], [], []
    for n, e in enumerate(expiries):
        j = pos.get(e)
        # A front expiry inside the data, with the incoming strategy's legs listed and a full window before E.
        if j is None or j < W or n + n_legs + 1 > len(codes) or n + 2 >= len(codes):
            continue
        # N was the front on E: the first contract expiring on or after it (as c1 in curve_lab_2.py).
        if bisect_left(expiries, e) != n:
            continue
        L = pos[expiries[n + 1]] - j if expiries[n + 1] in pos else None
        offsets = range(-W, W + 1)
        dates, s_in, s_out, p0, p1, p2, o0, o1, o2 = [], [], [], [], [], [], [], [], []
        for t in offsets:
            i = j + t
            if i >= len(days):
                for arr in (dates, s_in, s_out, p0, p1, p2, o0, o1, o2):
                    arr.append(None)
                continue
            d = days[i]
            p, o = px[d], oi[d]
            alive = L is None or t < L  # N+1 has not reached its own expiry
            dates.append(d.isoformat())
            s_in.append(_weighted([p.get(n + 1 + k) for k in range(n_legs)], weights) if alive else None)
            s_out.append(_weighted([p.get(n + k) for k in range(n_legs)], weights) if t <= 0 else None)
            p0.append(p.get(n) if t <= 0 else None)
            p1.append(p.get(n + 1) if alive else None)
            p2.append(p.get(n + 2))
            o0.append(o.get(n) if t <= 0 else None)
            o1.append(o.get(n + 1) if alive else None)
            o2.append(o.get(n + 2))
        start = px[days[j - W]]
        back = start.get(n) is not None and start.get(n + 1) is not None and start[n] > start[n + 1]
        events.append({
            "out": strip(codes[n]),
            "in": strip(codes[n + 1]),
            "next": strip(codes[n + 2]),
            "expiry": e.isoformat(),
            "L": L,
            "back": back,
            "dates": dates,
            "in_values": s_in,
            "out_values": s_out,
            "px": [p0, p1, p2],
            "oi": [o0, o1, o2],
        })
        if e >= CROSSOVER_FROM:
            cross = next((t for t, a, b in zip(offsets, o0, o1) if t <= 0 and a is not None and b is not None and b > a), None)
            if cross is not None:
                crossovers.append(cross)
            if L is not None:
                lengths.append(L)

    if not events:
        raise HTTPException(status_code=404, detail=f"No {PRODUCTS[product].label} expiries in the data")
    cross = round(statistics.median(crossovers)) if crossovers else -8
    length = round(statistics.median(lengths)) if lengths else 21
    return {
        "product": product,
        "product_label": PRODUCTS[product].label,
        "strategy": strategy,
        "strategy_label": label,
        "weights": list(weights),
        "window": W,
        "crossover": cross,
        "cycle_length": length,
        "sections": _sections(cross, length),
        "last": days[-1].isoformat(),
        "events": events,
    }
