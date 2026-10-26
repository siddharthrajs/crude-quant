"""Any strategy as weighted legs on generic slots, and its three series.

A leg is (product, slot, weight): slot 3 of LCO is the third Brent contract from the front on that bar. A 3rd
double fly is LCO slots 3,4,5,6 with weights 1,-3,3,-1; a 3M fly on WTI is CL 1,4,7 with 1,-2,1; a Brent/WTI
box is LCO 1,2 and CL 1,2 with 1,-1,-1,1. Products are aligned on common 15-minute bars.

When the front contract expires every slot moves up one contract, so "the 3rd double fly" is a different set of
contracts after the roll. Three series keep that apart:
  * generic (raw)   -- the weighted sum of whatever contracts sit in the slots: what the screen shows, roll jumps
                       included;
  * roll-adjusted   -- the sum of bar-to-bar changes measured on the contracts held over each step (the
                       contracts in the slots on the later bar, priced on both bars), anchored to end at today's
                       generic level. It is the P&L of holding the generic strategy and rolling it; the difference
                       between the generic's change and this change is the roll gap (the term structure of the
                       strategy, not a market move);
  * contract-specific -- fixed contracts, e.g. the ones in the slots today, traced back through history.

Daily values are taken at the settlement window of the reference product (the first leg's product unless stated):
the last bar closing at or before 19:30 London (Brent) / 14:30 New York (WTI), or the day's last bar if none.
"""

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from app.quant.calendar import key_code
from app.quant.source import PRODUCTS, Frame


class StrategyError(ValueError):
    pass


@dataclass(frozen=True)
class Leg:
    product: str
    slot: int
    weight: float


@dataclass
class Series:
    """A strategy on the valid bars (every leg priced), plus its daily view."""

    legs: tuple[Leg, ...]
    ref: str
    ts: np.ndarray
    day: np.ndarray
    settle: np.ndarray  # bar closes at or before the reference product's settlement time
    raw: np.ndarray
    chg: np.ndarray  # change on held contracts since the previous valid bar (0 where it could not be matched)
    codes: np.ndarray  # (n, legs) contract per leg
    front: np.ndarray  # reference product's front contract per bar
    unmatched: int
    daily: pd.DataFrame = field(init=False)

    def __post_init__(self) -> None:
        self.daily = _daily(self)


def validate(legs: list[Leg]) -> None:
    if not legs:
        raise StrategyError("a strategy needs at least one leg")
    if len(legs) > 12:
        raise StrategyError("at most 12 legs")
    for leg in legs:
        spec = PRODUCTS.get(leg.product)
        if spec is None:
            raise StrategyError(f"unknown product {leg.product!r}")
        if not 1 <= leg.slot <= spec.depth - 1:
            raise StrategyError(f"{spec.label} slots run 1..{spec.depth - 1}; got {leg.slot}")
        if not np.isfinite(leg.weight) or leg.weight == 0:
            raise StrategyError("leg weights must be non-zero numbers")


def build(legs: list[Leg], frames: dict[str, Frame], ref: str | None = None) -> Series:
    validate(legs)
    ref = ref or legs[0].product
    products = list(dict.fromkeys([leg.product for leg in legs] + [ref]))
    ts = frames[products[0]].ts
    for p in products[1:]:
        ts = np.intersect1d(ts, frames[p].ts, assume_unique=True)
    rows = {p: np.searchsorted(frames[p].ts, ts) for p in products}

    n = len(ts)
    mids = np.empty((n, len(legs)))
    codes = np.empty((n, len(legs)), "int32")
    next_mid = np.empty((n, len(legs)))
    next_code = np.empty((n, len(legs)), "int32")
    for j, leg in enumerate(legs):
        f, r, s = frames[leg.product], rows[leg.product], leg.slot - 1
        mids[:, j], codes[:, j] = f.mid[r, s], f.code[r, s]
        next_mid[:, j], next_code[:, j] = f.mid[r, s + 1], f.code[r, s + 1]

    ok = np.isfinite(mids).all(axis=1) & (codes >= 0).all(axis=1)
    if ok.sum() < 2:
        raise StrategyError("the strategy has no history: some leg is never quoted inside the spread limit")
    ts, mids, codes, next_mid, next_code = ts[ok], mids[ok], codes[ok], next_mid[ok], next_code[ok]
    ref_rows = rows[ref][ok]
    w = np.array([leg.weight for leg in legs])
    raw = mids @ w

    # Price, on the previous valid bar, of the contract each leg holds now: same slot if nothing rolled, the next
    # slot out if the contract has since moved up one slot.
    prev = np.full_like(mids, np.nan)
    same = codes[1:] == codes[:-1]
    moved = codes[1:] == next_code[:-1]
    prev[1:] = np.where(same, mids[:-1], np.where(moved, next_mid[:-1], np.nan))
    leg_chg = mids - prev
    matched = np.isfinite(leg_chg).all(axis=1)
    matched[0] = True
    chg = np.where(matched, np.nan_to_num(leg_chg) @ w, 0.0)
    chg[0] = 0.0

    rf = frames[ref]
    return Series(
        legs=tuple(legs),
        ref=ref,
        ts=ts,
        day=rf.day[ref_rows],
        settle=rf.settle_ok[ref_rows],
        raw=raw,
        chg=chg,
        codes=codes,
        front=rf.code[ref_rows, 0],
        unmatched=int((~matched).sum()),
    )


def _daily(s: Series) -> pd.DataFrame:
    """One row per trading day: close at the settlement bar, intraday high/low of the roll-adjusted series."""
    adj = np.cumsum(s.chg)
    adj += s.raw[-1] - adj[-1]
    df = pd.DataFrame({"day": s.day, "raw": s.raw, "adj": adj, "settle": s.settle})
    df["i"] = np.arange(len(df))
    g = df.groupby("day", sort=True)
    close_i = df[df["settle"]].groupby("day")["i"].last().reindex(g.size().index)
    close_i = close_i.fillna(g["i"].last()).astype(int)
    out = pd.DataFrame(index=pd.DatetimeIndex(close_i.index, name="date"))
    ci = close_i.to_numpy()
    out["raw"] = s.raw[ci]
    out["adj"] = adj[ci]
    out["adj_hi"] = g["adj"].max().to_numpy()
    out["adj_lo"] = g["adj"].min().to_numpy()
    out["front"] = s.front[ci]
    for j in range(len(s.legs)):
        out[f"leg{j}"] = s.codes[ci, j]
    # Roll gap between consecutive closes: generic change minus held-contract change.
    out["gap"] = out["raw"].diff() - out["adj"].diff()
    out.loc[out["gap"].abs() < 1e-9, "gap"] = 0.0
    return out


def legs_label(legs: tuple[Leg, ...] | list[Leg], codes: np.ndarray | None = None) -> str:
    """'LCO c3 − 3·c4 + 3·c5 − c6', or with contracts: 'LCOF27 − 3·LCOG27 ...'."""
    parts = []
    for j, leg in enumerate(legs):
        mag = abs(leg.weight)
        name = f"{leg.product}{key_code(int(codes[j]))}" if codes is not None else f"{leg.product} c{leg.slot}"
        body = name if mag == 1 else f"{mag:g}·{name}"
        sign = "−" if leg.weight < 0 else "+"
        parts.append(f"{'-' if leg.weight < 0 else ''}{body}" if j == 0 else f" {sign} {body}")
    return "".join(parts)


def contract_daily(frames: dict[str, Frame], legs: list[tuple[str, int, float]]) -> pd.Series:
    """Daily settlement value of fixed contracts [(product, contract, weight)].

    Every leg is priced on the same 15-minute bar (whichever slot the contract sits in on that bar) and only bars
    where all legs are quoted count, so an illiquid back month can never contribute a quote hours older than the
    others. The day's value is then sampled at the first leg's product's settlement window, as for generics."""
    if not legs:
        return pd.Series(dtype=float)
    ref = legs[0][0]
    products = list(dict.fromkeys([p for p, _, _ in legs]))
    ts = frames[ref].ts
    for p in products:
        if p != ref:
            ts = np.intersect1d(ts, frames[p].ts, assume_unique=True)
    total = np.zeros(len(ts))
    for product, key, weight in legs:
        f = frames[product]
        rows = np.searchsorted(f.ts, ts)
        hit = f.code[rows] == key
        slot = hit.argmax(axis=1)
        mid = f.mid[rows, slot]
        mid[~hit.any(axis=1)] = np.nan
        total += weight * mid
    ok = np.isfinite(total)
    if not ok.any():
        return pd.Series(dtype=float)
    rf, rrows = frames[ref], np.searchsorted(frames[ref].ts, ts[ok])
    df = pd.DataFrame({"day": rf.day[rrows], "v": total[ok], "settle": rf.settle_ok[rrows]})
    last = df.groupby("day")["v"].last()
    at_settle = df[df["settle"]].groupby("day")["v"].last()
    out = at_settle.reindex(last.index).fillna(last)
    out.index = pd.DatetimeIndex(out.index, name="date")
    return out
