// Live pricing for a position's leg list, off the same shared tick store every curve reads. Same
// math as the backend's `StructureEngine._compute` (`backend/app/lightstreamer/structures.py`) --
// reimplemented client-side, rather than registered as a server-side structure, so a position's mark
// survives a backend restart and needs no backend pricing support at all.
import type { Leg } from "@/lib/strategy-resolver"
import type { RowStore } from "@/lib/row-store"
import { priceOf, type PriceField, type Tick } from "@/lib/ticks"

export type Side = "long" | "short"

/** Every product on this desk quotes on a 0.01 tick worth $10 -- so a lot's P&L in dollars is the
 * price move divided into ticks, times $10. Mirrored server-side in `routers/positions.py`'s
 * realized P&L so a closed trade's journal entry lands in the same units as an open position's live
 * P&L; keep the two in sync if either changes. */
export const TICK_SIZE = 0.01
export const TICK_VALUE_USD = 10
export const PRICE_MULTIPLIER = TICK_VALUE_USD / TICK_SIZE

/** The field a position's live price reads off the tick store. Mid (bid/ask average, falling back to
 * the trade print) updates on every quote, not just a print -- unlike the curves tab's own default of
 * last-trade, a position's live price needs to move continuously even on a quiet instrument. */
export const LIVE_FIELD: PriceField = "mid"

/** Sum of each leg's weighted live price; `null` if any leg's tick hasn't arrived yet. */
export function computeWeightedPrice(legs: Leg[], field: PriceField, store: RowStore<Tick>): number | null {
  let total = 0
  for (const { item, weight } of legs) {
    const price = priceOf(store.getRow(item), field)
    if (price === null) return null
    total += weight * price
  }
  return total
}

/** `size * (mark - average) * $10-per-0.01-tick * (+1 long, -1 short)`, in dollars. `null` if the
 * mark isn't resolvable yet. */
export function livePnl(legs: Leg[], side: Side, size: number, averagePrice: number, field: PriceField, store: RowStore<Tick>): number | null {
  const mark = computeWeightedPrice(legs, field, store)
  if (mark === null) return null
  return size * (mark - averagePrice) * PRICE_MULTIPLIER * (side === "long" ? 1 : -1)
}
