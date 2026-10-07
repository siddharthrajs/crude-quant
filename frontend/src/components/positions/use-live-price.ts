import { useEffect, useState } from "react"
import { computeWeightedPrice, LIVE_FIELD } from "@/lib/position-pricing"
import type { RowStore } from "@/lib/row-store"
import type { Leg } from "@/lib/strategy-resolver"
import type { Tick } from "@/lib/ticks"

/** The live weighted price of `legs` off the shared tick store, refreshed once per animation frame
 * (row-store's own documented cadence) while `legs` resolves to at least one leg. */
export function useLivePrice(legs: Leg[] | null, tickStore: RowStore<Tick>): number | null {
  const [price, setPrice] = useState<number | null>(null)
  const hasLegs = Boolean(legs && legs.length > 0)

  useEffect(() => {
    if (!legs || legs.length === 0) return
    let raf = 0
    const step = () => {
      setPrice(computeWeightedPrice(legs, LIVE_FIELD, tickStore))
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [legs, tickStore])

  // Derived, not reset via the effect above: once `legs` goes null the effect above simply stops
  // running (its cleanup cancels the frame), and this returns null directly rather than a stale price.
  return hasLegs ? price : null
}
