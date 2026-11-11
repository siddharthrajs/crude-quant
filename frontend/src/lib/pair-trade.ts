// Hedge ratio and mean-reversion statistics for one A point against one B point, for the Correlations view's
// pair-trade panels. Pure functions; nothing here touches React.
//
//   hedge ratio h   minimum-variance ratio of A's daily changes on B's (OLS), or the symmetric total-least-squares
//                   slope, over a trailing window: long 1 A, short h B
//   combination S   A − h·B on the contracts held on the chosen day (not the generic slots), so a roll never puts a
//                   jump in it; this is the thing you would actually trade
//   bands           S's rolling mean and standard deviation over the lookback, so z = (S − mean) / sd
//   half-life       from an AR(1) fit of S over the lookback: ΔS_t = a + b·S_{t−1}, half-life = −ln 2 / ln(1 + b)
//   ADF t           b / se(b) from that fit (Dickey–Fuller with no lags); h is estimated, so it is read against the
//                   Engle–Granger two-variable critical values

import type { CurveLab2Curves, CurveLab2Day } from "@/lib/curve-lab-2-api"

export type HedgeFit = "ols" | "tls"

/** Engle–Granger critical values for two series, constant, no trend (MacKinnon): 1%, 5%, 10%. */
export const EG_CRITICAL = { p1: -3.9, p5: -3.34, p10: -3.04 } as const

/** The strategy's value on the contracts whose front leg is `ref`, on each day; NaN where that contract has no value. */
export function contractSeries(curves: CurveLab2Curves, dates: string[], ref: string): Float64Array {
  const byDate = new Map<string, CurveLab2Day>(curves.days.map((d) => [d.date, d]))
  const out = new Float64Array(dates.length).fill(NaN)
  if (!ref) return out
  for (let t = 0; t < dates.length; t++) {
    const day = byDate.get(dates[t])
    if (!day) continue
    const k = day.refs.indexOf(ref)
    const v = k >= 0 && k < day.settle.length ? day.settle[k] : null
    if (v !== null) out[t] = v
  }
  return out
}

/** Slope of y on x from centered sums: OLS cov/var(x), or the total-least-squares (orthogonal) slope. */
function slope(fit: HedgeFit, vx: number, vy: number, cxy: number): number {
  if (fit === "ols") return cxy / vx
  if (Math.abs(cxy) < 1e-15) return 0
  const d = vy - vx
  return (d + Math.sqrt(d * d + 4 * cxy * cxy)) / (2 * cxy)
}

export interface RollingHedge {
  /** h on each day: A's change on B's over the window to that day; NaN with fewer than minObs shared days. */
  h: Float64Array
  /** r² of the same fit. */
  r2: Float64Array
}

/** Rolling hedge ratio of series a (held) on series b (hedge), both daily changes, over a trailing window. */
export function rollingHedge(a: Float64Array, b: Float64Array, window: number, minObs: number, fit: HedgeFit): RollingHedge {
  const days = a.length
  const h = new Float64Array(days).fill(NaN)
  const r2 = new Float64Array(days).fill(NaN)
  let n = 0
  let sa = 0
  let sb = 0
  let saa = 0
  let sbb = 0
  let sab = 0
  const fold = (t: number, s: 1 | -1) => {
    const x = b[t]
    const y = a[t]
    if (Number.isNaN(x) || Number.isNaN(y)) return
    n += s
    sb += s * x
    sa += s * y
    sbb += s * x * x
    saa += s * y * y
    sab += s * x * y
  }
  for (let t = 0; t < days; t++) {
    fold(t, 1)
    if (t >= window) fold(t - window, -1)
    if (n < minObs) continue
    const vb = sbb - (sb * sb) / n
    const va = saa - (sa * sa) / n
    const cab = sab - (sa * sb) / n
    if (vb <= 1e-12 * Math.max(1, sbb) || va <= 1e-12 * Math.max(1, saa)) continue
    h[t] = slope(fit, vb, va, cab)
    r2[t] = (cab * cab) / (va * vb)
  }
  return { h, r2 }
}

/** Day-on-day change of a series (NaN where either day is missing). */
export function diff(s: Float64Array): Float64Array {
  const out = new Float64Array(s.length).fill(NaN)
  for (let t = 1; t < s.length; t++) out[t] = s[t] - s[t - 1]
  return out
}

/** qa·a − h·b, elementwise (qa lots of A against h of B). */
export function combine(a: Float64Array, b: Float64Array, h: number, qa = 1): Float64Array {
  const out = new Float64Array(a.length)
  for (let t = 0; t < a.length; t++) out[t] = qa * a[t] - h * b[t]
  return out
}

/** Rolling mean and standard deviation over the trailing `lookback` days (NaN with fewer than minObs values). */
export function rollingBands(s: Float64Array, lookback: number, minObs: number): { mean: Float64Array; sd: Float64Array } {
  const mean = new Float64Array(s.length).fill(NaN)
  const sd = new Float64Array(s.length).fill(NaN)
  let n = 0
  let sum = 0
  let sq = 0
  for (let t = 0; t < s.length; t++) {
    if (!Number.isNaN(s[t])) {
      n++
      sum += s[t]
      sq += s[t] * s[t]
    }
    const o = t - lookback
    if (o >= 0 && !Number.isNaN(s[o])) {
      n--
      sum -= s[o]
      sq -= s[o] * s[o]
    }
    if (n < minObs) continue
    const m = sum / n
    mean[t] = m
    sd[t] = Math.sqrt(Math.max(0, (sq - n * m * m) / (n - 1)))
  }
  return { mean, sd }
}

/** Sample standard deviation of the non-NaN values in s[from..to]; NaN with fewer than 3. */
export function stdev(s: Float64Array, from: number, to: number): number {
  let n = 0
  let sum = 0
  let sq = 0
  for (let t = Math.max(0, from); t <= to; t++) {
    const v = s[t]
    if (Number.isNaN(v)) continue
    n++
    sum += v
    sq += v * v
  }
  if (n < 3) return NaN
  const m = sum / n
  return Math.sqrt(Math.max(0, (sq - n * m * m) / (n - 1)))
}

export interface Reversion {
  /** Observations in the lookback. */
  n: number
  min: number
  max: number
  /** Share of lookback values at or below the day's value, 0–100. */
  percentile: number
  /** AR(1) coefficient b in ΔS_t = a + b·S_{t−1}; negative means it pulls back toward a mean. */
  b: number
  /** Days for a gap to the mean to halve; null when b ≥ 0 (no pull back) or b ≤ −1. */
  halfLife: number | null
  /** Dickey–Fuller t-statistic of b. */
  adfT: number
}

/** Mean-reversion statistics of s over the `lookback` days ending at day T (inclusive); null with too few values. */
export function reversion(s: Float64Array, T: number, lookback: number): Reversion | null {
  const from = Math.max(0, T - lookback + 1)
  const today = s[T]
  if (Number.isNaN(today)) return null
  let n = 0
  let below = 0
  let min = Infinity
  let max = -Infinity
  // AR(1) regression sums: y = ΔS_t, x = S_{t−1}.
  let m = 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let t = from; t <= T; t++) {
    const v = s[t]
    if (Number.isNaN(v)) continue
    n++
    if (v <= today) below++
    min = Math.min(min, v)
    max = Math.max(max, v)
    if (t > from && !Number.isNaN(s[t - 1])) {
      const x = s[t - 1]
      const y = v - x
      m++
      sx += x
      sy += y
      sxx += x * x
      sxy += x * y
      syy += y * y
    }
  }
  if (n < 10 || m < 10) return null
  const vx = sxx - (sx * sx) / m
  if (vx <= 0) return null
  const b = (sxy - (sx * sy) / m) / vx
  const a = (sy - b * sx) / m
  // Residual variance of the fit, then the slope's standard error.
  const rss = syy - 2 * a * sy - 2 * b * sxy + m * a * a + 2 * a * b * sx + b * b * sxx
  const se = Math.sqrt(Math.max(0, rss / (m - 2)) / vx)
  const halfLife = b < 0 && b > -1 ? -Math.LN2 / Math.log(1 + b) : null
  return { n, min, max, percentile: (100 * below) / n, b, halfLife, adfT: se > 0 ? b / se : NaN }
}

/** The smallest whole-lot ratio a : b (a lots of A against b lots of B) within `tol` of h, up to `maxLots` lots of A. */
export function lotRatio(h: number, maxLots = 10, tol = 0.05): [number, number] | null {
  if (!Number.isFinite(h) || h === 0) return null
  const target = Math.abs(h)
  let best: [number, number] | null = null
  let bestErr = Infinity
  for (let a = 1; a <= maxLots; a++) {
    const b = Math.max(1, Math.round(a * target))
    const err = Math.abs(b / a - target) / target
    if (err < bestErr - 1e-9) {
      best = [a, b]
      bestErr = err
    }
    if (err <= tol) return [a, b]
  }
  return best
}

/** h rounded to one side being a single lot: 1 : round(|h|) when |h| ≥ 1 (2.3 → 1 : 2), else round(1 / |h|) : 1 (0.3 → 3 : 1). */
export function oneLotRatio(h: number): [number, number] | null {
  if (!Number.isFinite(h) || h === 0) return null
  const m = Math.abs(h)
  return m >= 1 ? [1, Math.round(m)] : [Math.round(1 / m), 1]
}

export interface LegExposure {
  /** Full contract code, e.g. "CLG27". */
  code: string
  /** A's weight on the contract, per lot of A. */
  a: number
  /** −h × B's weight on the contract. */
  b: number
  net: number
}

/**
 * The contracts in long qa A, short h B, and the weight on each. A's legs are its front contract and the next ones
 * on its curve; same for B. Same-product contracts are netted.
 */
export function legExposure(
  a: { root: string; weights: number[]; refs: string[]; front: number },
  b: { root: string; weights: number[]; refs: string[]; front: number },
  h: number,
  qa = 1,
): LegExposure[] {
  const rows = new Map<string, LegExposure & { order: number }>()
  // Same product: one curve, so sort by position on it; otherwise A's contracts first.
  const add = (code: string, order: number, wa: number, wb: number) => {
    const row = rows.get(code) ?? { code, order, a: 0, b: 0, net: 0 }
    row.a += wa
    row.b += wb
    row.net = row.a + row.b
    rows.set(code, row)
  }
  a.weights.forEach((w, k) => {
    const ref = a.refs[a.front + k]
    if (ref) add(a.root + ref, a.front + k, qa * w, 0)
  })
  b.weights.forEach((w, k) => {
    const ref = b.refs[b.front + k]
    if (ref) add(b.root + ref, (a.root === b.root ? 0 : 1000) + b.front + k, 0, -h * w)
  })
  return [...rows.values()].sort((x, y) => x.order - y.order).map((r) => ({ code: r.code, a: r.a, b: r.b, net: r.net }))
}
