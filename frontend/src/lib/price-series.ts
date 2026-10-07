import type { Direction } from "@/hooks/use-flash"
import { decimalsFromTick, formatPrice, formatSigned, NULL_TOKEN, type InstrumentConvention, type Nullable, type PriceConvention } from "@/lib/format"
import type { DeltaBatch, RowId, RowStore } from "@/lib/row-store"

export interface Bar {
  /** When the bar opened, ms since the epoch. Its row id is `barId(time)`. */
  time: number
  open: number
  high: number
  low: number
  close: number
  /** Size traded in the bar; null or absent when the feed has none. */
  volume?: number | null
  /**
   * When the earliest and the latest prints folded into the bar happened. `foldTick` writes them, so a print
   * that arrives late corrects the high, the low, and the volume, and moves the open or the close only when it
   * is the earliest or the latest print the bar has seen. A bar that came in whole has neither and keeps its open.
   */
  firstAt?: number
  lastAt?: number
}

export interface PriceTick {
  /** When it printed, ms since the epoch. */
  at: number
  price: number
  /** Size, when the feed has one. */
  size?: number | null
}

/** The row id of a bar: its start time as a string. */
export const barId = (time: number): RowId => String(time)

/** The start of the bar a moment falls in, on a grid of `intervalMs` from the epoch. */
export function barStart(at: number, intervalMs: number): number {
  return Math.floor(at / intervalMs) * intervalMs
}

/**
 * A tick folded into the bar it belongs to: a new bar when none is open at its start, else that bar with the
 * high, the low, and the volume extended, the close moved if the tick is the latest the bar has seen, and the
 * open moved if it is the earliest. So a late print corrects the bar and never rewrites its close.
 */
export function foldTick(bar: Bar | undefined, tick: PriceTick, intervalMs: number): Bar {
  const time = barStart(tick.at, intervalMs)
  const size = typeof tick.size === "number" && Number.isFinite(tick.size) ? tick.size : null
  if (!bar || bar.time !== time) return { time, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: size, firstAt: tick.at, lastAt: tick.at }
  const volume = size === null ? (bar.volume ?? null) : (bar.volume ?? 0) + size
  const earliest = bar.firstAt !== undefined && tick.at < bar.firstAt
  const latest = bar.lastAt === undefined || tick.at >= bar.lastAt
  return {
    ...bar,
    open: earliest ? tick.price : bar.open,
    high: Math.max(bar.high, tick.price),
    low: Math.min(bar.low, tick.price),
    close: latest ? tick.price : bar.close,
    volume,
    ...(bar.firstAt !== undefined ? { firstAt: Math.min(bar.firstAt, tick.at) } : {}),
    lastAt: bar.lastAt === undefined ? tick.at : Math.max(bar.lastAt, tick.at),
  }
}

/**
 * The batch that folds a frame's ticks into a store of bars: one upsert per bar touched, each bar read from the
 * store first so the fold continues where the last batch left it. The ticks are folded in time order whatever
 * order they arrived in, so a shuffled frame folds as it happened. Apply it with `applyDeltas`.
 */
export function foldTicks(store: RowStore<Bar>, ticks: readonly PriceTick[], intervalMs: number): DeltaBatch<Bar> {
  const bars = new Map<number, Bar>()
  const ordered = ticks.filter((tick) => Number.isFinite(tick.price) && Number.isFinite(tick.at)).sort((a, b) => a.at - b.at)
  for (const tick of ordered) {
    const time = barStart(tick.at, intervalMs)
    bars.set(time, foldTick(bars.get(time) ?? store.getRow(barId(time)), tick, intervalMs))
  }
  return { upsert: [...bars.values()] }
}

/** The store's bars as the columns a canvas wants, in time order. */
export interface BarColumns {
  bars: readonly Bar[]
  time: number[]
  open: number[]
  high: number[]
  low: number[]
  close: number[]
  volume: (number | null)[]
}

export const EMPTY_COLUMNS: BarColumns = { bars: [], time: [], open: [], high: [], low: [], close: [], volume: [] }

const finiteBar = (bar: Bar | undefined): bar is Bar => bar !== undefined && [bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)

/**
 * Every finite bar in the store, in time order. The store's own order is trusted while it is already by time,
 * which a feed that appends is; a backfill that arrived out of order is sorted, once, here.
 */
export function columnsOf(store: RowStore<Bar>): BarColumns {
  const ids = store.getIds()
  let bars: Bar[] = []
  let sorted = true
  for (const id of ids) {
    const bar = store.getRow(id)
    if (!finiteBar(bar)) continue
    if (bars.length && bar.time < bars[bars.length - 1]!.time) sorted = false
    bars.push(bar)
  }
  if (!sorted) bars = bars.sort((a, b) => a.time - b.time)
  if (!bars.length) return EMPTY_COLUMNS
  const n = bars.length
  const out: BarColumns = { bars, time: new Array<number>(n), open: new Array<number>(n), high: new Array<number>(n), low: new Array<number>(n), close: new Array<number>(n), volume: new Array<number | null>(n) }
  for (let i = 0; i < n; i++) {
    const b = bars[i]!
    out.time[i] = b.time
    out.open[i] = b.open
    out.high[i] = b.high
    out.low[i] = b.low
    out.close[i] = b.close
    out.volume[i] = typeof b.volume === "number" && Number.isFinite(b.volume) ? b.volume : null
  }
  return out
}

/** What the chart says about its series in words and numbers: the last close against a reference, the range, the count. */
export interface SeriesSummary {
  count: number
  first: Bar | null
  last: Bar | null
  /** The lowest low and the highest high over every bar; 0 with no bars. */
  low: number
  high: number
  /** What the change is measured from: the baseline when given, else the first bar's open. */
  reference: number | null
  change: number | null
  changePct: number | null
  direction: Direction
}

export const EMPTY_SUMMARY: SeriesSummary = { count: 0, first: null, last: null, low: 0, high: 0, reference: null, change: null, changePct: null, direction: "flat" }

/** The direction of `to` against `from`: equal is flat, never up, the flash cell's rule. */
export function directionBetween(from: number, to: number): Direction {
  return to > from ? "up" : to < from ? "down" : "flat"
}

/** The summary of some columns against a baseline (a previous close) or, without one, against the first bar's open. */
export function summarize(columns: BarColumns, baseline?: number | null): SeriesSummary {
  const n = columns.bars.length
  if (!n) return EMPTY_SUMMARY
  let low = Infinity
  let high = -Infinity
  for (let i = 0; i < n; i++) {
    if (columns.low[i]! < low) low = columns.low[i]!
    if (columns.high[i]! > high) high = columns.high[i]!
  }
  const first = columns.bars[0]!
  const last = columns.bars[n - 1]!
  const reference = typeof baseline === "number" && Number.isFinite(baseline) ? baseline : first.open
  const change = last.close - reference
  return { count: n, first, last, low, high, reference, change, changePct: reference === 0 ? null : (change / Math.abs(reference)) * 100, direction: directionBetween(reference, last.close) }
}

/** The price convention of either shape: an instrument's, or a bare one. */
export function priceOf(convention: PriceConvention | InstrumentConvention): PriceConvention {
  return "price" in convention ? convention.price : convention
}

/** The smallest step a convention prints: the instrument's tick, a fraction's 32nd or 64th, a decimal's last place. */
export function priceStep(convention: PriceConvention | InstrumentConvention): number {
  if ("price" in convention && convention.tick > 0) return convention.tick
  const price = priceOf(convention)
  switch (price.kind) {
    case "fraction":
      return 1 / price.denominator
    case "tick":
      return price.tick
    case "decimal":
      return 10 ** -price.decimals
  }
}

/**
 * The steps a price axis may split on, from the convention's grid up: a fraction doubles (a 32nd, a 16th,
 * an 8th, a quarter, a half, a point, two points, ...), so every label prints as a clean fraction; a decimal
 * goes 1, 2, 5 per decade. In price units, for a canvas axis that picks the smallest step that fits.
 */
export function priceIncrements(convention: PriceConvention | InstrumentConvention): number[] {
  const step = priceStep(convention)
  const out: number[] = []
  if (priceOf(convention).kind === "fraction") {
    for (let i = 0; i < 20; i++) out.push(step * 2 ** i)
  } else {
    for (let decade = 0; decade < 9; decade++) for (const m of [1, 2, 5]) out.push(step * m * 10 ** decade)
  }
  // Float noise off the doubling and the decades, so 1/64 * 64 is 1, not 0.9999...
  return out.map((v) => Number(v.toPrecision(12)))
}

/** How many decimals a change in this convention prints with: a decimal's own, a tick's derived, none for a fraction (which prints as a fraction). */
export function priceDecimals(convention: PriceConvention | InstrumentConvention): number {
  const price = priceOf(convention)
  return price.kind === "decimal" ? price.decimals : price.kind === "tick" ? decimalsFromTick(price.tick) : 0
}

const MINUS = "−"

/** A change in price with its sign: "+0-02+" for a fraction, "+0.125" for a decimal, "0-00" or "0.00" for none. */
export function formatChange(change: Nullable, convention: PriceConvention | InstrumentConvention): string {
  if (change === null || change === undefined || !Number.isFinite(change)) return NULL_TOKEN
  const price = priceOf(convention)
  if (price.kind !== "fraction") return formatSigned(change, { decimals: priceDecimals(convention) })
  const sign = change > 0 ? "+" : change < 0 ? MINUS : ""
  return `${sign}${formatPrice(Math.abs(change), price)}`
}

const timeFormats = new Map<string, Intl.DateTimeFormat>()
const dayFormats = new Map<string, Intl.DateTimeFormat>()

/** A formatter for a zone, cached by its options, falling back to the runtime's zone for one the runtime does not know. */
function zonedFormat(cache: Map<string, Intl.DateTimeFormat>, key: string, locale: string | undefined, options: Intl.DateTimeFormatOptions, zone: string | undefined): Intl.DateTimeFormat {
  let format = cache.get(key)
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(locale ?? "en-US", { ...options, timeZone: zone })
    } catch {
      format = new Intl.DateTimeFormat(locale ?? "en-US", options)
    }
    cache.set(key, format)
  }
  return format
}

/**
 * A clock reading in a zone, `14:32:05`, in the 24-hour cycle whatever the locale's habit. A zone the runtime
 * does not know falls back to the runtime's own zone rather than throwing, since a chart must still draw.
 */
export function timeFormatter(zone?: string, locale?: string, seconds = true): (ms: number) => string {
  const format = zonedFormat(timeFormats, `${zone ?? ""}|${locale ?? ""}|${seconds ? "s" : "m"}`, locale, { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hourCycle: "h23" }, zone)
  return (ms) => format.format(ms)
}

/** The month and day in the zone, `01/15`, for an axis whose range runs past one day. Same fallback as `timeFormatter`. */
export function dayFormatter(zone?: string, locale?: string): (ms: number) => string {
  const format = zonedFormat(dayFormats, `${zone ?? ""}|${locale ?? ""}`, locale, { month: "2-digit", day: "2-digit" }, zone)
  return (ms) => format.format(ms)
}
