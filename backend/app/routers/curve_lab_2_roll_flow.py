"""Curve Lab 2 roll order flow: who aggresses in the first four contracts, their spreads and flies, around each expiry.

  GET /api/curve-lab-2/roll-flow?product=CL                         every roll: daily aggressor flow, price, OI
  GET /api/curve-lab-2/roll-flow/orders?product=CL&expiry=...&role=4  order sizes of one roll and instrument

Nothing here is stored in the database: order flow comes live from the QH Data API (settlements and open interest
are the dashboard's own, qh_settlements).

The events, the E-relative axis and the sections are the roll view's (curve_lab_2_roll.py). For each roll (front N
expiring on E) the instruments are fixed for the whole window -- N, N+1, N+2, N+3, the spreads N/N+1, N+1/N+2,
N+2/N+3 and the flies N/N+1/N+2, N+1/N+2/N+3 -- so a series never jumps when the generic slots shift. The roll
still running (its front not expired yet) is the last event, flagged `live`, with its days up to the latest
settlement placed by counting the exchange business days left to its expiry.

/roll-flow, per instrument and settlement day (offset -window .. +window):
  lots  lots traded, net  lots bought minus sold by the aggressor -- from QH's daily bars (/ohlc/ 1D with buy and
        sell volume, which equal the time and sales' totals), available from BARS_FROM; one or two calls for every
        roll, kept in memory for BARS_TTL
  px    settlement (spreads and flies from their legs' settlements); and oi of the four outrights
A value is null before BARS_FROM, and 0 on a day with bars for the product but none for that instrument.

/roll-flow/orders needs individual orders (app/qh/tas.py), which take minutes per roll to fetch: it queues the roll's
days of that one instrument (newest first) and answers at once with what is ready -- for every roll, so rolls looked
at before give the comparison -- and the selected roll's progress. Poll it until `status.queued` is 0. Per day:
  large / block  net of orders of at least size[kind] lots (app.qh.tas.SIZES), settle_net  net inside the
  settlement window, sweeps  orders that filled at more than one price.
"""

import asyncio
import time
from datetime import date, datetime, timezone

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.db.base import get_db
from app.db.models import User
from app.qh import tas
from app.qh.client import QhError, client
from app.qh.products import PRODUCTS
from app.quant.calendar import _ice_bday, _nymex_bday
from app.routers.curve_lab_2_roll import roll_events

router = APIRouter(prefix="/api/curve-lab-2", tags=["curve-lab-2"])

ROLES = [
    ("N", "outright"), ("N+1", "outright"), ("N+2", "outright"), ("N+3", "outright"),
    ("N/N+1", "spread"), ("N+1/N+2", "spread"), ("N+2/N+3", "spread"),
    ("N/N+1/N+2", "fly"), ("N+1/N+2/N+3", "fly"),
]
# QH's daily bars have real buy and sell volume from this trade date on (zero before).
BARS_FROM = date(2024, 7, 15)
BARS_TTL = 15 * 60
OHLC_BATCH = 50
ORDER_FIELDS = ("large", "block", "settle_net", "sweeps")

# product -> (fetched at, codes, {(code, day): (volume, buy, sell)}, days with any bar)
_bars: dict[str, tuple[float, frozenset[str], dict[tuple[str, date], tuple[int, int, int]], set[date]]] = {}


async def _daily_bars(product: str, codes: set[str], start: date) -> tuple[dict[tuple[str, date], tuple[int, int, int]], set[date]]:
    hit = _bars.get(product)
    if hit and time.monotonic() - hit[0] < BARS_TTL and codes <= hit[1]:
        return hit[2], hit[3]
    since = int(datetime.combine(start, datetime.min.time(), timezone.utc).timestamp())
    batches = [sorted(codes)[i:i + OHLC_BATCH] for i in range(0, len(codes), OHLC_BATCH)]
    out: dict[tuple[str, date], tuple[int, int, int]] = {}
    for batch in batches:
        bars = await asyncio.to_thread(client.ohlc, batch, "1D", start=since, end=int(time.time()), extra=("buyvolume", "sellvolume"))
        for b in bars:
            buy, sell = b.get("buyvolume"), b.get("sellvolume")
            if buy is None or sell is None:
                continue
            d = datetime.fromtimestamp(b["time"] / 1000, timezone.utc).date()  # 1D bars are stamped with their trade date
            out[(b["product"], d)] = (int(round(float(b["volume"] or 0))), int(round(float(buy))), int(round(float(sell))))
    days = {d for _, d in out if d >= BARS_FROM}
    _bars[product] = (time.monotonic(), frozenset(codes), out, days)
    return out, days


async def _live_event(db: AsyncSession, product: str, contracts: list[str], done: list[dict], win: int) -> dict | None:
    """The roll still running: the front that has not expired yet, on the same E-relative axis. Days up to the
    latest settlement get offsets counted back from E through the exchange business days still to come (the
    calendar the expiry rule uses; Brent's can be a day out around a UK bank holiday ICE trades through)."""
    days = [
        r.trade_date
        for r in (
            await db.execute(
                text(
                    """SELECT DISTINCT s.trade_date FROM qh_settlements s JOIN qh_contracts c ON c.code = s.code
                       WHERE c.product = :p ORDER BY s.trade_date DESC LIMIT :n"""
                ),
                {"p": product, "n": 2 * win + 1},
            )
        ).all()
    ]
    if not days:
        return None
    last = days[0]
    row = (
        await db.execute(
            text("SELECT code, expiry FROM qh_contracts WHERE product = :p AND expiry > :d ORDER BY delivery_month LIMIT 1"),
            {"p": product, "d": last},
        )
    ).first()
    if row is None or any(e["expiry"] == row.expiry.isoformat() for e in done):
        return None
    n = contracts.index(row.code)
    if n + 2 >= len(contracts):
        return None
    bday = _nymex_bday() if PRODUCTS[product].rule == "cl" else _ice_bday()
    ahead = len(pd.date_range(pd.Timestamp(last) + bday, pd.Timestamp(row.expiry), freq=bday))  # business days after `last` up to E
    dates: list[str | None] = [None] * (2 * win + 1)
    for i, d in enumerate(days):
        t = -ahead - i
        if t >= -win:
            dates[t + win] = d.isoformat()
    strip = len(product)
    first_day = next((d for d in dates if d), None)
    back = False
    if first_day:
        p = dict(
            (await db.execute(
                text("SELECT code, settle FROM qh_settlements WHERE trade_date = :d AND code = ANY(:c)"),
                {"d": date.fromisoformat(first_day), "c": contracts[n:n + 2]},
            )).all()
        )
        back = None not in (p.get(contracts[n]), p.get(contracts[n + 1])) and p[contracts[n]] > p[contracts[n + 1]]
    return {
        "out": contracts[n][strip:],
        "in": contracts[n + 1][strip:],
        "expiry": row.expiry.isoformat(),
        "back": back,
        "L": None,
        "dates": dates,
        "live": True,
    }


Picked = list[tuple[dict, list[date | None], list[str], list[str]]]
# The roll view's events change once a day but take ~30-60 s to build against a remote database, and the orders
# endpoint is polled every few seconds: kept in memory for ROLLS_TTL. product -> (built at, rolls, picked)
ROLLS_TTL = 10 * 60
_rolls_cache: dict[str, tuple[float, dict, Picked]] = {}
_rolls_locks: dict[str, asyncio.Lock] = {}


async def _rolls(product: str, db: AsyncSession, user: User) -> tuple[dict, Picked]:
    if product not in tas.SESSIONS:
        raise HTTPException(status_code=400, detail="Order flow covers CL and CO only")
    async with _rolls_locks.setdefault(product, asyncio.Lock()):
        hit = _rolls_cache.get(product)
        if hit and time.monotonic() - hit[0] < ROLLS_TTL:
            return hit[1], hit[2]
        rolls, picked = await _build_rolls(product, db, user)
        _rolls_cache[product] = (time.monotonic(), rolls, picked)
        return rolls, picked


async def _build_rolls(product: str, db: AsyncSession, user: User) -> tuple[dict, Picked]:
    """The roll view's events whose window reaches BARS_FROM, then the roll still running, each with its days,
    its four outright legs and its instrument codes in ROLES order."""
    rolls = await roll_events(product=product, strategy="spread", db=db, _=user)
    contracts = [r.code for r in (await db.execute(text("SELECT code FROM qh_contracts WHERE product = :p ORDER BY delivery_month"), {"p": product})).all()]
    index = {c: i for i, c in enumerate(contracts)}
    live = await _live_event(db, product, contracts, rolls["events"], rolls["window"])
    picked = []
    for e in [*rolls["events"], *([live] if live else [])]:
        days = [date.fromisoformat(d) if d else None for d in e["dates"]]
        if not any(d and d >= BARS_FROM for d in days):
            continue
        n = index.get(product + e["out"])
        if n is None or n + 4 > len(contracts):
            continue
        legs = contracts[n:n + 4]
        picked.append((e, days, legs, tas.instrument_codes(product, legs)))
    if not picked:
        raise HTTPException(status_code=404, detail="No roll since order flow data starts")
    return rolls, picked


def _sizes(product: str) -> dict[str, dict[str, int]]:
    return {k: {"large": a, "block": b} for k, (a, b) in tas.SIZES[product].items()}


@router.get("/roll-flow")
async def roll_flow(
    product: str = Query(pattern="^(CL|CO)$"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    rolls, picked = await _rolls(product, db, user)
    win = rolls["window"]
    codes = {c for *_, cs in picked for c in cs}
    outrights = sorted({c for _, _, legs, _ in picked for c in legs})
    start = min(d for _, ds, _, _ in picked for d in ds if d)
    try:
        bars, bar_days = await _daily_bars(product, codes, max(start, BARS_FROM))
    except QhError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    px_rows = (
        await db.execute(
            text("SELECT code, trade_date, settle, oi FROM qh_settlements WHERE code = ANY(:codes) AND trade_date >= :a"),
            {"codes": outrights, "a": start},
        )
    ).all()
    px = {(r.code, r.trade_date): r.settle for r in px_rows}
    oi = {(r.code, r.trade_date): r.oi for r in px_rows}

    def leg_px(legs: list[str], d: date, weights: tuple[int, ...]) -> float | None:
        vals = [px.get((c, d)) for c in legs]
        return None if any(v is None for v in vals) else round(sum(w * v for w, v in zip(weights, vals)), 4)

    events = []
    for e, days, legs, cs in picked:
        groups = [
            *[([legs[i]], (1,)) for i in range(4)],
            *[(legs[i:i + 2], (1, -1)) for i in range(3)],
            *[(legs[i:i + 3], (1, -2, 1)) for i in range(2)],
        ]
        lots = [[None] * len(days) for _ in cs]
        net = [[None] * len(days) for _ in cs]
        px_s = [[None] * len(days) for _ in cs]
        oi_s = [[None] * len(days) for _ in range(4)]
        for t, d in enumerate(days):
            if d is None:
                continue
            for i, c in enumerate(cs):
                px_s[i][t] = leg_px(groups[i][0], d, groups[i][1])
                if d in bar_days:
                    v, b, s = bars.get((c, d), (0, 0, 0))
                    lots[i][t], net[i][t] = v, b - s
            for i in range(4):
                oi_s[i][t] = oi.get((legs[i], d))
        events.append({
            "out": e["out"], "in": e["in"], "expiry": e["expiry"], "back": e["back"], "L": e["L"],
            "live": e.get("live", False), "dates": e["dates"], "codes": cs,
            "lots": lots, "net": net, "px": px_s, "oi": oi_s,
        })

    covered = sorted(bar_days)
    return {
        "product": product,
        "product_label": PRODUCTS[product].label,
        "window": win,
        "crossover": rolls["crossover"],
        "sections": rolls["sections"],
        "roles": [{"id": r, "kind": k} for r, k in ROLES],
        "size": _sizes(product),
        "coverage": {
            "first": covered[0].isoformat() if covered else None,
            "last": covered[-1].isoformat() if covered else None,
            "days": len(covered),
            "orders_from": tas.FIRST_DAY.isoformat(),
        },
        "events": events,
    }


@router.get("/roll-flow/orders")
async def roll_flow_orders(
    product: str = Query(pattern="^(CL|CO)$"),
    expiry: date = Query(),
    role: int = Query(ge=0, lt=len(ROLES)),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    _, picked = await _rolls(product, db, user)
    chosen = next(((days, cs) for e, days, _, cs in picked if e["expiry"] == expiry.isoformat()), None)
    if chosen is None:
        raise HTTPException(status_code=404, detail=f"No roll expiring {expiry}")
    days, cs = chosen
    tas.request(product, cs[role], days)
    events = []
    for e, ds, _, cs_e in picked:
        got = tas.flows(cs_e[role], ds)
        if not any(got):
            continue
        events.append({
            "expiry": e["expiry"],
            **{k: [getattr(f, k) if f else None for f in got] for k in ORDER_FIELDS},
        })
    return {"code": cs[role], "status": tas.status(cs[role], days), "events": events}
