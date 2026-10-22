"""Strategy Lab tools. Each takes the run context and its own params and returns a JSON-able dict.

  profile   what the strategy is and how it moves: three series, ranges, mean reversion, what drives it
            (beta to the front and to M1-M2, by days-to-expiry and structure), PCA of the curve, vol by DTE
  scenario  "given this state, what range and what next": the strategy's level and forward outcomes on the
            days matching the filters, against all days
  breakout  event study: the front breaks its range (rolling N-day or a fixed band) -> the strategy's path
  expiry    every front expiry lined up: held (roll-adjusted) path, the generic path with its roll gap, and the
            same template at every slot of the curve (how the 2nd, 3rd ... flies behave through the roll)
  seasonal  by calendar (each year's path) and by contract month (each year's instance by days to expiry)
  analogs   the K past days most like today, and what the strategy did next
"""

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from app.quant.calendar import key_code, key_of, rule_expiry
from app.quant.source import PRODUCTS, Frame
from app.quant.state import HORIZONS, STATE_VARS, apply_filters
from app.quant.stats import bootstrap_median_ci, dense_band, despike, episodes, histogram, non_overlapping, ols, ou_fit, summary
from app.quant.strategy import Leg, Series, StrategyError, build, contract_daily, legs_label

DTE_BUCKETS = ((0, 5, "0–5"), (6, 10, "6–10"), (11, 15, "11–15"), (16, 40, "16+"))


@dataclass
class Ctx:
    frames: dict[str, Frame]
    strat: Series
    state: pd.DataFrame
    mask: np.ndarray  # all filters
    base: np.ndarray  # date range and event exclusions only (the "all days" comparison)
    filters: dict
    lookback: int


def nums(x, nd: int = 4) -> list:
    a = np.asarray(x, dtype="float64")
    return [None if not math.isfinite(v) else round(float(v), nd) for v in a]


def dates(idx) -> list[str]:
    return [pd.Timestamp(d).date().isoformat() for d in idx]


def _r(v, nd: int = 4):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return round(v, nd) if math.isfinite(v) else None


def col_median(rows: list[np.ndarray]) -> np.ndarray:
    """Column-wise median ignoring NaN; NaN where a column has no value (no warning)."""
    if not rows:
        return np.array([])
    a = np.array(rows, dtype="float64")
    out = np.full(a.shape[1], np.nan)
    has = np.isfinite(a).any(axis=0)
    out[has] = np.nanmedian(a[:, has], axis=0)
    return out


def fan(paths: np.ndarray, xs: list[int]) -> dict:
    """Per-x quantiles of an (events x len(xs)) array of paths."""
    out = {"x": xs, "n": [], "p10": [], "p25": [], "p50": [], "p75": [], "p90": [], "mean": []}
    for j in range(len(xs)):
        v = paths[:, j] if len(paths) else np.array([])
        v = v[np.isfinite(v)]
        out["n"].append(int(len(v)))
        for key, q in (("p10", 0.1), ("p25", 0.25), ("p50", 0.5), ("p75", 0.75), ("p90", 0.9)):
            out[key].append(_r(np.quantile(v, q)) if len(v) else None)
        out["mean"].append(_r(v.mean()) if len(v) else None)
    return out


def _paths(series: np.ndarray, at: np.ndarray, pre: int, post: int) -> np.ndarray:
    """Rows: events at positions `at`; columns x = -pre..post; values series[t+x] - series[t]."""
    xs = np.arange(-pre, post + 1)
    out = np.full((len(at), len(xs)), np.nan)
    n = len(series)
    for i, t in enumerate(at):
        pos = t + xs
        ok = (pos >= 0) & (pos < n)
        out[i, ok] = series[pos[ok]] - series[t]
    return out


def _outcomes(st: pd.DataFrame, rows: np.ndarray, non_overlap: bool) -> list[dict]:
    """Forward-outcome distributions at every horizon for the rows (positions) given."""
    out = []
    for h in HORIZONS:
        r = non_overlapping(rows, h) if non_overlap else rows
        chg = st[f"fchg_{h}"].to_numpy()[r]
        lo, hi = bootstrap_median_ci(chg)
        out.append(
            {
                "h": h,
                "chg": summary(chg),
                "chg_ci": [lo, hi],
                "mfe": summary(st[f"fmax_{h}"].to_numpy()[r]),
                "mae": summary(st[f"fmin_{h}"].to_numpy()[r]),
                "range": summary(st[f"frng_{h}"].to_numpy()[r]),
            }
        )
    return out


def _structure(st: pd.DataFrame) -> np.ndarray:
    return np.where(st["m1m2"].to_numpy() > 0, "backwardation", "contango")


def _dte_bucket(dte: np.ndarray) -> np.ndarray:
    out = np.full(len(dte), "", dtype=object)
    for lo, hi, label in DTE_BUCKETS:
        out[(dte >= lo) & (dte <= hi)] = label
    return out


def _now(ctx: Ctx) -> dict:
    st = ctx.state
    last = st.iloc[-1]
    codes = ctx.strat.codes[-1]
    return {
        "date": st.index[-1].date().isoformat(),
        "label_contracts": legs_label(ctx.strat.legs, codes),
        "state": {k: _r(last[k]) for k in STATE_VARS},
        "front": f"{ctx.strat.ref}{key_code(int(last['f1_front']))}" if last["f1_front"] >= 0 else None,
        "expiry": pd.Timestamp(last["expiry"]).date().isoformat() if pd.notna(last["expiry"]) else None,
    }


# ---------------------------------------------------------------------------------------------------- profile


def tool_profile(ctx: Ctx, p: dict) -> dict:
    st, s = ctx.state, ctx.strat
    m = ctx.mask
    sel = st[m]
    if len(sel) < 30:
        raise StrategyError(f"only {len(sel)} days pass the filters; profile needs 30+")

    # Contract-specific: today's contracts traced back.
    fixed = contract_daily(ctx.frames, [(leg.product, int(s.codes[-1, j]), leg.weight) for j, leg in enumerate(s.legs)])
    fixed = fixed.reindex(st.index)

    lvl = sel["lvl"]
    cur = float(st["lvl"].iloc[-1])
    window = int(p.get("range_days") or 250)
    recent = st["lvl"].iloc[-window:]

    def ranges(v: pd.Series, breaks: pd.Series) -> dict:
        ou = ou_fit(v, breaks)
        mu, sd = float(v.mean()), float(v.std())
        out = {
            "n": int(v.notna().sum()),
            "min": _r(v.min()),
            "max": _r(v.max()),
            "dense80": dense_band(v.to_numpy(), 0.8),
            "dense90": dense_band(v.to_numpy(), 0.9),
            "sd2": [_r(mu - 2 * sd), _r(mu + 2 * sd)],
            "ou": ou,
            "ou2": [_r(ou["mu"] - 2 * ou["sd_eq"]), _r(ou["mu"] + 2 * ou["sd_eq"])] if ou and ou["half_life"] else None,
            "pct_now": _r((v < cur).mean(), 3),
            "summary": summary(v),
        }
        return out

    # Drivers: the strategy's held-contract daily change against the front's and M1-M2's.
    d_s = st["adj"].diff()
    d_f1 = st["f1_adj"].diff()
    d_sp = st["m1m2"].diff().where(~st["roll"])
    X = np.column_stack([d_f1.to_numpy(), d_sp.to_numpy()])
    y = d_s.to_numpy()
    mm = m.copy()
    mm[0] = False
    struct = _structure(st)
    bucket = _dte_bucket(st["dte"].to_numpy())
    drivers = {"all": ols(y[mm], X[mm]), "cells": []}
    for _, _, label in DTE_BUCKETS:
        for sname in ("backwardation", "contango"):
            cell = mm & (bucket == label) & (struct == sname)
            fit = ols(y[cell], X[cell])
            vol = float(np.nanstd(y[cell], ddof=1)) if cell.sum() > 2 else None
            drivers["cells"].append({"dte": label, "structure": sname, "fit": fit, "vol": _r(vol), "n": int(cell.sum())})

    # PCA of the reference curve's daily (held-contract) changes over the filtered days.
    k = min(12, PRODUCTS[s.ref].depth - 1)
    curve = pd.concat({j: build([Leg(s.ref, j, 1.0)], ctx.frames).daily["adj"].diff() for j in range(1, k + 1)}, axis=1)
    curve = curve.reindex(st.index)[m].dropna()
    pca = None
    if len(curve) > 60:
        Z = curve.to_numpy() - curve.to_numpy().mean(axis=0)
        cov = np.cov(Z, rowvar=False)
        vals, vecs = np.linalg.eigh(cov)
        order = np.argsort(vals)[::-1][:3]
        vals, vecs = vals[order], vecs[:, order]
        vecs = vecs * np.sign(vecs.sum(axis=0) + 1e-12)  # PC1 positive = curve up
        scores = Z @ vecs
        ys = d_s.reindex(curve.index).to_numpy()
        share = []
        for j in range(3):
            ok = np.isfinite(ys)
            c = np.corrcoef(scores[ok, j], ys[ok])[0, 1] if ok.sum() > 10 else np.nan
            share.append(_r(c * c, 3))
        pca = {
            "slots": list(range(1, k + 1)),
            "loadings": [nums(vecs[:, j]) for j in range(3)],
            "explained": [_r(v / np.trace(cov), 3) for v in vals],
            "strategy_r2": share,
            "n": int(len(curve)),
        }

    roll_days = st.index[st["roll"]]
    return {
        "now": _now(ctx),
        "history": {
            "dates": dates(st.index),
            "raw": nums(st["lvl"]),
            "adj": nums(st["adj"]),
            "fixed": nums(fixed),
            "matched": [bool(x) for x in m],
            "rolls": dates(roll_days),
        },
        "ranges": {"filtered": ranges(lvl, sel["roll"]), "recent": ranges(recent, st["roll"].iloc[-window:]), "recent_days": window},
        "drivers": drivers,
        "pca": pca,
        "unmatched_bars": s.unmatched,
        "roll_gap": summary(st["gap"][st["roll"] & m]),
    }


# ---------------------------------------------------------------------------------------------------- scenario


def tool_scenario(ctx: Ctx, p: dict) -> dict:
    st = ctx.state
    rows = np.flatnonzero(ctx.mask)
    base = np.flatnonzero(ctx.base)
    non_overlap = bool(p.get("non_overlap"))
    eps = episodes(st.index[rows])
    by_year = pd.Series(st["year"].to_numpy()[rows]).value_counts().sort_index()
    yr_med = {}
    for y in by_year.index:
        r = rows[st["year"].to_numpy()[rows] == y]
        yr_med[int(y)] = {"n": int(len(r)), "lvl_p50": _r(np.nanmedian(st["lvl"].to_numpy()[r])), "chg5_p50": _r(np.nanmedian(st["fchg_5"].to_numpy()[r]))}

    lvl_now = float(st["lvl"].iloc[-1])
    matched_out = _outcomes(st, rows, non_overlap)
    implied = []
    for o in matched_out:
        c = o["chg"]
        implied.append(
            {
                "h": o["h"],
                "n": c["n"],
                "lo10": _r(lvl_now + c["p10"]) if c["p10"] is not None else None,
                "mid": _r(lvl_now + c["p50"]) if c["p50"] is not None else None,
                "hi90": _r(lvl_now + c["p90"]) if c["p90"] is not None else None,
                "mae10": o["mae"]["p10"],
                "mfe90": o["mfe"]["p90"],
            }
        )

    ep_rows = []
    for a, b, n in eps[-200:]:
        i = st.index.get_loc(a)
        ep_rows.append(
            {
                "start": a.date().isoformat(),
                "end": b.date().isoformat(),
                "days": n,
                "f1": _r(st["f1"].iloc[i]),
                "dte": _r(st["dte"].iloc[i]),
                "lvl": _r(st["lvl"].iloc[i]),
                "fchg_5": _r(st["fchg_5"].iloc[i]),
                "fchg_10": _r(st["fchg_10"].iloc[i]),
                "frng_5": _r(st["frng_5"].iloc[i]),
            }
        )

    return {
        "now": _now(ctx),
        "today_matches": bool(ctx.mask[-1]),
        "n_days": int(len(rows)),
        "n_base": int(len(base)),
        "n_episodes": len(eps),
        "by_year": yr_med,
        "level": {"matched": summary(st["lvl"].to_numpy()[rows]), "all": summary(st["lvl"].to_numpy()[base])},
        "level_hist": histogram({"matched": st["lvl"].to_numpy()[rows], "all": st["lvl"].to_numpy()[base]}),
        "outcomes": {"matched": matched_out, "all": _outcomes(st, base, non_overlap)},
        "implied": implied,
        "episodes": ep_rows,
        "matched_dates": dates(st.index[rows]),
        "non_overlap": non_overlap,
    }


# ---------------------------------------------------------------------------------------------------- breakout


def tool_breakout(ctx: Ctx, p: dict) -> dict:
    st = ctx.state
    mode = p.get("mode") or "rolling"
    pre, post = int(p.get("pre") or 5), int(p.get("post") or 10)
    cooldown = int(p.get("cooldown") or ctx.lookback)
    f1 = st["f1"].to_numpy()
    c = st["f1_adj"].to_numpy()
    if mode == "fixed":
        lo, hi = p.get("lo"), p.get("hi")
        if lo is None or hi is None or float(lo) >= float(hi):
            raise StrategyError("fixed band needs lo < hi (front price)")
        lo, hi = float(lo), float(hi)
        inside = int(p.get("inside_days") or 0)
        prev = np.roll(f1, 1)
        prev[0] = np.nan
        up = (f1 > hi) & (prev <= hi)
        dn = (f1 < lo) & (prev >= lo)
        if inside > 0:
            s = pd.Series(f1)
            was_in = ((s.shift(1).rolling(inside).max() <= hi) & (s.shift(1).rolling(inside).min() >= lo)).to_numpy()
            up &= was_in
            dn &= was_in
        band = {"lo": lo, "hi": hi}
    else:
        k = float(p.get("k_atr") if p.get("k_atr") is not None else 0.5)
        atr = st["f1_atr"].to_numpy()
        with np.errstate(invalid="ignore"):
            up = c > st["f1_hi_prev"].to_numpy() + k * atr
            dn = c < st["f1_lo_prev"].to_numpy() - k * atr
        band = {"lookback": ctx.lookback, "k_atr": k}

    events = []
    for direction, hit in (("up", up), ("down", dn)):
        last = -(10**9)
        for t in np.flatnonzero(hit & ctx.mask):
            if t - last < cooldown:
                continue
            last = t
            events.append((int(t), direction))
    events.sort()

    adj = st["adj"].to_numpy()
    xs = list(range(-pre, post + 1))
    out = {}
    struct = _structure(st)
    for direction in ("up", "down"):
        at = np.array([t for t, d in events if d == direction], dtype=int)
        out[direction] = {
            "n": int(len(at)),
            "path": fan(_paths(adj, at, pre, post), xs),
            "f1_path": fan(_paths(c, at, pre, post), xs),
            "outcomes": _outcomes(st, at, False),
            "by_structure": [
                {"structure": sname, "n": int((struct[at] == sname).sum()), "chg5": summary(st["fchg_5"].to_numpy()[at[struct[at] == sname]])}
                for sname in ("backwardation", "contango")
            ],
        }
    table = [
        {
            "date": st.index[t].date().isoformat(),
            "dir": d,
            "f1": _r(f1[t]),
            "dte": _r(st["dte"].iloc[t]),
            "m1m2": _r(st["m1m2"].iloc[t]),
            "lvl": _r(st["lvl"].iloc[t]),
            "fchg_1": _r(st["fchg_1"].iloc[t]),
            "fchg_5": _r(st["fchg_5"].iloc[t]),
            "fchg_10": _r(st["fchg_10"].iloc[t]),
            "fmin_10": _r(st["fmin_10"].iloc[t]),
            "fmax_10": _r(st["fmax_10"].iloc[t]),
        }
        for t, d in events
    ]
    return {"now": _now(ctx), "mode": mode, "band": band, "events": table, "up": out["up"], "down": out["down"], "baseline": _outcomes(st, np.flatnonzero(ctx.base), False)}


# ---------------------------------------------------------------------------------------------------- expiry


def _shifted(legs: tuple[Leg, ...], anchor: int) -> list[Leg]:
    base = min(leg.slot for leg in legs)
    return [Leg(leg.product, leg.slot - base + anchor, leg.weight) for leg in legs]


def tool_expiry(ctx: Ctx, p: dict) -> dict:
    st, s = ctx.state, ctx.strat
    pre, post = int(p.get("pre") or 15), int(p.get("post") or 10)
    # Events are expiries, so filters on the roll-cycle position (DTE, days since expiry) do not apply; every other
    # filter is read on the expiry day.
    flt = dict(ctx.filters)
    flt["conditions"] = [c for c in flt.get("conditions") or [] if c.get("var") not in ("dte", "since_exp")]
    emask = apply_filters(st, flt)
    roll_pos = np.flatnonzero(st["roll"].to_numpy())
    t0 = roll_pos - 1  # expiry day = last day of the old front
    t0 = t0[(t0 >= 0) & emask[np.clip(t0, 0, None)]]
    xs = list(range(-pre, post + 1))
    adj, raw = st["adj"].to_numpy(), st["lvl"].to_numpy()

    def moves(adj_a: np.ndarray, gap_a: np.ndarray, t: int) -> tuple:
        n = len(adj_a)
        g = gap_a[t + 1] if t + 1 < n else np.nan
        pre_m = adj_a[t] - adj_a[t - 5] if t - 5 >= 0 else np.nan
        post_m = adj_a[t + 5] - adj_a[t] if t + 5 < n else np.nan
        return g, pre_m, post_m

    gap = st["gap"].to_numpy()
    table = []
    for t in t0:
        g, pm, qm = moves(adj, gap, t)
        table.append(
            {
                "expiry": st.index[t].date().isoformat(),
                "contract": f"{s.ref}{key_code(int(st['f1_front'].iloc[t]))}",
                "lvl_before": _r(raw[t]),
                "lvl_after": _r(raw[t + 1]) if t + 1 < len(raw) else None,
                "gap": _r(g),
                "pre5": _r(pm),
                "post5": _r(qm),
                "m1m2": _r(st["m1m2"].iloc[t]),
            }
        )

    # The same template at every slot of the curve, on the same expiries.
    depth = PRODUCTS[s.ref].depth - 1
    span = max(leg.slot for leg in s.legs) - min(leg.slot for leg in s.legs)
    expiry_days = st.index[t0]
    curve = []
    for anchor in range(1, depth - span + 1):
        legs = _shifted(s.legs, anchor)
        if any(PRODUCTS[leg.product].depth - 1 < leg.slot for leg in legs):
            continue
        try:
            d = build(legs, ctx.frames, s.ref).daily
        except StrategyError:
            continue
        pos = d.index.get_indexer(expiry_days)
        a, gp = d["adj"].to_numpy(), d["gap"].to_numpy()
        gaps, pres, posts = [], [], []
        for t in pos[pos >= 0]:
            g, pm, qm = moves(a, gp, t)
            gaps.append(g), pres.append(pm), posts.append(qm)
        curve.append(
            {
                "anchor": anchor,
                "label": legs_label(legs),
                "gap": summary(gaps),
                "pre5": summary(pres),
                "post5": summary(posts),
                "level": _r(d["raw"].iloc[-1]),
            }
        )

    return {
        "now": _now(ctx),
        "n": int(len(t0)),
        "held": fan(_paths(adj, t0, pre, post), xs),
        "generic": fan(_paths(raw, t0, pre, post), xs),
        "gap": summary([r["gap"] for r in table if r["gap"] is not None]),
        "events": table,
        "curve": curve,
        "anchor": min(leg.slot for leg in s.legs),
    }


# ---------------------------------------------------------------------------------------------------- seasonal


def tool_seasonal(ctx: Ctx, p: dict) -> dict:
    st, s = ctx.state, ctx.strat
    mode = p.get("mode") or "calendar"
    if mode == "contract":
        month = int(p.get("month") or 12)
        window = int(p.get("window") or 250)
        first = min(range(len(s.legs)), key=lambda j: s.legs[j].slot)
        offsets = [leg.slot - s.legs[first].slot for leg in s.legs]
        frame = ctx.frames[s.legs[first].product]
        years = sorted({k // 12 for k in frame.expiry})
        lines = []
        grid = np.arange(-window, 1)
        mat = []
        removed = 0
        for y in years:
            key = key_of(y, month)
            fixed = contract_daily(ctx.frames, [(leg.product, key + off, leg.weight) for leg, off in zip(s.legs, offsets)])
            if len(fixed) < 20:
                continue
            # Far-dated legs are thin: isolated bad prints are dropped (counted) so they don't set the scale.
            fixed, n_bad = despike(fixed)
            removed += n_bad
            exp = frame.expiry.get(key) or rule_expiry(frame.spec.expiry_rule, key)
            x = -np.busday_count(fixed.index.values.astype("datetime64[D]"), np.datetime64(exp, "D"))
            keep = (x >= -window) & (x <= 0)
            if keep.sum() < 10:
                continue
            xv, yv = x[keep], fixed.to_numpy()[keep]
            lines.append({"label": key_code(key), "x": [int(v) for v in xv], "y": nums(yv), "expired": frame.expiry_source.get(key) == "data"})
            row = pd.Series(yv, index=xv).groupby(level=0).last().reindex(grid)
            mat.append(row.to_numpy())
        med = col_median(mat)
        return {"now": _now(ctx), "mode": mode, "month": month, "lines": lines, "median": {"x": [int(v) for v in grid], "y": nums(med)}, "despiked": removed}

    # Calendar: each year's held-contract path rebased to 0 at its first day (optionally detrended).
    m = ctx.base
    sel = st[m]
    detrend = bool(p.get("detrend"))
    lines = []
    grid = np.arange(1, 367)
    mat = []
    for y, g in sel.groupby("year"):
        if len(g) < 40:
            continue
        v = g["adj"].to_numpy() - g["adj"].iloc[0]
        doy = g.index.dayofyear.to_numpy()
        if detrend:
            b, a = np.polyfit(doy, v, 1)
            v = v - (a + b * doy)
        lines.append({"label": str(y), "x": [int(d) for d in doy], "y": nums(v)})
        mat.append(pd.Series(v, index=doy).groupby(level=0).last().reindex(grid).ffill().to_numpy())
    med = col_median(mat)

    # Month-end to month-end change; a month counts only when the previous calendar month is in the sample too
    # (January compares with the previous December).
    month_end = sel["adj"].groupby([sel["year"], sel["month"]]).last()
    ordinal = np.array([y * 12 + m for y, m in month_end.index])
    monthly = month_end.diff().where(np.diff(ordinal, prepend=ordinal[0] - 2) == 1)
    months = []
    for mo in range(1, 13):
        v = monthly.xs(mo, level=1).dropna() if mo in monthly.index.get_level_values(1) else pd.Series(dtype=float)
        months.append({"month": mo, "by_year": {int(k): _r(x) for k, x in v.items()}, "chg": summary(v.to_numpy())})
    return {"now": _now(ctx), "mode": mode, "lines": lines, "median": {"x": [int(v) for v in grid], "y": nums(med)}, "months": months, "detrend": detrend}


# ---------------------------------------------------------------------------------------------------- analogs

DEFAULT_FEATURES = ["f1_rng", "f1_chg", "f1_pos", "dte", "m1m2", "m1m6", "f1_rv", "lvl_z"]


def tool_analogs(ctx: Ctx, p: dict) -> dict:
    st = ctx.state
    feats = [f for f in (p.get("features") or DEFAULT_FEATURES) if f in STATE_VARS]
    if not feats:
        raise StrategyError("pick at least one feature")
    k = int(p.get("k") or 40)
    min_gap = int(p.get("min_gap") or 5)
    horizon_guard = max(HORIZONS)
    X = st[feats].to_numpy(dtype="float64")
    today = X[-1]
    if not np.isfinite(today).all():
        missing = [f for f, v in zip(feats, today) if not np.isfinite(v)]
        raise StrategyError(f"today's state is missing {', '.join(missing)}")
    cand = ctx.mask.copy()
    cand[-horizon_guard:] = False
    cand &= np.isfinite(X).all(axis=1)
    rows = np.flatnonzero(cand)
    if len(rows) < k:
        raise StrategyError(f"only {len(rows)} candidate days; loosen the filters")
    med = np.median(X[rows], axis=0)
    mad = np.median(np.abs(X[rows] - med), axis=0) * 1.4826
    mad[mad == 0] = 1.0
    weights = np.array([float((p.get("weights") or {}).get(f, 1.0)) for f in feats])
    z = (X[rows] - med) / mad
    zt = (today - med) / mad
    dist = np.sqrt((((z - zt) ** 2) * weights).sum(axis=1))
    order = rows[np.argsort(dist)]
    dist_by_row = dict(zip(rows, dist))

    picked: list[int] = []
    d64 = st.index.values.astype("datetime64[D]")
    for r in order:
        if all(abs(np.busday_count(d64[r], d64[q])) >= min_gap for q in picked):
            picked.append(int(r))
        if len(picked) >= k:
            break
    at = np.array(sorted(picked))
    lvl_now = float(st["lvl"].iloc[-1])
    outcomes = _outcomes(st, at, False)
    xs = list(range(0, 21))
    return {
        "now": _now(ctx),
        "features": feats,
        "today": {f: _r(v) for f, v in zip(feats, today)},
        "analogs": [
            {
                "date": st.index[r].date().isoformat(),
                "dist": _r(dist_by_row[r], 3),
                **{f: _r(st[f].iloc[r]) for f in feats},
                "lvl": _r(st["lvl"].iloc[r]),
                "fchg_5": _r(st["fchg_5"].iloc[r]),
                "fchg_10": _r(st["fchg_10"].iloc[r]),
                "fchg_20": _r(st["fchg_20"].iloc[r]),
            }
            for r in sorted(picked, key=lambda r: dist_by_row[r])
        ],
        "outcomes": outcomes,
        "implied": [
            {"h": o["h"], "lo10": _r(lvl_now + o["chg"]["p10"]) if o["chg"]["p10"] is not None else None, "mid": _r(lvl_now + o["chg"]["p50"]) if o["chg"]["p50"] is not None else None, "hi90": _r(lvl_now + o["chg"]["p90"]) if o["chg"]["p90"] is not None else None}
            for o in outcomes
        ],
        "path": fan(_paths(st["adj"].to_numpy(), at, 0, 20)[:, :], xs),
        "base": _outcomes(st, np.flatnonzero(ctx.base), False),
    }


TOOLS = {
    "profile": tool_profile,
    "scenario": tool_scenario,
    "breakout": tool_breakout,
    "expiry": tool_expiry,
    "seasonal": tool_seasonal,
    "analogs": tool_analogs,
}
