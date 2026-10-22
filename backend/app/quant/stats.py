"""Small statistics helpers shared by the Strategy Lab tools. Everything reports N; nothing hides a thin sample."""

import math

import numpy as np
import pandas as pd

QUANTILES = (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)


def _r(x, nd: int = 4):
    if x is None:
        return None
    x = float(x)
    return round(x, nd) if math.isfinite(x) else None


def summary(values) -> dict:
    """n, mean, std and the 5..95 percentiles of the finite values, plus the share above zero."""
    v = np.asarray(values, dtype="float64")
    v = v[np.isfinite(v)]
    out: dict = {"n": int(len(v))}
    if not len(v):
        return out | {"mean": None, "std": None, "up": None} | {f"p{int(q * 100):02d}": None for q in QUANTILES}
    qs = np.quantile(v, QUANTILES)
    out |= {"mean": _r(v.mean()), "std": _r(v.std(ddof=1)) if len(v) > 1 else None, "up": _r((v > 0).mean(), 3)}
    out |= {f"p{int(q * 100):02d}": _r(x) for q, x in zip(QUANTILES, qs)}
    return out


def bootstrap_median_ci(values, n_boot: int = 1000, alpha: float = 0.1, seed: int = 7) -> tuple[float | None, float | None]:
    v = np.asarray(values, dtype="float64")
    v = v[np.isfinite(v)]
    if len(v) < 5:
        return None, None
    rng = np.random.default_rng(seed)
    meds = np.median(rng.choice(v, size=(n_boot, len(v)), replace=True), axis=1)
    lo, hi = np.quantile(meds, [alpha / 2, 1 - alpha / 2])
    return _r(lo), _r(hi)


def dense_band(values, cover: float) -> tuple[float | None, float | None]:
    """Shortest interval holding `cover` (0..1) of the values: where the strategy actually spent its time."""
    v = np.sort(np.asarray(values, dtype="float64")[np.isfinite(values)])
    n = len(v)
    if n < 2:
        return None, None
    w = max(2, int(math.ceil(cover * n)))
    if w >= n:
        return _r(v[0]), _r(v[-1])
    i = int(np.argmin(v[w - 1 :] - v[: n - w + 1]))
    return _r(v[i]), _r(v[i + w - 1])


def ou_fit(level: pd.Series, breaks: pd.Series | None = None) -> dict | None:
    """AR(1) / Ornstein-Uhlenbeck fit on daily values: x[t+1] = a + phi x[t] + e.

    Pairs that straddle a roll (`breaks` True on the later day) are left out, so a roll jump never reads as a
    move. phi in (0, 1) -> half-life ln2 / -ln(phi) days, mean a / (1 - phi), equilibrium sd = sd(e)/sqrt(1-phi^2)."""
    x = level.to_numpy(dtype="float64")
    x0, x1 = x[:-1], x[1:]
    ok = np.isfinite(x0) & np.isfinite(x1)
    if breaks is not None:
        ok &= ~breaks.to_numpy()[1:]
    x0, x1 = x0[ok], x1[ok]
    if len(x0) < 30 or np.ptp(x0) == 0:
        return None
    phi, a = np.polyfit(x0, x1, 1)
    resid = x1 - (a + phi * x0)
    out = {"phi": _r(phi), "n": int(len(x0)), "half_life": None, "mu": None, "sd_eq": None}
    if 0 < phi < 1:
        out |= {
            "half_life": _r(math.log(2) / -math.log(phi), 2),
            "mu": _r(a / (1 - phi)),
            "sd_eq": _r(resid.std(ddof=2) / math.sqrt(1 - phi * phi)),
        }
    return out


def histogram(groups: dict[str, np.ndarray], bins: int = 30) -> dict:
    """Shared-bin histograms for several samples (counts normalised to shares, so samples of any size compare)."""
    allv = np.concatenate([np.asarray(v, dtype="float64")[np.isfinite(v)] for v in groups.values()] or [np.array([])])
    if len(allv) < 2:
        return {"edges": [], "series": {}}
    lo, hi = np.quantile(allv, [0.005, 0.995])
    if hi <= lo:
        lo, hi = allv.min(), allv.max() + 1e-9
    edges = np.linspace(lo, hi, bins + 1)
    series = {}
    for name, v in groups.items():
        v = np.clip(np.asarray(v, dtype="float64")[np.isfinite(v)], lo, hi)
        counts, _ = np.histogram(v, edges)
        series[name] = [_r(c / max(1, len(v)), 5) for c in counts]
    return {"edges": [_r(e) for e in edges], "series": series}


def episodes(dates: pd.DatetimeIndex, gap_bdays: int = 5) -> list[tuple[pd.Timestamp, pd.Timestamp, int]]:
    """Group matched days into episodes: days further apart than `gap_bdays` business days start a new one."""
    if len(dates) == 0:
        return []
    d = dates.values.astype("datetime64[D]")
    gaps = np.busday_count(d[:-1], d[1:]) > gap_bdays
    starts = np.concatenate([[0], np.flatnonzero(gaps) + 1])
    ends = np.concatenate([np.flatnonzero(gaps), [len(d) - 1]])
    return [(dates[s], dates[e], int(e - s + 1)) for s, e in zip(starts, ends)]


def non_overlapping(positions: np.ndarray, h: int) -> np.ndarray:
    """Greedy thinning of row positions so no two kept rows are closer than h rows (forward windows never overlap)."""
    keep = []
    last = -(10**9)
    for p in positions:
        if p - last >= h:
            keep.append(p)
            last = p
    return np.asarray(keep, dtype=int)


def ols(y: np.ndarray, X: np.ndarray) -> dict | None:
    """y = a + X b. Returns betas, R² and n (None when fewer than 20 complete rows)."""
    ok = np.isfinite(y) & np.isfinite(X).all(axis=1)
    y, X = y[ok], X[ok]
    if len(y) < 20:
        return None
    A = np.column_stack([np.ones(len(y)), X])
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    resid = y - A @ coef
    ss = ((y - y.mean()) ** 2).sum()
    return {"alpha": _r(coef[0], 6), "betas": [_r(b) for b in coef[1:]], "r2": _r(1 - (resid**2).sum() / ss, 3) if ss > 0 else None, "n": int(len(y))}


def despike(s: pd.Series, k: float = 6.0, window: int = 11) -> tuple[pd.Series, int]:
    """Hampel filter: drop isolated prints more than k robust sigmas from the centred rolling median.

    The scale is the rolling MAD, floored by the series' typical deviation so a flat stretch never flags every
    tick. A level shift is kept (the median catches up within half a window)."""
    if len(s) < window:
        return s, 0
    med = s.rolling(window, center=True, min_periods=3).median()
    dev = (s - med).abs()
    scale = dev.rolling(window, center=True, min_periods=3).median() * 1.4826
    floor = max(float(dev.median()) * 1.4826, 1e-9)
    bad = dev > k * np.maximum(scale.fillna(floor), floor)
    return s[~bad], int(bad.sum())
