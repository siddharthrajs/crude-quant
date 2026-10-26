"""Market data for the Strategy Lab, read straight from the Reuters 1-minute SQLite databases.

Each product's database (settings.quant_db_dir) holds one table per generic outright (`lcoc1`, `clc7`,
`wtclc3_lcoc3`, ...), one row per minute with bid/ask OHLC, sizes, volume, the underlying contract
(`alias_underlying_ric`) and `datetime_ts` in exchange-local time with its `gmt_offset` (hours).

The share is slow and the tables are large, so each product is reduced once to 15-minute bars and kept in a local
cache (settings.quant_cache_dir); later loads read the cache and pull only the new minutes. A bar keeps:
  * mid   -- mid of the bar's last bid/ask; NaN when a side is missing, the quote is crossed or wider than the
             product's MAX spread (a wide back-month quote is a guess, and a fly built on it is noise);
  * code  -- the contract in that generic slot (month ordinal, see calendar.py; -1 = unknown);
  * vol   -- volume traded in the bar.
Bars are keyed by their start time in UTC (datetime_ts minus gmt_offset).

Each product also gets its trading day per bar and whether the bar closes at or before the settlement time
(Brent 19:30 London, WTI 14:30 New York), so a daily series can be sampled at the settlement window.
"""

import logging
import os
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from app.config import settings
from app.quant.calendar import derived_expiries, parse_contract, rule_expiry

logger = logging.getLogger(__name__)

BAR_MS = 15 * 60 * 1000
CACHE_VERSION = 1
# A loaded product is refreshed from the share when it is older than this.
REFRESH_SECONDS = 15 * 60
# Re-read this much history on a refresh, so a late-arriving minute near the cache's end is not lost.
OVERLAP_MS = 2 * 24 * 3600 * 1000
LOAD_THREADS = 4


@dataclass(frozen=True)
class ProductSpec:
    key: str
    label: str
    db_file: str
    table: str  # generic slot n -> table name
    depth: int  # generic slots loaded (strategies may use up to depth - 1; the last slot is for roll matching)
    tz: str
    day_shift_hours: int  # local time + this = the trading day the bar belongs to (evening sessions roll forward)
    settle: tuple[int, int]  # local settlement time; the daily price is the last bar closing at or before it
    expiry_rule: str
    max_spread: float


PRODUCTS: dict[str, ProductSpec] = {
    "LCO": ProductSpec("LCO", "Brent", "lco_futures.db", "lcoc{n}", 19, "Europe/London", 1, (19, 30), "brent", 0.25),
    "CL": ProductSpec("CL", "WTI", "cl_futures.db", "clc{n}", 19, "America/New_York", 6, (14, 30), "cl", 0.25),
    "WTCLCO": ProductSpec("WTCLCO", "WTI-Brent", "wtclco_futures.db", "wtclc{n}_lcoc{n}", 13, "Europe/London", 1, (19, 30), "brent", 0.30),
}


@dataclass
class Frame:
    """One product's 15-minute bars: arrays of shape (T,) and (T, depth)."""

    spec: ProductSpec
    ts: np.ndarray  # int64 ms UTC, bar start, ascending
    mid: np.ndarray  # float64 (T, depth)
    code: np.ndarray  # int32 (T, depth)
    vol: np.ndarray  # float32 (T, depth)
    day: np.ndarray = field(init=False)  # datetime64[D] trading day
    settle_ok: np.ndarray = field(init=False)  # bar closes at or before the settlement time of its trading day
    expiry: dict[int, object] = field(init=False)  # contract -> last trading day (date)
    expiry_source: dict[int, str] = field(init=False)  # "data" | "rule"
    loaded_at: float = field(default_factory=time.time)

    def __post_init__(self) -> None:
        local = pd.to_datetime(self.ts, unit="ms", utc=True).tz_convert(self.spec.tz).tz_localize(None)
        day = (local + pd.Timedelta(hours=self.spec.day_shift_hours)).normalize()
        # Stray weekend rows belong to no trading day.
        keep = np.asarray(day.dayofweek < 5)
        self.ts, self.mid, self.code, self.vol = self.ts[keep], self.mid[keep], self.code[keep], self.vol[keep]
        local, day = local[keep], day[keep]
        end = local + pd.Timedelta(milliseconds=BAR_MS)
        h, m = self.spec.settle
        self.day = day.values.astype("datetime64[D]")
        self.settle_ok = np.asarray(end <= day + pd.Timedelta(hours=h, minutes=m))
        self._expiries()

    def _expiries(self) -> None:
        # Front contract per trading day = the c1 contract on that day's last settlement-window bar that names one.
        # On an expiry day Reuters blanks c1 after the settlement and may roll it to the next contract late in the
        # evening, so bars after the settlement say nothing about which contract expired.
        named = np.flatnonzero((self.code[:, 0] >= 0) & self.settle_ok)
        days, last = np.unique(self.day[named][::-1], return_index=True)
        front = self.code[named[len(named) - 1 - last], 0]
        derived = derived_expiries(days, front)
        known = set(np.unique(self.code[self.code >= 0]).tolist())
        self.expiry = {}
        self.expiry_source = {}
        for key in known:
            if key in derived:
                self.expiry[key], self.expiry_source[key] = derived[key], "data"
            else:
                self.expiry[key], self.expiry_source[key] = rule_expiry(self.spec.expiry_rule, key), "rule"

    @property
    def last_ts(self) -> int:
        return int(self.ts[-1]) if len(self.ts) else 0


_QUERY = """
SELECT (datetime_ts - COALESCE(gmt_offset, 0) * 3600000) / {bar} AS b,
       max(datetime_ts), close_bid, close_ask, alias_underlying_ric, sum(COALESCE(volume, 0))
FROM "{table}" WHERE datetime_ts >= ? GROUP BY b ORDER BY b
"""


def _read_slot(spec: ProductSpec, n: int, since_ms: int) -> pd.DataFrame:
    path = Path(settings.quant_db_dir) / spec.db_file
    con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, check_same_thread=False)
    try:
        rows = con.execute(_QUERY.format(bar=BAR_MS, table=spec.table.format(n=n)), (since_ms,)).fetchall()
    finally:
        con.close()
    df = pd.DataFrame(rows, columns=["b", "_", "bid", "ask", "ric", "vol"]).drop(columns="_")
    df["ts"] = df.pop("b").astype("int64") * BAR_MS
    bid, ask = df["bid"].astype("float64"), df["ask"].astype("float64")
    good = bid.notna() & ask.notna() & (ask >= bid) & (ask - bid <= spec.max_spread)
    df["mid"] = ((bid + ask) / 2).where(good)
    # Contract names -> month ordinals, resolved once per (name, year, month) of the bar.
    when = pd.to_datetime(df["ts"], unit="ms", utc=True)
    keys = pd.DataFrame({"ric": df["ric"].fillna(""), "y": when.dt.year, "m": when.dt.month})
    uniq = keys.drop_duplicates()
    uniq["code"] = [parse_contract(r, y, m) for r, y, m in zip(uniq["ric"], uniq["y"], uniq["m"])]
    df["code"] = keys.merge(uniq, on=["ric", "y", "m"], how="left")["code"].fillna(-1).astype("int32").to_numpy()
    return df[["ts", "mid", "code", "vol"]]


def _assemble(spec: ProductSpec, slots: list[pd.DataFrame]) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    ts = np.unique(np.concatenate([s["ts"].to_numpy() for s in slots])) if slots else np.array([], "int64")
    mid = np.full((len(ts), spec.depth), np.nan)
    code = np.full((len(ts), spec.depth), -1, "int32")
    vol = np.zeros((len(ts), spec.depth), "float32")
    for j, s in enumerate(slots):
        pos = np.searchsorted(ts, s["ts"].to_numpy())
        mid[pos, j] = s["mid"].to_numpy()
        code[pos, j] = s["code"].to_numpy()
        vol[pos, j] = s["vol"].to_numpy()
    return ts, mid, code, vol


def _cache_path(spec: ProductSpec) -> Path:
    return Path(settings.quant_cache_dir) / f"{spec.key}_15m_v{CACHE_VERSION}.npz"


def _retry(fn, tries: int = 10):
    """Windows refuses to open a file another process is replacing (and vice versa); wait it out briefly."""
    for i in range(tries):
        try:
            return fn()
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(0.5)


def _read_cache(path: Path) -> tuple[np.ndarray, ...]:
    # Copy out and close: on Windows an open .npz cannot be replaced by a save.
    with np.load(path) as z:
        return z["ts"].copy(), z["mid"].copy(), z["code"].copy(), z["vol"].copy()


def _load(spec: ProductSpec, progress) -> Frame:
    path = _cache_path(spec)
    old = None
    since = 0
    if path.exists():
        old = _retry(lambda: _read_cache(path))
        since = max(0, int(old[0][-1]) - OVERLAP_MS) if len(old[0]) else 0
    # datetime_ts is exchange-local; reading from a little before the UTC cut-off is harmless (bars are merged).
    since_local = max(0, since - 24 * 3600 * 1000)
    done = 0

    def one(n: int) -> pd.DataFrame:
        nonlocal done
        df = _read_slot(spec, n, since_local)
        done += 1
        progress(done / spec.depth)
        return df

    with ThreadPoolExecutor(LOAD_THREADS) as pool:
        slots = list(pool.map(one, range(1, spec.depth + 1)))
    ts, mid, code, vol = _assemble(spec, slots)
    if old is not None:
        keep = old[0] < (ts[0] if len(ts) else np.iinfo("int64").max)
        ts = np.concatenate([old[0][keep], ts])
        mid = np.concatenate([old[1][keep], mid])
        code = np.concatenate([old[2][keep], code])
        vol = np.concatenate([old[3][keep], vol])
    path.parent.mkdir(parents=True, exist_ok=True)
    # Per-process temp name: two processes (e.g. a reloading dev server) may refresh the same product at once.
    tmp = path.with_name(f"{path.stem}.{os.getpid()}.tmp.npz")
    np.savez(tmp, ts=ts, mid=mid, code=code, vol=vol)
    try:
        _retry(lambda: tmp.replace(path))
    finally:
        tmp.unlink(missing_ok=True)
    return Frame(spec, ts, mid, code, vol)


class NotReady(Exception):
    pass


class Store:
    """Loaded frames plus their load state; loads and refreshes run on background threads."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._frames: dict[str, Frame] = {}
        self._status: dict[str, dict] = {k: {"state": "idle", "progress": 0.0, "error": None} for k in PRODUCTS}

    def status(self) -> dict[str, dict]:
        with self._lock:
            out = {}
            for k, st in self._status.items():
                f = self._frames.get(k)
                out[k] = {
                    **st,
                    "label": PRODUCTS[k].label,
                    "ready": f is not None,
                    "bars": int(len(f.ts)) if f else 0,
                    "first": _iso(f.ts[0]) if f and len(f.ts) else None,
                    "last": _iso(f.ts[-1]) if f and len(f.ts) else None,
                }
            return out

    def ensure(self, product: str) -> None:
        """Start a load (first time) or a refresh (stale) in the background; never blocks."""
        with self._lock:
            st = self._status[product]
            frame = self._frames.get(product)
            if st["state"] == "loading":
                return
            if frame is not None and time.time() - frame.loaded_at < REFRESH_SECONDS:
                return
            st.update(state="loading", progress=0.0, error=None)
        threading.Thread(target=self._run, args=(product,), daemon=True, name=f"quant-load-{product}").start()

    def _run(self, product: str) -> None:
        spec = PRODUCTS[product]
        started = time.time()

        def progress(p: float) -> None:
            with self._lock:
                self._status[product]["progress"] = round(p, 3)

        try:
            frame = _load(spec, progress)
            with self._lock:
                self._frames[product] = frame
                self._status[product].update(state="ready", progress=1.0)
            logger.info("quant: %s loaded, %d bars in %.0fs", product, len(frame.ts), time.time() - started)
        except Exception as exc:  # the share can drop; keep serving the old frame
            logger.exception("quant: loading %s failed", product)
            with self._lock:
                self._status[product].update(state="error", error=str(exc))

    def get(self, product: str) -> Frame:
        if product not in PRODUCTS:
            raise KeyError(product)
        self.ensure(product)
        with self._lock:
            frame = self._frames.get(product)
        if frame is None:
            raise NotReady(product)
        return frame


def _iso(ms) -> str:
    return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).isoformat()


store = Store()
