// Turns the backend's per-year price levels into the lines the seasonality chart draws: daily change or a
// zero-based running total, optional spike removal, calendar or days-to-expiry alignment, a days window,
// and an average line. Pure functions, so every toggle is instant and testable without a refetch.

import type { YearSeries } from "@/lib/seasonality-api"

export type Align = "current" | "expiry"

/** Every price on this desk quotes on a 0.01 tick worth $10; every plotted and calculated value is a whole number of ticks. */
export const TICK = 0.01

/** Rounds a price to the nearest tick, as an exact two-decimal number (no 0.30000000000000004). */
export const toTick = (price: number): number => Math.round(Math.round(price / TICK) * TICK * 100) / 100

/** What a line shows: each day's change, the running total of changes from the first visible day (zero-based), or the raw price level. */
export type ViewMode = "change" | "cumulative" | "level"

export interface ViewOptions {
  mode: ViewMode
  removeSpikes: boolean
  align: Align
  /** Contract years to show (series.year). */
  years: ReadonlySet<number>
  /** Keep only days whose distance to expiry is in [minDays, maxDays]. */
  minDays: number
  maxDays: number
  average: boolean
}

export interface Line {
  /** Contract year, or "Avg" for the average line. */
  name: string
  /** Years back from the strategy as entered (0 = current year); -1 marks the average line. */
  shift: number
  x: number[]
  y: number[]
  /** The actual trading date of each point (absent on the average line). */
  dates?: string[]
}

const DAY_MS = 86_400_000
const SPIKE_MADS = 4

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number)
  return [y, m, d]
}

function dayNumber(date: string): number {
  const [y, m, d] = parts(date)
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}

/** Seconds since epoch for `date` moved forward `years` years, so every year's line lands on the base year's calendar. */
function shiftedEpoch(date: string, years: number): number {
  const [y, m, d] = parts(date)
  return Date.UTC(y + years, m - 1, d) / 1000
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Zeroes daily moves further than SPIKE_MADS robust standard deviations from the median move. */
export function dropSpikes(changes: number[]): number[] {
  if (changes.length < 10) return changes
  const med = median(changes)
  const mad = median(changes.map((c) => Math.abs(c - med))) * 1.4826
  if (mad === 0) return changes
  return changes.map((c) => (Math.abs(c - med) > SPIKE_MADS * mad ? 0 : c))
}

function buildLine(series: YearSeries, opts: ViewOptions): Line {
  const { dates } = series
  // Levels snap to the tick first, so changes and running totals are whole ticks and add up exactly.
  const values = series.values.map(toTick)
  let changes = values.slice(1).map((v, i) => toTick(v - values[i]))
  if (opts.removeSpikes) changes = dropSpikes(changes)
  const expiryDay = series.expiry ? dayNumber(series.expiry) : null

  const x: number[] = []
  const y: number[] = []
  const kept: string[] = []
  let running = 0
  // A change needs a previous day, so the first day only appears in level mode.
  for (let i = opts.mode === "level" ? 0 : 1; i < values.length; i++) {
    const date = dates[i]
    const daysLeft = expiryDay === null ? 0 : expiryDay - dayNumber(date)
    if (expiryDay !== null && (daysLeft < opts.minDays || daysLeft > opts.maxDays)) continue
    if (opts.mode !== "level") running = toTick(running + changes[i - 1])
    x.push(opts.align === "expiry" ? -daysLeft : shiftedEpoch(date, series.shift))
    y.push(opts.mode === "level" ? values[i] : opts.mode === "cumulative" ? running : changes[i - 1])
    kept.push(date)
  }
  return { name: String(series.year), shift: series.shift, x, y, dates: kept }
}

/** The lines' values gathered on a daily grid. Daily moves group only the lines that traded that day; running totals carry forward over gaps. */
function bucketize(lines: Line[], opts: ViewOptions): { step: number; buckets: Map<number, number[]> } {
  const step = opts.align === "current" ? 86_400 : 1
  const buckets = new Map<number, number[]>()
  for (const line of lines) {
    let carried: number | null = null
    let prev: number | null = null
    for (let i = 0; i < line.x.length; i++) {
      const key = Math.round(line.x[i] / step)
      if (opts.mode !== "change" && prev !== null) {
        // Fill the weekend / holiday days between two observations with the last total.
        for (let k = prev + 1; k < key; k++) buckets.set(k, [...(buckets.get(k) ?? []), carried as number])
      }
      buckets.set(key, [...(buckets.get(key) ?? []), line.y[i]])
      carried = line.y[i]
      prev = key
    }
  }
  return { step, buckets }
}

/** Mean of the lines on a daily grid. */
function averageLine(lines: Line[], opts: ViewOptions): Line {
  const { step, buckets } = bucketize(lines, opts)
  const need = Math.min(2, lines.length)
  const keys = [...buckets.keys()].sort((a, b) => a - b).filter((k) => (buckets.get(k) as number[]).length >= need)
  return {
    name: "Avg",
    shift: -1,
    x: keys.map((k) => k * step),
    y: keys.map((k) => {
      const v = buckets.get(k) as number[]
      return toTick(v.reduce((a, b) => a + b, 0) / v.length)
    }),
  }
}

export function buildLines(series: readonly YearSeries[], opts: ViewOptions): Line[] {
  const lines = series.filter((s) => opts.years.has(s.year) && s.values.length > 1).map((s) => buildLine(s, opts)).filter((l) => l.x.length > 0)
  if (opts.average && lines.length > 0) lines.push(averageLine(lines, opts))
  return lines
}

/** Aligns the lines on one shared, sorted x array (uPlot's data shape): [xs, ys of line 0, ys of line 1, ...], null where a line has no point. */
export function toChartData(lines: readonly Line[]): (number | null)[][] {
  const xs = [...new Set(lines.flatMap((l) => l.x))].sort((a, b) => a - b)
  const index = new Map(xs.map((x, i) => [x, i]))
  const columns = lines.map((line) => {
    const col: (number | null)[] = new Array(xs.length).fill(null)
    line.x.forEach((x, i) => (col[index.get(x) as number] = line.y[i]))
    return col
  })
  return [xs, ...columns]
}

/** "2025, 2023-2021" -> a set of years. Anything unparseable is ignored. */
export function parseYearList(text: string): Set<number> {
  const out = new Set<number>()
  for (const token of text.split(/[\s,;]+/)) {
    const range = token.match(/^(\d{4})-(\d{4})$/)
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])].sort((p, q) => p - q)
      for (let y = a; y <= b; y++) out.add(y)
    } else if (/^\d{4}$/.test(token)) out.add(Number(token))
  }
  return out
}

export function toCsv(lines: readonly Line[], align: Align): string {
  const [xs, ...cols] = toChartData(lines)
  const header = [align === "expiry" ? "days_to_expiry" : "date", ...lines.map((l) => l.name)].join(",")
  const rows = xs.map((x, i) => {
    const label = align === "expiry" ? String(-(x as number)) : new Date((x as number) * 1000).toISOString().slice(0, 10)
    return [label, ...cols.map((c) => (c[i] === null ? "" : (c[i] as number).toFixed(2)))].join(",")
  })
  return [header, ...rows].join("\n")
}
