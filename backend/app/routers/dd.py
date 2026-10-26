"""Strategy Lab DD tab: a target strategy's distribution under range filters on base strategies (app/qh/dd.py).

  GET  /api/dd/meta   products, each product's contracts (for RD legs), generic slot range, QH sync state
  POST /api/dd/run    price the strategies, apply the filters, return the target's distributions

Data: QH daily bars in Postgres, kept current by app/qh/sync.py.
"""

import asyncio
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.db.base import get_db
from app.db.models import User
from app.qh import dd, sync
from app.qh.curve import get_curves
from app.qh.products import PRODUCTS

router = APIRouter(prefix="/api/dd", tags=["dd"])

MAX_SLOT = 24
MAX_LEGS = 8
MAX_STRATEGIES = 6
MIN_BINS = 3
MAX_BINS = 200

Product = Literal["CL", "CO", "WTCLCO"]


class LegIn(BaseModel):
    product: Product
    ref: str = Field(min_length=2, max_length=4)
    weight: float


class StrategyIn(BaseModel):
    id: str = Field(min_length=1, max_length=16)
    name: str = Field(default="", max_length=40)
    # GD: legs are generic slots ("c3"); RD: named contracts ("Z26").
    mode: Literal["RD", "GD"]
    legs: list[LegIn] = Field(min_length=1, max_length=MAX_LEGS)
    lo: float | None = None
    hi: float | None = None


class RunIn(BaseModel):
    strategies: list[StrategyIn] = Field(min_length=1, max_length=MAX_STRATEGIES)
    target_id: str
    start: date | None = None
    end: date | None = None
    include_stale: bool = False
    # Bar count of the target's histograms; None = automatic (Freedman-Diaconis).
    bins: int | None = Field(default=None, ge=MIN_BINS, le=MAX_BINS)

    @model_validator(mode="after")
    def _target_present(self) -> "RunIn":
        if self.target_id not in {s.id for s in self.strategies}:
            raise ValueError("target_id must be one of the strategies")
        return self


@router.get("/meta")
async def meta(db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)) -> dict:
    rows = (
        await db.execute(
            text(
                "SELECT product, code, delivery_month, expiry, first_bar, last_bar FROM qh_contracts "
                "WHERE last_bar IS NOT NULL ORDER BY product, delivery_month"
            )
        )
    ).all()
    contracts: dict[str, list[dict]] = {p: [] for p in PRODUCTS}
    for r in rows:
        contracts[r.product].append({
            "ref": r.code[len(r.product):],
            "expiry": r.expiry.isoformat(),
            "first_bar": r.first_bar.isoformat(),
            "last_bar": r.last_bar.isoformat(),
        })
    return {
        "products": [{"root": p.root, "label": p.label} for p in PRODUCTS.values()],
        "contracts": contracts,
        "max_slot": MAX_SLOT,
        "horizons": list(dd.HORIZONS),
        "sync": sync.status,
    }


@router.post("/run")
async def run(body: RunIn, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)) -> dict:
    for s in body.strategies:
        for leg in s.legs:
            if s.mode == "GD" and leg.ref.lower().startswith("c") and leg.ref[1:].isdigit() and int(leg.ref[1:]) > MAX_SLOT:
                raise HTTPException(status_code=422, detail=f"Generic slots go up to c{MAX_SLOT}")
    products = {leg.product for s in body.strategies for leg in s.legs}
    curves = await get_curves(db, products)
    if any(len(c.days) == 0 for c in curves.values()):
        raise HTTPException(status_code=503, detail="QH daily data is still loading; try again shortly")
    strategies = [
        dd.Strategy(
            id=s.id,
            name=s.name,
            mode=s.mode,
            legs=tuple(dd.Leg(l.product, l.ref, l.weight) for l in s.legs if l.weight != 0),
            lo=s.lo,
            hi=s.hi,
        )
        for s in body.strategies
    ]
    if any(not s.legs for s in strategies):
        raise HTTPException(status_code=422, detail="Every strategy needs at least one leg with a non-zero weight")
    try:
        return await asyncio.to_thread(
            dd.run, strategies, body.target_id, curves, body.start, body.end, body.include_stale, body.bins
        )
    except dd.DDError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
