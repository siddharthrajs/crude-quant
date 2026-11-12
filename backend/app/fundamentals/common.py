"""Paths and the Postgres connection shared by the fundamentals scripts."""

import datetime as dt
from pathlib import Path

import asyncpg

from app.config import settings

MODES = ("backtest", "live")

DATA = Path(settings.fundamentals_dir)
REPORTS = DATA / "reports"
TEXT = DATA / "text"  # pdftotext reading order: articles read straight through
TEXT_LAYOUT = DATA / "text_layout"  # pdftotext -layout: tables keep their columns
BUNDLES = DATA / "bundles"
FACTS = DATA / "facts"
RUNS = DATA / "runs"
STATE = DATA / "state.json"

# The Brent contract a run quotes its ranges and `brent_ref` tests on, stored on the run (fnd.runs.ref_contract).
# The backtest is pinned to COF27 (front month from 31 Oct, expires 30 Nov 2026) so its runs compare. A live run
# takes the first Brent contract that expires more than REF_MIN_DAYS after the run date, so it never expires before
# the run's horizons (the Friday of the following week, at most 11 days out).
REF_CONTRACT = "COF27"
REF_MIN_DAYS = 14


def run_paths(mode: str) -> tuple[Path, Path]:
    """(runs dir, state file) of a mode. The backtest's sit at the top of DATA, the live ones under DATA/live."""
    assert mode in MODES, mode
    return (RUNS, STATE) if mode == "backtest" else (DATA / "live" / "runs", DATA / "live" / "state.json")


async def ref_contract(conn: asyncpg.Connection, day: dt.date, mode: str) -> str:
    if mode == "backtest":
        return REF_CONTRACT
    return await conn.fetchval(
        "SELECT code FROM qh_contracts WHERE product = 'CO' AND expiry > $1 ORDER BY expiry LIMIT 1",
        day + dt.timedelta(days=REF_MIN_DAYS))


async def connect() -> asyncpg.Connection:
    return await asyncpg.connect(settings.database_url.replace("postgresql+asyncpg://", "postgresql://"))
