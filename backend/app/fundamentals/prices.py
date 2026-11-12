"""Print crude settlement metrics for the 25 trading days up to and including a date, never later.

    python -m app.fundamentals.prices 2026-11-10            # backtest: brent_ref is COF27
    python -m app.fundamentals.prices 2026-11-24 --live      # live: brent_ref is the run's reference contract

The forecaster's only price input, so a backtest run cannot see later prices. Columns are the metrics a price-test
scenario can use: brent_ref (the reference contract's settle, see common.ref_contract), brent_m1 (front month, code
shown), brent_m1m2, wti_m1 and wti_brent_m1 (ICE WTI-Brent front). The front month is the first contract not yet
expired, so on its expiry day the expiring contract still shows.
"""

import asyncio
import datetime as dt
import sys

from app.fundamentals.common import REF_CONTRACT, connect, ref_contract

METRICS = """
WITH s AS (
  SELECT c.product, s.code, c.expiry, s.trade_date, s.settle,
         row_number() OVER (PARTITION BY c.product, s.trade_date ORDER BY c.expiry) AS slot
  FROM qh_settlements s JOIN qh_contracts c USING (code)
  WHERE s.trade_date BETWEEN $1 AND $2 AND c.expiry >= s.trade_date AND c.product IN ('CO', 'CL', 'WTCLCO'))
SELECT trade_date,
  max(settle) FILTER (WHERE code = $3) AS brent_ref,
  max(settle) FILTER (WHERE product = 'CO' AND slot = 1) AS brent_m1,
  max(code)   FILTER (WHERE product = 'CO' AND slot = 1) AS brent_m1_code,
  max(settle) FILTER (WHERE product = 'CO' AND slot = 1) - max(settle) FILTER (WHERE product = 'CO' AND slot = 2) AS brent_m1m2,
  max(settle) FILTER (WHERE product = 'CL' AND slot = 1) AS wti_m1,
  max(settle) FILTER (WHERE product = 'WTCLCO' AND slot = 1) AS wti_brent_m1
FROM s GROUP BY trade_date ORDER BY trade_date"""


async def metrics(conn, start: dt.date, end: dt.date, ref: str = REF_CONTRACT):
    """Rows of the five test metrics for each trade date in [start, end], brent_ref on contract `ref`."""
    return await conn.fetch(METRICS, start, end, ref)


async def main(day: dt.date, mode: str) -> None:
    conn = await connect()
    try:
        ref = await ref_contract(conn, day, mode)
        rows = (await metrics(conn, day - dt.timedelta(days=40), day, ref))[-25:]
    finally:
        await conn.close()

    def f(v):
        return "    n/a" if v is None else f"{v:7.2f}"

    print(f"ref_contract {ref}")
    print(f"trade_date  brent_ref({ref})  brent_m1(code)        brent_m1m2  wti_m1  wti_brent_m1")
    for r in rows:
        print(r["trade_date"], f(r["brent_ref"]), "  ", f(r["brent_m1"]), f"({r['brent_m1_code']})", "  ",
              f(r["brent_m1m2"]), f(r["wti_m1"]), f(r["wti_brent_m1"]))


if __name__ == "__main__":
    asyncio.run(main(dt.date.fromisoformat(sys.argv[1]), "live" if "--live" in sys.argv[2:] else "backtest"))
