// What a watchlist item needs from a Seasonality plot: the combined weighted outright legs, and the two base
// ranges of that combination, computed exactly as the chart's summary bar computes them: the range of its daily
// change and the range of its price level. Shared by "Add to watchlist" and by the watchlist's own range refresh.

import { buildLines } from "@/lib/seasonality"
import type { SeasonalityResult, StrategyInput } from "@/lib/seasonality-api"
import { computeRange } from "@/lib/seasonality-stats"
import type { WatchLeg, WatchRange, WatchRanges, WatchSettings } from "@/lib/watchlist-api"

const MONTH_CODES = "FGHJKMNQUVXZ"

/** Chronological position of a tenor code: "K27" is May 2027. */
const tenorRank = (tenor: string) => Number(tenor.slice(1)) * 12 + MONTH_CODES.indexOf(tenor[0])

/** Every enabled strategy summed into one weight per (product, tenor); legs that cancel out are dropped. */
export function mergeLegs(strategies: readonly StrategyInput[]): WatchLeg[] {
  const merged = new Map<string, WatchLeg>()
  for (const s of strategies) {
    if (!s.enabled) continue
    for (const [tenor, weight] of Object.entries(s.weights)) {
      if (!weight) continue
      const key = `${s.product}:${tenor}`
      const prior = merged.get(key)
      merged.set(key, { product: s.product, tenor, weight: (prior?.weight ?? 0) + weight * s.size })
    }
  }
  return [...merged.values()].filter((l) => Math.abs(l.weight) > 1e-9).sort((a, b) => a.product.localeCompare(b.product) || tenorRank(a.tenor) - tenorRank(b.tenor))
}

/** One strategy per product holding that product's legs: the shape the seasonality endpoint takes, rebuilt from saved legs. */
export function legsToStrategies(legs: readonly WatchLeg[]): StrategyInput[] {
  const byProduct = new Map<WatchLeg["product"], Record<string, number>>()
  for (const l of legs) byProduct.set(l.product, { ...(byProduct.get(l.product) ?? {}), [l.tenor]: l.weight })
  return [...byProduct.entries()].map(([product, weights]) => ({ product, size: 1, enabled: true, weights }))
}

export interface MeasuredRanges {
  ranges: WatchRanges
  /** The newest trading date the ranges' history reaches. */
  asOf: string | null
}

/** The base range of one view of the combined position in `result`, using the years / window / width in `settings`. */
function rangeOf(result: SeasonalityResult, settings: WatchSettings, mode: "level" | "change"): WatchRange | null {
  const picked = new Set(result.series.filter((s) => settings.shifts.includes(s.shift)).map((s) => s.year))
  const lines = buildLines(result.series, {
    mode,
    removeSpikes: mode === "change" && settings.remove_spikes,
    align: "current",
    years: picked,
    minDays: settings.min_days,
    maxDays: settings.max_days,
    average: false,
  })
  const stats = computeRange(lines, { sigma: settings.sigma, basis: settings.basis })
  if (!stats) return null
  const { lo, mid, hi, sd, n } = stats.range
  return { lo, mid, hi, sd, n }
}

/** Both base ranges (price level and daily change) of the combined position in `result`; null when neither could be measured. */
export function measureRanges(result: SeasonalityResult, settings: WatchSettings): MeasuredRanges | null {
  const ranges: WatchRanges = { level: rangeOf(result, settings, "level"), change: rangeOf(result, settings, "change") }
  if (!ranges.level && !ranges.change) return null
  const asOf = result.series.flatMap((s) => s.dates.slice(-1)).sort().pop() ?? null
  return { ranges, asOf }
}
