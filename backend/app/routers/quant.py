"""Strategy Lab API: any strategy (weighted generic slots) analysed against the market state.

  GET  /api/quant/status     load state of each product's 15-minute cache (built from the SQLite share)
  GET  /api/quant/meta       products, state variables, events, horizons -- what the UI offers
  GET  /api/quant/calendar   every contract's expiry, from the data where known, and the exchange rule beside it
  POST /api/quant/run        one tool (see app/quant/tools.py) for one strategy + filters

The work is pandas/numpy on in-memory arrays, so the endpoints are plain `def` (FastAPI runs them on its thread
pool) and the per-strategy state table is cached until a product's data is refreshed.
"""

from collections import OrderedDict
from datetime import date
from threading import Lock
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth.dependencies import get_current_user
from app.db.models import User
from app.quant.calendar import key_code, rule_expiry
from app.quant.source import PRODUCTS, NotReady, store
from app.quant.state import EVENTS, HORIZONS, STATE_VARS, apply_filters, build_state
from app.quant.strategy import Leg, StrategyError, build, legs_label
from app.quant.tools import TOOLS, Ctx

router = APIRouter(prefix="/api/quant", tags=["quant"])

Product = Literal["LCO", "CL", "WTCLCO"]


class LegIn(BaseModel):
    product: Product
    slot: int = Field(ge=1, le=24)
    weight: float


class ConditionIn(BaseModel):
    var: str
    lo: float | None = None
    hi: float | None = None


class FiltersIn(BaseModel):
    start: date | None = None
    end: date | None = None
    exclude_events: list[str] = []
    months: list[int] = []
    weekdays: list[int] = []
    gsci: int | None = None
    conditions: list[ConditionIn] = []


class RunIn(BaseModel):
    legs: list[LegIn] = Field(min_length=1, max_length=12)
    ref: Product | None = None
    lookback: int = Field(default=10, ge=3, le=120)
    filters: FiltersIn = FiltersIn()
    tool: Literal["profile", "scenario", "breakout", "expiry", "seasonal", "analogs"]
    params: dict = {}


_cache: OrderedDict = OrderedDict()
_cache_lock = Lock()
CACHE_SIZE = 8


def _frames(products: set[str]) -> dict:
    try:
        return {p: store.get(p) for p in products}
    except NotReady as exc:
        raise HTTPException(status_code=503, detail=f"{PRODUCTS[str(exc)].label} data is still loading from the share; try again shortly")


@router.get("/status")
def status(_: User = Depends(get_current_user)) -> dict:
    for p in PRODUCTS:
        store.ensure(p)
    return store.status()


@router.get("/meta")
def meta(_: User = Depends(get_current_user)) -> dict:
    return {
        "products": [{"key": s.key, "label": s.label, "depth": s.depth - 1} for s in PRODUCTS.values()],
        "state_vars": [{"key": k, "label": label, "unit": unit} for k, (label, unit) in STATE_VARS.items()],
        "events": [{"key": k, "label": label, "start": a, "end": b} for k, (a, b, label) in EVENTS.items()],
        "horizons": list(HORIZONS),
    }


@router.get("/calendar")
def calendar(product: Product = "LCO", _: User = Depends(get_current_user)) -> list[dict]:
    frame = _frames({product})[product]
    out = []
    for key in sorted(frame.expiry):
        rule = rule_expiry(frame.spec.expiry_rule, key)
        out.append(
            {
                "contract": f"{product}{key_code(key)}",
                "expiry": frame.expiry[key].isoformat(),
                "source": frame.expiry_source[key],
                "rule": rule.isoformat(),
                "matches_rule": frame.expiry[key] == rule,
            }
        )
    return out


@router.post("/run")
def run(body: RunIn, _: User = Depends(get_current_user)) -> dict:
    legs = [Leg(l.product, l.slot, l.weight) for l in body.legs]
    ref = body.ref or legs[0].product
    frames = _frames({l.product for l in legs} | {ref})
    key = (tuple(legs), ref, body.lookback, tuple(sorted((p, f.loaded_at) for p, f in frames.items())))
    try:
        with _cache_lock:
            hit = _cache.get(key)
            if hit:
                _cache.move_to_end(key)
        if hit is None:
            strat = build(legs, frames, ref)
            state = build_state(strat, frames, body.lookback)
            hit = (strat, state)
            with _cache_lock:
                _cache[key] = hit
                while len(_cache) > CACHE_SIZE:
                    _cache.popitem(last=False)
        strat, state = hit
        flt = body.filters.model_dump(mode="json")
        mask = apply_filters(state, flt)
        base = apply_filters(state, {k: flt[k] for k in ("start", "end", "exclude_events")})
        ctx = Ctx(frames=frames, strat=strat, state=state, mask=mask, base=base, filters=flt, lookback=body.lookback)
        result = TOOLS[body.tool](ctx, body.params)
    except StrategyError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {
        "tool": body.tool,
        "label": legs_label(strat.legs),
        "ref": ref,
        "first": state.index[0].date().isoformat(),
        "last": state.index[-1].date().isoformat(),
        "n_days": int(len(state)),
        "n_matched": int(mask.sum()),
        "result": result,
    }
