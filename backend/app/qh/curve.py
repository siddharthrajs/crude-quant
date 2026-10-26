"""Daily curves for the Strategy Lab, read from qh_daily_bars (kept current by app/qh/sync.py).

A product's curve is a [trading day x contract] grid:
  days      trading days (datetime64[D], ascending) -- weekdays on which the front contract traded
  keys      contract month ordinals (app/quant/calendar.py), ascending; `codes` the QH codes beside them
  expiry    each contract's last trading day
  close     session last trade (not settlement); NaN where the contract had no bar that day
  close_ff  close carried forward over days the contract did not trade, within its life (NaN before its first bar
            and after its expiry) -- the value a stale leg is priced at
  volume    0 where the contract had no bar

Generic slots come from the expiries: on day d, c1 is the first contract whose expiry is on or after d, c2 the
next, and so on, so the slots roll the day after expiry (as QH's own CL1, CO1 and WTCLCO1 do).

Curves are cached in memory and reloaded when a sync has touched the product (max synced_at changes).
"""

import asyncio
from dataclasses import dataclass
from datetime import datetime

import numpy as np
import pandas as pd
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.quant.calendar import key_of


@dataclass
class Curve:
    product: str
    version: datetime | None
    days: np.ndarray
    keys: np.ndarray
    codes: list[str]
    expiry: np.ndarray
    close: np.ndarray
    close_ff: np.ndarray
    volume: np.ndarray

    def index_of_keys(self, keys: np.ndarray) -> np.ndarray:
        """Contract index of each month ordinal (-1 where the contract is not on the curve, or the key is -1)."""
        i = np.searchsorted(self.keys, keys)
        found = (keys >= 0) & (i < len(self.keys))
        found[found] &= self.keys[i[found]] == keys[found]
        return np.where(found, i, -1)

    def slot_index(self, slot: int) -> np.ndarray:
        """Contract index in generic slot `slot` (1 = front) on each day; -1 where the curve is not that long."""
        front = np.searchsorted(self.expiry, self.days, side="left")
        idx = front + slot - 1
        return np.where(idx < len(self.keys), idx, -1)


_cache: dict[str, Curve] = {}
_lock = asyncio.Lock()


async def _version(db: AsyncSession, product: str) -> datetime | None:
    return (await db.execute(text("SELECT max(synced_at) FROM qh_contracts WHERE product = :p"), {"p": product})).scalar()


async def _load(db: AsyncSession, product: str, version: datetime | None) -> Curve:
    contracts = (
        await db.execute(
            text("SELECT code, delivery_month, expiry FROM qh_contracts WHERE product = :p ORDER BY delivery_month"),
            {"p": product},
        )
    ).all()
    bars = (
        await db.execute(
            text(
                "SELECT b.code, b.trade_date, b.close, b.volume FROM qh_daily_bars b "
                "JOIN qh_contracts c ON c.code = b.code WHERE c.product = :p"
            ),
            {"p": product},
        )
    ).all()
    codes = [c.code for c in contracts]
    keys = np.array([key_of(c.delivery_month.year, c.delivery_month.month) for c in contracts], dtype=np.int64)
    expiry = np.array([c.expiry for c in contracts], dtype="datetime64[D]")
    frame = pd.DataFrame(bars, columns=["code", "trade_date", "close", "volume"])
    frame["trade_date"] = pd.to_datetime(frame["trade_date"])
    close = frame.pivot(index="trade_date", columns="code", values="close").reindex(columns=codes)
    volume = frame.pivot(index="trade_date", columns="code", values="volume").reindex(columns=codes)
    close = close[close.index.dayofweek < 5].sort_index()
    volume = volume.reindex(close.index).fillna(0)

    all_days = close.index.values.astype("datetime64[D]")
    front = np.searchsorted(expiry, all_days, side="left")
    has_front = front < len(codes)
    rows = np.arange(len(all_days))
    traded = np.zeros(len(all_days), dtype=bool)
    traded[has_front] = ~np.isnan(close.to_numpy()[rows[has_front], front[has_front]])
    close, volume, days = close[traded], volume[traded], all_days[traded]

    after_expiry = days[:, None] > expiry[None, :]
    close_ff = close.ffill().to_numpy()
    close_ff[after_expiry] = np.nan
    return Curve(
        product=product,
        version=version,
        days=days,
        keys=keys,
        codes=codes,
        expiry=expiry,
        close=close.to_numpy(),
        close_ff=close_ff,
        volume=volume.to_numpy(),
    )


async def get_curves(db: AsyncSession, products: set[str]) -> dict[str, Curve]:
    out = {}
    async with _lock:
        for p in products:
            version = await _version(db, p)
            cached = _cache.get(p)
            if cached is None or cached.version != version:
                cached = _cache[p] = await _load(db, p, version)
            out[p] = cached
    return out
