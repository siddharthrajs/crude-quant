"""DD (data distribution): a target strategy's distribution on the days that pass range filters on up to five
base strategies and the target itself.

A strategy is weighted legs and its own mode:
  GD  a leg is a generic slot (c1, c2, ...) that rolls the day after expiry;
  RD  a calendar-month structure. Legs are written as contracts (Z26, F27, ...), but only their months and the
      years between them count: "Z26 - F27" is the Dec/Jan spread, run through every year (Z19-F20, Z20-F21, ...).
      On each day the strategy holds the nearest year whose first leg (earliest delivery) has not expired, so it
      moves on to the next year the day after that leg's expiry.
Strategies of both modes can be combined (e.g. a GD target filtered on an RD base). The strategy is priced on
every common trading day of the products it uses as the weighted sum of its legs' closes (app/qh/curve.py).

A day is *stale* for a strategy when any leg did not trade that day: the leg is then priced at its last close,
and the day is dropped from the analysis unless `include_stale` is set.

Changes never mix contracts across a roll: the daily change and the forward change over h days are the
change of the contracts the strategy holds on the day, i.e. the P&L of holding the position.
"""

import re
from dataclasses import dataclass
from datetime import date

import numpy as np

from app.qh.curve import Curve
from app.qh.products import PRODUCTS
from app.quant.calendar import MONTH_CODES, key_of

HORIZONS = (1, 5, 10)
PERCENTILES = (5, 25, 50, 75, 95)
# Most bins a histogram may have; the strategy rows' mini histograms are narrower.
TARGET_BINS = 60
FILTER_BINS = 30
# Fewer matching days than this and the bin width comes from all days instead.
MIN_BIN_SAMPLE = 10
# Price tick: the narrowest bin.
TICK = 0.01


class DDError(ValueError):
    pass


@dataclass(frozen=True)
class Leg:
    product: str
    ref: str  # "c3" in GD mode, "Z26" in RD mode
    weight: float


@dataclass(frozen=True)
class Strategy:
    id: str
    name: str
    mode: str  # "GD" or "RD"
    legs: tuple[Leg, ...]
    lo: float | None = None
    hi: float | None = None


@dataclass
class Priced:
    value: np.ndarray
    stale: np.ndarray
    chg: np.ndarray  # change since the previous common day
    fwd: dict[int, np.ndarray]


def _num(x: float) -> float | None:
    return None if x is None or not np.isfinite(x) else round(float(x), 6)


def leg_label(leg: Leg) -> str:
    w = f"{leg.weight:+g}"
    w = {"+1": "+", "-1": "-"}.get(w, w)
    return f"{w}{PRODUCTS[leg.product].label} {leg.ref}"


def common_days(curves: dict[str, Curve], start: date | None, end: date | None) -> np.ndarray:
    days = None
    for c in curves.values():
        days = c.days if days is None else np.intersect1d(days, c.days)
    if start:
        days = days[days >= np.datetime64(start)]
    if end:
        days = days[days <= np.datetime64(end)]
    return days


_REF_RE = re.compile(r"^([FGHJKMNQUVXZ])(\d{2})$")


def _ref_key(ref: str) -> int:
    """Month ordinal of an RD leg ('Z26')."""
    m = _REF_RE.match(ref.upper())
    if not m:
        raise DDError(f"'{ref}' is not a contract month (Z26, F27, ...)")
    return key_of(2000 + int(m.group(2)), MONTH_CODES.index(m.group(1)) + 1)


def _rd_held_keys(s: Strategy, curves: dict[str, Curve], days: np.ndarray) -> dict[Leg, np.ndarray]:
    """RD: the contract (month ordinal) each leg holds on each day, -1 where that year is not listed.

    The first leg (earliest delivery) picks the year: the nearest contract in its calendar month whose expiry is on
    or after the day. Every other leg keeps its month distance from it."""
    keys = {leg: _ref_key(leg.ref) for leg in s.legs}
    first = min(s.legs, key=lambda leg: keys[leg])
    curve = curves[first.product]
    same_month = curve.keys % 12 == keys[first] % 12
    month_keys, month_expiry = curve.keys[same_month], curve.expiry[same_month]
    i = np.searchsorted(month_expiry, days, side="left")
    anchor = np.where(i < len(month_keys), month_keys[np.minimum(i, len(month_keys) - 1)], -1)
    return {leg: np.where(anchor >= 0, anchor + keys[leg] - keys[first], -1) for leg in s.legs}


def _contract_rows(s: Strategy, leg: Leg, curve: Curve, rows: np.ndarray, rd_keys: dict[Leg, np.ndarray]) -> np.ndarray:
    """Contract index the leg holds on each common day (-1 = none)."""
    if s.mode == "GD":
        if not leg.ref.lower().startswith("c") or not leg.ref[1:].isdigit() or int(leg.ref[1:]) < 1:
            raise DDError(f"'{leg.ref}' is not a generic slot (c1, c2, ...)")
        return curve.slot_index(int(leg.ref[1:]))[rows]
    return curve.index_of_keys(rd_keys[leg])


def price(s: Strategy, curves: dict[str, Curve], days: np.ndarray) -> Priced:
    n = len(days)
    value = np.zeros(n)
    stale = np.zeros(n, dtype=bool)
    chg = np.zeros(n)
    fwd = {h: np.zeros(n) for h in HORIZONS}
    rd_keys = _rd_held_keys(s, curves, days) if s.mode == "RD" else {}
    for leg in s.legs:
        curve = curves[leg.product]
        rows = np.searchsorted(curve.days, days)  # every common day is one of the curve's days
        k = _contract_rows(s, leg, curve, rows, rd_keys)
        ok = k >= 0
        kk = np.where(ok, k, 0)
        # Price of the contract held on day i, on day i + shift (NaN past the end, or when nothing is held).
        def held_at(shift: int) -> np.ndarray:
            out = np.full(n, np.nan)
            if shift >= 0:
                if n > shift:
                    out[: n - shift] = curve.close_ff[rows[shift:], kk[: n - shift]]
            else:
                out[-shift:] = curve.close_ff[rows[: n + shift], kk[-shift:]]
            return np.where(ok, out, np.nan)

        now = held_at(0)
        value += leg.weight * now
        traded = ok & (curve.volume[rows, kk] > 0) & ~np.isnan(curve.close[rows, kk])
        stale |= ~traded
        chg += leg.weight * (now - held_at(-1))
        for h in HORIZONS:
            fwd[h] += leg.weight * (held_at(h) - now)
    return Priced(value=value, stale=stale, chg=chg, fwd=fwd)


def _summary(x: np.ndarray, signed: bool) -> dict:
    x = x[np.isfinite(x)]
    if len(x) == 0:
        return {"n": 0}
    p = np.percentile(x, PERCENTILES)
    out = {
        "n": int(len(x)),
        "mean": _num(x.mean()),
        "std": _num(x.std(ddof=1)) if len(x) > 1 else None,
        "min": _num(x.min()),
        "max": _num(x.max()),
        "pct": {str(q): _num(v) for q, v in zip(PERCENTILES, p)},
    }
    if signed:
        out["pct_up"] = _num((x > 0).mean() * 100)
        out["pct_down"] = _num((x < 0).mean() * 100)
    return out


def _raw_width(x: np.ndarray) -> tuple[float, str]:
    """Bin width for a sample: Freedman-Diaconis (2 IQR n^-1/3), robust to fat tails; Scott (3.49 sd n^-1/3) when
    the IQR is zero (a mostly-constant series); the full range over Sturges' bin count as a last resort."""
    n = len(x)
    q25, q75 = np.percentile(x, [25, 75])
    if q75 > q25:
        return 2 * (q75 - q25) * n ** (-1 / 3), "Freedman–Diaconis"
    sd = x.std()
    if sd > 0:
        return 3.49 * sd * n ** (-1 / 3), "Scott"
    return (x.max() - x.min()) / (np.log2(n) + 1) if x.max() > x.min() else 1.0, "Sturges"


def _nice(h: float) -> float:
    """The smallest of 1, 2, 5 x 10^k at or above h, and never below the 0.01 price tick, so bins are readable
    ranges on whole ticks."""
    if h <= TICK:
        return TICK
    exp = np.floor(np.log10(h))
    for step in (1, 2, 5, 10):
        if step * 10**exp >= h - 1e-12:
            return round(float(step * 10**exp), 10)
    return round(float(10 ** (exp + 1)), 10)


def _hist(all_x: np.ndarray, matched_x: np.ndarray, max_bins: int, bins: int | None = None) -> dict:
    """Shared range bins for all days and matching days; they span p0.5-p99.5 of both samples, and values beyond
    that are counted as below / above instead of being piled into the end bins.

    Width: with `bins` set, that span over `bins`, rounded to the nearest 0.01 tick (so the count can come out a
    little off, and fine counts on a narrow span are capped by the tick); otherwise Freedman-Diaconis on the matching days (all days when fewer than MIN_BIN_SAMPLE
    match), rounded to a nice step."""
    a = all_x[np.isfinite(all_x)]
    m = matched_x[np.isfinite(matched_x)]
    if len(a) == 0:
        return {"edges": [], "all": [], "matched": [], "width": None, "method": None}
    basis = m if len(m) >= MIN_BIN_SAMPLE else a
    lo, hi = np.percentile(np.concatenate([a, m]), [0.5, 99.5])
    if bins:
        h = round(max(TICK, round((hi - lo) / bins / TICK) * TICK), 10)
        method, max_bins = f"{bins} bins", bins + 2
    else:
        raw, method = _raw_width(basis)
        h = _nice(raw)
    while True:
        start = np.floor(lo / h + 1e-9) * h
        stop = max(np.ceil(hi / h - 1e-9) * h, start + h)
        n_bins = int(round((stop - start) / h))
        if n_bins <= max_bins:
            break
        # Too many bins for the spread: next nice step up (or the next tick, for a requested count).
        h = round(h + TICK, 10) if bins else _nice(h * 1.001)
    edges = np.round(start + h * np.arange(n_bins + 1), 10)
    inside = lambda v: v[(v >= edges[0]) & (v <= edges[-1])]
    return {
        "edges": [float(e) for e in edges],
        "width": h,
        "method": method,
        "basis": "matching" if basis is m else "all",
        "all": np.histogram(inside(a), edges)[0].tolist(),
        "matched": np.histogram(inside(m), edges)[0].tolist(),
        "below": {"all": int((a < edges[0]).sum()), "matched": int((m < edges[0]).sum())},
        "above": {"all": int((a > edges[-1]).sum()), "matched": int((m > edges[-1]).sum())},
    }


def run(strategies: list[Strategy], target_id: str, curves: dict[str, Curve],
        start: date | None, end: date | None, include_stale: bool, bins: int | None = None) -> dict:
    """`bins`: bar count for the target's histograms (None = Freedman-Diaconis)."""
    days = common_days(curves, start, end)
    if len(days) < 2:
        raise DDError("No common trading days in the selected range")
    priced = {s.id: price(s, curves, days) for s in strategies}
    t = priced[target_id]

    def usable(p: Priced) -> np.ndarray:
        ok = np.isfinite(p.value)
        return ok if include_stale else ok & ~p.stale

    universe = usable(t)
    matched = universe.copy()
    for s in strategies:
        if s.lo is None and s.hi is None:
            continue
        p = priced[s.id]
        cond = usable(p)
        with np.errstate(invalid="ignore"):
            if s.lo is not None:
                cond &= p.value >= s.lo
            if s.hi is not None:
                cond &= p.value <= s.hi
        matched &= cond

    metrics = {"level": (t.value, False), "chg": (t.chg, True)} | {f"fwd{h}": (t.fwd[h], True) for h in HORIZONS}
    target_out = {}
    for name, (x, signed) in metrics.items():
        target_out[name] = {
            "all": _summary(x[universe], signed),
            "matched": _summary(x[matched], signed),
            "hist": _hist(x[universe], x[matched], TARGET_BINS, bins),
        }

    out_strats = []
    for s in strategies:
        p = priced[s.id]
        ok = usable(p)
        last = np.flatnonzero(np.isfinite(p.value))
        out_strats.append({
            "id": s.id,
            "name": s.name,
            "mode": s.mode,
            "label": " ".join(leg_label(l) for l in s.legs) + (" (every year)" if s.mode == "RD" else ""),
            "values": [_num(v) for v in p.value],
            "stale": p.stale.tolist(),
            "summary": _summary(p.value[ok], False),
            "hist": _hist(p.value[ok], p.value[ok & matched], FILTER_BINS),
            "today": {"date": str(days[last[-1]]), "value": _num(p.value[last[-1]]), "stale": bool(p.stale[last[-1]])} if len(last) else None,
            "n_usable": int(ok.sum()),
        })

    return {
        "dates": [str(d) for d in days],
        "first": str(days[0]),
        "last": str(days[-1]),
        "n_all": int(universe.sum()),
        "n_matched": int(matched.sum()),
        "matched": matched.tolist(),
        "target_id": target_id,
        "horizons": list(HORIZONS),
        "strategies": out_strats,
        "target": target_out,
    }
