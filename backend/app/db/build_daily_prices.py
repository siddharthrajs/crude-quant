"""Rebuild `daily_prices` from `hourly_bars`.

One price per contract per New York calendar day: the mid of the 14:00 New York bar's close (the
settlement window for both WTI and Brent), or, when that bar is unusable, the mid of the latest usable
bar between 08:00 and 16:59 New York that day. A bar is unusable when a side is missing, the quote is
crossed, it is locked with no volume (maintenance-hour filler), or it is wider than MAX_SPREAD -- the deferred
CL/LCO contracts (c13+ / c10+) were quoted $0.80-1.00 wide for most of history, and a mid that wide is a guess,
so those days are left empty rather than filled.

Each contract's last day is dropped when the contract has expired (its final bar has blown-out quotes).

Run from backend/ after loading bars; safe to re-run, it rebuilds the whole table:

    .venv\\Scripts\\python -m app.db.build_daily_prices
"""

import asyncio

import asyncpg

from app.config import settings

# Widest bid/ask gap, in price units, a bar may have and still produce a daily price.
MAX_SPREAD = {"CL": 0.15, "LCO": 0.15, "WTCLCO": 0.30}
# A contract whose last bar is this many days older than the newest bar anywhere has expired.
EXPIRED_AFTER_DAYS = 3

BUILD_SQL = """
INSERT INTO daily_prices (contract_id, trade_date, price, bar_hour)
SELECT DISTINCT ON (contract_id, d) contract_id, d, (bid + ask) / 2, h
FROM (
    SELECT b.contract_id, b.ts, b.bid, b.ask,
           (b.ts AT TIME ZONE 'America/New_York')::date AS d,
           extract(hour FROM b.ts AT TIME ZONE 'America/New_York')::int AS h
    FROM hourly_bars b
    JOIN contracts c ON c.id = b.contract_id
    WHERE b.bid IS NOT NULL AND b.ask IS NOT NULL
      AND b.ask >= b.bid
      AND (b.ask > b.bid OR b.volume > 0)
      AND b.ask - b.bid <= CASE c.product WHEN 'CL' THEN $1::float8 WHEN 'LCO' THEN $2::float8 ELSE $3::float8 END
) bars
WHERE h BETWEEN 8 AND 16
ORDER BY contract_id, d, (h = 14) DESC, ts DESC
"""

DROP_EXPIRY_DAY_SQL = """
DELETE FROM daily_prices dp
USING (SELECT contract_id, max(trade_date) AS last_day FROM daily_prices GROUP BY contract_id) last
WHERE dp.contract_id = last.contract_id
  AND dp.trade_date = last.last_day
  AND last.last_day < (SELECT max(trade_date) FROM daily_prices) - $1::int
"""


async def main() -> None:
    conn = await asyncpg.connect(settings.database_url.replace("postgresql+asyncpg://", "postgresql://"))
    try:
        async with conn.transaction():
            await conn.execute("TRUNCATE daily_prices")
            await conn.execute(BUILD_SQL, MAX_SPREAD["CL"], MAX_SPREAD["LCO"], MAX_SPREAD["WTCLCO"])
            dropped = await conn.execute(DROP_EXPIRY_DAY_SQL, EXPIRED_AFTER_DAYS)
        print(f"expiry-day rows dropped: {dropped.split()[-1]}")
        rows = await conn.fetch(
            "SELECT c.product, count(DISTINCT dp.contract_id) AS contracts, count(*) AS days, "
            "min(dp.trade_date) AS first_day, max(dp.trade_date) AS last_day, "
            "avg((dp.bar_hour = 14)::int)::numeric(4,2) AS share_at_1400 "
            "FROM daily_prices dp JOIN contracts c ON c.id = dp.contract_id GROUP BY c.product ORDER BY 1"
        )
        for row in rows:
            print(dict(row))
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
