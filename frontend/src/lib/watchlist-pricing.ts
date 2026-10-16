// Live pricing for a watchlist combination. The deferred outright quotes are wide (a CLBZZ K27 can be 0.40 wide)
// and a combination sums the width of every leg, so pricing a fly off outright mids is both far off and jumpy.
// The 1-month calendar spreads are quoted a tick or two wide with real size, and any combination whose weights
// sum to zero (a spread, fly, double-fly, or a sum of them) is exactly a weighted sum of those spreads:
//
//     sum_t w_t * P_t  =  sum_u c_u * (P_{u+1} - P_u),   c_u = sum of the weights of the months after u
//
// A 1MS instrument is quoted NEAR minus FAR (WTI X26-Z26 = P_X26 - P_Z26, checked against the live outrights on
// all three products), i.e. the negative of (P_{u+1} - P_u), so each spread's weight is -c_u.
//
// So that is what is priced when every spread it needs is on the feed; otherwise the outrights, with the
// quote width reported so a row built on a thin market can say so instead of turning red on a guess.

import type { InstrumentRecord } from "@/lib/api"
import type { RowStore } from "@/lib/row-store"
import { toNumber, type Tick } from "@/lib/ticks"
import type { WatchLeg } from "@/lib/watchlist-api"

const MONTH_CODES = "FGHJKMNQUVXZ"

/** Months in a row are consecutive ranks: "K27" (May 2027) is 27*12 + 4, "M27" the next one. */
const rankOf = (tenor: string) => Number(tenor.slice(1)) * 12 + MONTH_CODES.indexOf(tenor[0])
const tenorOf = (rank: number) => `${MONTH_CODES[rank % 12]}${String(Math.floor(rank / 12)).padStart(2, "0")}`

export interface PriceTerm {
  item: string
  weight: number
}

export interface PricePlan {
  /** "spreads": every product's legs were rebuilt from 1-month spreads. "outrights": at least one product fell back to raw outright quotes. */
  via: "spreads" | "outrights"
  terms: PriceTerm[]
}

export interface LiveQuote {
  /** Weighted sum of the terms' mids. */
  price: number
  /** Weighted sum of the terms' bid/ask widths: how far the mid could be from where the combination would actually trade. */
  width: number
  /** The same combination's move since the previous settlement: weighted sum of (mid - settlementPrice). Null until every term has a settlement. */
  move: number | null
}

/** How to price `legs` from the instruments on the feed; null when a leg or spread the pricing needs is not on it. */
export function buildPricePlan(legs: readonly WatchLeg[], instruments: readonly InstrumentRecord[]): PricePlan | null {
  const outrights = new Map<string, string>()
  const spreads = new Map<string, string>()
  for (const i of instruments) {
    if (i.instrument_type === "OUTRIGHT") outrights.set(`${i.product}:${i.tenor}`, i.item)
    else if (i.instrument_type === "1MS") spreads.set(`${i.product}:${i.tenor}`, i.item)
  }

  const byProduct = new Map<string, WatchLeg[]>()
  for (const leg of legs) byProduct.set(leg.product, [...(byProduct.get(leg.product) ?? []), leg])

  const terms: PriceTerm[] = []
  let via: PricePlan["via"] = "spreads"
  for (const [product, group] of byProduct) {
    const ordered = [...group].sort((a, b) => rankOf(a.tenor) - rankOf(b.tenor))
    const total = ordered.reduce((sum, l) => sum + l.weight, 0)

    let viaSpreads: PriceTerm[] | null = null
    if (Math.abs(total) < 1e-9 && ordered.length >= 2) {
      const first = rankOf(ordered[0].tenor)
      const last = rankOf(ordered[ordered.length - 1].tenor)
      const built: PriceTerm[] = []
      for (let r = first; r < last; r++) {
        const weight = ordered.filter((l) => rankOf(l.tenor) > r).reduce((sum, l) => sum + l.weight, 0)
        if (Math.abs(weight) < 1e-9) continue
        const item = spreads.get(`${product}:${tenorOf(r)}-${tenorOf(r + 1)}`)
        if (!item) {
          built.length = 0
          break
        }
        built.push({ item, weight: -weight })
      }
      if (built.length > 0) viaSpreads = built
    }

    if (viaSpreads) {
      terms.push(...viaSpreads)
      continue
    }
    via = "outrights"
    for (const leg of ordered) {
      const item = outrights.get(`${product}:${leg.tenor}`)
      if (!item) return null
      terms.push({ item, weight: leg.weight })
    }
  }
  return terms.length > 0 ? { via, terms } : null
}

/** The plan's live mid and total quote width; null when any term has no two-sided market yet. */
export function livePlanQuote(plan: PricePlan, store: RowStore<Tick>): LiveQuote | null {
  let price = 0
  let width = 0
  let move: number | null = 0
  for (const { item, weight } of plan.terms) {
    const tick = store.getRow(item)
    const bid = toNumber(tick?.bidPrice)
    const ask = toNumber(tick?.askPrice)
    if (bid === null || ask === null || ask < bid) return null
    const mid = (bid + ask) / 2
    price += weight * mid
    width += Math.abs(weight) * (ask - bid)
    // The feed's settlementPrice is the previous day's settle until today's is struck; Seasonality's daily change is settle to settle.
    const settle = toNumber(tick?.settlementPrice)
    move = move === null || settle === null ? null : move + weight * (mid - settle)
  }
  return { price, width, move }
}
