"""Contracts and expiries.

A contract is held as a month ordinal, `year * 12 + month - 1` of its delivery month, so "one contract further
out" is +1 and the gap between two legs is a plain difference.

Expiries come from two places:
  * the data: a contract's last trading day as the front (c1) generic, once a later contract has taken over the
    front -- this is the truth for every past expiry and catches holiday shifts no rule table remembers;
  * the exchange rule, for the current front and later contracts (and as a cross-check of the data):
      Brent (ICE)  last business day of the second month before delivery;
      WTI (NYMEX)  three business days before the 25th of the month before delivery (from the business day
                   before the 25th when the 25th is not one), business days skipping NYMEX holidays.
      WTI-Brent    the Reuters WTCL-LCO chain rolls on the Brent dates (every roll since 2019 matches; 2011-2018
                   used other conventions, which the data covers).
"""

import re
from datetime import date, timedelta
from functools import lru_cache

import numpy as np
import pandas as pd

MONTH_CODES = "FGHJKMNQUVXZ"
# Last Brent contract (Feb 2016 delivery) under ICE's pre-2016 expiry rule.
OLD_BRENT_RULE_LAST = 2016 * 12 + 1
_NAME_RE = re.compile(r"([FGHJKMNQUVXZ])(\d{1,2})$")


def key_of(year: int, month: int) -> int:
    return year * 12 + month - 1


def key_date(key: int) -> date:
    return date(key // 12, key % 12 + 1, 1)


def key_code(key: int) -> str:
    """'Z26' for Dec 2026."""
    return f"{MONTH_CODES[key % 12]}{key // 12 % 100:02d}"


def parse_contract(name: str, bar_year: int, bar_month: int) -> int | None:
    """Month ordinal of a Reuters contract name ('LCOZ6', 'CLX26', 'WTCL-LCOU7').

    Older contracts carry a one-digit year; a futures contract delivers after the month it is quoted in, so a
    one-digit year is the first year ending in that digit at or after the bar's month."""
    m = _NAME_RE.search(name or "")
    if not m:
        return None
    month = MONTH_CODES.index(m.group(1)) + 1
    digits = m.group(2)
    if len(digits) == 2:
        return key_of(2000 + int(digits), month)
    year = bar_year - bar_year % 10 + int(digits)
    if (year, month) < (bar_year, bar_month):
        year += 10
    return key_of(year, month)


@lru_cache(maxsize=1)
def _nymex_bday() -> pd.offsets.CustomBusinessDay:
    from pandas.tseries import holiday as h

    nearest = h.nearest_workday

    class NymexCalendar(h.AbstractHolidayCalendar):
        rules = [
            h.Holiday("New Year", month=1, day=1, observance=nearest),
            h.USMartinLutherKingJr,
            h.USPresidentsDay,
            h.GoodFriday,
            h.USMemorialDay,
            h.Holiday("Juneteenth", month=6, day=19, start_date="2022-06-19", observance=nearest),
            h.Holiday("Independence Day", month=7, day=4, observance=nearest),
            h.USLaborDay,
            h.USThanksgivingDay,
            h.Holiday("Christmas", month=12, day=25, observance=nearest),
        ]

    return pd.offsets.CustomBusinessDay(calendar=NymexCalendar())


@lru_cache(maxsize=1)
def _ice_bday() -> pd.offsets.CustomBusinessDay:
    """ICE Futures Europe business days for the Brent expiry: weekdays minus the UK bank holidays."""
    from pandas.tseries import holiday as h

    class UkCalendar(h.AbstractHolidayCalendar):
        rules = [
            h.Holiday("New Year", month=1, day=1, observance=h.next_monday),
            h.GoodFriday,
            h.EasterMonday,
            h.Holiday("Early May", month=5, day=1, offset=pd.DateOffset(weekday=h.MO(1))),
            h.Holiday("Spring", month=5, day=31, offset=pd.DateOffset(weekday=h.MO(-1))),
            h.Holiday("Summer", month=8, day=31, offset=pd.DateOffset(weekday=h.MO(-1))),
            h.Holiday("Christmas", month=12, day=25, observance=h.next_monday_or_tuesday),
            h.Holiday("Boxing Day", month=12, day=26, observance=h.next_monday_or_tuesday),
        ]

    return pd.offsets.CustomBusinessDay(calendar=UkCalendar())


def rule_expiry(rule: str, key: int) -> date:
    """Exchange-rule last trading day of the contract `key` (see the module docstring).

    Brent: last ICE business day of the second month before delivery; the February contract (expiring in December)
    expires on the penultimate business day, since 31 December is a short session. Checked against every Brent
    expiry since 2019 in the Reuters data (bank holidays, Good Friday and the December rule all match).
    Contracts up to Feb 2016 delivery used ICE's old rule: the business day before the 15th calendar day before
    the first day of the delivery month -- or, when that 15th day is not a business day, the business day before
    the last business day ahead of it."""
    if rule == "brent":
        bd = _ice_bday()
        if key <= OLD_BRENT_RULE_LAST:
            fifteenth_before = pd.Timestamp(key_date(key) - timedelta(days=15))
            return (bd.rollback(fifteenth_before) - bd).date()
        last = bd.rollback(pd.Timestamp(key_date(key - 1) - timedelta(days=1)))
        if key % 12 == 1:  # February delivery
            last -= bd
        return last.date()
    prior = key_date(key - 1)
    bd = _nymex_bday()
    return (bd.rollback(pd.Timestamp(prior.year, prior.month, 25)) - 3 * bd).date()


def derived_expiries(days: np.ndarray, front: np.ndarray) -> dict[int, date]:
    """Last day each contract was the front, for contracts a later contract has since replaced.

    `days` are trading days (datetime64[D], ascending) and `front` the front contract on each (-1 = unknown).
    A contract that shows up as the front again after a later one (a stray quote) is ignored after that point:
    only a run of 3+ days counts as the new front, so a one-day flicker never ends a contract early."""
    out: dict[int, date] = {}
    ok = front >= 0
    d, f = days[ok], front[ok]
    if len(f) == 0:
        return out
    # Collapse into runs and drop flicker runs shorter than 3 days.
    change = np.flatnonzero(np.diff(f)) + 1
    starts = np.concatenate([[0], change])
    ends = np.concatenate([change, [len(f)]])
    runs = [(int(f[s]), s, e) for s, e in zip(starts, ends) if e - s >= 3 or e == len(f)]
    for (key, _, end), (nxt, _, _) in zip(runs, runs[1:]):
        if nxt > key:
            out[key] = pd.Timestamp(d[end - 1]).date()
    return out
