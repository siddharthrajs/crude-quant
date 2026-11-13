// Statistics for the Roll transition section (components/curve-lab-2/roll-transition.tsx). Every series is indexed
// by offset from the old front's expiry: index i is offset i - window.

import type { RollEvent, RollSection } from "@/lib/curve-lab-2-api"

export type Series = (number | null)[]

export type RollHistory = "all" | "regime" | "month"

/** The past rolls to compare a roll with: all, the ones that started in the same curve regime, or the same calendar roll. */
export function historyOf(events: RollEvent[], selected: RollEvent, filter: RollHistory): RollEvent[] {
  return events.filter((e) => e !== selected && (filter === "all" || (filter === "regime" ? e.back === selected.back : e.out[0] === selected.out[0])))
}

/** A series minus its value on E (offset 0); null everywhere if it has none. */
export function rebased(values: Series, window: number): Series {
  const base = values[window]
  return values.map((v) => (v === null || base === null || base === undefined ? null : Math.round((v - base) * 1e6) / 1e6))
}

export function quantile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const a = [...values].sort((x, y) => x - y)
  const i = (a.length - 1) * p
  const lo = Math.floor(i)
  return a[lo] + (a[Math.ceil(i)] - a[lo]) * (i - lo)
}

/** Mean after dropping `cut` of the values at each end. */
export function trimmedMean(values: number[], cut: number): number | null {
  if (values.length === 0) return null
  const a = [...values].sort((x, y) => x - y)
  const k = Math.floor(a.length * cut)
  const kept = a.length > 2 * k ? a.slice(k, a.length - k) : a
  return kept.reduce((s, v) => s + v, 0) / kept.length
}

function sd(values: number[]): number | null {
  if (values.length < 2) return null
  const m = values.reduce((s, v) => s + v, 0) / values.length
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1))
}

/** Per offset across many series: a function of the non-null values there. */
export function across(series: Series[], length: number, f: (values: number[]) => number | null): Series {
  return Array.from({ length }, (_, i) => {
    const vs: number[] = []
    for (const s of series) {
      const v = s[i]
      if (v !== null && v !== undefined) vs.push(v)
    }
    return f(vs)
  })
}

/** Change over a section: from the day before it starts to its last day. */
export function sectionChange(values: Series, window: number, s: Pick<RollSection, "from" | "to">): number | null {
  const a = values[s.from - 1 + window]
  const b = values[s.to + window]
  return a === null || a === undefined || b === null || b === undefined ? null : b - a
}

function dailyChanges(values: Series, window: number, s: RollSection): number[] {
  const out: number[] = []
  for (let t = s.from; t <= s.to; t++) {
    const a = values[t - 1 + window]
    const b = values[t + window]
    if (a !== null && a !== undefined && b !== null && b !== undefined) out.push(b - a)
  }
  return out
}

export interface SectionStat {
  section: RollSection
  /** Rolls with a value over the whole section. */
  n: number
  /** Change over the section, 5% trimmed mean across rolls. */
  mean: number | null
  /** Share of rolls in which it rose. */
  up: number | null
  t: number | null
  /** Robust standard deviation of the daily changes in the section (IQR / 1.349). */
  dailyVol: number | null
  /** The selected roll's change over the section. */
  selected: number | null
  /** The outgoing strategy's average change, for sections up to E. */
  outMean: number | null
}

export function sectionStats(history: RollEvent[], selected: RollEvent, sections: RollSection[], window: number): SectionStat[] {
  return sections.map((section) => {
    const ch = history.map((e) => sectionChange(e.in_values, window, section)).filter((v): v is number => v !== null)
    const mean = trimmedMean(ch, 0.05)
    const s = sd(ch)
    const daily = history.flatMap((e) => dailyChanges(e.in_values, window, section))
    const q1 = quantile(daily, 0.25)
    const q3 = quantile(daily, 0.75)
    const outCh = section.to <= 0 ? history.map((e) => sectionChange(e.out_values, window, section)).filter((v): v is number => v !== null) : []
    return {
      section,
      n: ch.length,
      mean,
      up: ch.length ? ch.filter((v) => v > 0).length / ch.length : null,
      t: mean !== null && s ? mean / (s / Math.sqrt(ch.length)) : null,
      dailyVol: q1 !== null && q3 !== null && daily.length > 3 ? (q3 - q1) / 1.349 : null,
      selected: sectionChange(selected.in_values, window, section),
      outMean: outCh.length ? trimmedMean(outCh, 0.05) : null,
    }
  })
}

export interface CarryOver {
  points: { event: RollEvent; x: number; y: number }[]
  slope: number | null
  intercept: number | null
  /** Spearman rank correlation. */
  rho: number | null
  /** Share of rolls whose two changes have the same sign. */
  same: number | null
}

/** One roll per point: the incoming strategy's change over section `x` against its change over section `y`. */
export function carryOver(history: RollEvent[], x: RollSection, y: RollSection, window: number): CarryOver {
  const points = history.flatMap((event) => {
    const a = sectionChange(event.in_values, window, x)
    const b = sectionChange(event.in_values, window, y)
    return a === null || b === null ? [] : [{ event, x: a, y: b }]
  })
  const n = points.length
  if (n < 3) return { points, slope: null, intercept: null, rho: null, same: null }
  const mx = points.reduce((s, p) => s + p.x, 0) / n
  const my = points.reduce((s, p) => s + p.y, 0) / n
  const sxx = points.reduce((s, p) => s + (p.x - mx) ** 2, 0)
  const slope = sxx > 0 ? points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / sxx : null
  const rank = (vs: number[]) => {
    const order = vs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
    const r = new Array<number>(vs.length)
    order.forEach(([, i], k) => (r[i] = k))
    return r
  }
  const rx = rank(points.map((p) => p.x))
  const ry = rank(points.map((p) => p.y))
  const mr = (n - 1) / 2
  const num = rx.reduce((s, v, i) => s + (v - mr) * (ry[i] - mr), 0)
  const den = Math.sqrt(rx.reduce((s, v) => s + (v - mr) ** 2, 0) * ry.reduce((s, v) => s + (v - mr) ** 2, 0))
  return {
    points,
    slope,
    intercept: slope === null ? null : my - slope * mx,
    rho: den > 0 ? num / den : null,
    same: points.filter((p) => Math.sign(p.x) === Math.sign(p.y) && p.x !== 0).length / n,
  }
}

/** The first offset at which N+1's open interest exceeds N's in this roll. */
export function oiCrossover(e: RollEvent, window: number): number | null {
  const [n, n1] = e.oi
  for (let i = 0; i <= window; i++) {
    const a = n[i]
    const b = n1[i]
    if (a !== null && b !== null && b > a) return i - window
  }
  return null
}

export const offsetLabel = (t: number) => (t === 0 ? "E" : t < 0 ? `E−${-t}` : `E+${t}`)
