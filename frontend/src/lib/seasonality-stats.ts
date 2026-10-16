// Statistics for the seasonality tab. The headline one is the BASE RANGE: the band of mean ± k standard
// deviations of whatever the chart is showing (daily change, running total, or price level), measured over the
// other years, and how often each year left it. Seasonal drift and hedge ratios work on the raw per-year price
// levels the endpoint returns. Pure functions; `Ticks` means 1 tick = 0.01 = $10 per lot.

import { TICK, toTick, type Line } from "@/lib/seasonality"
import type { SeasonalityResult, StrategySeries, YearSeries } from "@/lib/seasonality-api"

export { TICK }
export const TICK_USD = 10
/** Calendar days either side of today's date that count as "the same time of year" when pooling other years. */
const POOL_DAYS = 5
const MIN_POOL = 5
const HORIZONS = [5, 10, 20] as const

const mean = (v: readonly number[]) => v.reduce((a, b) => a + b, 0) / v.length

function sd(v: readonly number[]): number {
  if (v.length < 2) return 0
  const m = mean(v)
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1))
}

function median(v: readonly number[]): number {
  const s = [...v].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function dayOf(date: string, addYears = 0): number {
  const [y, m, d] = date.split("-").map(Number)
  return Math.round(Date.UTC(y + addYears, m - 1, d) / 86_400_000)
}

// ---------------------------------------------------------------------------------------------------------------
// Base range and breaks
// ---------------------------------------------------------------------------------------------------------------

/** Which years define "normal": the others (the current year is tested against them), or every selected year. */
export type RangeBasis = "others" | "all"

export interface RangeOptions {
  /** How many standard deviations either side of the mean. */
  sigma: number
  basis: RangeBasis
}

export interface BaseRange {
  mid: number
  sd: number
  lo: number
  hi: number
  /** Points the range was measured over. */
  n: number
  /** The basis actually used; falls back to "all" when there are no other years. */
  basis: RangeBasis
}

export type RangeState = "inside" | "above" | "below"

export interface YearBreaks {
  year: number
  days: number
  daysOutside: number
  breaksAbove: number
  breaksBelow: number
  /** Most consecutive days spent outside the range. */
  longestOutside: number
  /** How far past the nearest edge the line got at its worst, in ticks. */
  furthestTicks: number
}

export interface RangeNow {
  year: number
  date: string
  value: number
  state: RangeState
  /** Standard deviations from the mean. */
  z: number
  /** Ticks past the edge when outside; ticks to the nearest edge when inside. */
  edgeTicks: number
  /** Date of the most recent break, and trading days since. Null when it never broke. */
  lastBreak: { date: string; daysAgo: number } | null
}

export interface RangeStats {
  range: BaseRange
  now: RangeNow | null
  years: YearBreaks[]
  /** Average breaks per year over the years that define the range's history, or the others when current is shown. */
  avgBreaksOthers: number | null
}

function stateOf(value: number, range: BaseRange): RangeState {
  return value > range.hi ? "above" : value < range.lo ? "below" : "inside"
}

function breaksFor(line: Line, range: BaseRange): { out: YearBreaks; lastBreakIndex: number | null } {
  let state: RangeState = "inside"
  let run = 0
  let lastBreakIndex: number | null = null
  const out: YearBreaks = { year: Number(line.name), days: line.y.length, daysOutside: 0, breaksAbove: 0, breaksBelow: 0, longestOutside: 0, furthestTicks: 0 }
  line.y.forEach((v, i) => {
    const next = stateOf(v, range)
    if (next !== "inside") {
      out.daysOutside++
      run = next === state ? run + 1 : 1
      out.longestOutside = Math.max(out.longestOutside, run)
      out.furthestTicks = Math.max(out.furthestTicks, Math.round((next === "above" ? v - range.hi : range.lo - v) / TICK))
      // A break is the move from inside (or across to the opposite side) into outside.
      if (next !== state) {
        if (next === "above") out.breaksAbove++
        else out.breaksBelow++
        lastBreakIndex = i
      }
    } else run = 0
    state = next
  })
  return { out, lastBreakIndex }
}

/** The base range of the plotted lines and how each year behaved against it. `lines` are the chart's own year lines. */
export function computeRange(lines: readonly Line[], opts: RangeOptions): RangeStats | null {
  const yearLines = lines.filter((l) => l.shift >= 0 && l.y.length > 0)
  const others = yearLines.filter((l) => l.shift > 0)
  const basis: RangeBasis = opts.basis === "others" && others.length > 0 ? "others" : "all"
  const pool = (basis === "others" ? others : yearLines).flatMap((l) => l.y)
  const spread = sd(pool)
  if (pool.length < 10 || spread === 0) return null
  // The edges are rounded to the nearest tick, so a break is judged against a price the market can actually print.
  const mid = mean(pool)
  const range: BaseRange = { mid: toTick(mid), sd: spread, lo: toTick(mid - opts.sigma * spread), hi: toTick(mid + opts.sigma * spread), n: pool.length, basis }

  const perYear = yearLines.map((l) => ({ line: l, ...breaksFor(l, range) }))
  const cur = perYear.find((p) => p.line.shift === 0)

  let now: RangeNow | null = null
  if (cur) {
    const { line, out: breaks } = cur
    const last = line.y.length - 1
    const value = line.y[last]
    const state = stateOf(value, range)
    const edgeTicks = Math.round((state === "above" ? value - range.hi : state === "below" ? range.lo - value : Math.min(range.hi - value, value - range.lo)) / TICK)
    const date = line.dates?.[last] ?? ""
    const brokeAt = cur.lastBreakIndex
    now = {
      year: breaks.year,
      date,
      value,
      state,
      z: (value - range.mid) / range.sd,
      edgeTicks,
      lastBreak: brokeAt === null || !line.dates ? null : { date: line.dates[brokeAt], daysAgo: last - brokeAt },
    }
  }

  const history = perYear.filter((p) => p.line.shift > 0)
  return {
    range,
    now,
    years: perYear.map((p) => p.out),
    avgBreaksOthers: history.length ? mean(history.map((p) => p.out.breaksAbove + p.out.breaksBelow)) : null,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Seasonal drift and hedge ratios (on the raw per-year price levels)
// ---------------------------------------------------------------------------------------------------------------

export interface LevelOptions {
  years: ReadonlySet<number>
  minDays: number
  maxDays: number
}

/** One year's levels inside the days window, with every date also placed on the base year's calendar. */
interface Win {
  year: number
  shift: number
  dates: string[]
  /** Shifted calendar day number, so years line up by time of year. */
  day: number[]
  values: number[]
}

export interface ZStat {
  z: number
  /** Share of the reference points at or below the current value, 0-100. */
  percentile: number
  mean: number
  sd: number
  n: number
}

export interface DriftStat {
  label: string
  n: number
  meanTicks: number
  medianTicks: number
  hitRate: number
  avgWinTicks: number | null
  avgLossTicks: number | null
}

export interface HedgeStat {
  a: { index: number; label: string }
  b: { index: number; label: string }
  /** Units of B to sell per 1 of A to cancel A's daily moves (OLS slope of A's changes on B's). */
  beta: number
  corr: number
  r2: number
  n: number
  perYear: { year: number; beta: number; n: number }[]
  /** Where A − beta × B is now, versus the other years at the same dates. */
  residual: ZStat | null
}

export interface HalfLifeStat {
  year: number
  /** Trading days of price level the estimate used. */
  days: number
  /** Trading days to revert halfway to the year's own average; null when the level trends instead of reverting (or there are too few days). */
  halfLifeDays: number | null
}

export interface LevelStats {
  /** The current year's newest date, for labelling the drift table. */
  asOf: string | null
  drift: DriftStat[]
  hedges: HedgeStat[]
  /** Mean-reversion speed of each selected year's price level, whatever the chart is showing. */
  halfLives: HalfLifeStat[]
}

function prep(series: YearSeries, minDays: number, maxDays: number): Win {
  const expiry = series.expiry ? dayOf(series.expiry) : null
  const win: Win = { year: series.year, shift: series.shift, dates: [], day: [], values: [] }
  series.dates.forEach((date, i) => {
    const left = expiry === null ? 0 : expiry - dayOf(date)
    if (expiry !== null && (left < minDays || left > maxDays)) return
    win.dates.push(date)
    win.day.push(dayOf(date, series.shift))
    win.values.push(toTick(series.values[i]))
  })
  return win
}

/**
 * Mean-reversion half-life of a price-level series: fit x[t] = phi * x[t-1] to the level taken from its own average,
 * then half-life = ln(0.5) / ln(phi), in trading days. Only meaningful for 0 < phi < 1; phi at or above 1 is a level
 * that trends (no reversion), and phi at or below 0 reverts faster than a day, so both return null.
 */
function halfLife(values: readonly number[]): number | null {
  if (values.length < 20) return null
  const m = mean(values)
  let num = 0
  let den = 0
  for (let i = 1; i < values.length; i++) {
    num += (values[i] - m) * (values[i - 1] - m)
    den += (values[i - 1] - m) ** 2
  }
  const phi = den > 0 ? num / den : 0
  return phi > 0 && phi < 1 ? Math.log(0.5) / Math.log(phi) : null
}

const diffs = (values: readonly number[]) => values.slice(1).map((v, i) => toTick(v - values[i]))

function zStat(current: number, pool: readonly number[]): ZStat | null {
  const spread = sd(pool)
  if (pool.length < MIN_POOL || spread === 0) return null
  const m = mean(pool)
  return { z: (current - m) / spread, percentile: (100 * pool.filter((x) => x <= current).length) / pool.length, mean: m, sd: spread, n: pool.length }
}

/** Every point of `others` within POOL_DAYS of the same time of year. */
function pooled(others: readonly Win[], day: number): number[] {
  const out: number[] = []
  for (const w of others) w.day.forEach((d, i) => Math.abs(d - day) <= POOL_DAYS && out.push(w.values[i]))
  return out
}

function nearest(w: Win, day: number): number {
  let best = -1
  let gap = POOL_DAYS + 1
  w.day.forEach((d, i) => {
    if (Math.abs(d - day) < gap) [best, gap] = [i, Math.abs(d - day)]
  })
  return best
}

function driftStat(label: string, moves: number[]): DriftStat | null {
  if (moves.length === 0) return null
  const wins = moves.filter((m) => m > 0)
  const losses = moves.filter((m) => m < 0)
  return {
    label,
    n: moves.length,
    meanTicks: Math.round(mean(moves) / TICK),
    medianTicks: Math.round(median(moves) / TICK),
    hitRate: (100 * wins.length) / moves.length,
    avgWinTicks: wins.length ? Math.round(mean(wins) / TICK) : null,
    avgLossTicks: losses.length ? Math.round(mean(losses) / TICK) : null,
  }
}

function hedgeStat(a: StrategySeries, b: StrategySeries, opts: LevelOptions): HedgeStat | null {
  const dA: number[] = []
  const dB: number[] = []
  const perYear: HedgeStat["perYear"] = []
  const pairs: { year: number; shift: number; dates: string[]; day: number[]; a: number[]; b: number[] }[] = []

  for (const sa of a.series) {
    const sb = b.series.find((s) => s.shift === sa.shift)
    if (!sb || !opts.years.has(sa.year)) continue
    const wa = prep(sa, opts.minDays, opts.maxDays)
    const wb = prep(sb, opts.minDays, opts.maxDays)
    const byDate = new Map(wb.dates.map((d, i) => [d, i]))
    const pair = { year: sa.year, shift: sa.shift, dates: [] as string[], day: [] as number[], a: [] as number[], b: [] as number[] }
    wa.dates.forEach((date, i) => {
      const j = byDate.get(date)
      if (j === undefined) return
      pair.dates.push(date)
      pair.day.push(wa.day[i])
      pair.a.push(wa.values[i])
      pair.b.push(wb.values[j])
    })
    if (pair.dates.length < 3) continue
    pairs.push(pair)
    const ca = diffs(pair.a)
    const cb = diffs(pair.b)
    dA.push(...ca)
    dB.push(...cb)
    if (cb.length >= 10) {
      const [ma, mb] = [mean(ca), mean(cb)]
      const vb = cb.reduce((s, x) => s + (x - mb) ** 2, 0)
      if (vb > 0) perYear.push({ year: sa.year, beta: ca.reduce((s, x, i) => s + (x - ma) * (cb[i] - mb), 0) / vb, n: cb.length })
    }
  }
  if (dA.length < 20) return null

  const [mA, mB] = [mean(dA), mean(dB)]
  const cov = dA.reduce((s, x, i) => s + (x - mA) * (dB[i] - mB), 0)
  const varB = dB.reduce((s, x) => s + (x - mB) ** 2, 0)
  const varA = dA.reduce((s, x) => s + (x - mA) ** 2, 0)
  if (varA === 0 || varB === 0) return null
  const beta = cov / varB
  const corr = cov / Math.sqrt(varA * varB)

  const residuals: Win[] = pairs.map((p) => ({ year: p.year, shift: p.shift, dates: p.dates, day: p.day, values: p.a.map((x, i) => x - beta * p.b[i]) }))
  const cur = residuals.find((r) => r.shift === 0)
  const others = residuals.filter((r) => r.shift !== 0)
  const residual = cur && cur.values.length ? zStat(cur.values[cur.values.length - 1], pooled(others, cur.day[cur.day.length - 1])) : null

  return { a: { index: a.index, label: a.label }, b: { index: b.index, label: b.label }, beta, corr, r2: corr ** 2, n: dA.length, perYear, residual }
}

export function computeLevelStats(result: SeasonalityResult, opts: LevelOptions): LevelStats {
  const wins = result.series.filter((s) => opts.years.has(s.year)).map((s) => prep(s, opts.minDays, opts.maxDays)).filter((w) => w.values.length > 1)
  const cur = wins.find((w) => w.shift === 0)
  const others = wins.filter((w) => w.shift !== 0)
  const drift: DriftStat[] = []

  if (cur) {
    const day = cur.day[cur.day.length - 1]
    // What the other years did from this time of year onward (trading-day offsets within each year's own series).
    for (const h of HORIZONS) {
      const moves: number[] = []
      for (const w of others) {
        const i = nearest(w, day)
        if (i >= 0 && i + h < w.values.length) moves.push(w.values[i + h] - w.values[i])
      }
      const stat = driftStat(`Next ${h} days`, moves)
      if (stat) drift.push(stat)
    }
    const toEnd: number[] = []
    for (const w of others) {
      const i = nearest(w, day)
      if (i >= 0 && i < w.values.length - 1) toEnd.push(w.values[w.values.length - 1] - w.values[i])
    }
    const end = driftStat("To expiry / window end", toEnd)
    if (end) drift.push(end)
  }

  const hedges: HedgeStat[] = []
  for (let i = 0; i < result.strategies.length; i++) {
    for (let j = i + 1; j < result.strategies.length; j++) {
      const h = hedgeStat(result.strategies[i], result.strategies[j], opts)
      if (h) hedges.push(h)
    }
  }

  const halfLives = wins.map((w) => ({ year: w.year, days: w.values.length, halfLifeDays: halfLife(w.values) }))

  return { asOf: cur ? cur.dates[cur.dates.length - 1] : null, drift, hedges, halfLives }
}
