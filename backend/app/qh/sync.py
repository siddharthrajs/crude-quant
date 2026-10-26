"""Keep qh_contracts, qh_settlements and qh_daily_bars current from the QH Data API.

Settlements (/common/dailymarketdata) are what the Strategy Lab prices from. The first load (and any load after
qh_history_start moves earlier, see qh_sync_state) pulls each generic slot 1..SETTLE_SLOTS by generic code: one
call gives every day's contract in that slot and its settlement, back to 2005, including contracts /ohlc no longer
has. After that, the contracts still trading are topped up by code over the last TOPUP_DAYS.

Daily bars (/ohlc) keep each session's OHLC, volume and buy/sell volume (last trades, not settlements). Every
monthly contract of each product (app/qh/products.py) that expires on or after settings.qh_history_start,
up to AHEAD_MONTHS past today, is tracked. A contract's daily bars are fetched in full the first time -- and again
whenever qh_history_start moves earlier than the date it was fetched from (`fetched_from`); after that only the
last TOPUP_DAYS are fetched again (re-fetched, not appended, so a late correction overwrites). A contract that
expired more than TOPUP_DAYS ago is complete and never fetched again.

QH's /ohlc has daily bars from 2011 on, but only for contracts expiring from about mid-2015 (CO back to ~2006);
earlier contracts come back empty, so history before 2015 is partial.

QH labels a daily bar with its trade date (checked against summed hourly bars for CL, CO and WTCLCO). The bar of
the session still trading is never stored: only trade dates before today (London) are kept.

Expiry: for a contract past its exchange-rule expiry, the date of its last settlement (else its last bar) when that
is within EXPIRY_TOLERANCE_DAYS of the rule (the data catches holiday shifts the rule table misses), otherwise the
rule (logged); for a live contract, the rule.

Run from backend/ (a full backfill on empty tables, a top-up after that):

    .venv\\Scripts\\python -m app.qh.sync
    .venv\\Scripts\\python -m app.qh.sync --products CL --check-rolls

--check-rolls compares the expiries with QH's own front-month (`CL1`, ...) roll dates.
"""

import argparse
import asyncio
import logging
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import asyncpg

from app.config import settings
from app.qh.client import client
from app.qh.products import PRODUCTS, QhProduct, contract_code
from app.quant.calendar import MONTH_CODES, key_date, key_of, rule_expiry

logger = logging.getLogger(__name__)

LONDON = ZoneInfo("Europe/London")
# Contracts per /ohlc call (the API takes up to 50; a full-history call of 20 is ~20k rows).
BATCH = 20
AHEAD_MONTHS = 36
TOPUP_DAYS = 10
EXPIRY_TOLERANCE_DAYS = 5
# Generic slots whose settlement history is loaded. An RD strategy can sit up to ~11 slots further out than its
# columns (which reach c24) during the year, so 36 covers it.
SETTLE_SLOTS = 36

UPSERT_SETTLE = """
INSERT INTO qh_settlements (code, trade_date, settle, volume, oi) VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (code, trade_date) DO UPDATE SET settle = EXCLUDED.settle, volume = EXCLUDED.volume, oi = EXCLUDED.oi
"""

UPSERT_BAR = """
INSERT INTO qh_daily_bars (code, trade_date, open, high, low, close, volume, buy_volume, sell_volume)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (code, trade_date) DO UPDATE SET
    open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
    volume = EXCLUDED.volume, buy_volume = EXCLUDED.buy_volume, sell_volume = EXCLUDED.sell_volume
"""

# Per product: state (idle / syncing / ok / error), when it last finished, its newest trade date, the last error.
status: dict[str, dict] = {
    root: {"state": "idle", "last_sync": None, "last_trade_date": None, "error": None} for root in PRODUCTS
}
_lock = asyncio.Lock()


def _dsn() -> str:
    return settings.database_url.replace("postgresql+asyncpg://", "postgresql://")


def _today() -> date:
    return datetime.now(LONDON).date()


def _unix(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())


def _opt_int(v) -> int | None:
    return None if v is None else int(round(float(v)))


def _expiry(p: QhProduct, key: int, last_day: date | None, today: date) -> tuple[date, str]:
    rule = rule_expiry(p.rule, key)
    if rule >= today or last_day is None:
        return rule, "rule"
    if abs((last_day - rule).days) <= EXPIRY_TOLERANCE_DAYS:
        if last_day != rule:
            logger.info("%s: last day %s, rule expiry %s -- using the data", contract_code(p.root, key), last_day, rule)
        return last_day, "data"
    logger.warning("%s: last day %s is far from the rule expiry %s -- using the rule", contract_code(p.root, key), last_day, rule)
    return rule, "rule"


def _key_of_code(root: str, code: str) -> int | None:
    """Month ordinal of a QH outright code of this product ('CLZ26' -> Dec 2026); None for anything else."""
    rest = code[len(root):] if code.startswith(root) else ""
    if len(rest) != 3 or rest[0] not in MONTH_CODES or not rest[1:].isdigit():
        return None
    return key_of(2000 + int(rest[1:]), MONTH_CODES.index(rest[0]) + 1)


async def _ensure_contract(conn: asyncpg.Connection, p: QhProduct, key: int) -> str:
    code = contract_code(p.root, key)
    await conn.execute(
        "INSERT INTO qh_contracts (code, product, delivery_month, expiry, expiry_source) "
        "VALUES ($1, $2, $3, $4, 'rule') ON CONFLICT (code) DO NOTHING",
        code, p.root, key_date(key), rule_expiry(p.rule, key),
    )
    return code


async def _refresh_expiry(conn: asyncpg.Connection, p: QhProduct, key: int, today: date) -> None:
    """Expiry from the contract's last settlement, else its last bar (see the module docstring)."""
    code = contract_code(p.root, key)
    last = await conn.fetchval(
        "SELECT coalesce((SELECT max(trade_date) FROM qh_settlements WHERE code = $1), "
        "(SELECT max(trade_date) FROM qh_daily_bars WHERE code = $1))",
        code,
    )
    expiry, source = _expiry(p, key, last, today)
    await conn.execute("UPDATE qh_contracts SET expiry = $2, expiry_source = $3 WHERE code = $1", code, expiry, source)


async def _store_settlements(conn: asyncpg.Connection, p: QhProduct, rows: list[dict], today: date) -> int:
    by_key: dict[int, list[tuple]] = defaultdict(list)
    for r in rows:
        key = _key_of_code(p.root, r.get("qhcode") or "")
        d = date.fromisoformat(r["datetime"][:10])
        if key is None or r.get("close") is None or d >= today:
            continue
        by_key[key].append((contract_code(p.root, key), d, float(r["close"]), _opt_int(r.get("volume")), _opt_int(r.get("oi"))))
    n = 0
    async with conn.transaction():
        for key, vals in by_key.items():
            await _ensure_contract(conn, p, key)
            await conn.executemany(UPSERT_SETTLE, vals)
            await _refresh_expiry(conn, p, key, today)
            n += len(vals)
    return n


async def _sync_settlements(conn: asyncpg.Connection, p: QhProduct, today: date) -> int:
    start = settings.qh_history_start
    loaded_from = await conn.fetchval("SELECT settlements_from FROM qh_sync_state WHERE product = $1", p.root)
    n = 0
    if loaded_from is None or loaded_from > start:
        for slot in range(1, SETTLE_SLOTS + 1):
            rows = await asyncio.to_thread(client.settlements, gdcode=f"{p.root}{slot}", start=start.isoformat(), end=today.isoformat())
            n += await _store_settlements(conn, p, rows, today)
            logger.info("QH %s settlements: slot %d -> %d rows", p.root, slot, len(rows))
        await conn.execute(
            "INSERT INTO qh_sync_state (product, settlements_from, settlements_synced_at) VALUES ($1, $2, now()) "
            "ON CONFLICT (product) DO UPDATE SET settlements_from = EXCLUDED.settlements_from, settlements_synced_at = now()",
            p.root, start,
        )
        return n
    since = today - timedelta(days=TOPUP_DAYS)
    codes = [
        r["code"]
        for r in await conn.fetch(
            "SELECT code FROM qh_contracts WHERE product = $1 AND expiry >= $2 ORDER BY delivery_month", p.root, since
        )
    ]
    for i in range(0, len(codes), BATCH):
        rows = await asyncio.to_thread(client.settlements, qhcodes=codes[i:i + BATCH], start=since.isoformat(), end=today.isoformat())
        n += await _store_settlements(conn, p, rows, today)
    await conn.execute("UPDATE qh_sync_state SET settlements_synced_at = now() WHERE product = $1", p.root)
    return n


async def _store(conn: asyncpg.Connection, p: QhProduct, keys: list[int], bars: list[dict], today: date,
                 fetched_from: date | None) -> int:
    """Upserts the bars and refreshes each contract's row. `fetched_from` is the start of a full-history fetch (None
    for a top-up)."""
    rows: dict[str, list[tuple]] = defaultdict(list)
    for b in bars:
        d = datetime.fromtimestamp(b["time"] / 1000, timezone.utc).date()
        if d >= today:
            continue
        rows[b["product"]].append((
            b["product"], d, float(b["open"]), float(b["high"]), float(b["low"]), float(b["close"]),
            int(round(float(b["volume"] or 0))), _opt_int(b.get("buyvolume")), _opt_int(b.get("sellvolume")),
        ))
    n = 0
    async with conn.transaction():
        for key in keys:
            code = await _ensure_contract(conn, p, key)
            if rows.get(code):
                await conn.executemany(UPSERT_BAR, rows[code])
                n += len(rows[code])
            first, last = await conn.fetchrow("SELECT min(trade_date), max(trade_date) FROM qh_daily_bars WHERE code = $1", code)
            await conn.execute(
                "UPDATE qh_contracts SET first_bar = $2, last_bar = $3, synced_at = now(), "
                "fetched_from = COALESCE($4, fetched_from) WHERE code = $1",
                code, first, last, fetched_from,
            )
            await _refresh_expiry(conn, p, key, today)
    return n


async def _sync_product(conn: asyncpg.Connection, p: QhProduct) -> None:
    st = status[p.root]
    st.update(state="syncing", error=None)
    try:
        today = _today()
        start = settings.qh_history_start
        settled = await _sync_settlements(conn, p, today)
        logger.info("QH %s: %d settlements written", p.root, settled)
        known = {
            r["code"]: r
            for r in await conn.fetch("SELECT code, expiry, synced_at, fetched_from FROM qh_contracts WHERE product = $1", p.root)
        }
        full: list[int] = []
        topup: list[int] = []
        for key in range(key_of(start.year, start.month), key_of(today.year, today.month) + AHEAD_MONTHS + 1):
            if rule_expiry(p.rule, key) < start:
                continue
            k = known.get(contract_code(p.root, key))
            if k is None or k["synced_at"] is None or k["fetched_from"] is None or k["fetched_from"] > start:
                full.append(key)
            elif k["expiry"] >= today - timedelta(days=TOPUP_DAYS):
                topup.append(key)
        end = int(time.time())
        stored = 0
        for keys, since, is_full in ((full, start, True), (topup, today - timedelta(days=TOPUP_DAYS), False)):
            for i in range(0, len(keys), BATCH):
                chunk = keys[i:i + BATCH]
                codes = [contract_code(p.root, k) for k in chunk]
                bars = await asyncio.to_thread(client.ohlc, codes, "1D", start=_unix(since), end=end, extra=("buyvolume", "sellvolume"))
                stored += await _store(conn, p, chunk, bars, today, start if is_full else None)
                logger.info("QH %s: %s..%s from %s -> %d bars", p.root, codes[0], codes[-1], since, len(bars))
        st.update(
            state="ok",
            last_sync=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            last_trade_date=await conn.fetchval(
                "SELECT max(s.trade_date) FROM qh_settlements s JOIN qh_contracts c ON c.code = s.code WHERE c.product = $1", p.root
            ),
        )
        logger.info("QH %s synced: %d new contracts, %d topped up, %d bars written", p.root, len(full), len(topup), stored)
    except Exception as e:
        st.update(state="error", error=str(e))
        logger.exception("QH sync of %s failed", p.root)


async def sync(products: list[str] | None = None) -> dict[str, dict]:
    async with _lock:
        conn = await asyncpg.connect(_dsn())
        try:
            for root in products or list(PRODUCTS):
                await _sync_product(conn, PRODUCTS[root])
        finally:
            await conn.close()
    return status


def _seconds_to_next_run(now: datetime) -> float:
    hour, minute = (int(x) for x in settings.qh_sync_time.split(":"))
    run = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if run <= now:
        run = (run + timedelta(days=1)).replace(hour=hour, minute=minute)
    return (run - now).total_seconds()


async def run_forever() -> None:
    """Background top-up while the API runs (settings.qh_autosync): once at startup, to catch up on any days the
    API was down, then daily at settings.qh_sync_time London."""
    while True:
        await sync()
        await asyncio.sleep(_seconds_to_next_run(datetime.now(LONDON)))


async def check_rolls(root: str) -> list[str]:
    """Compare each expiry with the day QH's front-month generic moved to the next contract.

    QH's daily generic dates are a day early in UK summer-time months, so a roll date from expiry + 0 days (the
    shifted label) to expiry + 4 days (a weekend or holiday in between) is a match."""
    p = PRODUCTS[root]
    start = settings.qh_history_start
    series = await asyncio.to_thread(client.generic, f"{root}1", "1D", (date.today() - start).days)
    rolls = {
        r["Product"]: datetime.fromtimestamp(r["Date"] / 1000, timezone.utc).date() for r in series.get("roll_dates", [])
    }
    conn = await asyncpg.connect(_dsn())
    try:
        contracts = await conn.fetch(
            "SELECT code, expiry, expiry_source FROM qh_contracts WHERE product = $1 ORDER BY delivery_month", p.root
        )
    finally:
        await conn.close()
    problems = []
    checked = 0
    for prev, nxt in zip(contracts, contracts[1:]):
        rolled = rolls.get(nxt["code"])
        if rolled is None or prev["expiry"] < start:
            continue
        checked += 1
        gap = (rolled - prev["expiry"]).days
        if not 0 <= gap <= 4:
            problems.append(f"{prev['code']} expiry {prev['expiry']} ({prev['expiry_source']}) but QH rolled to {nxt['code']} on {rolled}")
    logger.info("QH %s roll check: %d rolls compared, %d mismatches", root, checked, len(problems))
    return problems


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--products", nargs="+", choices=list(PRODUCTS), default=list(PRODUCTS))
    parser.add_argument("--check-rolls", action="store_true")
    args = parser.parse_args()

    result = asyncio.run(sync(args.products))
    for root in args.products:
        print(root, result[root])
    failed = any(result[root]["state"] == "error" for root in args.products)
    if args.check_rolls:
        for root in args.products:
            for line in asyncio.run(check_rolls(root)):
                print("  ROLL MISMATCH", line)
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
