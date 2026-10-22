"""The state table: one row per trading day with the market state (known at that day's close) and the strategy's
forward outcomes. Every Strategy Lab question is a filter on the state columns and an aggregate of the outcomes.

State is measured on the reference product (the first leg's product unless chosen otherwise):
  f1                front contract settlement price (absolute level, for "Brent between 100 and 106")
  f1_rng            high-low range of the front over the last `lookback` days, % of price (range regime)
  f1_pos            where today's close sits in that range, 0 = low, 1 = high
  f1_chg            front change over `lookback` days, %
  f1_atr            14-day average true range of the front, $
  f1_rv             20-day std of daily front changes, $
  dte               business days to the front's expiry (0 = expiry day)
  since_exp         business days since the previous front expiry (roll-cycle day)
  m1m2, m1m6        front spreads, $ (> 0 backwardation)
  lvl               the strategy's generic level; lvl_z = its 60-day z-score; lvl_pct = 250-day percentile (0..1)
  s_rv              20-day std of the strategy's daily (roll-adjusted) change
  month, weekday, bdom (business day of month), gsci (1 inside the GSCI roll, business days 5-9)
Front-month quantities use the roll-adjusted front so an expiry never registers as a breakout or a vol spike.

Outcomes for each horizon h (trading days), all on the roll-adjusted strategy (what holding it would do):
  fchg_h  change from today's close to the close h days later
  fmax_h  best intraday excursion above today's close over the next h days (MFE for a long)
  fmin_h  worst intraday excursion below today's close (MAE for a long; negative)
  frng_h  high-low range covered over the next h days
"""

import numpy as np
import pandas as pd

from app.quant.source import Frame
from app.quant.strategy import Leg, Series, build

HORIZONS = (1, 3, 5, 10, 20)

EVENTS = {
    "covid": ("2020-02-15", "2020-06-30", "COVID crash and negative WTI (Feb–Jun 2020)"),
    "ukraine": ("2022-02-24", "2022-06-30", "Russia–Ukraine invasion (Feb–Jun 2022)"),
}

STATE_VARS = {
    "f1": ("Front price", "$"),
    "f1_rng": ("Front range over lookback", "% of price"),
    "f1_pos": ("Front position in range", "0 low … 1 high"),
    "f1_chg": ("Front change over lookback", "%"),
    "f1_atr": ("Front ATR (14d)", "$"),
    "f1_rv": ("Front daily vol (20d)", "$"),
    "dte": ("Business days to front expiry", "days"),
    "since_exp": ("Business days since last expiry", "days"),
    "m1m2": ("M1–M2 spread", "$"),
    "m1m6": ("M1–M6 spread", "$"),
    "lvl": ("Strategy level (generic)", "$"),
    "lvl_z": ("Strategy z-score (60d)", "σ"),
    "lvl_pct": ("Strategy percentile (250d)", "0…1"),
    "s_rv": ("Strategy daily vol (20d)", "$"),
    "bdom": ("Business day of month", "day"),
}


def _fwd_extreme(x: pd.Series, h: int, how: str) -> pd.Series:
    """max/min of x over the next h rows (excluding today)."""
    rev = x.iloc[::-1].rolling(h, min_periods=h)
    agg = rev.max() if how == "max" else rev.min()
    return agg.iloc[::-1].shift(-1)


def build_state(strat: Series, frames: dict[str, Frame], lookback: int = 10) -> pd.DataFrame:
    ref = strat.ref
    d = strat.daily
    f1 = build([Leg(ref, 1, 1.0)], frames).daily
    m12 = build([Leg(ref, 1, 1.0), Leg(ref, 2, -1.0)], frames).daily["raw"].rename("m1m2")
    m16 = build([Leg(ref, 1, 1.0), Leg(ref, 6, -1.0)], frames).daily["raw"].rename("m1m6")

    s = pd.DataFrame(index=d.index)
    s["lvl"], s["adj"], s["adj_hi"], s["adj_lo"], s["gap"] = d["raw"], d["adj"], d["adj_hi"], d["adj_lo"], d["gap"]
    s = s.join(f1[["raw", "adj", "adj_hi", "adj_lo", "front"]].add_prefix("f1_"), how="inner").join(m12).join(m16)
    s = s.rename(columns={"f1_raw": "f1"})

    c, hi, lo = s["f1_adj"], s["f1_adj_hi"], s["f1_adj_lo"]
    rng_hi, rng_lo = hi.rolling(lookback).max(), lo.rolling(lookback).min()
    s["f1_rng"] = (rng_hi - rng_lo) / s["f1"] * 100
    s["f1_pos"] = ((c - rng_lo) / (rng_hi - rng_lo)).clip(0, 1)
    s["f1_chg"] = (c - c.shift(lookback)) / s["f1"] * 100
    prev = c.shift(1)
    tr = pd.concat([hi, prev], axis=1).max(axis=1) - pd.concat([lo, prev], axis=1).min(axis=1)
    s["f1_atr"] = tr.rolling(14).mean()
    s["f1_rv"] = c.diff().rolling(20).std()
    # Prior-window range, for breakout detection (the window ends yesterday).
    s["f1_hi_prev"], s["f1_lo_prev"] = rng_hi.shift(1), rng_lo.shift(1)

    expiry = frames[ref].expiry
    days = s.index.values.astype("datetime64[D]")
    front = s["f1_front"].to_numpy()
    exp = np.array([np.datetime64(expiry.get(int(k), "NaT"), "D") if k >= 0 else np.datetime64("NaT") for k in front])
    prev_exp = np.array([np.datetime64(expiry.get(int(k) - 1, "NaT"), "D") if k >= 0 else np.datetime64("NaT") for k in front])
    s["dte"] = np.where(np.isnat(exp), np.nan, np.busday_count(days, np.where(np.isnat(exp), days, exp)))
    s["since_exp"] = np.where(np.isnat(prev_exp), np.nan, np.busday_count(np.where(np.isnat(prev_exp), days, prev_exp), days))
    s["expiry"] = exp
    s["roll"] = s["f1_front"].ne(s["f1_front"].shift(1)) & s.index.to_series().gt(s.index[0])

    lvl = s["lvl"]
    s["lvl_z"] = (lvl - lvl.rolling(60).mean()) / lvl.rolling(60).std()
    s["lvl_pct"] = lvl.rolling(250, min_periods=60).rank(pct=True)
    s["s_rv"] = s["adj"].diff().rolling(20).std()

    idx = s.index
    s["month"], s["weekday"], s["year"] = idx.month, idx.dayofweek, idx.year
    month_start = (idx - pd.offsets.MonthBegin(1)).where(idx.day != 1, idx).values.astype("datetime64[D]")
    s["bdom"] = np.busday_count(month_start, days) + 1
    s["gsci"] = ((s["bdom"] >= 5) & (s["bdom"] <= 9)).astype(int)

    a = s["adj"]
    for h in HORIZONS:
        fmax = _fwd_extreme(s["adj_hi"], h, "max")
        fmin = _fwd_extreme(s["adj_lo"], h, "min")
        s[f"fchg_{h}"] = a.shift(-h) - a
        s[f"fmax_{h}"] = (fmax - a).clip(lower=0)
        s[f"fmin_{h}"] = (fmin - a).clip(upper=0)
        s[f"frng_{h}"] = fmax - fmin
    return s


def apply_filters(state: pd.DataFrame, flt: dict) -> np.ndarray:
    """Boolean mask over the state rows. `flt`: start, end, exclude_events, months, weekdays, gsci, conditions."""
    m = np.ones(len(state), bool)
    idx = state.index
    if flt.get("start"):
        m &= idx >= pd.Timestamp(flt["start"])
    if flt.get("end"):
        m &= idx <= pd.Timestamp(flt["end"])
    for ev in flt.get("exclude_events") or []:
        if ev in EVENTS:
            a, b, _ = EVENTS[ev]
            m &= ~((idx >= pd.Timestamp(a)) & (idx <= pd.Timestamp(b)))
    if flt.get("months"):
        m &= np.isin(state["month"].to_numpy(), flt["months"])
    if flt.get("weekdays"):
        m &= np.isin(state["weekday"].to_numpy(), flt["weekdays"])
    if flt.get("gsci") in (0, 1):
        m &= state["gsci"].to_numpy() == flt["gsci"]
    for cond in flt.get("conditions") or []:
        var = cond.get("var")
        if var not in STATE_VARS:
            continue
        v = state[var].to_numpy(dtype="float64")
        with np.errstate(invalid="ignore"):
            if cond.get("lo") is not None:
                m &= v >= float(cond["lo"])
            if cond.get("hi") is not None:
                m &= v <= float(cond["hi"])
    return m
