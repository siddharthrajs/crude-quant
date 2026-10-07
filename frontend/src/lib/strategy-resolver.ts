// Resolves a strategy code + tenor to a weighted leg list purely in terms of live-feed instruments,
// so a position's mark can be priced client-side (see `position-pricing.ts`) without any backend
// pricing support. Mirrors -- and generalizes to any N-month spacing -- the same "difference of two
// narrower structures" pattern the backend already uses for its double-flies
// (`build_dfly_structures` in `backend/app/lightstreamer/structures.py`): a real quoted instrument is
// preferred when the feed has one, and only synthesized from outrights when it doesn't.
import type { InstrumentRecord } from "@/lib/api"
import { addMonths } from "@/lib/tenor"

export interface Leg {
  item: string
  weight: number
}

const SPACINGS = [1, 2, 3, 6, 12] as const

/** OUT, then 1MS..12MS, 1MF..12MF, 1MDF..12MDF. */
export const STRATEGY_CODES = [
  "OUT",
  ...SPACINGS.map((n) => `${n}MS`),
  ...SPACINGS.map((n) => `${n}MF`),
  ...SPACINGS.map((n) => `${n}MDF`),
] as const

export type StrategyCode = (typeof STRATEGY_CODES)[number]

function findInstrument(product: string, type: string, tenor: string, instruments: InstrumentRecord[]): InstrumentRecord | undefined {
  return instruments.find((i) => i.product === product && i.instrument_type === type && i.tenor === tenor)
}

function outrightItem(product: string, tenor: string, instruments: InstrumentRecord[]): string | null {
  return findInstrument(product, "OUTRIGHT", tenor, instruments)?.item ?? null
}

function negate(legs: Leg[]): Leg[] {
  return legs.map((l) => ({ item: l.item, weight: -l.weight }))
}

/** Sums weights per item across leg groups and drops anything that nets to zero (a leg two groups share, wing to wing). */
function mergeLegs(...groups: Leg[][]): Leg[] {
  const byItem = new Map<string, number>()
  for (const legs of groups) {
    for (const { item, weight } of legs) byItem.set(item, (byItem.get(item) ?? 0) + weight)
  }
  return [...byItem.entries()].filter(([, weight]) => Math.abs(weight) > 1e-9).map(([item, weight]) => ({ item, weight }))
}

/** N-month spread starting at `tenor`: the live `1MS` instrument when N is 1 and one is quoted, else OUT(tenor+N) − OUT(tenor). */
function spreadLegs(product: string, tenor: string, n: number, instruments: InstrumentRecord[]): Leg[] | null {
  if (n === 1) {
    const direct = findInstrument(product, "1MS", `${tenor}-${addMonths(tenor, 1)}`, instruments)
    if (direct) return [{ item: direct.item, weight: 1 }]
  }
  const near = outrightItem(product, tenor, instruments)
  const far = outrightItem(product, addMonths(tenor, n), instruments)
  return near && far ? [{ item: near, weight: -1 }, { item: far, weight: 1 }] : null
}

/** N-month fly centered at `tenor`: the live `FLY` instrument (the market's own "1-month fly") when N is 1 and one is quoted, else spread(tenor,N) − spread(tenor+N,N). */
function flyLegs(product: string, tenor: string, n: number, instruments: InstrumentRecord[]): Leg[] | null {
  if (n === 1) {
    const direct = findInstrument(product, "FLY", tenor, instruments)
    if (direct) return [{ item: direct.item, weight: 1 }]
  }
  const near = spreadLegs(product, tenor, n, instruments)
  const far = near && spreadLegs(product, addMonths(tenor, n), n, instruments)
  return near && far ? mergeLegs(near, negate(far)) : null
}

/** N-month double-fly at `tenor`: fly(tenor,N) − fly(tenor+N,N). */
function doubleFlyLegs(product: string, tenor: string, n: number, instruments: InstrumentRecord[]): Leg[] | null {
  const near = flyLegs(product, tenor, n, instruments)
  const far = near && flyLegs(product, addMonths(tenor, n), n, instruments)
  return near && far ? mergeLegs(near, negate(far)) : null
}

/** Resolves any `STRATEGY_CODES` entry at `tenor` to a weighted leg list; `null` if a required outright is out of the live forward curve. */
export function resolveStrategy(code: string, product: string, tenor: string, instruments: InstrumentRecord[]): Leg[] | null {
  if (code === "OUT") {
    const item = outrightItem(product, tenor, instruments)
    return item ? [{ item, weight: 1 }] : null
  }
  const m = /^(\d+)M(S|F|DF)$/.exec(code)
  if (!m) return null
  const n = Number(m[1])
  if (m[2] === "S") return spreadLegs(product, tenor, n, instruments)
  if (m[2] === "F") return flyLegs(product, tenor, n, instruments)
  return doubleFlyLegs(product, tenor, n, instruments)
}

/** "X26 1MF": the tenor first, then the strategy code. */
export function strategyLabel(code: string, tenor: string): string {
  return `${tenor} ${code}`
}
