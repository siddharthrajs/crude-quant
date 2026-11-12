"""Curve Lab 2 Distribution: one strategy's distribution on the days that a set of conditions hold.

  POST /api/curve-lab-2/distribution         the target's value on every day in the range where each base
                                             condition's strategy sits inside its range
  POST /api/curve-lab-2/distribution/curve   a strategy's forward curve over a set of days: per point, the mean,
                                             median, min and max across those days

Strategies are written as QH codes, generic (GD) or running (RD):
  GD  CL1, CL1-2, CL1-2-3, CL1-2-3-4    legs by generic slot (c1 = first contract expiring on or after the day,
                                        as in curve_lab_2.py); CL1-CL2 is accepted too
  RD  CLZ26, CLZ26-F27, CLZ26-F27-G27   legs by contract; CLZ26-CLF27 is accepted too
Products are CL, CO and WTCLCO. The leg count sets the weights: outright 1, spread 1:-1, fly 1:-2:1,
dfly 1:-3:3:-1. Legs need not be adjacent (CL1-3, CLZ26-Z27).

A strategy's forward curve is its leg pattern moved along the curve: for CL1-2 (or CLZ26-F27) point k is
c(k)-c(k+1) on each day, the same curve the Curves view draws. Points are lined up by generic slot.

Values are official settlements, or with price=close the session's last trade, missing when any leg has none.
"""

import re
import statistics
from bisect import bisect_left
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.db.base import get_db
from app.db.models import User
from app.qh.products import PRODUCTS
from app.routers.curve_lab_2 import MAX_DAYS, MAX_DEPTH

router = APIRouter(prefix="/api/curve-lab-2/distribution", tags=["curve-lab-2"])

MAX_CONDITIONS = 5
MAX_SLOT = 36
WEIGHTS: dict[int, tuple[int, ...]] = {1: (1,), 2: (1, -1), 3: (1, -2, 1), 4: (1, -3, 3, -1)}
STRUCTURE = {1: "outright", 2: "spread", 3: "fly", 4: "dfly"}

Mode = Literal["GD", "RD"]
Price = Literal["settle", "close"]

# Longest root first, so WTCLCO is not read as anything shorter.
_ROOTS = sorted(PRODUCTS, key=len, reverse=True)
_TENOR = r"[FGHJKMNQUVXZ]\d{2}"


@dataclass(frozen=True)
class Code:
    text: str
    product: str
    mode: Mode
    # GD: generic slots (1 = c1); RD: contract codes ('CLZ26').
    legs: tuple
    weights: tuple[int, ...]


def parse_code(raw: str) -> Code:
    s = raw.strip().upper().replace(" ", "")
    root = next((r for r in _ROOTS if s.startswith(r)), None)
    if not root:
        raise HTTPException(422, f"{raw!r}: start with a product ({', '.join(PRODUCTS)}), e.g. CL1-2 or CLZ26-F27")
    parts = [p[len(root):] if p.startswith(root) and p != root else p for p in s[len(root):].split("-")]
    if len(parts) not in WEIGHTS:
        raise HTTPException(422, f"{raw!r}: 1 to 4 legs (outright, spread, fly, dfly)")
    if all(re.fullmatch(r"\d{1,2}", p) for p in parts):
        slots = tuple(int(p) for p in parts)
        if slots[0] < 1 or slots[-1] > MAX_SLOT or any(b <= a for a, b in zip(slots, slots[1:])):
            raise HTTPException(422, f"{raw!r}: generic slots must rise from 1 up to {MAX_SLOT}")
        return Code(f"{root}{'-'.join(parts)}", root, "GD", slots, WEIGHTS[len(parts)])
    if all(re.fullmatch(_TENOR, p) for p in parts):
        contracts = tuple(root + p for p in parts)
        return Code(f"{root}{'-'.join(parts)}", root, "RD", contracts, WEIGHTS[len(parts)])
    raise HTTPException(422, f"{raw!r}: not a QH code; generic like {root}1-2, running like {root}Z26-F27")


@dataclass
class Book:
    """One product's contracts and quotes over a date range."""

    codes: list[str]
    expiries: list[date]
    index: dict[str, int]
    # day -> contract code -> value
    quotes: dict[date, dict[str, float | None]]

    def front(self, d: date) -> int:
        return bisect_left(self.expiries, d)

    def weighted(self, d: date, idx: list[int], weights: tuple[int, ...]) -> float | None:
        q = self.quotes.get(d)
        if q is None or any(i < 0 or i >= len(self.codes) for i in idx):
            return None
        vals = [q.get(self.codes[i]) for i in idx]
        if any(v is None for v in vals):
            return None
        return round(sum(w * v for w, v in zip(weights, vals)), 6)

    def leg_index(self, code: Code, d: date) -> list[int] | None:
        """Contract index of each leg on day d (None when a running leg is not on the curve)."""
        if code.mode == "GD":
            f = self.front(d)
            return [f + s - 1 for s in code.legs]
        idx = [self.index.get(c, -1) for c in code.legs]
        return None if min(idx) < 0 else idx

    def value(self, code: Code, d: date) -> float | None:
        idx = self.leg_index(code, d)
        if idx is None:
            return None
        if code.mode == "RD" and idx[0] < self.front(d):
            return None  # front leg expired
        return self.weighted(d, idx, code.weights)


async def load_book(db: AsyncSession, product: str, start: date, end: date, price: Price) -> Book:
    contracts = (
        await db.execute(
            text("SELECT code, expiry FROM qh_contracts WHERE product = :p AND expiry >= :s ORDER BY delivery_month"),
            {"p": product, "s": start},
        )
    ).all()
    column = "s.settle" if price == "settle" else "b.close"
    rows = (
        await db.execute(
            text(
                f"SELECT s.code, s.trade_date, {column} AS v FROM qh_settlements s "
                "JOIN qh_contracts c ON c.code = s.code "
                "LEFT JOIN qh_daily_bars b ON b.code = s.code AND b.trade_date = s.trade_date "
                "WHERE c.product = :p AND s.trade_date BETWEEN :s AND :e"
            ),
            {"p": product, "s": start, "e": end},
        )
    ).all()
    quotes: dict[date, dict[str, float | None]] = defaultdict(dict)
    for r in rows:
        quotes[r.trade_date][r.code] = r.v
    if len(quotes) > MAX_DAYS:
        raise HTTPException(422, f"At most {MAX_DAYS} settlement days per request; narrow the range")
    codes = [c.code for c in contracts]
    return Book(codes, [c.expiry for c in contracts], {c: i for i, c in enumerate(codes)}, dict(quotes))


async def load_books(db: AsyncSession, products: set[str], start: date, end: date, price: Price) -> dict[str, Book]:
    return {p: await load_book(db, p, start, end, price) for p in products}


def check_mode(codes: list[Code], mode: Mode) -> None:
    wrong = [c.text for c in codes if c.mode != mode]
    if wrong:
        want = "generic (like CL1-2)" if mode == "GD" else "running (like CLZ26-F27)"
        raise HTTPException(422, f"{', '.join(wrong)}: the tab is on {mode}, so codes are {want}")


class ConditionIn(BaseModel):
    code: str
    min: float | None = None
    max: float | None = None


class DistributionIn(BaseModel):
    start: date
    end: date
    mode: Mode = "GD"
    price: Price = "settle"
    conditions: list[ConditionIn] = Field(default_factory=list, max_length=MAX_CONDITIONS)
    target: str


@router.post("")
async def distribution(body: DistributionIn, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)) -> dict:
    if body.start > body.end:
        raise HTTPException(422, "Start date is after the end date")
    target = parse_code(body.target)
    conds = [(parse_code(c.code), c.min, c.max) for c in body.conditions]
    for code, lo, hi in conds:
        if lo is not None and hi is not None and lo > hi:
            raise HTTPException(422, f"{code.text}: min {lo} is above max {hi}")
    check_mode([target, *(c[0] for c in conds)], body.mode)

    books = await load_books(db, {target.product, *(c[0].product for c in conds)}, body.start, body.end, body.price)
    days = sorted(books[target.product].quotes)
    if not days:
        raise HTTPException(404, f"No {PRODUCTS[target.product].label} settlements between {body.start} and {body.end}")

    with_target = 0
    passed = [0] * len(conds)
    available = [0] * len(conds)
    dates: list[str] = []
    values: list[float] = []
    for d in days:
        v = books[target.product].value(target, d)
        if v is None:
            continue
        with_target += 1
        ok = True
        for i, (code, lo, hi) in enumerate(conds):
            c = books[code.product].value(code, d)
            if c is None:
                ok = False
                continue
            available[i] += 1
            if (lo is None or c >= lo) and (hi is None or c <= hi):
                passed[i] += 1
            else:
                ok = False
        if ok:
            dates.append(d.isoformat())
            values.append(v)

    return {
        "target": {"code": target.text, "label": f"{PRODUCTS[target.product].label} {STRUCTURE[len(target.legs)]}"},
        "mode": body.mode,
        "price": body.price,
        "days_in_range": len(days),
        "days_with_target": with_target,
        "conditions": [
            {"code": code.text, "min": lo, "max": hi, "available": available[i], "passed": passed[i]}
            for i, (code, lo, hi) in enumerate(conds)
        ],
        "dates": dates,
        "values": values,
    }


class CurveIn(BaseModel):
    code: str
    dates: list[date] = Field(min_length=1, max_length=MAX_DAYS)
    price: Price = "settle"
    depth: int = Field(default=MAX_DEPTH, ge=1, le=MAX_DEPTH)


@router.post("/curve")
async def curve_stats(body: CurveIn, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)) -> dict:
    code = parse_code(body.code)
    days = sorted(set(body.dates))
    book = await load_book(db, code.product, days[0], days[-1], body.price)

    columns: list[list[float]] = [[] for _ in range(body.depth)]
    refs: list[str | None] = [None] * body.depth  # each point's legs on the latest day that has it
    root = len(code.product)
    for d in days:
        idx = book.leg_index(code, d)
        if idx is None:
            continue
        # The leg pattern, moved so its front leg sits on c1, c2, ...
        offsets = [i - idx[0] for i in idx]
        front = book.front(d)
        for k in range(body.depth):
            legs = [front + k + o for o in offsets]
            v = book.weighted(d, legs, code.weights)
            if v is None:
                continue
            columns[k].append(v)
            refs[k] = "-".join(book.codes[i][root:] for i in legs)

    # The point the strategy itself sits on: fixed for GD, on the latest day for RD.
    own = None
    if code.mode == "GD":
        own = code.legs[0] - 1
    else:
        last = book.leg_index(code, days[-1])
        if last is not None:
            own = last[0] - book.front(days[-1])

    def stat(f):
        return [round(f(c), 6) if c else None for c in columns]

    return {
        "code": code.text,
        "label": f"{PRODUCTS[code.product].label} {STRUCTURE[len(code.legs)]}",
        "days": len(days),
        "points": [f"c{k + 1}" for k in range(body.depth)],
        "refs": refs,
        "count": [len(c) for c in columns],
        "mean": stat(statistics.fmean),
        "median": stat(statistics.median),
        "min": stat(min),
        "max": stat(max),
        "own": own if own is not None and 0 <= own < body.depth else None,
    }
