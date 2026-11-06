// Rolling correlations between the points of two Curve Lab 2 strategies (A's points against B's), for the
// Correlations view. Pure functions over the /api/curve-lab-2/curves responses; nothing here touches React.
//
// The two strategies are joined on the settlement days both have (two products can differ on holidays). A point's
// daily change is taken on the same contracts: today's value of the point minus yesterday's value of the point
// that had the same front contract yesterday. So when c1 rolls from Z26 to F27, c1's change that day is F27's
// move, not the jump from Z26's price to F27's.

import type { CurveLab2Curves, CurveLab2Day } from "@/lib/curve-lab-2-api"

/** Correlate day-on-day changes (on the same contracts) or the levels themselves. */
export type CorrBasis = "change" | "level"
/** Pair A's point k with B's point k (slot), or with B's point on the same front contract month (month). */
export type CorrAlign = "slot" | "month"

export interface PointSeries {
  /** values[t * depth + k]: point k on day t; NaN where it has no value. */
  values: Float64Array
  /** Each day's front contract per point (refs[t][k], "G27"), `depth` long; "" past the end of the curve. */
  refs: string[][]
}

/** The settlement days both strategies have, in order. */
export function sharedDates(a: CurveLab2Curves, b: CurveLab2Curves): string[] {
  const inB = new Set(b.days.map((d) => d.date))
  return a.days.map((d) => d.date).filter((d) => inB.has(d))
}

/** One strategy's points on the given days, as levels or as changes since the previous day in `dates`. */
export function pointSeries(curves: CurveLab2Curves, dates: string[], depth: number, basis: CorrBasis): PointSeries {
  const byDate = new Map<string, CurveLab2Day>(curves.days.map((d) => [d.date, d]))
  const values = new Float64Array(dates.length * depth).fill(NaN)
  const refs: string[][] = []
  for (let t = 0; t < dates.length; t++) {
    const day = byDate.get(dates[t])!
    const prev = t > 0 ? byDate.get(dates[t - 1])! : null
    const n = Math.min(depth, day.settle.length)
    refs.push(Array.from({ length: depth }, (_, k) => (k < n ? day.refs[k] : "")))
    for (let k = 0; k < n; k++) {
      const v = day.settle[k]
      if (v === null) continue
      if (basis === "level") {
        values[t * depth + k] = v
        continue
      }
      if (!prev) continue
      // Legs are adjacent contracts, so the same front contract means the same legs.
      const kp = prev.refs.indexOf(day.refs[k])
      const pv = kp >= 0 && kp < prev.settle.length ? prev.settle[kp] : null
      if (pv !== null) values[t * depth + k] = v - pv
    }
  }
  return { values, refs }
}

export interface RollingCorr {
  /** r[(t * na + i) * nb + j]: correlation of A's point i with B's point j over the `window` days to day t; NaN when fewer than `minObs` shared observations. */
  r: Float32Array
  na: number
  nb: number
}

/**
 * Pearson correlation of every A point against every B point over a trailing window of days, on the days both
 * have a value. Running sums per pair, so the cost is days × na × nb whatever the window.
 */
export function rollingCorr(a: Float64Array, na: number, b: Float64Array, nb: number, days: number, window: number, minObs: number): RollingCorr {
  const pairs = na * nb
  const n = new Float64Array(pairs)
  const sx = new Float64Array(pairs)
  const sy = new Float64Array(pairs)
  const sxx = new Float64Array(pairs)
  const syy = new Float64Array(pairs)
  const sxy = new Float64Array(pairs)
  const r = new Float32Array(days * pairs).fill(NaN)

  const fold = (t: number, sign: 1 | -1) => {
    for (let i = 0; i < na; i++) {
      const x = a[t * na + i]
      if (Number.isNaN(x)) continue
      for (let j = 0; j < nb; j++) {
        const y = b[t * nb + j]
        if (Number.isNaN(y)) continue
        const p = i * nb + j
        n[p] += sign
        sx[p] += sign * x
        sy[p] += sign * y
        sxx[p] += sign * x * x
        syy[p] += sign * y * y
        sxy[p] += sign * x * y
      }
    }
  }

  for (let t = 0; t < days; t++) {
    fold(t, 1)
    if (t >= window) fold(t - window, -1)
    for (let p = 0; p < pairs; p++) {
      const m = n[p]
      if (m < minObs) continue
      const vx = sxx[p] - (sx[p] * sx[p]) / m
      const vy = syy[p] - (sy[p] * sy[p]) / m
      // Subtracting old days leaves rounding residue; treat a variance that small as a flat series.
      if (vx <= 1e-12 * Math.max(1, sxx[p]) || vy <= 1e-12 * Math.max(1, syy[p])) continue
      const c = (sxy[p] - (sx[p] * sy[p]) / m) / Math.sqrt(vx * vy)
      r[t * pairs + p] = Math.max(-1, Math.min(1, c))
    }
  }
  return { r, na, nb }
}

/** The correlation of A's point i with B's point j on day t; null where there is none (or t is before the first day). */
export function corrAt(c: RollingCorr, t: number, i: number, j: number): number | null {
  if (t < 0) return null
  const v = c.r[(t * c.na + i) * c.nb + j]
  return Number.isNaN(v) ? null : v
}

/** B's point matched with A's point i on a day: the same slot, or the one on A's front contract month; -1 if none. */
export function matchedColumn(align: CorrAlign, refsA: string[], refsB: string[], i: number): number {
  if (align === "slot") return i < refsB.length && refsB[i] !== "" ? i : -1
  const ref = refsA[i]
  return ref ? refsB.indexOf(ref) : -1
}
