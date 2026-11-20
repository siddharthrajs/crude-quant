"""Aggressor order sizes from the QH Data API's /tas/ (time and sales), fetched live for the roll analysis.

Nothing is stored in the database. A trade date's fills for one instrument are fetched, collapsed into aggressor
orders and reduced to a handful of numbers (DayFlow), which are kept in this process's memory only -- they are gone
when the API restarts and are fetched again when next asked for.

Daily aggressor buy and sell volume (every order) does not need this: QH's daily bars carry it (see
app/routers/curve_lab_2_roll_flow.py). Time and sales are only for what needs individual orders: large and block-size
orders, the settlement window and sweeps. They are slow to fetch -- 10 calls a minute at 10,000 fills a call, so an
outright's trade date is ~5 calls and a spread's 1-2 -- so days are fetched by one background worker, newest request
first, and callers read whatever is ready (`flows`) and ask for the rest (`request`).

A trade belongs to the trade date of the session it printed in: CME's session for D runs from 18:00 New York on the
day before, ICE's from 23:00 London on the day before (Sunday evening opens Monday's), so D's trades are fetched
over two UTC dates and assigned by the exchange clock. Fills with the same instrument, millisecond and side are one
aggressor order (a sweep when it filled at more than one price). The feed has only regular screen trades -- no
implied, block or trade-at-settlement volume. QH has time and sales from about September 2024.
"""

import asyncio
import logging
from collections import OrderedDict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd

from app.qh.client import QhError, client

logger = logging.getLogger(__name__)

# QH has time and sales from about here.
FIRST_DAY = date(2024, 9, 16)


@dataclass(frozen=True)
class Session:
    tz: ZoneInfo
    # Hours added to the exchange clock so the session's start falls on its trade date's midnight.
    shift: int
    # Settlement window, exchange clock.
    settle_from: time
    settle_to: time


SESSIONS = {
    "CL": Session(ZoneInfo("America/New_York"), 6, time(14, 28), time(14, 30)),
    "CO": Session(ZoneInfo("Europe/London"), 1, time(19, 28), time(19, 30)),
}

# Aggressor order size (lots) from which an order counts as large / block-size: the 98th and 99.8th percentiles of
# order size (by count) per product and kind, measured on Dec 2025 - Nov 2026 time and sales.
SIZES = {
    "CL": {"outright": (5, 25), "spread": (10, 50), "fly": (10, 50)},
    "CO": {"outright": (10, 50), "spread": (25, 100), "fly": (10, 50)},
}


def kind(code: str) -> str:
    return ("outright", "spread", "fly")[code.count("-")]


def instrument_codes(root: str, contracts: list[str]) -> list[str]:
    """Outrights, adjacent spreads and flies of `contracts` (codes in delivery order): CLZ26, ..., CLZ26-F27, ...,
    CLZ26-F27-G27, ..."""
    legs = [c[len(root):] for c in contracts]
    spreads = [f"{root}{a}-{b}" for a, b in zip(legs, legs[1:])]
    flies = [f"{root}{a}-{b}-{c}" for a, b, c in zip(legs, legs[1:], legs[2:])]
    return [*contracts, *spreads, *flies]


def _segments(s: Session, d: date) -> list[tuple[str, str, str]]:
    """The session of trade date `d` as (UTC date, start, end) pieces split at UTC midnight."""
    start = datetime.combine(d, time(0), s.tz) - timedelta(hours=s.shift)
    end = start + timedelta(days=1)
    start, end = start.astimezone(timezone.utc), end.astimezone(timezone.utc)
    out = []
    cur = start
    while cur < end:
        stop = min(end, datetime.combine(cur.date() + timedelta(days=1), time(0), timezone.utc))
        last = stop - timedelta(seconds=1)
        out.append((cur.date().isoformat(), cur.strftime("%H:%M:%S"), last.strftime("%H:%M:%S")))
        cur = stop
    return out


@dataclass(frozen=True)
class DayFlow:
    """One instrument's aggressor orders on one trade date (lots; net = bought minus sold by the aggressor)."""

    large: int
    block: int
    settle_net: int
    sweeps: int


EMPTY = DayFlow(0, 0, 0, 0)


def summarise(fills: list[dict], root: str, code: str, d: date) -> DayFlow:
    s = SESSIONS[root]
    if not fills:
        return EMPTY
    f = pd.DataFrame(fills, columns=["timestamp", "price", "qty", "side"])
    t = pd.to_datetime(f["timestamp"], unit="ms", utc=True).dt.tz_convert(s.tz)
    f = f[((t + pd.Timedelta(hours=s.shift)).dt.date == d).to_numpy()]
    if f.empty:
        return EMPTY
    o = f.groupby(["timestamp", "side"], sort=False).agg(qty=("qty", "sum"), prices=("price", "nunique")).reset_index()
    signed = o["qty"] * o["side"].clip(-1, 1)  # side 0 (unknown aggressor) counts nowhere
    large, block = SIZES[root][kind(code)]
    clock = pd.to_datetime(o["timestamp"], unit="ms", utc=True).dt.tz_convert(s.tz).dt.time
    in_window = ((clock >= s.settle_from) & (clock < s.settle_to)).to_numpy()
    return DayFlow(
        large=int(signed[o["qty"] >= large].sum()),
        block=int(signed[o["qty"] >= block].sum()),
        settle_net=int(signed[in_window].sum()),
        sweeps=int((o["prices"] > 1).sum()),
    )


def fetch_day(root: str, code: str, d: date) -> DayFlow:
    """Blocking: fetch and summarise one instrument's trade date."""
    request = [{"id": code, "dates": [day], "start": a, "end": b} for day, a, b in _segments(SESSIONS[root], d)]
    return summarise(client.tas(request), root, code, d)


# In-memory only. A DayFlow is a few ints, so even every instrument of every roll since 2024 is small.
_done: dict[tuple[str, date], DayFlow] = {}
# Waiting (code, day) -> root, popped from the end: the newest request is fetched first.
_queue: "OrderedDict[tuple[str, date], str]" = OrderedDict()
_failed: dict[tuple[str, date], str] = {}
_worker: asyncio.Task | None = None


def flows(code: str, days: list[date | None]) -> list[DayFlow | None]:
    return [_done.get((code, d)) if d else None for d in days]


def status(code: str, days: list[date | None]) -> dict[str, int]:
    """How many of `days` (those time and sales cover) are fetched, still queued and failed."""
    want = [(code, d) for d in days if d and d >= FIRST_DAY]
    return {
        "total": len(want),
        "done": sum(k in _done for k in want),
        "queued": sum(k in _queue for k in want),
        "failed": sum(k in _failed for k in want),
    }


def request(root: str, code: str, days: list[date | None]) -> None:
    """Queue the days of `code` not fetched yet ahead of anything asked for earlier, newest day first. Days that
    failed are tried again."""
    want = sorted({d for d in days if d and d >= FIRST_DAY and (code, d) not in _done}, reverse=True)
    for d in reversed(want):  # oldest first, so the newest ends up last and is popped first
        _queue.pop((code, d), None)
        _queue[(code, d)] = root
        _failed.pop((code, d), None)
    global _worker
    if want and (_worker is None or _worker.done()):
        _worker = asyncio.get_running_loop().create_task(_work())


async def _work() -> None:
    while _queue:
        (code, d), root = _queue.popitem()
        try:
            _done[(code, d)] = await asyncio.to_thread(fetch_day, root, code, d)
        except QhError as e:
            _failed[(code, d)] = str(e)
            logger.warning("TAS %s %s failed: %s", code, d, e)
            if "rejected the token" in str(e):
                for k in list(_queue):
                    _failed[k] = str(e)
                _queue.clear()
        except Exception as e:
            logger.exception("TAS %s %s failed", code, d)
            _failed[(code, d)] = repr(e)
